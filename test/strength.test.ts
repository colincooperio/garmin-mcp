import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeActivity, formatAnalysis, SECTIONS } from "../src/analysis.ts";
import { decodeFit } from "../src/fit.ts";
import { MemoryKV } from "../src/memory-kv.ts";
import {
	agrees,
	type DoneSet,
	doneSets,
	epley,
	type LoadedSets,
	matchesExercise,
	MISMATCH_NOTE,
	parseSession,
	strengthProgress,
	topSet,
} from "../src/strength.ts";
import { buildFit, buildZip, steadyRun, type SynthActivity, T0 } from "./fit-fixture.ts";
import { callGarminTool } from "./tool-harness.ts";

type Ex = [category: string, sub: string | undefined, sets: number, reps: number, maxKg: number, volumeKg: number];
const BENCH = ["BENCH_PRESS", "DUMBBELL_BENCH_PRESS"] as const;

const activity = (id: number, date: string, rows: Ex[]) => ({
	activityId: id,
	startTimeLocal: `${date} 18:00:00`,
	activityType: { typeKey: "strength_training" },
	summarizedExerciseSets: rows.map(([category, subCategory, sets, reps, kg, vol]) => ({
		category,
		...(subCategory ? { subCategory } : {}),
		sets,
		reps,
		maxWeight: kg * 1000,
		volume: vol * 1000,
		duration: 1000,
	})),
});
const session = (id: number, date: string, rows: Ex[]) => parseSession(activity(id, date, rows));
const loaded = (sets: Record<string, DoneSet[]>, extra: Partial<LoadedSets> = {}): LoadedSets => ({
	sets: new Map(Object.entries(sets)),
	noFile: 0,
	deferred: 0,
	rateLimited: false,
	failed: 0,
	...extra,
});
const bench = (kg?: number, reps?: number): DoneSet => ({ name: "Dumbbell Bench Press", kg, reps });
const progress = (sessions: ReturnType<typeof session>[], opts: Partial<Parameters<typeof strengthProgress>[1]> = {}): any =>
	strengthProgress(sessions, { unit: "kg", ...opts });

describe("strength summary", () => {
	it("reads grams as kg, 0 as not recorded, and names the exercise by its subcategory", () => {
		const s = session(1, "2026-03-01", [
			[...BENCH, 2, 20, 30, 500],
			["ROW", undefined, 1, 4, 0, 0],
			["UNKNOWN", undefined, 3, 0, 0, 0],
		]);
		assert.deepEqual(
			s.rows.map(({ search: _, ...r }) => r),
			[
				{ name: "Dumbbell bench press", sets: 2, reps: 20, maxKg: 30, volumeKg: 500 },
				{ name: "Row", sets: 1, reps: 4, maxKg: undefined, volumeKg: undefined },
				{ name: undefined, sets: 3, reps: undefined, maxKg: undefined, volumeKg: undefined },
			],
		);
		assert.equal(s.recorded, true);
		assert.equal(session(2, "2026-03-01", [["UNKNOWN", undefined, 4, 0, 0, 0]]).recorded, false);
		assert.deepEqual(parseSession({ activityId: 3 }).rows, []);
	});

	it("gives one line per session and a first-vs-last trend, oldest first", () => {
		const out = progress([session(2, "2026-03-08", [[...BENCH, 2, 16, 32.5, 520]]), session(1, "2026-03-01", [[...BENCH, 2, 20, 30, 500]])]);
		assert.deepEqual(out.exercises, [
			{
				exercise: "Dumbbell bench press",
				sessions_logged: 2,
				trend: "2026-03-01 to 2026-03-08: max weight 30 -> 32.5 kg (+2.5), volume 500 -> 520 kg (+20)",
				sessions: [
					"2026-03-01: 2 sets, 20 reps, max 30 kg, volume 500 kg, avg load 25 kg",
					"2026-03-08: 2 sets, 16 reps, max 32.5 kg, volume 520 kg, avg load 32.5 kg",
				],
			},
		]);
		assert.equal(out.set_detail_complete, undefined, "no set detail asked for");
	});

	it("converts to lb", () => {
		const out = progress([session(1, "2026-03-01", [[...BENCH, 1, 10, 45.3592, 453.592]])], { unit: "lb" });
		assert.equal(out.exercises[0].sessions[0], "2026-03-01: 1 set, 10 reps, max 100 lb, volume 1000 lb, avg load 100 lb");
	});

	it("leaves sessions without weight out of the weight trend, but shows their reps", () => {
		const out = progress([
			session(1, "2026-03-01", [[...BENCH, 2, 20, 0, 0]]),
			session(2, "2026-03-08", [[...BENCH, 2, 20, 30, 600]]),
			session(3, "2026-03-15", [[...BENCH, 2, 18, 0, 0]]),
		]);
		assert.equal(out.exercises[0].trend, "one session with weight (2026-03-08), so no trend yet");
		assert.equal(out.exercises[0].sessions[0], "2026-03-01: 2 sets, 20 reps, no weight recorded");
		assert.equal(progress([session(1, "2026-03-01", [[...BENCH, 2, 20, 0, 0]])]).exercises[0].trend, "no weight recorded");
	});

	it("groups unidentified exercises and counts activities with nothing recorded", () => {
		const out = progress([
			session(1, "2026-03-01", [["UNKNOWN", undefined, 4, 26, 30, 340]]),
			session(2, "2026-03-02", [["UNKNOWN", undefined, 1, 6, 0, 0]]),
			session(3, "2026-03-03", [["UNKNOWN", undefined, 9, 0, 0, 0]]),
			parseSession({ activityId: 4, startTimeLocal: "2026-03-04 07:00:00" }),
		]);
		assert.match(out.unidentified, /^Unidentified: 5 sets, 32 reps in 2 sessions\. Exercise names come from logging with a Connect workout/);
		assert.deepEqual(out.notes, ["2 strength activities with no reps or weight recorded."]);
		assert.deepEqual(out.exercises, []);
	});

	it("without an exercise, lists every one found and details the top 5 by sessions", () => {
		const names = ["CURL", "ROW", "SQUAT", "LUNGE", "DEADLIFT", "PULL_UP"];
		const out = progress([
			session(1, "2026-03-01", names.map((n): Ex => [n, undefined, 1, 5, 10, 50])),
			session(2, "2026-03-02", [["PULL_UP", undefined, 1, 5, 10, 50]]),
		]);
		assert.equal(out.exercises_found.length, 6);
		assert.equal(out.exercises_found[0], "Pull up: 2 sessions");
		assert.equal(out.exercises.length, 5);
		assert.equal(out.exercises[0].exercise, "Pull up");
	});

	it("says what was found when nothing matches", () => {
		const out = progress([session(1, "2026-03-01", [[...BENCH, 1, 5, 10, 50]])], { exercise: "deadlift" });
		assert.ok(out.notes.some((n: string) => n === "No logged exercise matches 'deadlift'. Found: Dumbbell bench press."), out.notes);
	});
});

describe("matchesExercise", () => {
	const name = "bench press dumbbell bench press";
	it("matches whole words in any case, and every variant of a category", () => {
		for (const q of ["bench press", "Dumbbell Bench Press", "DUMBBELL_BENCH_PRESS", "bench presses", "dumbbell bench"]) {
			assert.ok(matchesExercise(q, name), q);
		}
		for (const q of ["barbell bench press", "row", "bench row", "", "--"]) assert.ok(!matchesExercise(q, name), q);
		assert.ok(!matchesExercise("row", "narrow grip press"), "not inside another word");
	});
	it("copes with plurals, hyphens and joined words", () => {
		assert.ok(matchesExercise("squats", "squat goblet squat"));
		assert.ok(matchesExercise("pull-ups", "pull up"));
		assert.ok(matchesExercise("pullups", "pull up wide grip pull up"));
		assert.ok(matchesExercise("straight leg deadlift", "Barbell Straight-leg Deadlift"));
	});
});

describe("FIT sets", () => {
	const TITLES = [
		{ category: 20, exercise: 25, title: "Medicine Ball Slam" },
		{ category: 0, exercise: 6, title: "Dumbbell Bench Press" },
		{ category: 8, exercise: 0, title: "Barbell Deadlift" },
	];
	const file = (a: Partial<SynthActivity>) => decodeFit(buildFit({ sport: 10, records: [], ...a }));

	it("decodes sets, including 32.5 kg (scale 16), and takes the first array element", () => {
		const fit = file({ sets: [{ at: 5, seconds: 23.5, reps: 8, kg: 32.5, category: [8, 7, 0], subtype: [0, 3, 4], step: 2 }] });
		assert.deepEqual(fit.sets, [{ startTs: T0 + 5, duration: 23.5, reps: 8, weight: 32.5, setType: 1, category: 8, subtype: 0, workoutStep: 2 }]);
	});

	it("names a set by its own numbers, never by its step's position or the watch's guesses", () => {
		const sets = doneSets(
			file({
				titles: TITLES,
				sets: [
					{ at: 0, seconds: 10, reps: 5, kg: 80, category: [8, 8, 8], subtype: [0, 0, 0], step: 0 },
					// The watch's guesses after 65534 include bench press.
					{ at: 20, seconds: 10, reps: 5, kg: 80, category: [65534, 0, 8], subtype: [undefined, 6, 0], step: 1 },
					{ at: 40, seconds: 10, reps: 5, kg: 80, category: [0, 0, 0], subtype: [65534, 6, 6] },
					{ at: 60, seconds: 10, reps: 5, kg: 80, category: [28, 28, 28], subtype: [37, 37, 37] },
					{ at: 80, seconds: 10, reps: 5, kg: 80 },
				],
			}),
		);
		assert.deepEqual(
			sets.map((s) => s.name),
			["Barbell Deadlift", undefined, undefined, undefined, undefined],
		);
	});

	it("leaves out rests, and reads blanks and zeros as not recorded", () => {
		const sets = doneSets(
			file({
				sets: [
					{ at: 0, seconds: 10, reps: 6, kg: 0 },
					{ at: 10, seconds: 10, type: 0 },
					{ at: 20, seconds: 10 },
				],
			}),
		);
		assert.deepEqual(
			sets.map(({ reps, kg }) => ({ reps, kg })),
			[{ reps: 6, kg: undefined }, { reps: undefined, kg: undefined }],
		);
	});

	it("never takes a planned target as reps done", () => {
		const fit = file({ titles: TITLES, plannedReps: [15], sets: [{ at: 0, seconds: 20, category: [8, 8, 8], subtype: [0, 0, 0], step: 0 }] });
		assert.deepEqual(doneSets(fit).map((s) => s.reps), [undefined]);
	});

	it("doesn't change the analysis of the same activity", () => {
		const base = { records: steadyRun(1400, 4) };
		const extra = { ...base, titles: TITLES, plannedReps: [15], sets: [{ at: 0, seconds: 20, reps: 5, kg: 20 }] };
		assert.deepEqual(analyzeActivity(decodeFit(buildFit(extra))), analyzeActivity(decodeFit(buildFit(base))));
		const compressed = { compressTimestamps: true };
		const a = analyzeActivity(decodeFit(buildFit({ ...extra, ...compressed })));
		assert.deepEqual(
			formatAnalysis(a, { unit: "km", include: SECTIONS }),
			formatAnalysis(analyzeActivity(decodeFit(buildFit(base))), { unit: "km", include: SECTIONS }),
		);
	});
});

describe("top sets", () => {
	it("takes the heaviest, then the most reps, needing both weight and reps", () => {
		assert.deepEqual(topSet([bench(30, 5), bench(32.5, 4), bench(32.5, 6), bench(32.5, 5), bench(40), bench(undefined, 20)]), { kg: 32.5, reps: 6 });
		assert.equal(topSet([bench(40), bench(undefined, 20)]), undefined);
	});

	it("estimates 1RM by Epley, with a single rep as its own weight", () => {
		assert.equal(epley(30, 10), 40);
		assert.equal(epley(100, 1), 100);
	});

	it("shows top set, 1RM and sets per session, and their trend", () => {
		const out = progress([session(1, "2026-03-01", [[...BENCH, 2, 18, 30, 500]]), session(2, "2026-03-08", [[...BENCH, 2, 14, 32.5, 435]])], {
			sets: loaded({ 1: [bench(20, 4 + 4), bench(34, 10)], 2: [bench(30, 8), bench(32.5, 6)] }),
		});
		// Session 1's sets have a heavier max than the summary, so only session 2 has detail.
		const [one, two] = out.exercises[0].sessions;
		assert.equal(one, `2026-03-01: 2 sets, 18 reps, max 30 kg, volume 500 kg, avg load 27.78 kg [${MISMATCH_NOTE}]`);
		assert.equal(
			two,
			"2026-03-08: 2 sets, 14 reps, max 32.5 kg, volume 435 kg, avg load 31.07 kg, top set 32.5 kg x 6 (est. 1RM 39 kg), sets: 30 kg x 8; 32.5 kg x 6",
		);
		const both = progress([session(1, "2026-03-01", [[...BENCH, 1, 10, 30, 300]]), session(2, "2026-03-08", [[...BENCH, 1, 6, 32.5, 195]])], {
			sets: loaded({ 1: [bench(30, 10)], 2: [bench(32.5, 6)] }),
		});
		assert.match(both.exercises[0].trend, /; top set 30 kg x 10 \(2026-03-01\) -> 32\.5 kg x 6 \(2026-03-08\), est\. 1RM 40 -> 39 kg$/);
	});

	it("lists unnamed sets without a top set or 1RM, and leaves them out of an exercise search", () => {
		const s = [session(1, "2026-03-01", [["UNKNOWN", undefined, 2, 14, 30, 340]])];
		const sets = loaded({ 1: [{ kg: 20, reps: 8 }, { kg: 30, reps: 6 }] });
		assert.deepEqual(progress(s, { sets }).other_sets, ["2026-03-01: unnamed exercise: 20 kg x 8; 30 kg x 6"]);
		assert.deepEqual(progress(s, { sets, exercise: "bench press" }).other_sets, []);
		assert.ok(!progress(s, { sets }).notes.some((n: string) => n.includes("1RM")), "no 1RM shown, so no note about it");
	});

	it("keeps a session without titles in the trend only, and says so", () => {
		const out = progress([session(1, "2026-03-01", [[...BENCH, 1, 10, 30, 300]])], { exercise: "bench press", sets: loaded({ 1: [{ kg: 30, reps: 10 }] }) });
		assert.equal(out.exercises[0].sessions[0], "2026-03-01: 1 set, 10 reps, max 30 kg, volume 300 kg, avg load 30 kg");
		assert.ok(out.notes.some((n: string) => /^1 session without a matching exercise title/.test(n)), out.notes);
	});
});

describe("watch record against Garmin Connect", () => {
	const s = session(1, "2026-03-01", [[...BENCH, 2, 14, 30, 340]]);
	it("accepts matching totals", () => {
		assert.ok(agrees([bench(20, 8), bench(30, 6)], s));
	});
	it("rejects a different set count, reps, weight or volume", () => {
		assert.ok(!agrees([bench(20, 8), bench(30, 6), bench()], s), "set count");
		assert.ok(!agrees([bench(20, 9), bench(30, 6)], s), "reps");
		assert.ok(!agrees([bench(20, 8), bench(32.5, 6)], s), "weight");
		assert.ok(!agrees([bench(20, 6), bench(30, 8)], s), "reps swapped between sets: same max and total, other volume");
		assert.ok(!agrees([bench(), bench()], s), "blank on the watch, filled in on Connect");
	});
	it("compares the whole activity, not each exercise", () => {
		const two = session(1, "2026-03-01", [
			[...BENCH, 1, 8, 20, 160],
			["DEADLIFT", "BARBELL_DEADLIFT", 1, 6, 30, 180],
		]);
		assert.ok(agrees([{ kg: 20, reps: 8 }, { kg: 30, reps: 6 }], two));
	});
	it("allows for pounds rounded to FIT's 1/16 kg", () => {
		const kg = 135 * 0.45359237;
		const lb = session(1, "2026-03-01", [[...BENCH, 3, 30, Math.round(kg * 1000) / 1000, kg * 30]]);
		const fitKg = Math.round(kg * 16) / 16;
		assert.ok(agrees([bench(fitKg, 10), bench(fitKg, 10), bench(fitKg, 10)], lb));
	});
});

describe("get_strength_progress tool", () => {
	const zip = (a: Partial<SynthActivity>) => buildZip([{ name: "a.fit", data: buildFit({ sport: 10, records: [], ...a }) }]);
	const today = new Date().toISOString().slice(0, 10);
	const file = zip({
		titles: [{ category: 0, exercise: 6, title: "Dumbbell Bench Press" }],
		sets: [{ at: 0, seconds: 20, reps: 10, kg: 32.5, category: [0, 0, 0], subtype: [6, 6, 6] }],
	});
	const list = (n = 1) => Array.from({ length: n }, (_, i) => activity(i + 1, today, [[...BENCH, 1, 10, 32.5, 325]]));

	it("makes one search and no downloads for the trend, and never caches it", async () => {
		const kv = new MemoryKV();
		const calls: URL[] = [];
		for (let i = 0; i < 2; i++) {
			const out = await callGarminTool("get_strength_progress", (url) => (calls.push(url), Response.json(list())), { weeks: 2 }, {}, kv);
			assert.equal(out.exercises[0].exercise, "Dumbbell bench press");
			assert.equal(out.unit, "kg");
		}
		assert.equal(calls.length, 2, "searched afresh each time");
		const p = calls[0]!.searchParams;
		assert.deepEqual([p.get("activityType"), p.get("activitySubType")], ["fitness_equipment", "strength_training"]);
		assert.equal(Date.parse(p.get("endDate")!) - Date.parse(p.get("startDate")!), 13 * 86_400_000);
	});

	it("reads sets from files with no recorded samples, once, and caches them", async () => {
		const kv = new MemoryKV();
		let downloads = 0;
		const call = () =>
			callGarminTool(
				"get_strength_progress",
				(url) => (url.pathname.endsWith("/search/activities") ? Response.json(list()) : (downloads++, new Response(file))),
				{ exercise: "bench press", detail: "sets" },
				{},
				kv,
			);
		for (const out of [await call(), await call()]) {
			assert.equal(out.set_detail_complete, true);
			assert.match(out.exercises[0].sessions[0], /top set 32\.5 kg x 10 \(est\. 1RM 43\.3 kg\)/);
		}
		assert.equal(downloads, 1);
	});

	it("drops the set detail when a Connect edit changed the summary after the sets were cached", async () => {
		const kv = new MemoryKV();
		let edited = false;
		const call = () =>
			callGarminTool(
				"get_strength_progress",
				(url) =>
					url.pathname.endsWith("/search/activities")
						? Response.json(edited ? [activity(1, today, [[...BENCH, 1, 12, 32.5, 390]])] : list())
						: new Response(file),
				{ detail: "sets" },
				{},
				kv,
			);
		assert.match((await call()).exercises[0].sessions[0], /top set/);
		edited = true;
		const line = (await call()).exercises[0].sessions[0];
		assert.match(line, /12 reps, max 32\.5 kg, volume 390 kg/);
		assert.ok(line.endsWith(`[${MISMATCH_NOTE}]`) && !line.includes("1RM"), line);
	});

	it("caps downloads, says it's partial, and downloads nothing for sessions with nothing recorded", async () => {
		const kv = new MemoryKV();
		const paths: string[] = [];
		const call = () =>
			callGarminTool(
				"get_strength_progress",
				(url) => {
					if (url.pathname.endsWith("/search/activities")) return Response.json([...list(3), activity(99, today, [["UNKNOWN", undefined, 4, 0, 0, 0]])]);
					paths.push(url.pathname);
					return new Response(file);
				},
				{ detail: "sets" },
				{ personalBests: { maxDownloads: 2 } },
				kv,
			);
		const first = await call();
		assert.deepEqual(Object.keys(first).slice(0, 4), ["start_date", "end_date", "set_detail_complete", "status"]);
		assert.equal(first.set_detail_complete, false);
		assert.match(first.status, /^Partial: per-set detail for 1 session not loaded yet\. Call again/);
		assert.equal((await call()).set_detail_complete, true);
		assert.ok(!paths.some((p) => p.endsWith("/99")));
	});

	it("keeps the trend when Garmin rate-limits or has no file", async () => {
		const call = (status: number) =>
			callGarminTool(
				"get_strength_progress",
				(url) => (url.pathname.endsWith("/search/activities") ? Response.json(list()) : new Response("", { status })),
				{ detail: "sets" },
			);
		const limited = await call(429);
		assert.match(limited.status, /rate-limited/);
		assert.equal(limited.exercises.length, 1);
		const none = await call(404);
		assert.ok(none.notes.some((n: string) => /^1 session without a readable FIT file/.test(n)), none.notes);
	});

	it("returns a clean result for an empty account", async () => {
		const out = await callGarminTool("get_strength_progress", () => Response.json([]), { exercise: "squat" });
		assert.equal(out.activities, 0);
		assert.match(out.notes[0], /No logged exercise matches 'squat'\. No named exercises were logged\./);
	});
});
