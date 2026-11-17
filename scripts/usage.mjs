#!/usr/bin/env node
// npm run usage: how many people use garmin-mcp, from GitHub's download counts.
//
// .github/workflows/stats.yml records, once a day shortly after 00:00 UTC, the
// download count of every file attached to every release, in
// stats/downloads.csv on the "stats" branch. This fetches that branch and
// works out, per install type (mcpb, npx, cloud) and in total:
//
//   DAU  daily increase in latest-<type>.json   (the once-a-day update check)
//   WAU  increase in weekly-<type>.json per ISO week
//   MAU  increase in monthly-<type>.json per calendar month
//   new installs: install-<type>.json (once ever per install)
//
// Counts are summed across all releases, because a new release mid-period
// splits that period's downloads between two tags. A snapshot dated D is
// normally taken just after 00:00 UTC, so it holds the counts up to the start
// of UTC day D, and periods line up with the clients' UTC days, ISO weeks and
// months. Each row says when it was taken (taken_at); rows from before that
// column are dated by the commit that added them. When a date has several
// snapshots (manual runs), day, week and month boundaries use the one taken
// closest to 00:00 UTC (normally the scheduled one); the very latest snapshot
// is only the end point of the periods still running ("so far").
//
// A day whose window isn't about 24 hours (a manual mid-day run, a late
// back-up run) is marked "(partial)". The running week and month count from
// their earliest snapshot, "(so far)"; an ended one that has no snapshot from
// its first morning is "(partial)". Only DAU/MAU needs a full month.
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
const HOUR = 3600;
/** A day's window counts as a full day within this many hours of 24. */
const DAY_SLACK_HOURS = 3;
/** A period's first snapshot counts as taken at its start up to this long after 00:00 UTC (the 06:17 back-up run, late). */
const ON_TIME_HOURS = 7;
/** Warn when the newest snapshot is older than this. */
const STALE_HOURS = 30;

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
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
/** "YYYY-MM-DD HH:MM UTC" */
const showTime = (seconds) => `${new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;

// ---- data -----------------------------------------------------------------------

/**
 * Rows of { date, tag, asset, count, at } from downloads.csv; `at` is when the
 * snapshot was taken (seconds). Rows without taken_at (written before it
 * existed) use `takenAt.get(date)`, the time of the commit that added them,
 * or else 00:00 UTC on their date.
 */
export function parseCsv(text, takenAt = new Map()) {
	const rows = [];
	for (const line of text.split(/\r?\n/)) {
		const [date, tag, asset, count, stamp] = line.split(",");
		if (!DATE.test(date ?? "") || !asset || !/^\d+$/.test(count ?? "")) continue; // header, blank
		const when = STAMP.test(stamp?.trim() ?? "") ? stamp.trim() : takenAt.get(date);
		const at = when ? Date.parse(when) / 1000 : toSeconds(date);
		rows.push({ date, tag, asset, count: Number(count), at });
	}
	return rows;
}

/** Every snapshot (one per workflow run): { date, at, counts: Map("tag\tasset" -> count) }, oldest first. */
export function runs(rows) {
	const byRun = new Map(); // "date\tat" -> snapshot
	for (const r of rows) {
		const key = `${r.date}\t${r.at}`;
		if (!byRun.has(key)) byRun.set(key, { date: r.date, at: r.at, counts: new Map() });
		byRun.get(key).counts.set(`${r.tag}\t${r.asset}`, r.count);
	}
	return [...byRun.values()].sort((a, b) => a.at - b.at);
}

/**
 * date -> the snapshot that marks the start of that UTC day: when a date has
 * several (manual runs), the one taken closest to 00:00 UTC.
 */
export function snapshots(rows) {
	const byDate = new Map();
	for (const snap of runs(rows)) {
		const kept = byDate.get(snap.date);
		const off = (x) => Math.abs(x.at - toSeconds(x.date));
		if (!kept || off(snap) < off(kept)) byDate.set(snap.date, snap);
	}
	return byDate;
}

/**
 * Downloads between two snapshots' counts of assets matching `pick(asset)`,
 * summed across releases. A release that appeared in between starts from 0;
 * one deleted in between is left out rather than counted as negative.
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
export function total(counts, pick) {
	let n = 0;
	for (const [key, count] of counts) if (pick(key.split("\t")[1])) n += count;
	return n;
}

const ping = (kind, type) => (asset) => {
	const m = PING.exec(asset);
	return !!m && m[1] === kind && (type === "total" || m[2] === type);
};

/** { mcpb, npx, cloud, total } for one ping kind between two snapshots, or undefined if either is missing. */
function perType(kind, a, b) {
	if (!a || !b) return undefined;
	const out = {};
	for (const t of [...TYPES, "total"]) out[t] = increase(a.counts, b.counts, ping(kind, t));
	return out;
}

// ---- the report -----------------------------------------------------------------

/**
 * The snapshots bounding a week or month [start, end): its start is the
 * snapshot dated `start` when that was taken on time, else (a partial
 * period) the earliest one inside it; its end is the snapshot dated `end`,
 * or the newest snapshot of all while the period is still running.
 * status: "full", "partial" (ended, but no snapshot from its first morning)
 * or "so far" (still running). Undefined when there's nothing to show.
 */
function span(snaps, dates, start, end, latest, newest) {
	const first = dates.find((d) => d >= start && d < end);
	if (!first) return undefined;
	const a = snaps.get(first);
	const running = end > latest;
	const b = running ? newest : snaps.get(end);
	if (running && a === b) return undefined; // only today's snapshot: nothing yet
	const onTime = first === start && a.at - toSeconds(start) <= ON_TIME_HOURS * HOUR;
	return { a, b, status: running ? "so far" : onTime ? "full" : "partial" };
}

/**
 * Everything npm run usage prints, as data. `now` (seconds) is only used for
 * the warning that the newest snapshot is old.
 */
export function buildReport(rows, { days = 14, weeks = 8, now = Date.now() / 1000 } = {}) {
	const snaps = snapshots(rows);
	const dates = [...snaps.keys()].sort();
	if (!dates.length) return undefined;
	const first = dates[0];
	const latest = dates.at(-1);
	const newest = runs(rows).at(-1); // the end point of "so far" periods, and the totals
	const age = now - newest.at;
	const stale = age > STALE_HOURS * HOUR ? { at: newest.at, hours: Math.floor(age / HOUR) } : undefined;

	// DAU: the last `days` days (a day ends at the next day's snapshot).
	const daily = [];
	for (let i = days; i >= 1; i--) {
		const day = addDays(latest, -i);
		if (day < first) continue;
		const a = snaps.get(day);
		const b = snaps.get(addDays(day, 1));
		const hours = a && b ? (b.at - a.at) / HOUR : undefined;
		const partial = hours !== undefined && Math.abs(hours - 24) > DAY_SLACK_HOURS;
		daily.push({ period: day, status: partial ? "partial" : "full", hours, values: perType("latest", a, b) });
	}

	// WAU and .mcpb downloads per ISO week.
	const weekly = [];
	const mcpbWeekly = [];
	const thisMonday = mondayOf(latest);
	for (let i = weeks - 1; i >= 0; i--) {
		const start = addDays(thisMonday, -7 * i);
		const end = addDays(start, 7);
		if (end <= first) continue;
		const label = periodKey("week", toSeconds(start));
		const w = span(snaps, dates, start, end, latest, newest);
		if (!w) {
			// No snapshot in it (the workflow wasn't running): n/a. One that started today: nothing yet.
			if (start < latest) {
				weekly.push({ period: label, status: "full", values: undefined });
				mcpbWeekly.push({ period: label, status: "full", value: undefined });
			}
			continue;
		}
		weekly.push({ period: label, status: w.status, values: perType("weekly", w.a, w.b) });
		mcpbWeekly.push({ period: label, status: w.status, value: w.b ? increase(w.a.counts, w.b.counts, (x) => x === MCPB) : undefined });
	}

	// MAU per calendar month, from the first month with data.
	const monthly = [];
	for (let start = firstOfMonth(first); start <= latest; start = nextMonth(start)) {
		const m = span(snaps, dates, start, nextMonth(start), latest, newest);
		if (m) monthly.push({ period: start.slice(0, 7), status: m.status, values: perType("monthly", m.a, m.b) });
	}

	// DAU/MAU for the last full month: average DAU over its full days / MAU.
	let ratio;
	const lastFullMonth = monthly.filter((m) => m.status === "full" && m.values).at(-1);
	if (lastFullMonth) {
		const start = `${lastFullMonth.period}-01`;
		const end = nextMonth(start);
		const dayValues = [];
		for (let d = start; d < end; d = addDays(d, 1)) {
			const a = snaps.get(d);
			const b = snaps.get(addDays(d, 1));
			if (!a || !b || Math.abs((b.at - a.at) / HOUR - 24) > DAY_SLACK_HOURS) continue;
			dayValues.push(perType("latest", a, b));
		}
		if (dayValues.length) {
			ratio = { period: lastFullMonth.period, days: dayValues.length, values: {} };
			for (const t of [...TYPES, "total"]) {
				const avg = dayValues.reduce((s, v) => s + v[t], 0) / dayValues.length;
				ratio.values[t] = lastFullMonth.values[t] ? avg / lastFullMonth.values[t] : undefined;
			}
		}
	}

	// The summary: the latest full period, else the running ("so far") or partial one, labelled.
	const pick = (list, fallback) => {
		const known = list.filter((p) => p.values);
		const p = known.filter((x) => x.status === "full").at(-1) ?? known.filter((x) => fallback.includes(x.status)).at(-1);
		return p ? { value: p.values.total, label: p.status === "full" ? undefined : p.status } : { value: undefined };
	};
	const dau = pick(daily, ["partial"]);
	const wau = pick(weekly, ["so far"]);
	const mau = pick(monthly, ["so far"]);
	const lastCounts = newest.counts;
	const summary = {
		mcpbDownloads: total(lastCounts, (a) => a === MCPB),
		installs: total(lastCounts, (a) => /^install-(mcpb|npx|cloud)\.json$/.test(a)),
		dau: dau.value,
		wau: wau.value,
		mau: mau.value,
		labels: Object.fromEntries(
			[
				["dau", dau.label],
				["wau", wau.label],
				["mau", mau.label],
			].filter(([, l]) => l),
		),
	};
	return { first, latest, stale, daily, weekly, monthly, mcpbWeekly, ratio, summary };
}

const show = (n) => (n === undefined ? "n/a" : String(n));
const tag = (label) => (label ? ` (${label})` : "");
const periodLabel = (p) => `${p.period}${p.status === "full" ? "" : ` (${p.status})`}`;

export function summaryLine(s) {
	const l = s.labels ?? {};
	return (
		`garmin-mcp: Claude Desktop extension downloaded ${show(s.mcpbDownloads)} times; ` +
		`at least ${show(s.installs)} installs since 1.4.2; ` +
		`at least ${show(s.dau)} daily${tag(l.dau)}, ${show(s.wau)} weekly${tag(l.wau)} and ${show(s.mau)} monthly${tag(l.mau)} active users.`
	);
}

function table(title, list) {
	const head = ["", ...TYPES, "total"];
	const lines = list.map((p) => [periodLabel(p), ...[...TYPES, "total"].map((t) => show(p.values?.[t]))]);
	const widths = head.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
	const fmt = (cells) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");
	return [title, fmt(head), ...lines.map(fmt)].join("\n");
}

export function formatReport(r) {
	if (!r) return "No rows in stats/downloads.csv yet.";
	const out = [];
	if (r.stale) {
		out.push(
			`Warning: the newest snapshot was taken ${showTime(r.stale.at)}, ${r.stale.hours} hours ago. ` +
				"The Usage stats workflow may not be running; check with: gh run list --workflow=stats.yml",
			"",
		);
	}
	out.push(`Baseline ${r.first}; data to ${r.latest} (snapshots shortly after 00:00 UTC; summed across releases).`, "");
	out.push(table("Daily active (latest-*.json per day, last 14 days; partial = window not about 24 hours)", r.daily), "");
	out.push(table("Weekly active (weekly-*.json per ISO week)", r.weekly), "");
	out.push(table("Monthly active (monthly-*.json per month)", r.monthly), "");
	if (r.ratio) {
		const pct = (v) => (v === undefined ? "n/a" : `${Math.round(v * 100)}%`);
		out.push(`DAU/MAU for ${r.ratio.period} (average DAU over ${r.ratio.days} days / MAU): ` + [...TYPES, "total"].map((t) => `${t} ${pct(r.ratio.values[t])}`).join(", "));
	} else out.push("DAU/MAU: n/a (no full month yet)");
	out.push("");
	out.push("garmin-mcp.mcpb downloads per ISO week");
	const labels = r.mcpbWeekly.map(periodLabel);
	const width = Math.max(0, ...labels.map((l) => l.length));
	r.mcpbWeekly.forEach((w, i) => out.push(`${labels[i].padEnd(width)}  ${show(w.value).padStart(5)}`));
	out.push("", summaryLine(r.summary));
	return out.join("\n");
}

// ---- running it -----------------------------------------------------------------

/** Commit time per date for rows written before taken_at ("Download counts for YYYY-MM-DD" commits). */
export function commitTimes(log) {
	const times = new Map();
	for (const line of log.split("\n")) {
		const [when, subject] = line.split("\t");
		const date = /^Download counts for (\d{4}-\d{2}-\d{2})$/.exec(subject ?? "")?.[1];
		// git log lists the newest first: keep the latest commit for each date.
		if (date && !times.has(date) && !Number.isNaN(Date.parse(when))) times.set(date, new Date(when).toISOString().replace(/\.\d{3}Z$/, "Z"));
	}
	return times;
}

async function readStats() {
	const flag = process.argv.indexOf("--file");
	if (flag !== -1) return { csv: readFileSync(process.argv[flag + 1], "utf8"), takenAt: new Map() };
	const git = promisify(execFile);
	try {
		// An explicit refspec, so origin/stats is updated even when the clone's fetch config leaves it out.
		await git("git", ["fetch", "--quiet", "origin", "+refs/heads/stats:refs/remotes/origin/stats"]);
	} catch (err) {
		throw new Error(
			`couldn't fetch the stats branch from origin (${err.stderr?.trim() || err.message}). ` +
				"It's created by the Usage stats workflow's first run: GitHub → Actions → Usage stats → Run workflow.",
		);
	}
	const { stdout: csv } = await git("git", ["show", "origin/stats:stats/downloads.csv"], { maxBuffer: 256 * 1024 * 1024 });
	const { stdout: log } = await git("git", ["log", "--format=%cI%x09%s", "origin/stats"], { maxBuffer: 64 * 1024 * 1024 });
	return { csv, takenAt: commitTimes(log) };
}

async function main() {
	try {
		const { csv, takenAt } = await readStats();
		console.log(formatReport(buildReport(parseCsv(csv, takenAt))));
	} catch (err) {
		console.error(`npm run usage: ${err instanceof Error ? err.message : String(err)}`);
		process.exitCode = 1;
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
