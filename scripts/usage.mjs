#!/usr/bin/env node
// npm run usage: how many people use garmin-mcp, from GitHub's download counts.
//
// .github/workflows/stats.yml records, once a day at 00:05 UTC, the download
// count of every file attached to every release, in stats/downloads.csv on the
// "stats" branch. This fetches that branch and works out, per install type
// (mcpb, npx, cloud) and in total:
//
//   DAU  daily increase in latest-<type>.json   (the once-a-day update check)
//   WAU  increase in weekly-<type>.json per ISO week
//   MAU  increase in monthly-<type>.json per calendar month
//   new installs: install-<type>.json (once ever per install)
//
// Counts are summed across all releases, because a new release mid-period
// splits that period's downloads between two tags. Each snapshot is taken
// just after midnight UTC, so a snapshot dated D holds the counts up to the
// start of UTC day D, and periods line up with the clients' UTC days, ISO
// weeks and months.
//
//   npm run usage                 # fetch origin/stats and print the report
//   npm run usage -- --file x.csv # read a local CSV instead
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { periodKey } from "../src/update.ts";

export const TYPES = ["mcpb", "npx", "cloud"];
const PING = /^(latest|weekly|monthly|install)-(mcpb|npx|cloud)\.json$/;
const MCPB = "garmin-mcp.mcpb";

// ---- dates (UTC, YYYY-MM-DD) ----------------------------------------------------

const toSeconds = (date) => Date.parse(`${date}T00:00:00Z`) / 1000;
export function addDays(date, n) {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + n);
	return d.toISOString().slice(0, 10);
}
/** The Monday starting date's ISO week. */
export function mondayOf(date) {
	const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
	return addDays(date, -((dow + 6) % 7));
}
const firstOfMonth = (date) => `${date.slice(0, 7)}-01`;
function nextMonth(first) {
	const d = new Date(`${first}T00:00:00Z`);
	d.setUTCMonth(d.getUTCMonth() + 1);
	return d.toISOString().slice(0, 10);
}

// ---- data -----------------------------------------------------------------------

/** Rows of { date, tag, asset, count } from downloads.csv. */
export function parseCsv(text) {
	const rows = [];
	for (const line of text.split(/\r?\n/)) {
		const [date, tag, asset, count] = line.split(",");
		if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "") || !asset || !/^\d+$/.test(count ?? "")) continue; // header, blank
		rows.push({ date, tag, asset, count: Number(count) });
	}
	return rows;
}

/** date -> Map("tag\tasset" -> count), one per day the workflow ran. */
export function snapshots(rows) {
	const byDate = new Map();
	for (const r of rows) {
		if (!byDate.has(r.date)) byDate.set(r.date, new Map());
		byDate.get(r.date).set(`${r.tag}\t${r.asset}`, r.count);
	}
	return byDate;
}

/**
 * Downloads between two snapshots of assets matching `pick(asset)`, summed
 * across releases. A release that appeared in between starts from 0; one
 * deleted in between is left out rather than counted as negative.
 */
export function increase(start, end, pick) {
	let n = 0;
	for (const [key, count] of end) {
		const asset = key.split("\t")[1];
		if (!pick(asset)) continue;
		n += Math.max(0, count - (start.get(key) ?? 0));
	}
	return n;
}

/** Total so far of assets matching `pick`, across releases. */
export function total(snap, pick) {
	let n = 0;
	for (const [key, count] of snap) if (pick(key.split("\t")[1])) n += count;
	return n;
}

const ping = (kind, type) => (asset) => {
	const m = PING.exec(asset);
	return !!m && m[1] === kind && (type === "total" || m[2] === type);
};

/** { mcpb, npx, cloud, total } for one ping kind between two snapshots, or undefined if either is missing. */
function perType(snaps, kind, from, to) {
	const a = snaps.get(from);
	const b = snaps.get(to);
	if (!a || !b) return undefined;
	const out = {};
	for (const t of [...TYPES, "total"]) out[t] = increase(a, b, ping(kind, t));
	return out;
}

// ---- the report -----------------------------------------------------------------

/**
 * Everything npm run usage prints, as data. A period is "full" when there's a
 * snapshot on its first day and on the day after it ends; the period still
 * running is given "so far" (to the latest snapshot) when its start is there.
 */
export function buildReport(rows, { days = 14, weeks = 8 } = {}) {
	const snaps = snapshots(rows);
	const dates = [...snaps.keys()].sort();
	if (!dates.length) return undefined;
	const first = dates[0];
	const latest = dates.at(-1);

	// DAU: the last `days` full days (a day ends at the next day's snapshot).
	const daily = [];
	for (let i = days; i >= 1; i--) {
		const day = addDays(latest, -i);
		if (day < first) continue;
		daily.push({ period: day, full: true, values: perType(snaps, "latest", day, addDays(day, 1)) });
	}

	// WAU and .mcpb downloads per ISO week.
	const weekly = [];
	const mcpbWeekly = [];
	const thisMonday = mondayOf(latest);
	for (let i = weeks - 1; i >= 0; i--) {
		const start = addDays(thisMonday, -7 * i);
		const end = addDays(start, 7);
		if (end <= first) continue;
		const full = end <= latest;
		if (!full && start >= latest) continue; // started today: nothing to show yet
		const to = full ? end : latest;
		const label = periodKey("week", toSeconds(start));
		weekly.push({ period: label, full, values: perType(snaps, "weekly", start, to) });
		const a = snaps.get(start);
		const b = snaps.get(to);
		mcpbWeekly.push({ period: label, full, value: a && b ? increase(a, b, (x) => x === MCPB) : undefined });
	}

	// MAU per calendar month, from the first month with data.
	const monthly = [];
	for (let start = firstOfMonth(first); start <= latest; start = nextMonth(start)) {
		const end = nextMonth(start);
		const full = end <= latest;
		if (!full && start >= latest) continue;
		const to = full ? end : latest;
		monthly.push({ period: start.slice(0, 7), full, values: perType(snaps, "monthly", start, to) });
	}

	// DAU/MAU for the last full month with an MAU: average DAU over its days / MAU.
	let ratio;
	const lastFullMonth = monthly.filter((m) => m.full && m.values).at(-1);
	if (lastFullMonth) {
		const start = `${lastFullMonth.period}-01`;
		const end = nextMonth(start);
		const dayValues = [];
		for (let d = start; d < end; d = addDays(d, 1)) {
			const v = perType(snaps, "latest", d, addDays(d, 1));
			if (v) dayValues.push(v);
		}
		if (dayValues.length) {
			ratio = { period: lastFullMonth.period, days: dayValues.length, values: {} };
			for (const t of [...TYPES, "total"]) {
				const avg = dayValues.reduce((s, v) => s + v[t], 0) / dayValues.length;
				ratio.values[t] = lastFullMonth.values[t] ? avg / lastFullMonth.values[t] : undefined;
			}
		}
	}

	const lastSnap = snaps.get(latest);
	const lastFull = (list) => list.filter((p) => p.full && p.values).at(-1);
	const summary = {
		mcpbDownloads: total(lastSnap, (a) => a === MCPB),
		installs: total(lastSnap, (a) => /^install-(mcpb|npx|cloud)\.json$/.test(a)),
		dau: lastFull(daily)?.values.total,
		wau: lastFull(weekly)?.values.total,
		mau: lastFull(monthly)?.values.total,
	};
	return { first, latest, daily, weekly, monthly, mcpbWeekly, ratio, summary };
}

const show = (n) => (n === undefined ? "n/a" : String(n));

export function summaryLine(s) {
	return (
		`garmin-mcp: Claude Desktop extension downloaded ${show(s.mcpbDownloads)} times; ` +
		`at least ${show(s.installs)} installs since 1.4.2; ` +
		`at least ${show(s.dau)} daily, ${show(s.wau)} weekly and ${show(s.mau)} monthly active users.`
	);
}

function table(title, list) {
	const head = ["", ...TYPES, "total"];
	const lines = list.map((p) => [
		p.full ? p.period : `${p.period} (so far)`,
		...[...TYPES, "total"].map((t) => show(p.values?.[t])),
	]);
	const widths = head.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
	const fmt = (cells) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");
	return [title, fmt(head), ...lines.map(fmt)].join("\n");
}

export function formatReport(r) {
	if (!r) return "No rows in stats/downloads.csv yet.";
	const out = [`Download counts from ${r.first} to ${r.latest} (snapshots just after 00:00 UTC; summed across releases).`, ""];
	out.push(table("Daily active (latest-*.json per day, last 14 days)", r.daily), "");
	out.push(table("Weekly active (weekly-*.json per ISO week)", r.weekly), "");
	out.push(table("Monthly active (monthly-*.json per month)", r.monthly), "");
	if (r.ratio) {
		const pct = (v) => (v === undefined ? "n/a" : `${Math.round(v * 100)}%`);
		out.push(`DAU/MAU for ${r.ratio.period} (average DAU over ${r.ratio.days} days / MAU): ` + [...TYPES, "total"].map((t) => `${t} ${pct(r.ratio.values[t])}`).join(", "));
	} else out.push("DAU/MAU: n/a (no full month yet)");
	out.push("");
	out.push("garmin-mcp.mcpb downloads per ISO week");
	const labels = r.mcpbWeekly.map((w) => (w.full ? w.period : `${w.period} (so far)`));
	const width = Math.max(0, ...labels.map((l) => l.length));
	r.mcpbWeekly.forEach((w, i) => out.push(`${labels[i].padEnd(width)}  ${show(w.value).padStart(5)}`));
	out.push("", summaryLine(r.summary));
	return out.join("\n");
}

// ---- running it -----------------------------------------------------------------

async function readStats() {
	const flag = process.argv.indexOf("--file");
	if (flag !== -1) return readFileSync(process.argv[flag + 1], "utf8");
	const git = promisify(execFile);
	try {
		await git("git", ["fetch", "--quiet", "origin", "stats"]);
	} catch (err) {
		throw new Error(
			`couldn't fetch the stats branch from origin (${err.stderr?.trim() || err.message}). ` +
				"It's created by the Usage stats workflow's first run: GitHub → Actions → Usage stats → Run workflow.",
		);
	}
	const { stdout } = await git("git", ["show", "origin/stats:stats/downloads.csv"], { maxBuffer: 256 * 1024 * 1024 });
	return stdout;
}

async function main() {
	try {
		console.log(formatReport(buildReport(parseCsv(await readStats()))));
	} catch (err) {
		console.error(`npm run usage: ${err instanceof Error ? err.message : String(err)}`);
		process.exitCode = 1;
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
