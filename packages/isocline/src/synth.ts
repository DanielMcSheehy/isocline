// Seeded synthetic time-series generator with ground-truth labels.
// Mirrors CONTRACT.md §5. Same seed → same data, always.

/** mulberry32 PRNG — tiny, fast, good enough for synthetic data. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller standard normal from a uniform rng. */
export function randn(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export interface GenOptions {
  n?: number; // length, default 720
  period?: number; // seasonal period in samples, default 24 (0 → none)
  base?: number; // level, default 50
  trend?: number; // slope per sample, default 0.02
  amplitude?: number; // first harmonic, default 8
  amplitude2?: number; // second harmonic, default 2
  sigma?: number; // noise std, default 1.5
  spikes?: number; // count of spike events, default 3
  dips?: number; // count of dip events, default 2
  spikeWidth?: number; // samples per event, default 2
  eventMag?: number; // event magnitude in σ units, default 6
  shift?: boolean; // inject one level shift, default true
  shiftMag?: number; // shift magnitude in σ units, default 5
  drift?: boolean; // inject one linear drift at the end, default true
  driftMag?: number; // total drift magnitude in σ units, default 8
  missing?: number; // number of NaN holes, default 8
  seed?: number; // default 42
}

export interface GenResult {
  y: Float64Array;
  t: Float64Array; // hourly epoch-ms, ending at the current hour
  /** ground-truth anomaly indices (every point of each spike/dip event) */
  anomalies: number[];
  /** ground-truth changepoint indices (shift start, drift start when present) */
  changepoints: number[];
}

/** Pick `count` well-separated event start positions in [lo, hi). */
function pickPositions(rng: () => number, count: number, lo: number, hi: number, sep: number, taken: number[]): number[] {
  const out: number[] = [];
  let guard = 0;
  while (out.length < count && guard++ < 1000) {
    const p = lo + Math.floor(rng() * (hi - lo));
    if (taken.some((q) => Math.abs(q - p) < sep)) continue;
    taken.push(p);
    out.push(p);
  }
  return out;
}

export function genSeries(opts: GenOptions = {}): GenResult {
  const {
    n = 720,
    period = 24,
    base = 50,
    trend = 0.02,
    amplitude = 8,
    amplitude2 = 2,
    sigma = 1.5,
    spikes = 3,
    dips = 2,
    spikeWidth = 2,
    eventMag = 6,
    shift = true,
    shiftMag = 5,
    drift = true,
    driftMag = 8,
    missing = 8,
    seed = 42,
  } = opts;

  const rng = mulberry32(seed);
  const y = new Float64Array(n);
  const phase = rng() * Math.PI * 2;
  for (let i = 0; i < n; i++) {
    let v = base + trend * i;
    if (period > 1) {
      v += amplitude * Math.sin((2 * Math.PI * i) / period + phase);
      v += amplitude2 * Math.sin((4 * Math.PI * i) / period + phase * 0.7);
    }
    v += sigma * randn(rng);
    y[i] = v;
  }

  const anomalies: number[] = [];
  const changepoints: number[] = [];
  const taken: number[] = [];
  const edge = Math.max(8, Math.floor(n * 0.03));
  const sep = Math.max(3 * spikeWidth, Math.floor(n * 0.04));

  // spikes + dips
  for (const [count, sign] of [[spikes, 1], [dips, -1]] as const) {
    for (const p of pickPositions(rng, count, edge, n - edge - spikeWidth, sep, taken)) {
      for (let k = 0; k < spikeWidth; k++) {
        const i = p + k;
        // events decay within their width (sharp attack, fast decay)
        const w = 1 - k / spikeWidth;
        y[i] = (y[i] ?? 0) + sign * eventMag * sigma * w;
        anomalies.push(i);
      }
    }
  }

  // level shift at ~60%
  if (shift && n > 40) {
    const p = Math.floor(n * 0.6) + Math.floor(rng() * Math.floor(n * 0.05));
    for (let i = p; i < n; i++) y[i] = (y[i] ?? 0) + shiftMag * sigma;
    changepoints.push(p);
    taken.push(p);
  }

  // drift over the last ~25%
  if (drift && n > 60) {
    const p = Math.floor(n * 0.75) + Math.floor(rng() * Math.floor(n * 0.04));
    const len = n - p;
    for (let i = p; i < n; i++) y[i] = (y[i] ?? 0) + (driftMag * sigma * (i - p)) / Math.max(1, len);
    changepoints.push(p);
  }

  // missing holes (never on ground-truth anomaly indices)
  const holes = pickPositions(rng, missing, edge, n - edge - 1, 5, [...anomalies, ...changepoints]);
  for (const p of holes) y[p] = NaN;

  // hourly timestamps ending at the current hour
  const endHour = Math.floor(Date.now() / 3.6e6) * 3.6e6;
  const t = new Float64Array(n);
  for (let i = 0; i < n; i++) t[i] = endHour - (n - 1 - i) * 3.6e6;

  anomalies.sort((a, b) => a - b);
  changepoints.sort((a, b) => a - b);
  return { y, t, anomalies, changepoints };
}
