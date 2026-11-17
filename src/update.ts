/**
 * Update notice. Once per UTC calendar day, in the background, download a
 * tiny version file attached to the latest GitHub release
 * (latest-<mcpb|npx|cloud>.json: {"latest": "x.y.z", "url": "<release>"}).
 * GitHub counts each download per file, so the daily counts are daily active
 * installs by type (usage.ts adds weekly, monthly and first-install files);
 * nothing about the user or their data is sent.
 *
 * The day of the last check is kept in the store passed as `kv`: locally the
 * state folder on disk (so a restart the same day doesn't check again), in the
 * cloud KV (so all Worker instances together check once a day).
 *
 * When a newer version exists, the first tool result of each server session
 * (local) or each day (cloud) carries an update_available field with one
 * instruction for how this copy is installed. For unpinned npx
 * (garmin-mcp@latest) that's just "restart your client": npx fetches the
 * latest version when the client starts the server again.
 *
 * Shared by the Worker and the local server, so no Node-only imports here.
 * Never blocks a tool call and never throws: every failure is silent.
 */

import type { KVLike } from "./garmin.ts";

export const RELEASES = "https://github.com/colincooperio/garmin-mcp/releases";
export const CHECK_INTERVAL_SECONDS = 24 * 60 * 60;
/** How long the last result is kept: a little over a day, so it's there until the next check. */
const CACHE_TTL_SECONDS = 2 * CHECK_INTERVAL_SECONDS;
export const CHECK_TIMEOUT_MS = 3000;
const USER_AGENT = "garmin-mcp-update-check";
/** Per install type: the Desktop extension and npx on one computer share the state folder. */
const CACHE_KEY = "garmin:update:latest:";
const SHOWN_KEY = "garmin:update:shown:";

/**
 * How this copy runs. `assetFor` picks the version file (and so the
 * download counter). Unpinned npx keeps the spec when it's known: a bare
 * "garmin-mcp" doesn't update on a restart (npx reuses its cached copy).
 */
export type Install =
	| { type: "mcpb" }
	| { type: "cloud" }
	| { type: "npx"; pinned: false; spec?: "garmin-mcp" | "garmin-mcp@latest" }
	| { type: "npx"; pinned: true; spec?: string }
	| { type: "global" };

export const assetFor = (install: Install) => (install.type === "global" ? "npx" : install.type);
export const checkUrl = (install: Install) => `${RELEASES}/latest/download/latest-${assetFor(install)}.json`;

/** One instruction for updating this kind of install. */
export function howToUpdate(install: Install, latest: string): string {
	switch (install.type) {
		case "mcpb":
			return "Download garmin-mcp.mcpb from the latest release and double-click it.";
		case "cloud":
			return "Run npm run update in your garmin-mcp folder.";
		case "npx":
			if (!install.pinned) {
				return install.spec === "garmin-mcp"
					? "In your MCP config, change garmin-mcp to garmin-mcp@latest (npx keeps reusing the copy it has otherwise), then restart your client to update."
					: "Restart your client to update.";
			}
			return `Change ${install.spec ?? "the pinned garmin-mcp@<version>"} to garmin-mcp@${latest} in your MCP config, then restart the app.`;
		case "global":
			return `Run npm install -g garmin-mcp@${latest}, then restart the app.`;
	}
}

export type Period = "day" | "week" | "month";

/**
 * The UTC period containing `seconds` (since epoch): "YYYY-MM-DD" for a day,
 * "YYYY-Www" for an ISO week (weeks start on Monday; week 1 holds the year's
 * first Thursday, so early January can belong to the previous year's last
 * week), "YYYY-MM" for a month.
 */
export function periodKey(period: Period, seconds: number): string {
	const d = new Date(seconds * 1000);
	if (period === "day") return d.toISOString().slice(0, 10);
	if (period === "month") return d.toISOString().slice(0, 7);
	// The Thursday of this ISO week decides its year.
	const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
	thursday.setUTCDate(thursday.getUTCDate() + 4 - (thursday.getUTCDay() || 7));
	const year = thursday.getUTCFullYear();
	const week = Math.ceil(((thursday.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
	return `${year}-W${String(week).padStart(2, "0")}`;
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** -1, 0 or 1; undefined when either isn't x.y.z[-pre]. A pre-release sorts before its release. */
export function compareSemver(a: string, b: string): number | undefined {
	const x = SEMVER.exec(a);
	const y = SEMVER.exec(b);
	if (!x || !y) return undefined;
	for (let i = 1; i <= 3; i++) {
		const d = Number(x[i]) - Number(y[i]);
		if (d) return Math.sign(d);
	}
	if (x[4] === y[4]) return 0;
	if (!x[4]) return 1;
	if (!y[4]) return -1;
	return x[4] < y[4] ? -1 : 1;
}

/** The last check: its UTC day, and the newest version known (kept from earlier checks if this one failed). */
interface Cached {
	day?: string;
	checkedAt: number;
	latest?: string;
	url?: string;
}

export interface UpdateOptions {
	current: string;
	install: Install;
	kv: KVLike;
	fetch?: (input: string, init?: RequestInit) => Promise<Response>;
	/** Seconds since epoch. */
	now?: () => number;
	/** Turned off (see updateCheckDisabled): no request, no notice. */
	disabled?: boolean;
	/** Cloud: once per day (tracked in KV). Local: once per server session. */
	perDay?: boolean;
}

export type UpdateNotice = {
	current: string;
	latest: string;
	how_to_update: string;
	release: string;
	note: string;
};

/** Truthy opt-out values for GARMIN_MCP_NO_UPDATE_CHECK. */
export const optedOut = (v: string | undefined) => ["1", "true", "yes"].includes(v?.trim().toLowerCase() ?? "");

/**
 * Whether the update check is off. Two switches, either one turns it off:
 * - GARMIN_MCP_NO_UPDATE_CHECK = "1" / "true" (/ "yes"): the documented
 *   opt-out for npx and cloud installs.
 * - GARMIN_MCP_UPDATE_CHECK = "false" / "0": the Desktop extension's
 *   "Check for updates" switch, unticked.
 * Anything else leaves it on, including an unset, empty or "true" value and
 * an unsubstituted "${user_config.update_check}" from an older Claude Desktop.
 */
export function updateCheckDisabled(noUpdateCheck: string | undefined, updateCheck: string | undefined): boolean {
	return optedOut(noUpdateCheck) || ["false", "0"].includes(updateCheck?.trim().toLowerCase() ?? "");
}

export class UpdateCheck {
	private readonly o: UpdateOptions;
	private readonly fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
	private readonly now: () => number;
	private cached?: Cached;
	private loading?: Promise<void>;
	private refreshing?: Promise<void>;
	private shownThisSession = false;

	constructor(o: UpdateOptions) {
		this.o = o;
		this.fetchImpl = o.fetch ?? ((input, init) => fetch(input, init));
		this.now = o.now ?? (() => Math.floor(Date.now() / 1000));
	}

	/** Reads the last result from the store into memory (once). Never throws. */
	load(): Promise<void> {
		this.loading ??= this.o.disabled ? Promise.resolve() : this.read();
		return this.loading;
	}

	private async read(): Promise<void> {
		try {
			const raw = await this.o.kv.get(CACHE_KEY + assetFor(this.o.install));
			if (raw) this.cached = JSON.parse(raw) as Cached;
		} catch {
			// Unreadable: keep what's in memory (or treat as never checked).
		}
	}

	/**
	 * Checks GitHub unless a check (successful or not) already happened on
	 * this UTC day, by this process or any other sharing the store. Meant to
	 * be started on start-up and on each tool call, not awaited. Never throws.
	 */
	refresh(): Promise<void> {
		if (this.o.disabled) return Promise.resolve();
		const today = periodKey("day", this.now());
		if (this.cached?.day === today) return Promise.resolve();
		this.refreshing ??= (async () => {
			// Always re-read: another Worker instance, or an earlier run today, may have checked.
			await this.load();
			await this.read();
			if (this.cached?.day === today) return;
			// Claim the day before downloading, so others sharing the store skip it.
			const claimed: Cached = { ...this.cached, day: today, checkedAt: this.now() };
			this.cached = claimed;
			await this.o.kv.put(CACHE_KEY + assetFor(this.o.install), JSON.stringify(claimed), { expirationTtl: CACHE_TTL_SECONDS }).catch(() => {});
			const result: Cached = { ...claimed };
			try {
				const res = await this.fetchImpl(checkUrl(this.o.install), {
					headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
					redirect: "follow",
					signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
				});
				if (res.ok) {
					const body = (await res.json()) as { latest?: unknown; url?: unknown };
					if (typeof body.latest === "string" && SEMVER.test(body.latest)) {
						result.latest = body.latest;
						result.url = typeof body.url === "string" && body.url.startsWith(`${RELEASES}/`) ? body.url : undefined;
					}
				} else await res.body?.cancel().catch(() => {});
			} catch {
				// Offline, timed out or blocked: keep what was known, try again tomorrow.
				return;
			}
			this.cached = result;
			await this.o.kv.put(CACHE_KEY + assetFor(this.o.install), JSON.stringify(result), { expirationTtl: CACHE_TTL_SECONDS }).catch(() => {});
		})()
			.catch(() => {})
			.finally(() => (this.refreshing = undefined));
		return this.refreshing;
	}

	/** The newer version the last check found, if any (and the check isn't off). */
	newer(): { latest: string; url: string } | undefined {
		if (this.o.disabled) return undefined;
		const latest = this.cached?.latest;
		if (!latest || compareSemver(latest, this.o.current) !== 1) return undefined;
		return { latest, url: this.cached?.url ?? `${RELEASES}/latest` };
	}

	/** One line for the server instructions, when an update is already known. */
	instructionsLine(): string | undefined {
		const n = this.newer();
		if (!n) return undefined;
		return (
			`An update is available (${this.o.current} -> ${n.latest}). ` +
			"When a tool result includes update_available, mention it to the user once, briefly, then answer their question."
		);
	}

	/**
	 * The notice for this tool result: only the first of each session (local)
	 * or each day (cloud), and only when an update is known. Uses what's
	 * already cached; never waits for a check.
	 */
	async notice(): Promise<UpdateNotice | undefined> {
		await this.load(); // the cache only; never the network
		const n = this.newer();
		if (!n) return undefined;
		if (this.o.perDay) {
			const day = new Date(this.now() * 1000).toISOString().slice(0, 10);
			const key = `${SHOWN_KEY}${day}`;
			try {
				if (await this.o.kv.get(key)) return undefined;
				await this.o.kv.put(key, "1", { expirationTtl: 2 * CHECK_INTERVAL_SECONDS });
			} catch {
				return undefined;
			}
		} else {
			if (this.shownThisSession) return undefined;
			this.shownThisSession = true;
		}
		return {
			current: this.o.current,
			latest: n.latest,
			how_to_update: howToUpdate(this.o.install, n.latest),
			release: n.url,
			note: "Mention this to the user once, briefly, then answer their question.",
		};
	}
}
