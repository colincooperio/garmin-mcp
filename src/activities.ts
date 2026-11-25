/**
 * Server-side trimming for activity lists. Garmin's search endpoint can't
 * select fields, and each activity carries 100+ of them, so a few months of
 * runs blows past the tool output cap. These helpers shrink the payload in the
 * Worker before it reaches the model.
 */

import { GarminApiError } from "./garmin.ts";
import { WEEK_ORDER, weekday, weekStart } from "./periods.ts";
import { addDays } from "./ranges.ts";
import { localStamp } from "./times.ts";
import { num, paceFrom, type Raw, round, typeKeyOf } from "./util.ts";

/** Fields kept in compact mode. Units are Garmin's: metres, seconds, m/s. */
export const COMPACT_FIELDS = [
	"activityId",
	"activityName",
	"startTimeLocal",
	"distance",
	"duration",
	"movingDuration",
	"elevationGain",
	"averageSpeed",
	"maxSpeed",
	"averageHR",
	"maxHR",
	"calories",
	"averageRunningCadenceInStepsPerMinute",
	"avgPower",
	"aerobicTrainingEffect",
	"anaerobicTrainingEffect",
	"activityTrainingLoad",
	"vO2MaxValue",
] as const;

/** One activity reduced to the fields that matter for most questions; nulls dropped. */
export function compactActivity(a: Raw): Raw {
	const out: Raw = {};
	for (const f of COMPACT_FIELDS) {
		const v = a[f];
		if (v !== null && v !== undefined && v !== "") out[f] = v;
	}
	if (out.startTimeLocal !== undefined) out.startTimeLocal = localStamp(out.startTimeLocal) ?? out.startTimeLocal;
	const type = typeKeyOf(a, "activityType");
	if (type) out.type = type;
	const event = typeKeyOf(a, "eventType");
	if (event && event !== "uncategorized") out.event = event;
	return out;
}

/** Parent type keys. Garmin answers 400 to any of these as activitySubType. */
const PARENT_TYPES: ReadonlySet<string> = new Set(["running", "cycling", "swimming", "walking", "hiking", "fitness_equipment"]);

/**
 * Subtype keys and their parent types. Garmin answers 400 to a subtype in
 * activityType, or under the wrong parent, but takes a subtype on its own.
 * Each was checked against the live API; keys not listed are passed through
 * as given.
 */
export const ACTIVITY_SUBTYPES: ReadonlyMap<string, string> = new Map(
	Object.entries({
		fitness_equipment: ["strength_training", "yoga", "pilates", "hiit", "elliptical", "stair_climbing", "indoor_cardio", "indoor_rowing"],
		water_sports: ["rowing"],
		running: ["trail_running", "treadmill_running", "track_running", "indoor_running", "virtual_run", "street_running", "ultra_run"],
		cycling: [
			"road_biking",
			"indoor_cycling",
			"virtual_ride",
			"mountain_biking",
			"gravel_cycling",
			"cyclocross",
			"e_bike_fitness",
			"e_bike_mountain",
		],
		swimming: ["lap_swimming", "open_water_swimming"],
		walking: ["casual_walking", "speed_walking"],
	}).flatMap(([parent, subs]) => subs.map((sub): [string, string] => [sub, parent])),
);

/** Plausible keys Garmin doesn't have (400 as type or subtype), and what it calls them. */
const SUBTYPE_ALIASES: Record<string, string> = { road_cycling: "road_biking" };

const garminKey = (key: string | undefined) => (key !== undefined && Object.hasOwn(SUBTYPE_ALIASES, key) ? SUBTYPE_ALIASES[key] : key);

/**
 * The activityType / activitySubType search parameters for what was asked. A
 * subtype given as the type moves to activitySubType, without a parent, since
 * a subtype is enough. An explicit subtype wins over one given as the type.
 * Combinations Garmin is known to reject throw, naming the valid form.
 */
export function activityTypeParams(type?: string, subtype?: string): { activityType?: string; activitySubType?: string } {
	const t = garminKey(type);
	const sub = garminKey(subtype);
	if (sub !== undefined && PARENT_TYPES.has(sub)) {
		throw new GarminApiError(`${sub} is a type, not a subtype; pass it as activity_type, without activity_subtype.`);
	}
	if (t !== undefined && ACTIVITY_SUBTYPES.has(t)) return { activityType: undefined, activitySubType: sub ?? t };
	const parent = sub === undefined ? undefined : ACTIVITY_SUBTYPES.get(sub);
	if (t !== undefined && PARENT_TYPES.has(t) && parent !== undefined && parent !== t) {
		throw new GarminApiError(
			`${sub} is not a subtype of ${t}. Pass activity_subtype ${sub} on its own, or with activity_type ${parent}.`,
		);
	}
	return { activityType: t, activitySubType: sub };
}

/** Replaces Garmin's bare 400 for a type or subtype key we don't know. */
export function explainTypeError(err: unknown, params: Record<string, unknown>): unknown {
	const { activityType: t, activitySubType: sub } = params;
	if (!(err instanceof GarminApiError) || err.status !== 400 || (!t && !sub)) return err;
	const given = [t && `activity_type ${t}`, sub && `activity_subtype ${sub}`].filter(Boolean).join(" with ");
	return new GarminApiError(
		`Garmin rejected this search (HTTP 400), most likely because it doesn't accept ${given}. ` +
			`activity_type takes a parent type (${[...PARENT_TYPES].join(", ")}); a narrower sport, e.g. strength_training or trail_running, ` +
			"goes in activity_subtype on its own or under its own parent.",
		400,
	);
}

export type GroupBy = "week" | "month" | "weekday" | "total";

function bucketKey(a: Raw, groupBy: GroupBy): string {
	const date = String(a.startTimeLocal ?? "").slice(0, 10);
	if (groupBy === "total" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return "total";
	if (groupBy === "weekday") return weekday(date);
	return groupBy === "month" ? date.slice(0, 7) : weekStart(date);
}

/**
 * Totals and averages per period and activity type. Average speed is total
 * distance over total moving time (falling back to duration), so long runs
 * weigh more than short ones, which is what "my average pace" usually means.
 */
export function summarizeActivities(activities: Raw[], groupBy: GroupBy) {
	type Acc = {
		period: string;
		type: string;
		count: number;
		dist: number;
		time: number;
		timedDist: number;
		elev: number;
		hrSum: number;
		hrTime: number;
		longest: number;
		fastest: number;
		load: number;
		zones: number[];
	};
	const groups = new Map<string, Acc>();

	for (const a of activities) {
		const period = bucketKey(a, groupBy);
		const type = typeKeyOf(a, "activityType") ?? "unknown";
		const k = `${period}|${type}`;
		let g = groups.get(k);
		if (!g) {
			g = {
				period,
				type,
				count: 0,
				dist: 0,
				time: 0,
				timedDist: 0,
				elev: 0,
				hrSum: 0,
				hrTime: 0,
				longest: 0,
				fastest: 0,
				load: 0,
				zones: [0, 0, 0, 0, 0],
			};
			groups.set(k, g);
		}
		const dist = num(a.distance) ?? 0;
		const time = num(a.movingDuration) ?? num(a.duration) ?? 0;
		g.count++;
		g.dist += dist;
		if (dist > 0 && time > 0) {
			g.time += time;
			g.timedDist += dist;
			g.fastest = Math.max(g.fastest, dist / time);
		}
		g.elev += num(a.elevationGain) ?? 0;
		const hr = num(a.averageHR);
		if (hr && time > 0) {
			g.hrSum += hr * time;
			g.hrTime += time;
		}
		g.longest = Math.max(g.longest, dist);
		g.load += num(a.activityTrainingLoad) ?? 0;
		for (let z = 0; z < 5; z++) g.zones[z]! += num(a[`hrTimeInZone_${z + 1}`]) ?? 0;
	}

	const order = (p: string) => (groupBy === "weekday" ? WEEK_ORDER.indexOf(p).toString() : p);
	return [...groups.values()]
		.sort((x, y) => order(x.period).localeCompare(order(y.period)) || x.type.localeCompare(y.type))
		.map((g) => {
			const speed = g.time > 0 ? g.timedDist / g.time : 0; // m/s
			const row: Raw = {
				period: g.period,
				type: g.type,
				count: g.count,
				distance_km: round(g.dist / 1000, 2),
				distance_mi: round(g.dist / 1609.344, 2),
				moving_time_h: round(g.time / 3600, 2),
				elevation_gain_m: Math.round(g.elev),
				longest_km: round(g.longest / 1000, 2),
			};
			if (speed > 0) {
				row.avg_speed_kmh = round(speed * 3.6);
				row.avg_pace_per_km = paceFrom(speed, 1000);
				row.avg_pace_per_mi = paceFrom(speed, 1609.344);
				row.fastest_avg_pace_per_km = paceFrom(g.fastest, 1000);
			}
			if (g.hrTime > 0) row.avg_hr = Math.round(g.hrSum / g.hrTime);
			if (g.load > 0) row.training_load = Math.round(g.load);
			const zoneTotal = g.zones.reduce((a, b) => a + b, 0);
			if (zoneTotal > 0) {
				row.hr_zone_minutes = g.zones.map((z) => Math.round(z / 60));
				row.hr_zone_pct = g.zones.map((z) => Math.round((z / zoneTotal) * 100));
			}
			return row;
		});
}

/**
 * Ways to score one activity's load, best first. The acute:chronic ratio is
 * only meaningful if one measure is used across the whole window, so the
 * first measure available for (nearly) every activity wins.
 */
const LOAD_METHODS: { method: string; label: string; score: (a: Raw) => number | undefined }[] = [
	{
		method: "garmin_training_load",
		label: "Garmin's per-activity training load (EPOC-based)",
		score: (a) => num(a.activityTrainingLoad),
	},
	{
		method: "hr_zone_trimp",
		label: "heart-rate zone load (Edwards TRIMP: minutes in zone x zone number)",
		score: (a) => {
			let total = 0;
			let seen = false;
			for (let z = 1; z <= 5; z++) {
				const secs = num(a[`hrTimeInZone_${z}`]);
				if (secs === undefined) continue;
				seen = true;
				total += (secs / 60) * z;
			}
			return seen && total > 0 ? total : undefined;
		},
	},
	{
		method: "moving_minutes",
		label: "moving minutes (no heart-rate or load data; ignores intensity)",
		score: (a) => {
			const secs = num(a.movingDuration) ?? num(a.duration);
			return secs && secs > 0 ? secs / 60 : undefined;
		},
	},
];

/** Share of activities a method must cover to be used; the rest count as zero. */
const LOAD_COVERAGE = 0.9;

type LoadMethod = (typeof LOAD_METHODS)[number];

/** The best load measure that (nearly) every activity has, so one measure is used throughout. */
function chooseLoadMethod(activities: Raw[]): LoadMethod {
	return (
		LOAD_METHODS.find((m) => activities.filter((a) => m.score(a) !== undefined).length >= activities.length * LOAD_COVERAGE) ??
		LOAD_METHODS.at(-1)!
	);
}

/** Above this acute:chronic ratio a period is flagged. */
export const RATIO_FLAG = 1.3;
/** A week-on-week (or month-on-month) load rise above this percentage is flagged. */
export const JUMP_FLAG_PCT = 30;

/** The common sports-science reading of the acute:chronic ratio (0.8-1.3 is the usual "sweet spot"). */
export function loadBand(ratio: number): string {
	return ratio < 0.8
		? "below usual (detraining or recovery week)"
		: ratio <= RATIO_FLAG
			? "in usual range"
			: ratio <= 1.5
				? "elevated"
				: "spike (high injury-risk zone)";
}

const dateOf = (a: Raw) => String(a.startTimeLocal ?? "").slice(0, 10);

/**
 * Acute:chronic workload ratio: the last 7 days' load against the average
 * week of the last 28. Computed here because Garmin's own Training Status
 * isn't in the Personal API. Uses Garmin's per-activity load when the watch
 * records it, else heart-rate zone time, else moving minutes, and says which.
 * Bands follow the common sports-science reading (0.8-1.3 is the usual
 * "sweet spot"); they apply to any load measure used consistently.
 */
export function trainingLoadRatio(activities: Raw[], date: string) {
	const from28 = addDays(date, -27);
	const from7 = addDays(date, -6);
	const inWindow = activities.filter((a) => {
		const d = dateOf(a);
		return d >= from28 && d <= date;
	});
	if (!inWindow.length) return { note: "no activities in the last 28 days" };

	const chosen = chooseLoadMethod(inWindow);
	let acute = 0;
	let chronic = 0;
	let missing = 0;
	for (const a of inWindow) {
		const load = chosen.score(a);
		if (load === undefined) {
			missing++;
			continue;
		}
		chronic += load;
		if (dateOf(a) >= from7) acute += load;
	}
	const weekly = chronic / 4;
	const ratio = weekly > 0 ? round(acute / weekly, 2) : undefined;
	return {
		acute_7d: Math.round(acute),
		chronic_weekly_avg_28d: Math.round(weekly),
		ratio,
		band: ratio === undefined ? undefined : loadBand(ratio),
		method: chosen.method,
		activities_counted: inWindow.length - missing,
		activities_without_value: missing || undefined,
		source: `computed from ${chosen.label}; not Garmin's Training Status`,
	};
}

/** How the 28 days before the range came back: fetched, fetched but empty, or failed. */
export type LeadIn = "ok" | "empty" | "unavailable";

/**
 * Load per week or month over [start, end], with the acute:chronic ratio at
 * the end of each period and the change from the previous period. Expects
 * activities from 28 days before `start` (the lead-in) so the first periods'
 * ratios have a full chronic window. Partial periods (a week cut by the range,
 * or the current week) get no change figure, since they'd compare unlike
 * spans. Flags ratios above 1.3 and rises over 30%.
 */
export function loadTimeline(activities: Raw[], start: string, end: string, groupBy: "week" | "month", leadIn: LeadIn) {
	const from = addDays(start, -28);
	const window = activities.filter((a) => {
		const d = dateOf(a);
		return d >= from && d <= end;
	});
	if (!window.some((a) => dateOf(a) >= start)) return undefined;
	const method = chooseLoadMethod(window);
	const daily = new Map<string, number>();
	for (const a of window) {
		const v = method.score(a);
		if (v !== undefined) daily.set(dateOf(a), (daily.get(dateOf(a)) ?? 0) + v);
	}
	const sum = (a: string, b: string) => {
		let t = 0;
		for (const [d, v] of daily) if (d >= a && d <= b) t += v;
		return t;
	};
	/** Lead-in dates are usable unless the lead-in fetch failed. */
	const known = (d: string) => d >= start || (leadIn !== "unavailable" && d >= from);

	const periods: { label: string; from: string; to: string; full: boolean }[] = [];
	if (groupBy === "week") {
		for (let p = weekStart(start); p <= end; p = addDays(p, 7)) {
			const last = addDays(p, 6);
			periods.push({ label: p, from: p < start ? start : p, to: last > end ? end : last, full: p >= start && last <= end });
		}
	} else {
		for (let p = `${start.slice(0, 7)}-01`; p <= end; p = nextMonth(p)) {
			const last = addDays(nextMonth(p), -1);
			periods.push({ label: p.slice(0, 7), from: p < start ? start : p, to: last > end ? end : last, full: p >= start && last <= end });
		}
	}

	const unit = groupBy === "week" ? "week" : "month";
	let prev: { load: number; full: boolean } | undefined;
	if (groupBy === "week" && periods[0]?.full && known(addDays(periods[0].from, -7))) {
		prev = { load: sum(addDays(periods[0].from, -7), addDays(periods[0].from, -1)), full: true };
	}
	let partialRatios = 0;
	const rows = periods.map((p) => {
		const load = sum(p.from, p.to);
		const row: Raw = { period: p.label, load: Math.round(load) };
		if (!p.full) row.partial = true;
		if (p.full && prev?.full && prev.load > 0) row.change_pct = Math.round((load / prev.load - 1) * 100);
		const chronicFrom = addDays(p.to, -27);
		if (known(chronicFrom)) {
			const weekly = sum(chronicFrom, p.to) / 4;
			if (weekly > 0) {
				const ratio = round(sum(addDays(p.to, -6), p.to) / weekly, 2);
				row.ratio = ratio;
				const band = loadBand(ratio);
				if (band !== "in usual range") row.band = band;
			}
		} else partialRatios++;
		const flags: string[] = [];
		if (typeof row.ratio === "number" && row.ratio > RATIO_FLAG) flags.push(`ratio ${row.ratio} above ${RATIO_FLAG}`);
		if (typeof row.change_pct === "number" && row.change_pct > JUMP_FLAG_PCT) flags.push(`load up ${row.change_pct}% on the previous ${unit}`);
		if (flags.length) row.flag = flags.join("; ");
		prev = { load, full: p.full };
		return row;
	});

	const notes: string[] = [];
	if (leadIn === "unavailable") {
		notes.push(`Couldn't fetch the 28 days before ${start}, so periods ending before ${addDays(start, 27)} have no ratio (${partialRatios} of them).`);
	} else if (leadIn === "empty") {
		notes.push(`No matching activities in the 28 days before ${start}. If that's missing data rather than rest, the first ratios read high.`);
	}
	return {
		method: method.method,
		source: `computed from ${method.label}; not Garmin's Training Status`,
		periods: rows,
		notes: notes.length ? notes : undefined,
	};
}

function nextMonth(firstOfMonth: string): string {
	const [y, m] = firstOfMonth.split("-").map(Number) as [number, number];
	return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}
