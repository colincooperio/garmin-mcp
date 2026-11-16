import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
// @ts-expect-error: plain .mjs script without type declarations
import { buildReport, formatReport, increase, mondayOf, parseCsv, snapshots, summaryLine } from "../scripts/usage.mjs";

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

describe("npm run usage", () => {
	const report = buildReport(parseCsv(FIXTURE));

	it("parses the CSV, skipping the header and blank lines", () => {
		const rows = parseCsv(`date,tag,asset,download_count\n\n2026-11-16,v1.4.2,latest-mcpb.json,100\n`);
		assert.deepEqual(rows, [{ date: "2026-11-16", tag: "v1.4.2", asset: "latest-mcpb.json", count: 100 }]);
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
		assert.equal(w47.full, true);
		// v1.4.2: 56-40 and 27-20; v1.4.3 (new mid-week): 30 and 12.
		assert.deepEqual(w47.values, { mcpb: 16 + 30, npx: 7 + 12, cloud: 0, total: 65 });
		assert.equal(w48.period, "2026-W48");
		assert.equal(w48.full, false, "the running week is 'so far'");
		assert.deepEqual(w48.values, { mcpb: 11, npx: 3, cloud: 0, total: 14 });
		assert.ok(report.weekly.filter((w: any) => !w.values).every((w: any) => w.period < "2026-W47"), "earlier weeks are n/a");
	});

	it(".mcpb downloads per week, across releases", () => {
		const known = report.mcpbWeekly.filter((w: any) => w.value !== undefined);
		assert.deepEqual(
			known.map((w: any) => [w.period, w.full, w.value]),
			[
				["2026-W47", true, 8 + 13],
				["2026-W48", false, 2],
			],
		);
	});

	it("MAU and DAU/MAU: n/a until a full month is in the data", () => {
		assert.deepEqual(report.monthly.map((m: any) => [m.period, m.full, m.values]), [["2026-11", false, undefined]]);
		assert.equal(report.ratio, undefined);
	});

	it("summary line: totals across releases, latest full day/week, n/a for a missing month", () => {
		assert.deepEqual(report.summary, { mcpbDownloads: 223, installs: 37, dau: 12, wau: 65, mau: undefined });
		assert.equal(
			summaryLine(report.summary),
			"garmin-mcp: Claude Desktop extension downloaded 223 times; at least 37 installs since 1.4.2; at least 12 daily, 65 weekly and n/a monthly active users.",
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
		assert.equal(nov.full, true);
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
		assert.equal(increase(snaps.get("2026-11-01"), snaps.get("2026-11-08"), () => true), 2 + 7);
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

describe("stats workflow", () => {
	const stats = readFileSync(new URL("../.github/workflows/stats.yml", import.meta.url), "utf8");

	it("runs daily at 00:05 UTC and by hand, may only write contents, and only pushes the stats branch", () => {
		assert.match(stats, /cron: "5 0 \* \* \*"/);
		assert.match(stats, /workflow_dispatch:/);
		assert.match(stats, /permissions:\n {2}contents: write # push to the stats branch\n\n/);
		const pushes = stats.match(/git push .*/g);
		assert.deepEqual(pushes, ["git push origin HEAD:refs/heads/stats"]);
		assert.match(stats, /stats\/downloads\.csv/);
		assert.match(stats, /"date,tag,asset,download_count"/);
	});
});
