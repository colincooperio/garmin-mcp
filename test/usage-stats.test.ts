import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
// @ts-expect-error: plain .mjs script without type declarations
import { buildReport, commitTimes, formatReport, increase, mondayOf, parseCsv, snapshots, summaryLine } from "../scripts/usage.mjs";
import { isWindows, readText } from "./platform.ts";

/**
 * Mon 16 Nov to Tue 24 Nov 2026. v1.4.2 throughout; v1.4.3 is released on
 * Thu 19 Nov, after which v1.4.2's counts stop moving. Week 47 (16-22 Nov)
 * is full (snapshots on the 16th and the 23rd); week 48 has one day so far.
 */
const V142_STATIC = "v1.4.2,latest-mcpb.json,121\nv1.4.2,latest-npx.json,60\nv1.4.2,weekly-mcpb.json,56\nv1.4.2,weekly-npx.json,27\nv1.4.2,install-mcpb.json,33\nv1.4.2,garmin-mcp.mcpb,208";
const day = (date: string, rows: string) =>
	rows
		.trim()
		.split("\n")
		.map((r) => `${date},${r.trim()}`)
		.join("\n");
const FIXTURE = [
	"date,tag,asset,download_count",
	day("2026-11-16", "v1.4.2,latest-mcpb.json,100\nv1.4.2,latest-npx.json,50\nv1.4.2,weekly-mcpb.json,40\nv1.4.2,weekly-npx.json,20\nv1.4.2,install-mcpb.json,30\nv1.4.2,garmin-mcp.mcpb,200"),
	day("2026-11-17", "v1.4.2,latest-mcpb.json,110\nv1.4.2,latest-npx.json,55\nv1.4.2,weekly-mcpb.json,52\nv1.4.2,weekly-npx.json,26\nv1.4.2,install-mcpb.json,32\nv1.4.2,garmin-mcp.mcpb,205"),
	day("2026-11-18", "v1.4.2,latest-mcpb.json,118\nv1.4.2,latest-npx.json,59\nv1.4.2,weekly-mcpb.json,55\nv1.4.2,weekly-npx.json,27\nv1.4.2,install-mcpb.json,33\nv1.4.2,garmin-mcp.mcpb,207"),
	day("2026-11-19", V142_STATIC + "\nv1.4.3,latest-mcpb.json,6\nv1.4.3,latest-npx.json,2\nv1.4.3,weekly-mcpb.json,2\nv1.4.3,weekly-npx.json,0\nv1.4.3,install-mcpb.json,1\nv1.4.3,garmin-mcp.mcpb,4"),
	day("2026-11-20", V142_STATIC + "\nv1.4.3,latest-mcpb.json,15\nv1.4.3,latest-npx.json,6\nv1.4.3,weekly-mcpb.json,4\nv1.4.3,weekly-npx.json,1\nv1.4.3,install-mcpb.json,2\nv1.4.3,garmin-mcp.mcpb,9"),
	day("2026-11-21", V142_STATIC + "\nv1.4.3,latest-mcpb.json,22\nv1.4.3,latest-npx.json,9\nv1.4.3,weekly-mcpb.json,5\nv1.4.3,weekly-npx.json,1\nv1.4.3,install-mcpb.json,2\nv1.4.3,garmin-mcp.mcpb,10"),
	day("2026-11-22", V142_STATIC + "\nv1.4.3,latest-mcpb.json,30\nv1.4.3,latest-npx.json,13\nv1.4.3,weekly-mcpb.json,6\nv1.4.3,weekly-npx.json,2\nv1.4.3,install-mcpb.json,3\nv1.4.3,garmin-mcp.mcpb,12"),
	day("2026-11-23", V142_STATIC + "\nv1.4.3,latest-mcpb.json,39\nv1.4.3,latest-npx.json,16\nv1.4.3,weekly-mcpb.json,30\nv1.4.3,weekly-npx.json,12\nv1.4.3,install-mcpb.json,3\nv1.4.3,garmin-mcp.mcpb,13"),
	day("2026-11-24", V142_STATIC + "\nv1.4.3,latest-mcpb.json,47\nv1.4.3,latest-npx.json,20\nv1.4.3,weekly-mcpb.json,41\nv1.4.3,weekly-npx.json,15\nv1.4.3,install-mcpb.json,4\nv1.4.3,garmin-mcp.mcpb,15"),
].join("\n");

const NOW = Date.parse("2026-11-24T12:00:00Z") / 1000;

describe("npm run usage", () => {
	const report = buildReport(parseCsv(FIXTURE), { now: NOW });

	it("parses the CSV, skipping the header and blank lines", () => {
		const rows = parseCsv(`date,tag,asset,download_count\n\n2026-11-16,v1.4.2,latest-mcpb.json,100\n`);
		assert.deepEqual(rows, [{ date: "2026-11-16", tag: "v1.4.2", asset: "latest-mcpb.json", count: 100, at: Date.parse("2026-11-16T00:00:00Z") / 1000 }]);
	});

	it("DAU: the daily increase in latest-*, per type and in total, summed across releases", () => {
		assert.deepEqual(
			report.daily.map((d: any) => [d.period, d.values.mcpb, d.values.npx, d.values.cloud, d.values.total]),
			[
				["2026-11-16", 10, 5, 0, 15],
				["2026-11-17", 8, 4, 0, 12],
				["2026-11-18", 9, 3, 0, 12], // v1.4.2 +3/+1, the new v1.4.3 +6/+2
				["2026-11-19", 9, 4, 0, 13],
				["2026-11-20", 7, 3, 0, 10],
				["2026-11-21", 8, 4, 0, 12],
				["2026-11-22", 9, 3, 0, 12],
				["2026-11-23", 8, 4, 0, 12],
			],
		);
	});

	it("WAU: a release mid-week doesn't split the week", () => {
		const [w47, w48] = report.weekly.filter((w: any) => w.values);
		assert.equal(w47.period, "2026-W47");
		assert.equal(w47.status, "full");
		// v1.4.2: 56-40 and 27-20; v1.4.3 (new mid-week): 30 and 12.
		assert.deepEqual(w47.values, { mcpb: 16 + 30, npx: 7 + 12, cloud: 0, total: 65 });
		assert.equal(w48.period, "2026-W48");
		assert.equal(w48.status, "so far");
		assert.deepEqual(w48.values, { mcpb: 11, npx: 3, cloud: 0, total: 14 });
		assert.ok(report.weekly.filter((w: any) => !w.values).every((w: any) => w.period < "2026-W47"), "earlier weeks are n/a");
	});

	it(".mcpb downloads per week, across releases", () => {
		const known = report.mcpbWeekly.filter((w: any) => w.value !== undefined);
		assert.deepEqual(
			known.map((w: any) => [w.period, w.status, w.value]),
			[
				["2026-W47", "full", 8 + 13],
				["2026-W48", "so far", 2],
			],
		);
	});

	it("MAU so far for the running month; DAU/MAU n/a until a full month is in the data", () => {
		assert.deepEqual(
			report.monthly.map((m: any) => [m.period, m.status, m.values]),
			[["2026-11", "so far", { mcpb: 0, npx: 0, cloud: 0, total: 0 }]],
		);
		assert.equal(report.ratio, undefined);
	});

	it("summary line: totals across releases, latest full day/week, the month so far", () => {
		assert.deepEqual(report.summary, { mcpbDownloads: 223, installs: 37, dau: 12, wau: 65, mau: 0, labels: { mau: "so far" } });
		assert.equal(
			summaryLine(report.summary),
			"garmin-mcp: Claude Desktop extension downloaded 223 times; at least 37 installs since 1.4.2; at least 12 daily, 65 weekly and 0 monthly (so far) active users.",
		);
		const text = formatReport(report);
		assert.match(text, /^2026-W48 \(so far\)/m);
		assert.ok(text.trimEnd().endsWith(summaryLine(report.summary)));
	});

	it("a full month: MAU from monthly-*, and DAU/MAU as average DAU over MAU", () => {
		const lines = ["date,tag,asset,download_count"];
		let d = new Date("2026-11-01T00:00:00Z");
		for (let i = 0; i <= 31; i++) {
			const date = d.toISOString().slice(0, 10);
			// 2 cloud deployments check in a day; 10 were active in November (monthly 5 -> 15).
			lines.push(`${date},v1.4.2,latest-cloud.json,${2 * i}`);
			lines.push(`${date},v1.4.2,monthly-cloud.json,${date < "2026-12-01" ? 5 + Math.min(i, 10) : 15}`);
			d = new Date(d.getTime() + 86_400_000);
		}
		const r = buildReport(parseCsv(lines.join("\n")));
		const nov = r.monthly.find((m: any) => m.period === "2026-11");
		assert.equal(nov.status, "full");
		assert.deepEqual(nov.values, { mcpb: 0, npx: 0, cloud: 10, total: 10 });
		assert.equal(r.summary.mau, 10);
		assert.equal(r.ratio.period, "2026-11");
		assert.equal(r.ratio.days, 30);
		assert.equal(r.ratio.values.cloud, 0.2);
		assert.equal(r.ratio.values.mcpb, undefined, "no MAU, no ratio");
	});

	it("increase: a new release starts from 0, a deleted one never counts negative", () => {
		const snaps = snapshots(
			parseCsv("2026-11-01,v1,weekly-npx.json,10\n2026-11-01,v0,weekly-npx.json,50\n2026-11-08,v1,weekly-npx.json,12\n2026-11-08,v2,weekly-npx.json,7"),
		);
		assert.equal(increase(snaps.get("2026-11-01").counts, snaps.get("2026-11-08").counts, () => true), 2 + 7);
	});

	it("ISO weeks start on Monday", () => {
		assert.equal(mondayOf("2026-11-22"), "2026-11-16");
		assert.equal(mondayOf("2026-11-23"), "2026-11-23");
		assert.equal(mondayOf("2027-01-01"), "2026-12-28");
	});

	it("no data: says so", () => {
		assert.equal(buildReport([]), undefined);
		assert.equal(formatReport(undefined), "No rows in stats/downloads.csv yet.");
	});
});

/**
 * test/fixtures/stats-downloads.csv, Tue 17 to Tue 24 Nov 2026, with taken_at:
 * - the baseline is a manual run at 14:05 on the 17th (a partial first day);
 * - the 19th has the 00:21 scheduled run and a manual one at 09:30; the
 *   day boundary is the 00:21 one, the one closest to 00:00 UTC;
 * - v1.4.3 appears on Fri 20th's snapshot (mid-week), after which v1.4.2's
 *   counts stop moving;
 * - November and week 47 started before the baseline (part month, part week);
 * - the newest snapshot is from 00:40 on the 24th.
 */
describe("npm run usage: snapshots at real times", () => {
	const csv = readText(new URL("./fixtures/stats-downloads.csv", import.meta.url));
	const at = (iso: string) => Date.parse(iso) / 1000;
	const report = buildReport(parseCsv(csv), { now: at("2026-11-24T20:00:00Z") });

	it("a date with several snapshots: boundaries use the one closest to 00:00 UTC", () => {
		const snaps = snapshots(parseCsv(csv));
		assert.equal(snaps.get("2026-11-19").at, at("2026-11-19T00:21:00Z"), "the scheduled run, not the 09:30 manual one");
		assert.equal(snaps.get("2026-11-19").counts.get("v1.4.2\tlatest-npx.json"), 110);
	});

	it("the very latest snapshot is only the end point of the periods so far", () => {
		const v142 = "v1.4.2,latest-npx.json,116\nv1.4.2,weekly-npx.json,46\nv1.4.2,monthly-npx.json,64\nv1.4.2,install-npx.json,21\nv1.4.2,latest-mcpb.json,62\nv1.4.2,garmin-mcp.mcpb,205";
		const v143 = "v1.4.3,latest-npx.json,45\nv1.4.3,weekly-npx.json,15\nv1.4.3,monthly-npx.json,7\nv1.4.3,install-npx.json,4\nv1.4.3,latest-mcpb.json,30\nv1.4.3,garmin-mcp.mcpb,14";
		const manual = `${v142}\n${v143}`
			.split("\n")
			.map((r) => `2026-11-24,${r},2026-11-24T15:00:00Z`)
			.join("\n");
		const rows = parseCsv(`${csv}${manual}\n`);
		assert.equal(snapshots(rows).get("2026-11-24").at, at("2026-11-24T00:40:00Z"), "the 24th still starts at 00:40");
		const r = buildReport(rows, { now: at("2026-11-24T20:00:00Z") });
		assert.deepEqual(r.daily.at(-1), { period: "2026-11-23", status: "full", hours: 24 + 23 / 60, values: { mcpb: 6, npx: 9, cloud: 0, total: 15 } });
		assert.deepEqual(r.weekly.at(-1).values.total, 15 - 7, "W48 so far: to 15:00");
		assert.equal(r.monthly[0].values.total, 64 - 60 + 7, "November so far: to 15:00");
		assert.equal(r.summary.mcpbDownloads, 205 + 14);
		assert.equal(r.stale, undefined);
	});

	it("DAU: marks days whose window isn't about 24 hours as partial", () => {
		assert.deepEqual(
			report.daily.map((d: any) => [d.period, d.status, Math.round(d.hours * 10) / 10, d.values.npx, d.values.mcpb, d.values.total]),
			[
				["2026-11-17", "partial", 10.2, 4, 3, 7], // the manual 14:05 baseline
				["2026-11-18", "full", 24.1, 6, 5, 11], // to the 00:21 scheduled run; the 09:30 manual one is ignored
				["2026-11-19", "full", 24, 6 + 3, 4 + 2, 15], // v1.4.3 is new: +3 npx, +2 mcpb
				["2026-11-20", "full", 24.7, 9, 6, 15],
				["2026-11-21", "full", 23.3, 10, 7, 17],
				["2026-11-22", "full", 24, 9, 6, 15],
				["2026-11-23", "full", 24.4, 9, 6, 15],
			],
		);
	});

	it("weeks and months: partial when they began before the baseline, so far while running, summed across the release", () => {
		assert.deepEqual(
			report.weekly.map((w: any) => [w.period, w.status, w.values?.total]),
			[
				["2026-W47", "partial", 46 - 40 + 7], // from the 14:05 baseline to Monday's snapshot
				["2026-W48", "so far", 13 - 7],
			],
		);
		assert.deepEqual(
			report.mcpbWeekly.map((w: any) => [w.period, w.status, w.value]),
			[
				["2026-W47", "partial", 205 - 200 + 10],
				["2026-W48", "so far", 2],
			],
		);
		assert.deepEqual(report.monthly, [{ period: "2026-11", status: "so far", values: { mcpb: 0, npx: 64 - 60 + 6, cloud: 0, total: 10 } }]);
		assert.equal(report.ratio, undefined, "DAU/MAU needs a full month");
	});

	it("summary: the latest full day, and the week and month so far, labelled", () => {
		assert.deepEqual(report.summary, {
			mcpbDownloads: 205 + 12,
			installs: 21 + 3,
			dau: 15,
			wau: 6,
			mau: 10,
			labels: { wau: "so far", mau: "so far" },
		});
		assert.equal(
			summaryLine(report.summary),
			"garmin-mcp: Claude Desktop extension downloaded 217 times; at least 24 installs since 1.4.2; at least 15 daily, 6 weekly (so far) and 10 monthly (so far) active users.",
		);
	});

	it("only a partial day: the summary uses it, labelled", () => {
		const r = buildReport(parseCsv(csv.split("\n").filter((l) => !/^2026-11-(19|2)/.test(l)).join("\n")), { now: at("2026-11-18T12:00:00Z") });
		assert.equal(r.summary.dau, 7);
		assert.match(summaryLine(r.summary), /at least 7 daily \(partial\), 2 weekly \(so far\) and 1 monthly \(so far\) active users\.$/);
	});

	it("the header, and a warning when the newest snapshot is more than 30 hours old", () => {
		const text = formatReport(report);
		assert.match(text, /^Baseline 2026-11-17; data to 2026-11-24 \(snapshots shortly after 00:00 UTC; summed across releases\)\.$/m);
		assert.doesNotMatch(text, /Warning/);
		assert.match(text, /^2026-11-17 \(partial\)/m);
		assert.match(text, /^2026-11-18  /m, "not partial");
		assert.match(text, /^2026-W47 \(partial\)/m);
		assert.match(text, /^2026-11 \(so far\)/m);

		const stale = formatReport(buildReport(parseCsv(csv), { now: at("2026-11-25T12:00:00Z") }));
		assert.ok(
			stale.startsWith(
				"Warning: the newest snapshot was taken 2026-11-24 00:40 UTC, 35 hours ago. " +
					"The Usage stats workflow may not be running; check with: gh run list --workflow=stats.yml\n",
			),
			stale.split("\n")[0],
		);
		assert.equal(buildReport(parseCsv(csv), { now: at("2026-11-25T06:39:00Z") }).stale, undefined, "29h59m: not yet");
	});

	it("rows from before taken_at are dated by the commit that added them", () => {
		const log = [
			"2026-11-17T06:04:47Z\tDownload counts for 2026-11-17",
			"2026-11-16T10:04:45Z\tDownload counts for 2026-11-16",
			"2026-11-16T09:58:09Z\tDownload counts for 2026-11-16",
			"2026-11-18T00:17:30Z\tDownload counts for 2026-11-18T00:17:02Z",
		].join("\n");
		const times = commitTimes(log);
		assert.deepEqual([...times], [
			["2026-11-17", "2026-11-17T06:04:47Z"],
			["2026-11-16", "2026-11-16T10:04:45Z"],
		]);
		const rows = parseCsv(
			"date,tag,asset,download_count,taken_at\n2026-11-16,v1.4.2,latest-npx.json,1\n2026-11-17,v1.4.2,latest-npx.json,9\n2026-11-18,v1.4.2,latest-npx.json,20,2026-11-18T00:17:02Z\n",
			times,
		);
		assert.deepEqual(rows.map((r: any) => r.at), [at("2026-11-16T10:04:45Z"), at("2026-11-17T06:04:47Z"), at("2026-11-18T00:17:02Z")]);
		const r = buildReport(rows, { now: at("2026-11-18T01:00:00Z") });
		assert.deepEqual(r.daily.map((d: any) => [d.period, d.status]), [["2026-11-16", "partial"], ["2026-11-17", "partial"]]);
	});
});

describe("stats workflow", () => {
	const stats = readText(new URL("../.github/workflows/stats.yml", import.meta.url));

	it("runs daily at 00:17 UTC with a 06:17 back-up, and by hand; may only write contents, and only pushes the stats branch", () => {
		const crons = [...stats.matchAll(/cron: "([^"]+)"/g)].map((m) => m[1]);
		assert.deepEqual(crons, ["17 0 * * *", "17 6 * * *"]);
		assert.match(stats, /workflow_dispatch:/);
		assert.match(stats, /permissions:\n {2}contents: write # push to the stats branch\n\n/);
		const pushes = stats.match(/git push .*/g);
		assert.deepEqual(pushes, ["git push origin HEAD:refs/heads/stats"]);
		assert.match(stats, /EVENT: \$\{\{ github\.event_name \}\}/);
	});

	// The step runs on ubuntu-latest, so its script isn't tested on Windows, where
	// "bash" may be missing or be WSL without a distro.
	const skip = isWindows && "a bash script for ubuntu-latest";

	/** The "Append them" step's script, run against a scratch origin as each event would. */
	const script = (() => {
		const step = stats.slice(stats.indexOf("- name: Append them"));
		const body = step.slice(step.indexOf("run: |") + "run: |".length).split("\n").slice(1);
		return body.map((l) => l.replace(/^ {10}/, "")).join("\n");
	})();
	const sh = (cwd: string, cmd: string, env: Record<string, string> = {}) =>
		execFileSync("bash", ["-c", cmd], { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", ...env }, encoding: "utf8" });
	const dirs: string[] = [];
	after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
	function scratch() {
		const dir = mkdtempSync(join(tmpdir(), "stats-wf-"));
		dirs.push(dir);
		sh(dir, "git init -q --bare origin.git && git init -q -b main seed && cd seed && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init && git push -q ../origin.git main");
		writeFileSync(join(dir, "rows.csv"), "v1.4.2,latest-npx.json,5\nv1.4.2,weekly-npx.json,3\n");
		/** One workflow run: a fresh checkout of main, then the step. */
		const run = (event: string) => {
			const work = mkdtempSync(join(dir, "run-"));
			sh(work, `git clone -q ../origin.git . && git switch -q main`);
			return sh(work, script, { EVENT: event, RUNNER_TEMP: dir });
		};
		const csv = () => sh(dir, "git --git-dir=origin.git show stats:stats/downloads.csv");
		const commits = () => Number(sh(dir, "git --git-dir=origin.git rev-list --count stats").trim());
		return { dir, run, csv, commits };
	}

	it("a scheduled run records once per UTC day; a manual run always records another snapshot", { skip }, () => {
		const { run, csv, commits } = scratch();
		run("schedule");
		const first = csv().trim().split("\n");
		assert.equal(first[0], "date,tag,asset,download_count,taken_at");
		assert.equal(first.length, 3);
		const m = /^(\d{4}-\d{2}-\d{2}),v1\.4\.2,latest-npx\.json,5,(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}Z$/.exec(first[1]);
		assert.ok(m, first[1]);
		assert.equal(m[1], m[2], "dated by the UTC day it was taken");

		assert.match(run("schedule"), /Already have a snapshot for \d{4}-\d{2}-\d{2}; nothing to do\./, "the back-up run");
		assert.equal(commits(), 1);

		run("workflow_dispatch");
		assert.equal(csv().trim().split("\n").length, 5, "manual: a second snapshot, nothing replaced");
		assert.equal(commits(), 2);
	});

	it("moves an existing file to the new header, keeping its older four-column rows", { skip }, () => {
		const { dir, run, csv } = scratch();
		sh(
			dir,
			"git init -q -b stats old && cd old && mkdir stats && printf 'date,tag,asset,download_count\\n2026-11-16,v1.4.2,latest-npx.json,1\\n' > stats/downloads.csv " +
				"&& git add . && git -c user.name=t -c user.email=t@t commit -q -m old && git push -q ../origin.git stats",
		);
		run("schedule");
		const lines = csv().trim().split("\n");
		assert.equal(lines[0], "date,tag,asset,download_count,taken_at");
		assert.equal(lines[1], "2026-11-16,v1.4.2,latest-npx.json,1");
		assert.equal(lines.length, 4);
	});
});
