import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ACTIVITY_SUBTYPES, activityTypeParams } from "../src/activities.ts";
import { callGarminTool } from "./tool-harness.ts";

/** Runs a tool against an empty Garmin account and returns the activity searches it made. */
async function searches(tool: string, args: object): Promise<URLSearchParams[]> {
	const seen: URLSearchParams[] = [];
	await callGarminTool(
		tool,
		(url) => {
			if (url.pathname === "/activitylist-service/activities/search/activities") seen.push(url.searchParams);
			return Response.json([]);
		},
		args,
	);
	assert.ok(seen.length > 0, `${tool} made no activity search`);
	return seen;
}

describe("activityTypeParams", () => {
	it("leaves parent types and correct type/subtype pairs alone", () => {
		for (const t of ["running", "cycling", "swimming", "walking", "hiking", "fitness_equipment"]) {
			assert.deepEqual(activityTypeParams(t), { activityType: t, activitySubType: undefined });
		}
		assert.deepEqual(activityTypeParams("running", "trail_running"), { activityType: "running", activitySubType: "trail_running" });
		assert.deepEqual(activityTypeParams(undefined, "strength_training"), { activityType: undefined, activitySubType: "strength_training" });
		assert.deepEqual(activityTypeParams(), { activityType: undefined, activitySubType: undefined });
	});

	it("moves every known subtype out of activityType, with no parent", () => {
		for (const t of ACTIVITY_SUBTYPES) assert.deepEqual(activityTypeParams(t), { activityType: undefined, activitySubType: t });
	});

	it("lets an explicit subtype win over one given as the type", () => {
		assert.deepEqual(activityTypeParams("strength_training", "yoga"), { activityType: undefined, activitySubType: "yoga" });
		assert.deepEqual(activityTypeParams("strength_training", "strength_training"), {
			activityType: undefined,
			activitySubType: "strength_training",
		});
	});

	it("reads road_cycling as Garmin's road_biking, in either field", () => {
		assert.deepEqual(activityTypeParams("road_cycling"), { activityType: undefined, activitySubType: "road_biking" });
		assert.deepEqual(activityTypeParams("cycling", "road_cycling"), { activityType: "cycling", activitySubType: "road_biking" });
	});

	it("passes unknown keys through, including names on Object.prototype", () => {
		assert.deepEqual(activityTypeParams("winter_sports", "new_subtype"), { activityType: "winter_sports", activitySubType: "new_subtype" });
		assert.equal(activityTypeParams("constructor").activityType, "constructor");
	});
});

describe("tools taking activity_type", () => {
	const range = { start_date: "2026-01-01", end_date: "2026-01-31" };
	const cases: [string, object][] = [
		["search_activities", {}],
		["summarize_activities", range],
		["get_personal_bests", range],
		["analyze_recovery_impact", range],
	];
	for (const [tool, args] of cases) {
		it(`${tool} sends strength_training as a subtype only`, async () => {
			for (const p of await searches(tool, { ...args, activity_type: "strength_training" })) {
				assert.equal(p.get("activityType"), null);
				assert.equal(p.get("activitySubType"), "strength_training");
			}
		});
		it(`${tool} still sends a parent type as the type`, async () => {
			for (const p of await searches(tool, { ...args, activity_type: "running" })) {
				assert.equal(p.get("activityType"), "running");
				assert.equal(p.get("activitySubType"), null);
			}
		});
	}

	it("covers the lead-in search for the load trend too", async () => {
		const all = await searches("summarize_activities", { ...range, group_by: "week", activity_type: "strength_training" });
		assert.ok(all.some((p) => p.get("endDate") === "2025-12-31"), "expected the 28-day lead-in search");
		assert.ok(all.every((p) => p.get("activitySubType") === "strength_training" && !p.has("activityType")));
	});
});
