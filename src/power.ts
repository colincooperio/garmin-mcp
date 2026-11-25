/**
 * Power from a timer-time timeline: average, best average power over set
 * durations, normalized power, and (with an FTP) intensity factor and TSS.
 *
 * As everywhere else in the analysis, a sample stands for the timer time since
 * the one before it, so irregular (smart) recording is weighted correctly.
 * Zero watts counts; time without a power reading is left out.
 */

export interface PowerSample {
	/** Timer seconds. */
	t: number;
	pwr?: number;
}

export const POWER_DURATIONS: [label: string, seconds: number][] = [
	["5 s", 5],
	["1 min", 60],
	["5 min", 300],
	["20 min", 1200],
	["60 min", 3600],
];

/**
 * A gap longer than this is missing data, not smart recording, and is left
 * out. Garmin Connect counts such dropouts as 0 W, so its best powers can be
 * lower for a ride with dropouts; without them the two agree exactly.
 */
const MAX_GAP_S = 30;
/** Share of a window that must have power, so a few readings can't stand for a long effort. */
const MIN_COVERAGE = 0.9;
/** Normalized power says little about short efforts. */
const MIN_NP_SECONDS = 600;
const NP_WINDOW_S = 30;
/** Timer times are sums of fractions of seconds. */
const EPS = 1e-6;

export interface BestPower {
	label: string;
	seconds: number;
	watts: number;
	/** Timer seconds from the start where the effort began. */
	startTime: number;
}

export interface PowerSummary {
	avg: number;
	normalized?: number;
	best: BestPower[];
}

/**
 * Cumulative joules and seconds with power at each sample, so any window's
 * average is a subtraction. Plain loops over typed arrays: this runs several
 * times over every record, within the Worker's CPU budget.
 */
interface Cumulative {
	n: number;
	t: Float64Array;
	joules: Float64Array;
	covered: Float64Array;
}

function accumulate(samples: readonly PowerSample[]): Cumulative {
	const t = new Float64Array(samples.length);
	const joules = new Float64Array(samples.length);
	const covered = new Float64Array(samples.length);
	let n = 0;
	for (const s of samples) {
		const w = n ? s.t - t[n - 1]! : 0;
		if (n && w <= 0) continue; // recorded while the timer was paused
		const counts = n > 0 && s.pwr !== undefined && w <= MAX_GAP_S;
		t[n] = s.t;
		joules[n] = (n ? joules[n - 1]! : 0) + (counts ? s.pwr! * w : 0);
		covered[n] = (n ? covered[n - 1]! : 0) + (counts ? w : 0);
		n++;
	}
	return { n, t, joules, covered };
}

/**
 * Average watts over [start, start + seconds] for each of `count` increasing
 * starts (NaN where too little of the window has power). Both edges only move
 * forward, and are interpolated between samples.
 */
function windowAverages(c: Cumulative, count: number, startAt: (i: number) => number, seconds: number): Float64Array {
	const { n, t, joules, covered } = c;
	const out = new Float64Array(count);
	const need = seconds * MIN_COVERAGE - EPS;
	let a = 0;
	let b = 0;
	for (let i = 0; i < count; i++) {
		const from = startAt(i);
		const to = from + seconds;
		while (a < n - 1 && t[a]! < from) a++;
		while (b < n - 1 && t[b]! < to) b++;
		let j = joules[b]! - joules[a]!;
		let k = covered[b]! - covered[a]!;
		// Back each edge up from its sample to the exact time.
		if (b > 0 && t[b]! > to) {
			const f = (t[b]! - to) / (t[b]! - t[b - 1]!);
			j -= f * (joules[b]! - joules[b - 1]!);
			k -= f * (covered[b]! - covered[b - 1]!);
		}
		if (a > 0 && t[a]! > from) {
			const f = (t[a]! - from) / (t[a]! - t[a - 1]!);
			j += f * (joules[a]! - joules[a - 1]!);
			k += f * (covered[a]! - covered[a - 1]!);
		}
		out[i] = k >= need ? j / k : Number.NaN;
	}
	return out;
}

/**
 * Best average power over `seconds`. Power is constant between samples, so
 * with no data missing the best window starts or ends at a sample: both are tried.
 */
function bestOver(c: Cumulative, seconds: number): { watts: number; startTime: number } | undefined {
	const { n, t } = c;
	const begin = t[0]!;
	const end = t[n - 1]!;
	if (end - begin < seconds - EPS) return undefined;
	let watts = -1;
	let start = 0;
	const sweep = (count: number, startAt: (i: number) => number) => {
		const avg = windowAverages(c, count, startAt, seconds);
		for (let i = 0; i < count; i++) {
			const w = avg[i]!;
			// Equal efforts: the earliest. NaN compares false.
			if (w > watts + EPS || (w > watts - EPS && startAt(i) < start)) {
				watts = w;
				start = startAt(i);
			}
		}
	};
	let last = n;
	while (last > 0 && t[last - 1]! + seconds > end + EPS) last--;
	sweep(last, (i) => t[i]!);
	let first = 0;
	while (first < n && t[first]! - seconds < begin - EPS) first++;
	sweep(n - first, (i) => t[first + i]! - seconds);
	return watts < 0 ? undefined : { watts, startTime: Math.max(0, start - begin) };
}

/** 30 s rolling average power each second, to the 4th power, averaged, 4th root. */
function normalizedPower(c: Cumulative): number | undefined {
	if (c.covered[c.n - 1]! < MIN_NP_SECONDS) return undefined;
	const begin = c.t[0]!;
	const avg = windowAverages(c, Math.floor(c.t[c.n - 1]! - begin - NP_WINDOW_S + EPS) + 1, (i) => begin + i, NP_WINDOW_S);
	let sum = 0;
	let count = 0;
	for (let i = 0; i < avg.length; i++) {
		const w = avg[i]!;
		if (Number.isNaN(w)) continue;
		sum += w * w * w * w;
		count++;
	}
	return count ? (sum / count) ** 0.25 : undefined;
}

/** Undefined when nothing but missing or zero power was recorded. */
export function summarizePower(samples: readonly PowerSample[]): PowerSummary | undefined {
	if (!samples.some((s) => s.pwr !== undefined && s.pwr > 0)) return undefined;
	const c = accumulate(samples);
	const seconds = c.covered[c.n - 1]!;
	if (seconds <= 0) return undefined;
	const normalized = normalizedPower(c);
	return {
		avg: c.joules[c.n - 1]! / seconds,
		...(normalized === undefined ? {} : { normalized }),
		best: POWER_DURATIONS.flatMap(([label, duration]) => {
			const b = bestOver(c, duration);
			return b ? [{ label, seconds: duration, ...b }] : [];
		}),
	};
}

/** Intensity factor and training stress score for `seconds` at normalized power `np`. */
export function trainingStress(np: number, ftp: number, seconds: number): { intensityFactor: number; tss: number } {
	const intensityFactor = np / ftp;
	return { intensityFactor, tss: ((seconds * np * intensityFactor) / (ftp * 3600)) * 100 };
}
