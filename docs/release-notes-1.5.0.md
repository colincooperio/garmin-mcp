**Cloud:** no new settings or secrets. Run `npm run update` to deploy.

## New
- **Strength progress.** Ask "is my bench going up?" or "how has my deadlift changed?". `get_strength_progress` shows sets, reps, max weight, volume and average load per exercise and session, with the trend. Ask about top sets to add each session's sets, top set and estimated 1RM. Log reps and weight on the watch or add them in Garmin Connect, and use a Connect workout to get exercise names. There's a new _Strength review_ prompt too.
- **Cycling power.** Activity analysis now gives average and normalized power and your best 5 s, 1 min, 5 min, 20 min and 60 min. Tell it your FTP and rides also get intensity factor and TSS (Garmin's Personal API doesn't provide FTP). Other activities with power, such as runs, get the power figures without IF and TSS. Watts per kg are added when Garmin has your weight.

## Improved
- **Analysis that fits the sport.**
  - Strength sessions, and other gym or generic activities under 1 km, no longer show pace, doubled cadence or distance best efforts.
  - Drift is now only for running, cycling, walking, hiking and rowing. Swimming and other sports no longer get it.
  - E-bike rides count as cycling.
- **Drift on rides and rows reads as speed.** `pace_change_pct` is now `speed_change_pct`, where positive means the second half was faster. Runs, walks and hikes are unchanged.
- **Training review prompt** covers pace for running, walking and hiking; speed and power for cycling; and frequency, duration and heart rate for everything else.

## Fixed
- **`activity_type: strength_training` no longer fails.** It and other subtypes, such as `trail_running` and `indoor_cycling`, now work in either field in every tool that takes an activity type, and `road_cycling` is read as Garmin's `road_biking`. A type and subtype that don't go together get a clear error instead of Garmin's bare HTTP 400.

## When you update
- The analysis cache version changed, so the first personal-bests question after updating downloads your activity files again. It may be slower, or partial on the cloud version: ask again and it carries on where it stopped.

## Known limitations
- Per-set strength detail matches by exact exercise title, so non-English titles fall into "other sets". Trends aren't affected.
- Named top sets with an estimated 1RM are covered by synthetic tests only, not yet by real data.
- W/kg is untested on real weight data.

**Full Changelog**: https://github.com/colincooperio/garmin-mcp/compare/v1.4.3...v1.5.0
