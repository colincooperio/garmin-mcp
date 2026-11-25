import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Analysis, analyzeActivity, formatAnalysis, SECTIONS } from "../src/analysis.ts";
import { decodeFit } from "../src/fit.ts";
import { type PowerSample, summarizePower, trainingStress } from "../src/power.ts";
import { PROMPTS } from "../src/prompts.ts";
import { buildFit, buildZip, steadyRun, type SynthActivity, type SynthRecord } from "./fit-fixture.ts";
import { callGarminTool } from "./tool-harness.ts";

/** One sample a second, from [seconds, watts] blocks. */
function blocks(...parts: [seconds: number, watts: number | undefined][]): PowerSample[] {
	const out: PowerSample[] = [{ t: 0, pwr: parts[0]![1] }];
	for (const [n, pwr] of parts) for (let i = 0; i < n; i++) out.push({ t: out.length, pwr });
	return out;
}
const best = (s: PowerSample[], seconds: number) => summarizePower(s)?.best.find((b) => b.seconds === seconds);
const near = (a: number | undefined, b: number, eps = 1e-6) => assert.ok(a !== undefined && Math.abs(a - b) <= eps, `${a} != ${b}`);

describe("best power", () => {
	it("finds the hardest window and where it starts", () => {
		const s = blocks([600, 150], [300, 300], [600, 150]);
		near(best(s, 300)?.watts, 300);
		assert.equal(best(s, 300)?.startTime, 600);
	});

	it("straddles a change of effort", () => {
		// 20 min around a 5 min surge: 300 s at 300 W and 900 s at 100 W.
		const s = blocks([600, 100], [300, 300], [600, 100]);
		near(best(s, 1200)?.watts, (300 * 300 + 900 * 100) / 1200);
		// 1 min across a 30 s step up that ends the ride.
		const step = blocks([300, 100], [30, 400]);
		near(best(step, 60)?.watts, 250);
		assert.equal(best(step, 60)?.startTime, 270);
	});

	it("only covers durations the activity is long enough for", () => {
		assert.deepEqual(summarizePower(blocks([299, 200]))?.best.map((b) => b.label), ["5 s", "1 min"]);
		assert.deepEqual(summarizePower(blocks([300, 200]))?.best.map((b) => b.label), ["5 s", "1 min", "5 min"]);
		assert.equal(summarizePower(blocks([3600, 200]))?.best.length, 5);
	});

	it("takes the earliest of equal efforts", () => {
		assert.equal(best(blocks([60, 300], [60, 100], [60, 300]), 60)?.startTime, 0);
	});

	it("counts zeros, skips missing readings, and won't let a few readings stand for a long effort", () => {
		near(summarizePower(blocks([30, 200], [30, 0]))?.avg, 100);
		near(summarizePower(blocks([30, 200], [30, undefined]))?.avg, 200);
		assert.equal(best(blocks([30, 200], [30, undefined]), 60), undefined, "half the minute is missing");
		near(best(blocks([57, 200], [3, undefined]), 60)?.watts, 200);
	});

	it("weights irregular samples by time, the same as one a second", () => {
		// 150 W for 100 s, 300 W for 60 s, 150 W for 100 s; recorded every 1 to 9 s.
		const t = [0];
		for (let i = 0; t.at(-1)! < 260; i++) t.push(Math.min(260, t.at(-1)! + [1, 4, 9, 2, 7][i % 5]!));
		const edges = [...new Set([...t, 100, 160])].sort((a, b) => a - b);
		const s = edges.map((x) => ({ t: x, pwr: x > 100 && x <= 160 ? 300 : 150 }));
		near(best(s, 60)?.watts, 300);
		near(best(s, 60)?.startTime, 100);
		near(summarizePower(s)?.avg, (200 * 150 + 60 * 300) / 260);
		// Sparse samples: a window starting between two of them is interpolated.
		near(best([{ t: 0, pwr: 0 }, { t: 10, pwr: 100 }, { t: 20, pwr: 300 }, { t: 23, pwr: 100 }], 5)?.watts, 300);
	});

	it("leaves out long dropouts rather than stretching one reading over them", () => {
		const s = [...blocks([100, 100]), { t: 160, pwr: 1000 }, ...Array.from({ length: 100 }, (_, i) => ({ t: 161 + i, pwr: 100 }))];
		near(summarizePower(s)?.avg, 100);
	});

	it("ignores samples recorded while the timer was paused", () => {
		near(summarizePower([...blocks([10, 200]), { t: 10, pwr: 0 }, { t: 10, pwr: 0 }, { t: 11, pwr: 200 }])?.avg, 200);
	});

	it("is undefined without power, or with nothing but zeros", () => {
		assert.equal(summarizePower(blocks([100, undefined])), undefined);
		assert.equal(summarizePower(blocks([100, 0])), undefined);
		assert.equal(summarizePower([]), undefined);
		assert.equal(summarizePower([{ t: 0, pwr: 200 }]), undefined);
	});
});

describe("normalized power", () => {
	it("equals the average at constant power", () => {
		const p = summarizePower(blocks([1200, 200]))!;
		near(p.normalized, 200);
		near(p.avg, 200);
	});
	it("is above the average when power varies", () => {
		const p = summarizePower(blocks(...Array.from({ length: 10 }, (): [number, number][] => [[60, 300], [60, 100]]).flat()))!;
		near(p.avg, 200);
		assert.ok(p.normalized! > 215 && p.normalized! < 300, String(p.normalized));
	});
	it("needs ten minutes of power data", () => {
		assert.equal(summarizePower(blocks([599, 200]))?.normalized, undefined);
		near(summarizePower(blocks([600, 200]))?.normalized, 200);
		assert.equal(summarizePower(blocks([500, 200], [500, undefined]))?.normalized, undefined);
	});
	it("gives an hour at FTP an IF of 1 and a TSS of 100", () => {
		assert.deepEqual(trainingStress(250, 250, 3600), { intensityFactor: 1, tss: 100 });
	});
});

const analyse = (a: Partial<SynthActivity>) => analyzeActivity(decodeFit(buildFit({ records: [], ...a })));
const format = (a: Analysis, power = {}): any => formatAnalysis(a, { unit: "km", include: SECTIONS, power });
const ride = (seconds = 1800): SynthRecord[] =>
	steadyRun(seconds, 8).map((r, i) => ({ ...r, cadence: 90, power: i > 600 && i <= 900 ? 300 : 180 }));

describe("analysis by sport", () => {
	it("a ride: power, distance best efforts with speed and no pace, IF and TSS only with an FTP", () => {
		const a = analyse({ sport: 2, records: ride() });
		const out = format(a);
		assert.equal(out.power.avg_w, 200);
		assert.ok(out.power.normalized_w > 200);
		assert.deepEqual(out.power.best.map((b: any) => b.duration), ["5 s", "1 min", "5 min", "20 min"]);
		assert.deepEqual(out.power.best[2], { duration: "5 min", watts: 300, w_per_kg: undefined, starts_at: "10:00" });
		assert.equal(out.power.tss, undefined);
		assert.equal(out.power.intensity_factor, undefined);
		assert.deepEqual(out.power.notes, ["Intensity factor and TSS need your FTP, which Garmin's Personal API doesn't provide: pass ftp_watts."]);
		assert.equal(out.best_efforts[0].speed_kmh, 28.8);
		assert.equal(out.best_efforts[0].time, "2:05");
		assert.ok(out.best_efforts.every((e: any) => e.pace === undefined));
		assert.ok(out.drift.first_half);

		const ftp = format(a, { ftp: 250, weight: { kg: 75, date: "2026-01-01" } }).power;
		const np = a.power!.normalized!;
		assert.equal(ftp.intensity_factor, Math.round((np / 250) * 100) / 100);
		assert.equal(ftp.tss, Math.round(((1800 * np * (np / 250)) / (250 * 3600)) * 1000) / 10);
		assert.equal(ftp.ftp_w, 250);
		assert.equal(ftp.best[2].w_per_kg, 4);
		assert.match(ftp.notes[0], /75 kg \(2026-01-01\)/);
	});

	it("a run: pace, doubled cadence and best efforts as before, with power but never IF or TSS", () => {
		const a = analyse({ sport: 1, records: steadyRun(1400, 4) });
		const out = format(a, { ftp: 250 });
		assert.equal(out.splits[0].pace, "4:10 /km");
		assert.equal(out.splits[0].cadence_spm, 170);
		assert.equal(out.best_efforts.length, 3);
		assert.equal(out.power.avg_w, 250);
		assert.equal(out.power.tss, undefined);
		assert.match(out.power.notes[0], /only given for rides/);
		assert.deepEqual(out.unavailable, ["hr_zones: no HR zones set in Garmin Connect"]);
		assert.equal(format(a).power.notes, undefined, "no note about FTP on a run");
	});

	it("a strength session: no pace, no doubled cadence, no distance efforts or drift, with reasons", () => {
		const records = Array.from({ length: 601 }, (_, i) => ({ at: i, hr: 110, cadence: 20 }));
		const laps = [{ at: 0, timerTime: 600, distance: 0, avgHr: 110 }];
		const a = analyse({ sport: 10, subSport: 20, records, laps });
		assert.equal(a.cadenceUnit, "per_min");
		const out = format(a);
		assert.equal(out.laps[0].pace, undefined);
		assert.equal(out.laps[0].speed_kmh, undefined);
		for (const s of ["best_efforts", "drift", "power"]) assert.equal(out[s], undefined, s);
		assert.deepEqual(
			out.unavailable.filter((u: string) => !u.startsWith("hr_zones")),
			[
				"best_efforts: distance isn't meaningful for this kind of activity",
				"drift: only for steady endurance sports (running, cycling, walking, hiking, rowing)",
				"power: no power data in this activity",
			],
		);
		// Walking about between sets doesn't make it a foot sport.
		const wandering = analyse({ sport: 10, subSport: 20, records: steadyRun(1200, 1) });
		assert.equal(wandering.cadenceUnit, "per_min");
		assert.equal(wandering.bestEfforts, undefined);
	});

	it("training and generic count as foot sports only from 1 km", () => {
		for (const sport of [10, 0]) {
			const short = analyse({ sport, records: steadyRun(249, 4) });
			assert.equal(short.cadenceUnit, "per_min");
			assert.equal(format(short).splits[0].pace, undefined);
			assert.equal(format(short).splits[0].cadence_per_min, 85);
			const long = analyse({ sport, records: steadyRun(250, 4) });
			assert.equal(long.cadenceUnit, "spm");
			assert.equal(format(long).splits[0].pace, "4:10 /km");
			assert.equal(format(long).splits[0].cadence_spm, 170);
			assert.equal(format(long).best_efforts.length, 1);
			assert.equal(format(long).drift, undefined, "not a steady endurance sport");
		}
	});

	it("a hike: pace, best efforts and drift", () => {
		const out = format(analyse({ sport: 17, records: steadyRun(1200, 1.5).map(({ power: _, ...r }) => r) }));
		assert.equal(out.sport, "hiking");
		assert.equal(out.best_efforts[0].pace, "11:07 /km");
		assert.ok(out.drift.first_half.pace);
		assert.deepEqual(out.unavailable.filter((u: string) => !u.startsWith("hr_zones")), ["power: no power data in this activity"]);
	});

	it("a swim keeps its distance efforts but has no drift", () => {
		const out = format(analyse({ sport: 5, records: steadyRun(1200, 1) }));
		assert.equal(out.best_efforts[0].distance, "1 km");
		assert.ok(out.unavailable.some((u: string) => u.startsWith("drift: only for steady")));
	});

	it("survives the JSON cache", () => {
		const a = analyse({ sport: 2, records: ride() });
		assert.deepEqual(format(JSON.parse(JSON.stringify(a))), format(a));
	});
});

describe("get_activity_analysis power", () => {
	const zip = (a: Partial<SynthActivity>) => buildZip([{ name: "a.fit", data: buildFit({ records: [], ...a }) }]);
	const call = (args: object, weight: (url: URL) => Response, file = zip({ sport: 2, records: ride() })) =>
		callGarminTool(
			"get_activity_analysis",
			(url) => (url.pathname.startsWith("/weight-service/") ? weight(url) : new Response(file)),
			{ activity_id: "1", include: ["power"], ...args },
		);

	it("applies ftp_watts, and the newest weight in grams", async () => {
		const out = await call({ ftp_watts: 250 }, () =>
			Response.json({
				dailyWeightSummaries: [
					{ summaryDate: "2026-01-01", latestWeight: { weight: 80_000 } },
					{ summaryDate: "2026-01-09", latestWeight: { weight: 75_000 } },
				],
			}),
		);
		assert.equal(out.power.ftp_w, 250);
		assert.ok(out.power.tss > 0);
		assert.equal(out.power.best[2].w_per_kg, 4);
	});

	it("falls back to the weight before the window, and to none", async () => {
		const prev = await call({}, () => Response.json({ dailyWeightSummaries: [], previousDateWeight: { calendarDate: "2025-01-01", weight: 60_000 } }));
		assert.equal(prev.power.best[2].w_per_kg, 5);
		for (const w of [() => Response.json({ previousDateWeight: { weight: null } }), () => new Response("", { status: 500 })]) {
			const none = await call({}, w);
			assert.equal(none.power.best[2].w_per_kg, undefined);
			assert.equal(none.power.best[2].watts, 300);
		}
	});

	it("doesn't ask for a weight it won't use", async () => {
		const file = zip({ sport: 1, records: steadyRun(300, 4).map(({ power: _, ...r }) => r) });
		const out = await call({}, () => assert.fail("no weight request expected"), file);
		assert.deepEqual(out.unavailable, ["power: no power data in this activity"]);
	});
});

describe("training_review prompt", () => {
	it("asks for pace, speed and power, or neither, by sport", () => {
		const text = PROMPTS.find((p) => p.name === "training_review")!.template;
		assert.match(text, /For running, walking or hiking, add the pace trend/);
		assert.match(text, /For cycling, add the speed trend, power where recorded/);
		assert.match(text, /For any other sport, or all sports, look at frequency, duration and heart rate instead of pace/);
	});
});
