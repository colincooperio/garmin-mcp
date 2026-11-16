import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createLocalKV, FileKV } from "../src/file-kv.ts";
import { MemoryKV } from "../src/memory-kv.ts";
import type { Install } from "../src/update.ts";
import { periodKey, pingUrl, UsagePings } from "../src/usage.ts";
import { callGarminTool } from "./tool-harness.ts";

const BASE = "https://github.com/colincooperio/garmin-mcp/releases/latest/download";
const at = (iso: string) => Date.parse(iso) / 1000;

function github(fail?: Error) {
	const urls: string[] = [];
	const inits: RequestInit[] = [];
	const fetch = async (url: string, init?: RequestInit) => {
		urls.push(url);
		inits.push(init ?? {});
		if (fail) throw fail;
		return Response.json({ ok: true });
	};
	return { fetch, urls, inits };
}

function pinger(o: { kv?: MemoryKV; clock: { t: number }; install?: Install; disabled?: boolean; fail?: Error; persistent?: () => boolean }) {
	const gh = github(o.fail);
	const kv = o.kv ?? new MemoryKV(() => o.clock.t);
	const p = new UsagePings({ install: o.install ?? { type: "mcpb" }, kv, fetch: gh.fetch, now: () => o.clock.t, disabled: o.disabled, persistent: o.persistent });
	return { p, gh, kv };
}

const names = (urls: string[]) => urls.map((u) => u.slice(BASE.length + 1)).sort();

describe("periodKey", () => {
	it("UTC day, ISO week and month", () => {
		assert.equal(periodKey("day", at("2026-11-16T23:59:59Z")), "2026-11-16");
		assert.equal(periodKey("month", at("2026-11-30T23:59:59Z")), "2026-11");
		assert.equal(periodKey("month", at("2026-12-01T00:00:00Z")), "2026-12");
		// Monday 16 Nov 2026 starts ISO week 47; Sunday the 22nd ends it.
		assert.equal(periodKey("week", at("2026-11-16T00:00:00Z")), "2026-W47");
		assert.equal(periodKey("week", at("2026-11-22T23:59:59Z")), "2026-W47");
		assert.equal(periodKey("week", at("2026-11-23T00:00:00Z")), "2026-W48");
		assert.equal(periodKey("week", at("2026-11-15T23:59:59Z")), "2026-W46");
	});

	it("ISO week years at the turn of the year", () => {
		assert.equal(periodKey("week", at("2021-01-03T12:00:00Z")), "2020-W53", "Sun 3 Jan 2021 is in 2020's week 53");
		assert.equal(periodKey("week", at("2021-01-04T00:00:00Z")), "2021-W01");
		assert.equal(periodKey("week", at("2024-12-30T00:00:00Z")), "2025-W01", "Mon 30 Dec 2024 is in 2025's week 1");
		assert.equal(periodKey("week", at("2026-01-01T00:00:00Z")), "2026-W01");
		assert.equal(periodKey("week", at("2026-12-31T00:00:00Z")), "2026-W53");
		assert.equal(periodKey("week", at("2027-01-03T00:00:00Z")), "2026-W53");
	});
});

describe("UsagePings", () => {
	it("downloads <ping>-<type>.json from the latest release, nothing else attached", async () => {
		assert.equal(pingUrl("weekly", { type: "mcpb" }), `${BASE}/weekly-mcpb.json`);
		assert.equal(pingUrl("monthly", { type: "npx", pinned: false }), `${BASE}/monthly-npx.json`);
		assert.equal(pingUrl("install", { type: "global" }), `${BASE}/install-npx.json`, "other npm installs count as npx");
		assert.equal(pingUrl("install", { type: "cloud" }), `${BASE}/install-cloud.json`);
		const { p, gh } = pinger({ clock: { t: at("2026-11-16T10:00:00Z") } });
		await p.tick();
		for (const [i, url] of gh.urls.entries()) {
			assert.ok(!url.includes("?") && !url.includes("#"), url);
			assert.deepEqual(gh.inits[i]!.headers, { "User-Agent": "garmin-mcp-update-check", Accept: "application/json" });
			assert.ok(gh.inits[i]!.signal instanceof AbortSignal, "times out");
		}
	});

	it("first run: install, weekly and monthly, once each", async () => {
		const clock = { t: at("2026-11-16T10:00:00Z") };
		const { p, gh } = pinger({ clock });
		await Promise.all([p.tick(), p.tick()]);
		await p.tick();
		assert.deepEqual(names(gh.urls), ["install-mcpb.json", "monthly-mcpb.json", "weekly-mcpb.json"]);
	});

	it("the same week and month: nothing, across restarts", async () => {
		const clock = { t: at("2026-11-16T10:00:00Z") };
		const kv = new MemoryKV(() => clock.t);
		await pinger({ kv, clock }).p.tick();
		clock.t = at("2026-11-22T23:00:00Z"); // still week 47, still November
		const restarted = pinger({ kv, clock });
		await restarted.p.tick();
		await restarted.p.tick();
		assert.deepEqual(restarted.gh.urls, []);
	});

	it("a new week: exactly one weekly download; a new month: exactly one monthly", async () => {
		const clock = { t: at("2026-11-16T10:00:00Z") };
		const kv = new MemoryKV(() => clock.t);
		const { p, gh } = pinger({ kv, clock });
		await p.tick();
		gh.urls.length = 0;
		clock.t = at("2026-11-23T00:00:01Z"); // week 48, same month
		await Promise.all([p.tick(), p.tick()]);
		await p.tick();
		assert.deepEqual(names(gh.urls), ["weekly-mcpb.json"]);
		gh.urls.length = 0;
		clock.t = at("2026-12-01T09:00:00Z"); // Tuesday of week 49, and a new month
		await p.tick();
		assert.deepEqual(names(gh.urls), ["monthly-mcpb.json", "weekly-mcpb.json"]);
		gh.urls.length = 0;
		clock.t = at("2026-12-03T09:00:00Z"); // same week, same month
		await p.tick();
		assert.deepEqual(gh.urls, []);
		// A restart later in the same week and month sends nothing.
		clock.t = at("2027-01-01T09:00:00Z"); // Friday of 2026-W53, January
		await p.tick();
		gh.urls.length = 0;
		clock.t = at("2027-01-02T09:00:00Z");
		const restarted = pinger({ kv, clock });
		await restarted.p.tick();
		assert.deepEqual(restarted.gh.urls, []);
	});

	it("install: once ever, never again after restarts", async () => {
		const clock = { t: at("2026-11-16T10:00:00Z") };
		const kv = new MemoryKV(() => clock.t);
		let installs = 0;
		for (let i = 0; i < 5; i++) {
			const { p, gh } = pinger({ kv, clock });
			await p.tick();
			installs += gh.urls.filter((u) => u.includes("/install-")).length;
			clock.t += 40 * 86_400;
		}
		assert.equal(installs, 1);
	});

	it("opted out: no downloads and nothing stored", async () => {
		const clock = { t: at("2026-11-16T10:00:00Z") };
		const kv = new MemoryKV(() => clock.t);
		const { p, gh } = pinger({ kv, clock, disabled: true });
		await p.tick();
		clock.t += 40 * 86_400;
		await p.tick();
		assert.deepEqual(gh.urls, []);
		assert.equal(await kv.get("garmin:usage:mcpb:install"), null);
	});

	it("a failed download is silent and not retried that period", async () => {
		const clock = { t: at("2026-11-16T10:00:00Z") };
		const kv = new MemoryKV(() => clock.t);
		const down = pinger({ kv, clock, fail: new Error("ENOTFOUND") });
		await down.p.tick(); // doesn't throw
		assert.equal(down.gh.urls.length, 3);
		const later = pinger({ kv, clock });
		await later.p.tick();
		assert.deepEqual(later.gh.urls, [], "counts only ever err low");
	});

	it("a store that can't persist: sends nothing, rather than counting every restart", async () => {
		const { p, gh } = pinger({ clock: { t: at("2026-11-16T10:00:00Z") }, persistent: () => false });
		await p.tick();
		assert.deepEqual(gh.urls, []);
	});

	it("the Desktop extension and npx on one computer share the state folder but are counted separately", async () => {
		const clock = { t: at("2026-11-16T10:00:00Z") };
		const kv = new MemoryKV(() => clock.t);
		const desktop = pinger({ kv, clock, install: { type: "mcpb" } });
		const npx = pinger({ kv, clock, install: { type: "npx", pinned: false } });
		await desktop.p.tick();
		await npx.p.tick();
		assert.deepEqual(names(npx.gh.urls), ["install-npx.json", "monthly-npx.json", "weekly-npx.json"]);
		await pinger({ kv, clock, install: { type: "npx", pinned: true } }).p.tick();
		const again = pinger({ kv, clock, install: { type: "global" } }); // other npm installs count as npx
		await again.p.tick();
		assert.deepEqual(again.gh.urls, []);
	});

	it("cloud: Worker instances sharing KV send each ping once in total", async () => {
		const clock = { t: at("2026-11-16T10:00:00Z") };
		const kv = new MemoryKV(() => clock.t);
		const a = pinger({ kv, clock, install: { type: "cloud" } });
		const b = pinger({ kv, clock, install: { type: "cloud" } });
		await a.p.tick();
		await b.p.tick();
		assert.deepEqual(names([...a.gh.urls, ...b.gh.urls]), ["install-cloud.json", "monthly-cloud.json", "weekly-cloud.json"]);
	});

	it("runs on each tool call without delaying it", async () => {
		const clock = { t: at("2026-11-16T10:00:00Z") };
		let release!: () => void;
		const slow = new Promise<void>((r) => (release = r));
		const urls: string[] = [];
		const p = new UsagePings({
			install: { type: "mcpb" },
			kv: new MemoryKV(() => clock.t),
			now: () => clock.t,
			fetch: async (url) => {
				urls.push(url);
				await slow; // GitHub hangs
				return Response.json({ ok: true });
			},
		});
		const result = await callGarminTool(
			"get_daily_summaries",
			() => Response.json({ data: [{ calendarDate: "2020-01-01", movement: { steps: { value: 1 } } }] }),
			{ start_date: "2020-01-01", end_date: "2020-01-02" },
			{ usage: p },
		);
		assert.equal(result[0].steps, 1, "the tool answered while the pings were still pending");
		assert.equal(urls.length, 3);
		release();
		await p.tick();
	});
});

describe("local state store", () => {
	it("keeps the markers on disk across restarts, with GARMIN_MCP_NO_CACHE=1 too, and the cache's cap never evicts them", async () => {
		const dir = await mkdtemp(join(tmpdir(), "garmin-usage-"));
		try {
			const clock = { t: at("2026-11-16T10:00:00Z") };
			const start = (env: Record<string, string>) => {
				const { state } = createLocalKV({ GARMIN_MCP_CACHE_DIR: dir, ...env }, { now: () => clock.t });
				const gh = github();
				const p = new UsagePings({ install: { type: "npx", pinned: false }, kv: state.kv, fetch: gh.fetch, now: () => clock.t, persistent: state.persistent });
				return { p, gh, state };
			};
			const first = start({ GARMIN_MCP_NO_CACHE: "1" });
			await first.p.tick();
			assert.deepEqual(names(first.gh.urls), ["install-npx.json", "monthly-npx.json", "weekly-npx.json"]);
			assert.equal(first.state.persistent(), true);
			assert.equal(first.state.dir, join(dir, "state"));
			assert.equal((await readdir(join(dir, "state"))).filter((f) => f.endsWith(".json")).length, 3, "small files in <cache>/state");

			// Fill the cache past a tiny cap: eviction only touches the cache's own files.
			const cache = new FileKV(dir, { maxBytes: 100, now: () => clock.t });
			for (let i = 0; i < 5; i++) await cache.put(`garmin:resp:${i}`, "x".repeat(80));
			await cache.prune();

			for (const env of [{}, { GARMIN_MCP_NO_CACHE: "1" }]) {
				const again = start(env);
				await again.p.tick();
				assert.deepEqual(again.gh.urls, [], `restart ${JSON.stringify(env)}`);
			}
			clock.t = at("2027-03-01T10:00:00Z");
			const later = start({});
			await later.p.tick();
			assert.deepEqual(names(later.gh.urls), ["monthly-npx.json", "weekly-npx.json"], "never install again");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("no usable directory: in memory, and reported as not persistent", async () => {
		const dir = await mkdtemp(join(tmpdir(), "garmin-usage-"));
		try {
			const { writeFile } = await import("node:fs/promises");
			const file = join(dir, "not-a-dir");
			await writeFile(file, "x");
			const warnings: string[] = [];
			const { state } = createLocalKV({ GARMIN_MCP_CACHE_DIR: file }, { warn: (m) => warnings.push(m) });
			const gh = github();
			const p = new UsagePings({ install: { type: "mcpb" }, kv: state.kv, fetch: gh.fetch, persistent: state.persistent });
			await p.tick();
			assert.equal(state.persistent(), false);
			assert.deepEqual(gh.urls, []);
			assert.equal(warnings.length, 1);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
