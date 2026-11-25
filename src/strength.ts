/**
 * Strength progress from two sources. Garmin's per-session summary
 * (summarizedExerciseSets on the activity list) is the main one: it names the
 * exercises and reflects edits made in Garmin Connect. The FIT file's set
 * messages add individual sets, but are the watch's original record and never
 * change, so they're only used for sessions where they agree with the summary.
 */

import { type AnalysisSource, loadFit } from "./analysis.ts";
import type { FitActivity } from "./fit.ts";
import { mapLimit } from "./ranges.ts";
import type { LoadLimits } from "./records.ts";
import { isObj, num, type Raw, round } from "./util.ts";

export type WeightUnit = "kg" | "lb";
const LB_PER_KG = 2.2046226218;
/** FIT's "unknown exercise", in either the category or the subtype. */
const UNKNOWN_CATEGORY = 65_534;
/** Exercises detailed when no exercise is asked for. */
export const TOP_EXERCISES = 5;

export const MISMATCH_NOTE = "watch record differs from Garmin Connect (probably edited there); per-set detail unavailable";
export const UNNAMED = "unnamed exercise";
const NAMES_HINT =
	"Names come from logging with a Connect workout, or, on watches that support it, choosing the exercise when you finish a set.";

// ---- the summary ------------------------------------------------------------

/** One exercise in one session. Undefined reps, weight or volume means not recorded. */
export interface ExerciseRow {
	/** Readable name; undefined when Garmin doesn't know the exercise. */
	name?: string;
	/** Text to match a search against: category and subcategory. */
	search: string;
	sets: number;
	reps?: number;
	maxKg?: number;
	volumeKg?: number;
}

export interface Session {
	id: string;
	/** Local start date, YYYY-MM-DD. */
	date: string;
	start: string;
	rows: ExerciseRow[];
	/** Whether any reps or weight were recorded at all. */
	recorded: boolean;
}

const positive = (v: unknown) => {
	const n = num(v);
	return n !== undefined && n > 0 ? n : undefined;
};
const add = (a: number | undefined, b: number | undefined) => (a === undefined ? b : b === undefined ? a : a + b);
const max = (a: number | undefined, b: number | undefined) => (a === undefined ? b : b === undefined ? a : Math.max(a, b));

const enumWords = (v: unknown) => (typeof v === "string" && v !== "" && v !== "UNKNOWN" ? v.toLowerCase().replace(/_/g, " ") : undefined);
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Reads an activity's summarizedExerciseSets. Weights arrive in grams and blanks as 0. */
export function parseSession(a: Raw): Session {
	const byName = new Map<string | undefined, ExerciseRow>();
	for (const e of Array.isArray(a.summarizedExerciseSets) ? a.summarizedExerciseSets.filter(isObj) : []) {
		const category = enumWords(e.category);
		const sub = enumWords(e.subCategory);
		const label = sub ?? category;
		const name = label === undefined ? undefined : sentence(label);
		const row = byName.get(name) ?? { name, search: "", sets: 0 };
		row.search = [row.search, category, sub].filter(Boolean).join(" ");
		row.sets += num(e.sets) ?? 0;
		row.reps = add(row.reps, positive(e.reps));
		const grams = positive(e.maxWeight);
		row.maxKg = max(row.maxKg, grams === undefined ? undefined : grams / 1000);
		const volume = positive(e.volume);
		row.volumeKg = add(row.volumeKg, volume === undefined ? undefined : volume / 1000);
		byName.set(name, row);
	}
	const rows = [...byName.values()];
	const start = String(a.startTimeLocal ?? "");
	return {
		id: String(a.activityId),
		date: start.slice(0, 10),
		start,
		rows,
		recorded: rows.some((r) => r.reps !== undefined || r.maxKg !== undefined),
	};
}

// ---- matching exercises -----------------------------------------------------

const words = (s: string) =>
	s
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim()
		.split(" ")
		.filter(Boolean)
		// Plurals: squats, curls, bench presses.
		.map((w) => (w.endsWith("sses") ? w.slice(0, -2) : /[^s]s$/.test(w) && w.length > 2 ? w.slice(0, -1) : w));

/** Every word of the query appears in the name, so "bench press" matches all bench presses; "pullups" also matches "pull up". */
export function matchesExercise(query: string, name: string): boolean {
	const q = words(query);
	const n = words(name);
	if (!q.length) return false;
	if (q.every((w) => n.includes(w))) return true;
	const joined = q.join("");
	return n.some((_, i) => n.slice(i, i + 2).join("") === joined);
}

/** The same exercise name, whatever the case, hyphens or underscores. */
const sameName = (a: string, b: string) => words(a).join(" ") === words(b).join(" ");

// ---- the FIT file's sets ----------------------------------------------------

/** One set done (rests are left out), as the watch recorded it. */
export interface DoneSet {
	/** From the file's exercise titles; undefined when the set has no matching title. */
	name?: string;
	reps?: number;
	kg?: number;
	/** FIT seconds. */
	start?: number;
	seconds?: number;
}

/**
 * The sets done in a FIT file, named by the exercise title with the set's own
 * category and subtype numbers. Workout steps are never read: they're plans.
 */
export function doneSets(fit: FitActivity): DoneSet[] {
	return (fit.sets ?? [])
		.filter((s) => s.setType === 1)
		.map((s) => {
			const known =
				s.category !== undefined && s.category !== UNKNOWN_CATEGORY && s.subtype !== undefined && s.subtype !== UNKNOWN_CATEGORY;
			const title = known ? fit.exerciseTitles?.find((t) => t.category === s.category && t.exercise === s.subtype)?.title : undefined;
			return { name: title, reps: positive(s.reps), kg: positive(s.weight), start: s.startTs, seconds: s.duration };
		});
}

/**
 * Whether the watch's sets still add up to what Garmin Connect shows for the
 * whole activity: sets, reps, volume and heaviest weight. Weights get a little
 * slack: FIT rounds to 1/16 kg, which shows for weights entered in pounds.
 */
export function agrees(sets: DoneSet[], session: Session): boolean {
	const sum = (xs: (number | undefined)[]) => xs.reduce<number>((t, x) => t + (x ?? 0), 0);
	const top = (xs: (number | undefined)[]) => Math.max(0, ...xs.map((x) => x ?? 0));
	const reps = sum(sets.map((s) => s.reps));
	return (
		sets.length === sum(session.rows.map((r) => r.sets)) &&
		reps === sum(session.rows.map((r) => r.reps)) &&
		Math.abs(top(sets.map((s) => s.kg)) - top(session.rows.map((r) => r.maxKg))) <= 0.1 &&
		Math.abs(sum(sets.map((s) => (s.reps ?? 0) * (s.kg ?? 0))) - sum(session.rows.map((r) => r.volumeKg))) <= 0.1 + reps * 0.05
	);
}

/** The heaviest set with both weight and reps; on a tie, the one with more reps. */
export function topSet(sets: DoneSet[]): { kg: number; reps: number } | undefined {
	let best: { kg: number; reps: number } | undefined;
	for (const { kg, reps } of sets) {
		if (kg === undefined || reps === undefined) continue;
		if (!best || kg > best.kg || (kg === best.kg && reps > best.reps)) best = { kg, reps };
	}
	return best;
}

/** Epley's estimated one-rep max. A single rep is its own answer. */
export const epley = (kg: number, reps: number) => (reps === 1 ? kg : kg * (1 + reps / 30));

const SETS_VERSION = 1;
const setsCacheName = (id: string) => `strength-sets:v${SETS_VERSION}:${id}`;

export interface LoadedSets {
	sets: Map<string, DoneSet[]>;
	/** Sessions with no readable FIT file. */
	noFile: number;
	/** Not loaded this call (download or time limit, or Garmin's rate limit). */
	deferred: number;
	rateLimited: boolean;
	failed: number;
	firstError?: string;
}

/** Loads sets for `sessions`, within the limits. Cached for good, since the original file never changes. */
export async function loadSets(
	src: AnalysisSource,
	sessions: Session[],
	limits: LoadLimits,
	opts: { now?: () => number; describe?: (err: unknown) => string } = {},
): Promise<LoadedSets> {
	const now = opts.now ?? Date.now;
	const started = now();
	const out: LoadedSets = { sets: new Map(), noFile: 0, deferred: 0, rateLimited: false, failed: 0 };
	let downloads = 0;
	await mapLimit(sessions, limits.concurrency, async ({ id }) => {
		const cached = await src.getCached<{ v: number; sets: DoneSet[] }>(setsCacheName(id));
		if (cached?.v === SETS_VERSION) {
			out.sets.set(id, cached.sets);
			return;
		}
		if (out.rateLimited || downloads >= limits.maxDownloads || now() - started > limits.timeBudgetMs) {
			out.deferred++;
			return;
		}
		downloads++;
		try {
			const loaded = await loadFit(src, id);
			if ("unavailable" in loaded) {
				out.noFile++;
				return;
			}
			const sets = doneSets(loaded.fit);
			await src.putCached(setsCacheName(id), { v: SETS_VERSION, sets });
			out.sets.set(id, sets);
		} catch (err) {
			if ((err as { status?: number }).status === 429) {
				out.rateLimited = true;
				out.deferred++;
			} else {
				out.failed++;
				out.firstError ??= opts.describe?.(err) ?? (err instanceof Error ? err.message : String(err));
			}
		}
	});
	return out;
}

// ---- output -----------------------------------------------------------------

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

function formatter(unit: WeightUnit) {
	const value = (kg: number) => (unit === "kg" ? round(kg, 2) : round(kg * LB_PER_KG, 1));
	const weight = (kg: number) => `${value(kg)} ${unit}`;
	const load = (kg: number) => `${round(unit === "kg" ? kg : kg * LB_PER_KG, 1)} ${unit}`;
	const change = (a: number, b: number) => {
		const diff = round(value(b) - value(a), 2);
		return `${value(a)} -> ${value(b)} ${unit} (${diff > 0 ? "+" : ""}${diff})`;
	};
	const oneRm = (t: { kg: number; reps: number }) => round(epley(t.kg, t.reps) * (unit === "kg" ? 1 : LB_PER_KG), 1);
	const top = (t: { kg: number; reps: number }) => `${weight(t.kg)} x ${t.reps}`;
	const set = (s: DoneSet) =>
		s.kg !== undefined && s.reps !== undefined
			? `${value(s.kg)} ${unit} x ${s.reps}`
			: s.reps !== undefined
				? `${plural(s.reps, "rep")}, no weight recorded`
				: s.kg !== undefined
					? `${weight(s.kg)}, reps not recorded`
					: "nothing recorded";
	return { weight, load, change, oneRm, top, set };
}

/** Per-exercise detail of one named group, oldest session first. */
type Entry = { session: Session; row: ExerciseRow };

/**
 * The tool's output. `sets` (when per-set detail was asked for) holds the
 * watch's sets by activity ID, for the sessions that could be read.
 */
export function strengthProgress(
	sessions: Session[],
	opts: { unit: WeightUnit; exercise?: string; sets?: LoadedSets },
): Record<string, unknown> {
	const f = formatter(opts.unit);
	const ordered = [...sessions].sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
	const recorded = ordered.filter((s) => s.recorded);
	const notes: string[] = [];

	const groups = new Map<string, Entry[]>();
	let unidentified = { sets: 0, reps: 0, sessions: 0 };
	for (const session of recorded) {
		for (const row of session.rows) {
			if (row.name === undefined) {
				unidentified = {
					sets: unidentified.sets + row.sets,
					reps: unidentified.reps + (row.reps ?? 0),
					sessions: unidentified.sessions + 1,
				};
			} else if (opts.exercise === undefined || matchesExercise(opts.exercise, row.search)) {
				groups.set(row.name, [...(groups.get(row.name) ?? []), { session, row }]);
			}
		}
	}
	const ranked = [...groups].sort(
		([a, x], [b, y]) => y.length - x.length || y.at(-1)!.session.start.localeCompare(x.at(-1)!.session.start) || a.localeCompare(b),
	);
	const detailed = opts.exercise === undefined ? ranked.slice(0, TOP_EXERCISES) : ranked;

	// Individual sets count only where the watch's record still matches Garmin Connect.
	const trusted = new Map<string, DoneSet[]>();
	const differs = new Set<string>();
	for (const s of recorded) {
		const sets = opts.sets?.sets.get(s.id);
		if (!sets) continue;
		if (agrees(sets, s)) trusted.set(s.id, sets);
		else differs.add(s.id);
	}
	const named = (id: string, name: string) => trusted.get(id)?.filter((s) => s.name !== undefined && sameName(s.name, name)) ?? [];

	const exercises = detailed.map(([name, entries]) => {
		const tops = entries.map(({ session }) => topSet(named(session.id, name)));
		const lines = entries.map(({ session, row }, i) => {
			const parts = [`${session.date}: ${plural(row.sets, "set")}`, row.reps === undefined ? "reps not recorded" : plural(row.reps, "rep")];
			if (row.maxKg === undefined) parts.push("no weight recorded");
			else parts.push(`max ${f.weight(row.maxKg)}`);
			if (row.volumeKg !== undefined) {
				parts.push(`volume ${f.load(row.volumeKg)}`);
				if (row.reps !== undefined) parts.push(`avg load ${f.load(row.volumeKg / row.reps)}`);
			}
			const top = tops[i];
			if (top) {
				parts.push(`top set ${f.top(top)} (est. 1RM ${f.oneRm(top)} ${opts.unit})`);
				parts.push(`sets: ${named(session.id, name).map(f.set).join("; ")}`);
			}
			return parts.join(", ") + (differs.has(session.id) ? ` [${MISMATCH_NOTE}]` : "");
		});
		return { exercise: name, sessions_logged: entries.length, trend: trend(entries, tops, f, opts.unit), sessions: lines };
	});

	// Sets that can't be tied to a named exercise, one line per session: what the
	// summary leaves unidentified, with the watch's unnamed or differently named sets.
	const otherSets: string[] = [];
	const unidentifiedIn = (s: Session) =>
		opts.exercise !== undefined
			? []
			: s.rows
					.filter((r) => r.name === undefined)
					.map((r) => `unidentified: ${plural(r.sets, "set")}, ${r.reps === undefined ? "reps not recorded" : plural(r.reps, "rep")}`);
	let untitled = 0;
	if (opts.sets) {
		for (const s of recorded) {
			const sets = trusted.get(s.id);
			if (!sets) {
				for (const c of unidentifiedIn(s)) otherSets.push(`${s.date}: ${c}${differs.has(s.id) ? ` [${MISMATCH_NOTE}]` : ""}`);
				continue;
			}
			const other = new Map<string, DoneSet[]>();
			let matched = false;
			for (const set of sets) {
				const label = set.name ?? UNNAMED;
				const wanted = set.name === undefined ? opts.exercise === undefined : opts.exercise === undefined || matchesExercise(opts.exercise, set.name);
				const hasRow = set.name !== undefined && s.rows.some((r) => r.name !== undefined && sameName(r.name, set.name!));
				if (wanted) matched ||= set.name !== undefined;
				if (wanted && !hasRow && (set.reps !== undefined || set.kg !== undefined)) other.set(label, [...(other.get(label) ?? []), set]);
			}
			const details = [...other].map(([label, list]) => {
				// A top set needs to be of one exercise, which unnamed sets may not be.
				const top = label === UNNAMED ? undefined : topSet(list);
				return `${label}: ${list.map(f.set).join("; ")}` + (top ? `; top set ${f.top(top)} (est. 1RM ${f.oneRm(top)} ${opts.unit})` : "");
			});
			const counts = unidentifiedIn(s);
			if (details.length || counts.length) otherSets.push(`${s.date}: ${[...counts, ...details].join(" | ")}`);
			const inTrend = opts.exercise !== undefined && s.rows.some((r) => r.name !== undefined && matchesExercise(opts.exercise!, r.search));
			if (inTrend && !matched) untitled++;
		}
		if (untitled) notes.push(`${plural(untitled, "session")} without a matching exercise title in the watch's file: in the trend only.`);
		if (opts.sets.noFile) notes.push(`${plural(opts.sets.noFile, "session")} without a readable FIT file: in the trend only.`);
		if (opts.sets.failed) notes.push(`Couldn't read the sets of ${plural(opts.sets.failed, "session")}: ${opts.sets.firstError}`);
		if ([...exercises.flatMap((e) => e.sessions), ...otherSets].some((line) => line.includes("est. 1RM"))) notes.push("est. 1RM is an estimate (Epley: weight x (1 + reps/30)), not a tested max.");
	}
	if (exercises.length) notes.push("avg load is volume / reps, so reps logged without a weight lower it.");
	const blank = ordered.length - recorded.length;
	if (blank) notes.push(`${blank} strength ${blank === 1 ? "activity" : "activities"} with no reps or weight recorded.`);
	if (opts.exercise !== undefined && !exercises.length && !otherSets.length) {
		const found = new Set(recorded.flatMap((s) => s.rows.flatMap((r) => (r.name === undefined ? [] : [r.name]))));
		notes.push(`No logged exercise matches '${opts.exercise}'. ${found.size ? `Found: ${[...found].join(", ")}.` : "No named exercises were logged."}`);
	}

	const incomplete = opts.sets && opts.sets.deferred > 0;
	return {
		...(opts.sets ? { set_detail_complete: !incomplete } : {}),
		...(incomplete
			? {
					status:
						`Partial: per-set detail for ${plural(opts.sets!.deferred, "session")} not loaded yet` +
						(opts.sets!.rateLimited ? " (Garmin rate-limited the file downloads). Wait a minute, then call again" : ". Call again to continue") +
						" before answering about top sets; the trends from Garmin's summary are complete.",
				}
			: {}),
		unit: opts.unit,
		activities: ordered.length,
		exercises_found: opts.exercise === undefined ? ranked.map(([name, e]) => `${name}: ${plural(e.length, "session")}`) : undefined,
		exercises,
		// One block, so the same session's unidentified total and sets don't read as two sessions.
		other_sets:
			unidentified.sessions || otherSets.length
				? {
						unidentified: unidentified.sessions
							? `Unidentified: ${plural(unidentified.sets, "set")}, ${plural(unidentified.reps, "rep")} in ${plural(unidentified.sessions, "session")}. ${NAMES_HINT}`
							: undefined,
						sessions: otherSets,
					}
				: undefined,
		notes,
	};
}

/** First against last session: heaviest weight, volume and, where known, top set and estimated 1RM. */
function trend(entries: Entry[], tops: ({ kg: number; reps: number } | undefined)[], f: ReturnType<typeof formatter>, unit: WeightUnit): string {
	const weighted = entries.filter((e) => e.row.maxKg !== undefined);
	if (!weighted.length) return "no weight recorded";
	if (weighted.length === 1) return `one session with weight (${weighted[0]!.session.date}), so no trend yet`;
	const first = weighted[0]!;
	const last = weighted.at(-1)!;
	const parts = [`max weight ${f.change(first.row.maxKg!, last.row.maxKg!)}`];
	if (first.row.volumeKg !== undefined && last.row.volumeKg !== undefined) parts.push(`volume ${f.change(first.row.volumeKg, last.row.volumeKg)}`);
	let out = `${first.session.date} to ${last.session.date}: ${parts.join(", ")}`;
	const withTop = entries.flatMap((e, i) => (tops[i] ? [{ date: e.session.date, top: tops[i]! }] : []));
	if (withTop.length > 1) {
		const a = withTop[0]!;
		const b = withTop.at(-1)!;
		// Named by date: these can be fewer sessions than the ones above.
		out += `; top set ${f.top(a.top)} (${a.date}) -> ${f.top(b.top)} (${b.date}), est. 1RM ${f.oneRm(a.top)} -> ${f.oneRm(b.top)} ${unit}`;
	}
	return out;
}
