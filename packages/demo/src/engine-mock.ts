// MOCK engine — pure-TypeScript stand-in for the wasm core, implementing the
// FULL `Isocline` contract interface (CONTRACT.md §2). Clearly-marked
// simplified outputs: plausible results, same shapes/invariants, same
// determinism (default seed 42). The demo UI is fully functional against it;
// integration swaps it for the real `loadIsocline()` wasm engine.
//
// Algorithms (mock-grade, contract-faithful in shape):
//   forecast      damped-drift projection on the (robustly) deseasonalized
//                 series; ±bands from a seeded residual bootstrap (per-step
//                 quantiles; naive/snaive use direct residual quantiles).
//   anomalies     modified z-score after rolling-median / STL-lite detrend,
//                 plus IQR-fence and EWMA-control-chart variants.
//   decompose     centered moving-average trend + per-phase seasonal means
//                 (+ bisquare reweighting when robust).
//   seasonality   brute-force ACF — O(n·maxLag), FINE for demo sizes. Above
//                 ~24k points the ACF/periodogram internally downsample (stride
//                 subsampling, lag rescaled) to keep the UI thread snappy;
//                 detected periods are rescaled back. The real wasm engine
//                 uses FFT and needs none of this.
//   changepoints  binary segmentation on mean shifts (CUSUM-style statistic).
//   backtest      rolling-origin loop of the mock forecast.
//   interpolate   linear fill over NaN holes.
//
// Invariants honored: output lengths, point within [lower, upper], finite
// metrics, anomalies sorted by index, deterministic per seed (default 42).

import {
  IsoclineError,
  mulberry32,
  type Anomaly,
  type AnomalyMethod,
  type AnomalyOptions,
  type AnomalyResult,
  type BacktestOptions,
  type BacktestResult,
  type BacktestRow,
  type Changepoint,
  type ChangepointOptions,
  type ChangepointResult,
  type DecomposeOptions,
  type DecomposeResult,
  type ForecastOptions,
  type ForecastResult,
  type InterpolateOptions,
  type Isocline,
  type Metrics,
  type ModelKind,
  type SeasonalityCandidate,
  type SeasonalityOptions,
  type SeasonalityResult,
  type SeriesInput,
} from "isocline";

// ---------- small numeric helpers ----------

type Nums = ArrayLike<number>;

/** typed-array index under noUncheckedIndexedAccess */
function at(a: Nums, i: number): number {
  return a[i] as number;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Linear interpolation over NaN holes; returns a fresh copy. */
function interpMissing(y: Nums): Float64Array {
  const n = y.length;
  const out = new Float64Array(n);
  let lastGood = NaN;
  let lastGoodIdx = -1;
  for (let i = 0; i < n; i++) {
    const v = at(y, i);
    if (Number.isFinite(v)) {
      if (lastGoodIdx >= 0 && i - lastGoodIdx > 1) {
        const gap = i - lastGoodIdx;
        for (let k = 1; k < gap; k++) out[lastGoodIdx + k] = lastGood + ((v - lastGood) * k) / gap;
      }
      out[i] = v;
      lastGood = v;
      lastGoodIdx = i;
    } else {
      out[i] = NaN; // back-filled below
    }
  }
  // leading holes: hold the first known value
  if (!Number.isFinite(out[0] as number)) {
    let first = 0;
    while (first < n && !Number.isFinite(out[first])) first++;
    const hold = first < n ? (out[first] as number) : 0;
    for (let i = 0; i < first; i++) out[i] = hold;
  }
  // remaining (interior + trailing) holes: hold previous known value
  let hold = out[0] as number;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(out[i] as number)) out[i] = hold;
    else hold = out[i] as number;
  }
  return out;
}

function meanOf(a: Nums, from = 0, to = a.length): number {
  let s = 0;
  const m = to - from;
  for (let i = from; i < to; i++) s += at(a, i);
  return m > 0 ? s / m : 0;
}

function varianceOf(a: Nums): number {
  const n = a.length;
  if (n < 2) return 0;
  const m = meanOf(a);
  let s = 0;
  for (let i = 0; i < n; i++) {
    const d = at(a, i) - m;
    s += d * d;
  }
  return s / (n - 1);
}

/** Type-7 linear-interpolation quantile of an ascending-sorted array. */
function quantileSorted(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0] as number;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo] as number;
  return (sorted[lo] as number) + (pos - lo) * ((sorted[hi] as number) - (sorted[lo] as number));
}

function sortedCopy(a: Nums, from = 0, to = a.length): number[] {
  const out: number[] = [];
  for (let i = from; i < to; i++) {
    const v = at(a, i);
    if (Number.isFinite(v)) out.push(v);
  }
  out.sort((x, y) => x - y);
  return out;
}

function medianOf(a: number[]): number {
  // quantileSorted requires ascending order — sort a copy (a may be unsorted)
  return quantileSorted([...a].sort((x, y) => x - y), 0.5);
}

function madOf(a: number[]): number {
  const med = medianOf(a);
  const devs = a.map((v) => Math.abs(v - med)).sort((x, y) => x - y);
  return quantileSorted(devs, 0.5);
}

/** Odd centered rolling median; window shrinks at the ends. O(n·w·log w). */
function rollingMedian(y: Float64Array, window: number): Float64Array {
  const n = y.length;
  let w = Math.max(3, Math.round(window));
  if (w % 2 === 0) w += 1;
  const half = (w - 1) / 2;
  const out = new Float64Array(n);
  const buf: number[] = [];
  for (let i = 0; i < n; i++) {
    buf.length = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) {
      const v = y[j] as number;
      if (Number.isFinite(v)) buf.push(v);
    }
    buf.sort((a, b) => a - b);
    out[i] = medianOf(buf);
  }
  return out;
}

/** Brute-force ACF, lags 0..maxLag — O(n·maxLag), fine at demo sizes. */
function acfOf(y: Float64Array, maxLag: number): Float64Array {
  const n = y.length;
  const L = Math.max(1, Math.min(maxLag, n - 1));
  const out = new Float64Array(L + 1);
  const m = meanOf(y);
  let denom = 0;
  for (let i = 0; i < n; i++) {
    const d = at(y, i) - m;
    denom += d * d;
  }
  out[0] = 1;
  if (denom < 1e-12) return out;
  for (let k = 1; k <= L; k++) {
    let s = 0;
    for (let i = 0; i + k < n; i++) s += (at(y, i) - m) * (at(y, i + k) - m);
    out[k] = s / denom;
  }
  return out;
}

/**
 * Naive DFT periodogram at k = 1..maxLag via a complex-rotation recurrence
 * (2 mults/step instead of trig calls). Power = |X_k|²/n, freq = k/n.
 */
function periodogramOf(y: Float64Array, maxLag: number): { power: Float64Array; freqs: Float64Array } {
  const n = y.length;
  const L = Math.max(1, Math.min(maxLag, n - 1));
  const power = new Float64Array(L + 1);
  const freqs = new Float64Array(L + 1);
  const m = meanOf(y);
  for (let k = 1; k <= L; k++) {
    const w = (2 * Math.PI * k) / n;
    const c = Math.cos(w);
    const s = Math.sin(w);
    let cr = 1;
    let ci = 0;
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      const d = at(y, i) - m;
      re += d * cr;
      im += d * ci;
      const ncr = cr * c - ci * s;
      ci = cr * s + ci * c;
      cr = ncr;
    }
    power[k] = (re * re + im * im) / n;
    freqs[k] = k / n;
  }
  return { power, freqs };
}

/** OLS slope/intercept of y over [from, to). */
function olsLine(y: Nums, from: number, to: number): { a: number; b: number } {
  const n = to - from;
  if (n < 2) return { a: at(y, from), b: 0 };
  const mx = (n - 1) / 2;
  let my = 0;
  for (let i = from; i < to; i++) my += at(y, i);
  my /= n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - mx;
    sxx += dx * dx;
    sxy += dx * (at(y, from + i) - my);
  }
  const b = sxx > 1e-12 ? sxy / sxx : 0;
  return { a: my - b * mx, b };
}

/** AR(2) fit by 2×2 normal equations with ridge; null when degenerate. */
function fitAR2(x: Float64Array): { c: number; a1: number; a2: number; resid: Float64Array } | null {
  const n = x.length;
  if (n < 8) return null;
  let s11 = 0;
  let s12 = 0;
  let s22 = 0;
  let s1y = 0;
  let s2y = 0;
  const m = meanOf(x);
  for (let i = 2; i < n; i++) {
    const x1 = at(x, i - 1) - m;
    const x2 = at(x, i - 2) - m;
    const yv = at(x, i) - m;
    s11 += x1 * x1;
    s12 += x1 * x2;
    s22 += x2 * x2;
    s1y += x1 * yv;
    s2y += x2 * yv;
  }
  s11 += 1e-8;
  s22 += 1e-8;
  const det = s11 * s22 - s12 * s12;
  if (Math.abs(det) < 1e-12) return null;
  const a1 = (s1y * s22 - s2y * s12) / det;
  const a2 = (s2y * s11 - s1y * s12) / det;
  const c = m * (1 - a1 - a2);
  const resid = new Float64Array(n);
  for (let i = 2; i < n; i++) resid[i] = at(x, i) - (c + a1 * at(x, i - 1) + a2 * at(x, i - 2));
  return { c, a1, a2, resid };
}

// ---------- decomposition core (STL-lite) ----------

interface Decomp {
  period: number;
  trend: Float64Array;
  seasonal: Float64Array;
  resid: Float64Array;
  seasonalStrength: number;
  robustWeights: Float64Array | null;
}

/**
 * Centered-MA trend + per-phase seasonal means; `seasons` inner iterations;
 * bisquare reweighting of phase means when robust. Mock-grade STL.
 */
function decomposeCore(y: Float64Array, periodIn: number, robust: boolean, seasons: number): Decomp {
  const n = y.length;
  const period = Math.max(1, Math.min(Math.round(periodIn), Math.max(1, Math.floor(n / 2))));
  const trend = new Float64Array(n);
  const seasonal = new Float64Array(n);
  const resid = new Float64Array(n);
  const weights = robust ? new Float64Array(n).fill(1) : null;

  // weighted centered MA (odd window; shrinks at the ends)
  const w = period % 2 === 1 ? period : period + 1;
  const half = (w - 1) / 2;
  const maWindow = (src: Float64Array, dst: Float64Array): void => {
    for (let i = 0; i < n; i++) {
      let s = 0;
      let sw = 0;
      for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) {
        const wj = weights ? weights[j] as number : 1;
        s += wj * at(src, j);
        sw += wj;
      }
      dst[i] = sw > 1e-12 ? s / sw : at(src, i);
    }
  };
  maWindow(y, trend);

  const phaseMean = new Float64Array(period);
  const iter = Math.max(1, Math.min(7, Math.round(seasons)));
  for (let it = 0; it < iter; it++) {
    phaseMean.fill(0);
    const phW = new Float64Array(period);
    for (let i = 0; i < n; i++) {
      const wt = weights ? weights[i] as number : 1;
      const p = i % period;
      phaseMean[p] = at(phaseMean, p) + wt * (at(y, i) - at(trend, i));
      phW[p] = at(phW, p) + wt;
    }
    let phAvg = 0;
    for (let p = 0; p < period; p++) {
      phaseMean[p] = phW[p]! > 1e-12 ? phaseMean[p]! / phW[p]! : 0;
      phAvg += phaseMean[p]!;
    }
    phAvg /= period;
    for (let p = 0; p < period; p++) phaseMean[p] = at(phaseMean, p) - phAvg; // center seasonal
    for (let i = 0; i < n; i++) seasonal[i] = phaseMean[i % period]!;
    for (let i = 0; i < n; i++) resid[i] = at(y, i) - at(trend, i) - at(seasonal, i);

    if (robust && it < iter - 1) {
      // bisquare weights on residuals: w = (1 − (r/6MAD)²)², clamped ≥ 0
      const rs = sortedCopy(resid);
      const scale = Math.max(1e-9, 6 * madOf(rs));
      for (let i = 0; i < n; i++) {
        const u = at(resid, i) / scale;
        weights![i] = Math.max(0, 1 - u * u) ** 2;
      }
      maWindow(y, trend); // re-trend with the new weights
    }
  }

  // strength = 1 − var(resid)/var(seasonal+resid), clamped [0,1]
  const sr = new Float64Array(n);
  for (let i = 0; i < n; i++) sr[i] = at(seasonal, i) + at(resid, i);
  const vsr = varianceOf(sr);
  const vr = varianceOf(resid);
  const strength = vsr > 1e-12 ? clamp(1 - vr / vsr, 0, 1) : 0;

  return { period, trend, seasonal, resid, seasonalStrength: strength, robustWeights: weights };
}

// ---------- seasonality machinery ----------

/** Work cap for the brute-force ACF/DFT (see file header note). */
const DOWNSAMPLE_LIMIT = 24_000;
const ACF_MAX_LAG_CAP = 1024;

interface SeasonalityScan {
  acf: Float64Array;
  lags: Float64Array;
  periodogram: Float64Array;
  frequencies: Float64Array;
  candidates: SeasonalityCandidate[];
}

function scanSeasonality(y: Float64Array, maxPeriod: number): SeasonalityScan {
  const n = y.length;
  const maxP = Math.max(2, Math.min(Math.round(maxPeriod), Math.max(2, Math.floor(n / 2))));
  // internal downsample to cap O(n·maxLag) work on big inputs (mock only)
  const stride = n > DOWNSAMPLE_LIMIT ? Math.ceil(n / DOWNSAMPLE_LIMIT) : 1;
  let ys = y;
  if (stride > 1) {
    const m = Math.floor(n / stride);
    ys = new Float64Array(m);
    for (let i = 0; i < m; i++) ys[i] = y[i * stride] as number;
  }
  const maxLag = Math.max(2, Math.min(ACF_MAX_LAG_CAP, maxP, Math.floor(ys.length / 2)));

  const acf = acfOf(ys, maxLag);
  const { power, freqs } = periodogramOf(ys, maxLag);
  const lags = new Float64Array(maxLag + 1);
  for (let k = 0; k <= maxLag; k++) lags[k] = k;

  const candidates: SeasonalityCandidate[] = [];

  // spectral candidates: top-3 local maxima of the periodogram (period = 1/freq)
  type Peak = { period: number; power: number };
  const peaks: Peak[] = [];
  for (let k = 2; k < maxLag; k++) {
    if (at(power, k) > at(power, k - 1) && at(power, k) >= at(power, k + 1)) {
      const f = at(freqs, k);
      if (f > 0) peaks.push({ period: 1 / f, power: at(power, k) });
    }
  }
  peaks.sort((a, b) => b.power - a.power);

  // acf candidates: positive local maxima at lag ≥ 2
  const acfPeaks: number[] = [];
  for (let k = 2; k < maxLag; k++) {
    if (at(acf, k) > at(acf, k - 1) && at(acf, k) >= at(acf, k + 1) && at(acf, k) > 0.1) acfPeaks.push(k);
  }

  const acfAt = (period: number): number => {
    // nearest acf peak within 5% of the period, else 0
    let best = 0;
    for (const lag of acfPeaks) {
      if (Math.abs(lag - period) <= 0.05 * period) best = Math.max(best, at(acf, lag));
    }
    return clamp(best, 0, 1);
  };

  const push = (rawPeriod: number, source: "acf" | "spectral"): void => {
    const p = Math.round(rawPeriod * stride); // rescale if downsampled
    if (p < 2 || p > maxP) return;
    if (candidates.some((c) => Math.abs(c.period - p) <= 0.05 * p)) return; // dedupe within 5%
    candidates.push({ period: p, strength: acfAt(rawPeriod), source });
  };

  for (const pk of peaks.slice(0, 3)) push(pk.period, "spectral");
  for (const lag of acfPeaks) push(lag, "acf");

  candidates.sort((a, b) => b.strength - a.strength);
  return { acf, lags, periodogram: power, frequencies: freqs, candidates: candidates.slice(0, 5) };
}

function resolveAutoPeriod(y: Float64Array): number | null {
  const n = y.length;
  if (n < 12) return null;
  const scan = scanSeasonality(y, Math.min(Math.floor(n / 3), 8640));
  const best = scan.candidates[0];
  if (!best) return null;
  // quick non-robust decompose pass to gate on real seasonal strength
  const d = decomposeCore(y, best.period, false, 2);
  return d.seasonalStrength >= 0.2 ? best.period : null;
}

// ---------- forecast internals ----------

interface Trajectory {
  pointD: Float64Array; // deseasonalized trajectory, length h
  resid: Float64Array; // in-sample one-step residuals (bootstrap source)
  trendProj: Float64Array | null; // length h (stl_ets only)
  seasonalProj: Float64Array; // length h (zeros when no period)
  params: Record<string, number>;
}

/** Damped-drift projection of level `l`, slope `b`, damping φ. */
function dampedPath(l: number, b: number, phi: number, h: number): Float64Array {
  const out = new Float64Array(h);
  for (let k = 0; k < h; k++) out[k] = l + (b * phi * (1 - Math.pow(phi, k + 1))) / (1 - phi);
  return out;
}

/** Holt damped one-step fits + end state; fixed plausible params (mock). */
function holtDamped(x: Float64Array, alpha = 0.3, beta = 0.1, phi = 0.95): { fitted: Float64Array; resid: Float64Array; l: number; b: number } {
  const n = x.length;
  const fitted = new Float64Array(n);
  const resid = new Float64Array(n);
  let l = at(x, 0);
  let b = n > 1 ? at(x, 1) - at(x, 0) : 0;
  fitted[0] = l;
  for (let i = 1; i < n; i++) {
    const f = l + phi * b;
    fitted[i] = f;
    resid[i] = at(x, i) - f;
    const lNew = alpha * at(x, i) + (1 - alpha) * f;
    b = beta * (lNew - l) + (1 - beta) * phi * b;
    l = lNew;
  }
  return { fitted, resid, l, b };
}

/** Seasonal projection (phase means of adj, centered), h steps ahead. */
function seasonalProjection(adj: Float64Array, p: number, h: number): Float64Array {
  const n = adj.length;
  const ph = new Float64Array(p);
  const phW = new Float64Array(p);
  for (let i = 0; i < n; i++) {
    const j = i % p;
    ph[j] = at(ph, j) + at(adj, i);
    phW[j] = at(phW, j) + 1;
  }
  let avg = 0;
  for (let i = 0; i < p; i++) {
    ph[i] = phW[i]! > 0 ? ph[i]! / phW[i]! : 0;
    avg += ph[i]!;
  }
  avg /= p;
  const out = new Float64Array(h);
  for (let k = 0; k < h; k++) out[k] = ph[(n + k) % p]! - avg;
  return out;
}

function buildTrajectory(model: Exclude<ModelKind, "auto">, y: Float64Array, period: number | null, h: number): Trajectory {
  const n = y.length;

  if (model === "naive" || (model === "snaive" && period == null)) {
    const last = at(y, n - 1);
    const pointD = new Float64Array(h).fill(last);
    const resid = new Float64Array(n);
    for (let i = 1; i < n; i++) resid[i] = at(y, i) - at(y, i - 1);
    return { pointD, resid, trendProj: null, seasonalProj: new Float64Array(h), params: {} };
  }

  if (model === "snaive" && period != null) {
    const p = period;
    const pointD = new Float64Array(h);
    for (let k = 0; k < h; k++) pointD[k] = at(y, n - p + (k % p));
    const resid = new Float64Array(n);
    for (let i = p; i < n; i++) resid[i] = at(y, i) - at(y, i - p);
    return { pointD, resid, trendProj: null, seasonalProj: new Float64Array(h), params: { period: p } };
  }

  // trend/seasonal models: deseasonalize (when a period exists), then project.
  // Without a period these are pure non-seasonal models on y itself.
  const hasSeason = period != null;
  const d = hasSeason ? decomposeCore(y, period as number, model === "stl_ets", 3) : null;
  const p = d ? d.period : 0;
  const adj = new Float64Array(n);
  if (d) {
    for (let i = 0; i < n; i++) adj[i] = at(y, i) - at(d.seasonal, i);
  } else {
    adj.set(y);
  }
  const seasonalProj = d ? seasonalProjection(adj, p, h) : new Float64Array(h);

  if (model === "ar") {
    const ar = fitAR2(adj);
    if (ar) {
      const pointD = new Float64Array(h);
      let prev1 = at(adj, n - 1);
      let prev2 = at(adj, n - 2);
      for (let k = 0; k < h; k++) {
        const v = ar.c + ar.a1 * prev1 + ar.a2 * prev2;
        pointD[k] = v;
        prev2 = prev1;
        prev1 = v;
      }
      return { pointD, resid: ar.resid, trendProj: null, seasonalProj, params: { ar1: ar.a1, ar2: ar.a2 } };
    }
    // degenerate → fall through to Holt
  }

  if (model === "stl_ets") {
    // OLS trend line over the tail of the smooth trend, damped projection
    const W = Math.min(n, Math.max(2 * p, 12));
    const { b } = olsLine(d!.trend, n - W, n);
    const phi = 0.95;
    const pointD = dampedPath(at(d!.trend, n - 1), b, phi, h);
    const resid = new Float64Array(n);
    for (let i = 0; i < n; i++) resid[i] = at(adj, i) - at(d!.trend, i);
    return { pointD, resid, trendProj: pointD.slice(), seasonalProj, params: { phi, slope: b } };
  }

  // ets: damped Holt on the (deseasonalized) series
  const hw = holtDamped(adj);
  const phi = 0.95;
  return {
    pointD: dampedPath(hw.l, hw.b, phi, h),
    resid: hw.resid,
    trendProj: null,
    seasonalProj,
    params: { alpha: 0.3, beta: 0.1, phi },
  };
}

function inSampleFit(model: Exclude<ModelKind, "auto">, y: Float64Array, period: number | null): Float64Array {
  const n = y.length;
  const fitted = new Float64Array(n);
  if (model === "naive" || (model === "snaive" && period == null)) {
    fitted[0] = at(y, 0);
    for (let i = 1; i < n; i++) fitted[i] = at(y, i - 1);
    return fitted;
  }
  if (model === "snaive" && period != null) {
    for (let i = 0; i < n; i++) fitted[i] = i >= period ? at(y, i - period) : at(y, i);
    return fitted;
  }
  if (period != null) {
    // decompose-based in-sample proxy: trend + seasonal
    const d = decomposeCore(y, period, model === "stl_ets", 3);
    for (let i = 0; i < n; i++) fitted[i] = at(d.trend, i) + at(d.seasonal, i);
    return fitted;
  }
  // non-seasonal one-step fits
  if (model === "ar") {
    const ar = fitAR2(y);
    if (ar) {
      for (let i = 2; i < n; i++) fitted[i] = ar.c + ar.a1 * at(y, i - 1) + ar.a2 * at(y, i - 2);
      fitted[0] = at(y, 0);
      fitted[1] = at(y, 1);
      return fitted;
    }
  }
  return holtDamped(y).fitted;
}

function metricsOf(y: Nums, fitted: Nums): Metrics {
  const n = y.length;
  let se = 0;
  let ae = 0;
  let smape = 0;
  let smapeN = 0;
  for (let i = 0; i < n; i++) {
    const e = at(y, i) - at(fitted, i);
    se += e * e;
    ae += Math.abs(e);
    const den = Math.abs(at(y, i)) + Math.abs(at(fitted, i));
    if (den > 1e-12) {
      smape += (200 * Math.abs(e)) / den;
      smapeN++;
    }
  }
  return {
    rmse: Math.sqrt(se / Math.max(1, n)),
    mae: ae / Math.max(1, n),
    smape: smapeN > 0 ? smape / smapeN : 0,
  };
}

function sanitizeMetrics(m: Metrics): Metrics {
  const f = (x: number): number => (Number.isFinite(x) ? x : 0);
  return { rmse: f(m.rmse), mae: f(m.mae), smape: f(m.smape) };
}

// ---------- the mock engine ----------

export function createMockEngine(): Isocline {
  function forecast(series: SeriesInput, opts: ForecastOptions = {}): ForecastResult {
    const yAll = interpMissing(series.y);
    const n = yAll.length;
    if (n < 3) throw new IsoclineError(`series too short: ${n} points (need ≥ 3)`, "tooShort");

    const h = clamp(Math.round(opts.horizon ?? 24), 1, 10_000);
    const level = clamp(opts.level ?? 0.95, 0.01, 0.999);
    const pathsN = clamp(Math.round(opts.paths ?? 200), 0, 2000);
    const seed = (opts.seed ?? 42) >>> 0;
    const warnings: string[] = [];

    // ---- resolve period
    let period: number | null = null;
    if (opts.period === "auto" || opts.period == null) period = resolveAutoPeriod(yAll);
    else if (opts.period >= 2) period = Math.round(opts.period);
    if (period != null && n < 2 * period + 1) {
      warnings.push("insufficient data for seasonality; fell back to naive");
      period = null;
    }

    // ---- resolve model
    const requested: ModelKind = opts.model ?? "auto";
    let model: Exclude<ModelKind, "auto"> = requested === "auto" ? "ets" : requested; // replaced below when auto
    if (requested === "auto") {
      if (period == null) {
        model = n < 16 ? "ets" : "ar";
      } else {
        const strength = decomposeCore(yAll, period, true, 2).seasonalStrength;
        model = strength >= 0.5 ? "stl_ets" : strength >= 0.2 ? "ets" : "ar";
      }
    }
    if (model === "snaive" && period == null) {
      warnings.push("no seasonal period detected; snaive degraded to naive");
    }

    // ---- trajectory + in-sample fit
    const traj = buildTrajectory(model, yAll, period, h);
    const fitted = inSampleFit(model, yAll, period);
    const metrics = sanitizeMetrics(metricsOf(yAll, fitted));

    // ---- prediction intervals + optional simulated paths
    const rng = mulberry32(seed);
    const qLo = (1 - level) / 2;
    const qHi = 1 - qLo;
    const point = new Float64Array(h);
    const lower = new Float64Array(h);
    const upper = new Float64Array(h);
    const paths = pathsN > 0 ? new Float64Array(pathsN * h) : null;
    const residPool = sortedCopy(traj.resid);
    if (residPool.length === 0) residPool.push(0);
    const sigma = Math.max(1e-9, madOf(residPool) * 1.4826);

    // per-phase residual quantiles for snaive's closed-form band
    let phaseQ: { lo: number[]; hi: number[] } | null = null;
    if (model === "snaive" && period != null && pathsN === 0) {
      const p = period;
      const lo = new Array<number>(p).fill(-1.96 * sigma);
      const hi = new Array<number>(p).fill(1.96 * sigma);
      for (let j = 0; j < p; j++) {
        const rs: number[] = [];
        for (let i = j + p; i < n; i += p) rs.push(at(traj.resid, i));
        rs.sort((a, b) => a - b);
        if (rs.length > 3) {
          lo[j] = quantileSorted(rs, qLo);
          hi[j] = quantileSorted(rs, qHi);
        }
      }
      phaseQ = { lo, hi };
    }

    if (paths) {
      // residual bootstrap: accumulate resampled residuals along the
      // deterministic trajectory, re-seasonalize; per-step quantiles.
      const noiseAcc = new Float64Array(pathsN * h);
      const col = new Array<number>(pathsN);
      for (let k = 0; k < h; k++) {
        for (let pI = 0; pI < pathsN; pI++) {
          const prevNoise = k === 0 ? 0 : at(noiseAcc, pI * h + k - 1);
          const nv = prevNoise + residPool[Math.floor(rng() * residPool.length)]!;
          noiseAcc[pI * h + k] = nv;
          const v = at(traj.pointD, k) + nv + at(traj.seasonalProj, k);
          paths[pI * h + k] = v;
          col[pI] = v;
        }
        col.sort((a, b) => a - b);
        point[k] = quantileSorted(col, 0.5); // median of paths (contract §4.7)
        lower[k] = quantileSorted(col, qLo);
        upper[k] = quantileSorted(col, qHi);
      }
    } else {
      // closed-form bands: residual quantiles, √h widening for drift models
      const rLo = residPool.length > 3 ? quantileSorted(residPool, qLo) : -1.96 * sigma;
      const rHi = residPool.length > 3 ? quantileSorted(residPool, qHi) : 1.96 * sigma;
      for (let k = 0; k < h; k++) {
        const widen = model === "snaive" || model === "naive" ? 1 : Math.sqrt(k + 1);
        point[k] = at(traj.pointD, k);
        if (phaseQ && period != null) {
          const j = (k + n) % period;
          lower[k] = at(traj.pointD, k) + phaseQ.lo[j]!;
          upper[k] = at(traj.pointD, k) + phaseQ.hi[j]!;
        } else {
          lower[k] = at(traj.pointD, k) + rLo * widen;
          upper[k] = at(traj.pointD, k) + rHi * widen;
        }
      }
    }

    // invariant: point within [lower, upper] — clamp against degenerate pools
    for (let k = 0; k < h; k++) {
      if (!Number.isFinite(point[k]!) || !Number.isFinite(lower[k]!) || !Number.isFinite(upper[k]!)) {
        const v = at(yAll, n - 1);
        point[k] = v;
        lower[k] = v;
        upper[k] = v;
      } else {
        point[k] = clamp(point[k]!, lower[k]!, upper[k]!);
      }
    }

    return {
      model,
      period,
      horizon: h,
      level,
      point,
      lower,
      upper,
      fitted,
      residuals: traj.resid,
      paths,
      pathsN,
      trend: model === "stl_ets" ? traj.trendProj : null,
      seasonal: model === "stl_ets" || model === "snaive" ? traj.seasonalProj : null,
      metrics,
      params: traj.params,
      warnings,
    };
  }

  function detectAnomalies(series: SeriesInput, opts: AnomalyOptions = {}): AnomalyResult {
    const y0 = series.y;
    const y = interpMissing(y0);
    const n = y.length;
    if (n < 3) throw new IsoclineError(`series too short: ${n} points (need ≥ 3)`, "tooShort");

    const method: AnomalyMethod = opts.method ?? "stl";
    const threshold = opts.threshold ?? (method === "iqr" ? 1.5 : method === "ewma" ? 3.0 : 3.5);
    const direction = opts.direction ?? "both";
    const lambda = clamp(opts.lambda ?? 0.3, 0.01, 1);

    let period: number | null = null;
    if (opts.period === "auto" || opts.period == null) period = resolveAutoPeriod(y);
    else if (opts.period >= 2) period = Math.round(opts.period);

    const expected = new Float64Array(n);
    const scores = new Float64Array(n); // signed; positive = above expected

    // Shared detrend for madz/iqr/ewma. MOCK ADAPTATION vs CONTRACT §4.8: the
    // spec's rolling-median window = period spans a full seasonal cycle, whose
    // median is the midline (not the seasonal wave), which suppresses event
    // detection on strongly seasonal data. We detrend with the non-robust
    // STL-lite instead, falling back to an 11-wide rolling median when no
    // period is detected. The real engine revisits this.
    const detrendExp = (): Float64Array => {
      if (period != null) {
        const d = decomposeCore(y, period, false, 2);
        const out = new Float64Array(n);
        for (let i = 0; i < n; i++) out[i] = at(d.trend, i) + at(d.seasonal, i);
        return out;
      }
      return rollingMedian(y, 11);
    };

    if (method === "ewma") {
      // EWMA control chart on the detrended residual: σ_z = σ_y·√(λ/(2−λ)),
      // robust σ_y from first differences. (EWMA on the raw seasonal series
      // mass-flags — σ_z assumes white noise.)
      const base = detrendExp();
      const d = new Float64Array(n);
      for (let i = 0; i < n; i++) d[i] = at(y, i) - at(base, i);
      const z = new Float64Array(n);
      z[0] = at(d, 0);
      for (let i = 1; i < n; i++) z[i] = lambda * at(d, i) + (1 - lambda) * at(z, i - 1);
      const diffs: number[] = [];
      for (let i = 1; i < n; i++) diffs.push(at(d, i) - at(d, i - 1));
      const sigmaY = Math.max(1e-9, (1.4826 * madOf(diffs)) / Math.SQRT2);
      const sigmaZ = Math.max(1e-9, sigmaY * Math.sqrt(lambda / (2 - lambda)));
      const zBar = medianOf(sortedCopy(z));
      const warmup = Math.max(period ?? 11, 11);
      for (let i = 0; i < n; i++) {
        expected[i] = at(base, i) + at(z, i);
        scores[i] = i < warmup ? 0 : (at(z, i) - zBar) / sigmaZ;
      }
    } else if (method === "iqr") {
      // IQR fences on the detrended residual; signed score in k-units so the
      // fences land exactly at ±threshold
      const exp = detrendExp();
      const r = new Float64Array(n);
      for (let i = 0; i < n; i++) r[i] = at(y, i) - at(exp, i);
      const rs = sortedCopy(r);
      const q1 = quantileSorted(rs, 0.25);
      const q3 = quantileSorted(rs, 0.75);
      const iqr = Math.max(1e-9, q3 - q1);
      const mid = (q1 + q3) / 2;
      const hiSpan = Math.max(1e-9, q3 + threshold * iqr - mid);
      const loSpan = Math.max(1e-9, mid - (q1 - threshold * iqr));
      for (let i = 0; i < n; i++) {
        expected[i] = at(exp, i);
        const v = at(r, i);
        scores[i] = v >= mid ? ((v - mid) / hiSpan) * threshold : ((v - mid) / loSpan) * threshold;
      }
    } else {
      // stl: robust STL-lite detrend; madz: same detrend, non-robust (see
      // detrendExp note)
      let exp: Float64Array;
      if (method === "stl" && period != null) {
        const d = decomposeCore(y, period, true, 3);
        exp = new Float64Array(n);
        for (let i = 0; i < n; i++) exp[i] = at(d.trend, i) + at(d.seasonal, i);
      } else if (method === "stl") {
        exp = rollingMedian(y, 11);
      } else {
        exp = detrendExp();
      }
      const r = new Float64Array(n);
      for (let i = 0; i < n; i++) r[i] = at(y, i) - at(exp, i);
      const rs = sortedCopy(r);
      const med = medianOf(rs);
      const mad = Math.max(1e-9, madOf(rs));
      for (let i = 0; i < n; i++) {
        expected[i] = at(exp, i);
        scores[i] = (0.6745 * (at(r, i) - med)) / mad;
      }
    }

    // flag + filter
    const anomalies: Anomaly[] = [];
    for (let i = 0; i < n; i++) {
      const s = at(scores, i);
      if (!Number.isFinite(s) || Math.abs(s) <= threshold) continue;
      const observed = at(y0, i);
      if (!Number.isFinite(observed)) continue; // never flag missing holes
      const dir: "spike" | "dip" = s > 0 ? "spike" : "dip";
      if (direction === "high" && dir !== "spike") continue;
      if (direction === "low" && dir !== "dip") continue;
      anomalies.push({ index: i, score: Math.abs(s), expected: at(expected, i), observed, direction: dir });
    }
    anomalies.sort((a, b) => a.index - b.index);

    return { method, threshold, anomalies, scores, expected };
  }

  function decompose(series: SeriesInput, opts: DecomposeOptions = {}): DecomposeResult {
    const y = interpMissing(series.y);
    const n = y.length;
    if (n < 3) throw new IsoclineError(`series too short: ${n} points (need ≥ 3)`, "tooShort");
    const period =
      opts.period === "auto" || opts.period == null ? resolveAutoPeriod(y) ?? 1 : Math.max(1, Math.round(opts.period));
    const robust = opts.robust ?? true;
    const seasons = clamp(Math.round(opts.seasons ?? 3), 1, 7);
    const d = decomposeCore(y, period, robust, seasons);
    return {
      period: d.period,
      trend: d.trend,
      seasonal: d.seasonal,
      resid: d.resid,
      seasonalStrength: d.seasonalStrength,
      robustWeights: d.robustWeights,
    };
  }

  function seasonality(series: SeriesInput, opts: SeasonalityOptions = {}): SeasonalityResult {
    const y = interpMissing(series.y);
    const n = y.length;
    if (n < 3) throw new IsoclineError(`series too short: ${n} points (need ≥ 3)`, "tooShort");
    const maxPeriod = Math.max(2, Math.round(opts.maxPeriod ?? Math.min(Math.floor(n / 3), 8640)));
    const scan = scanSeasonality(y, maxPeriod);

    let bestPeriod: number | null = null;
    let strength = 0;
    const best = scan.candidates[0];
    if (best) {
      const d = decomposeCore(y, best.period, false, 2);
      strength = d.seasonalStrength;
      if (strength >= 0.2) bestPeriod = best.period;
    }

    return {
      bestPeriod,
      strength,
      acf: scan.acf,
      lags: scan.lags,
      periodogram: scan.periodogram,
      frequencies: scan.frequencies,
      candidates: scan.candidates,
    };
  }

  function changepoints(series: SeriesInput, opts: ChangepointOptions = {}): ChangepointResult {
    const y = interpMissing(series.y);
    const n = y.length;
    if (n < 3) throw new IsoclineError(`series too short: ${n} points (need ≥ 3)`, "tooShort");
    const minSegment = clamp(Math.round(opts.minSegment ?? 10), 2, Math.max(2, Math.floor(n / 2)));
    const maxCp = clamp(Math.round(opts.maxChangepoints ?? 10), 1, 50);
    const threshold = opts.threshold ?? 3.0;

    // robust noise scale from first differences
    const diffs: number[] = [];
    for (let i = 1; i < n; i++) diffs.push(at(y, i) - at(y, i - 1));
    const sigmaHat = Math.max(1e-9, (1.4826 * madOf(diffs)) / Math.SQRT2);

    // prefix sums for O(1) segment means
    const pre = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) pre[i + 1] = at(pre, i) + at(y, i);
    const segMean = (a: number, b: number): number => (b > a ? (at(pre, b) - at(pre, a)) / (b - a) : 0);

    const found: Changepoint[] = [];
    const recurse = (a: number, b: number, depth: number): void => {
      if (depth <= 0 || b - a < 2 * minSegment) return;
      const segN = b - a;
      let bestS = -1;
      let bestG = 0;
      let bestM1 = 0;
      let bestM2 = 0;
      for (let s = a + minSegment; s <= b - minSegment; s++) {
        const n1 = s - a;
        const n2 = b - s;
        const m1 = segMean(a, s);
        const m2 = segMean(s, b);
        const g = Math.sqrt((n1 * n2) / segN) * (Math.abs(m1 - m2) / sigmaHat);
        if (g > bestG) {
          bestG = g;
          bestS = s;
          bestM1 = m1;
          bestM2 = m2;
        }
      }
      if (bestS >= 0 && bestG > threshold) {
        found.push({ index: bestS, meanBefore: bestM1, meanAfter: bestM2 });
        recurse(a, bestS, depth - 1);
        recurse(bestS, b, depth - 1);
      }
    };
    recurse(0, n, maxCp);
    found.sort((a, b) => a.index - b.index);

    // step array of segment means
    const means = new Float64Array(n);
    let prev = 0;
    for (let c = 0; c <= found.length; c++) {
      const end = c < found.length ? found[c]!.index : n;
      const m = c === 0 ? segMean(0, end) : found[c - 1]!.meanAfter;
      for (let i = prev; i < end; i++) means[i] = m;
      prev = end;
    }

    return { changepoints: found, means };
  }

  function backtest(series: SeriesInput, opts: BacktestOptions = {}): BacktestResult {
    const yAll = interpMissing(series.y);
    const n = yAll.length;
    if (n < 3) throw new IsoclineError(`series too short: ${n} points (need ≥ 3)`, "tooShort");
    const h = clamp(Math.round(opts.horizon ?? 24), 1, Math.max(1, Math.floor(n / 3)));
    const maxFolds = Math.max(1, Math.floor((n - 8) / h));
    const folds = clamp(Math.round(opts.folds ?? 3), 1, maxFolds);
    const seed = (opts.seed ?? 42) >>> 0;

    // resolve period once on the full series (contract: auto resolved once)
    let period: number | null = null;
    if (opts.period === "auto" || opts.period == null) period = resolveAutoPeriod(yAll);
    else if (opts.period >= 2) period = Math.round(opts.period);

    const models: ModelKind[] =
      opts.models && opts.models.length > 0 ? opts.models : ["stl_ets", "ets", "ar", "snaive"];

    const rows: BacktestRow[] = [];
    for (const m of models) {
      let se = 0;
      let ae = 0;
      let smape = 0;
      let smapeN = 0;
      let inside = 0;
      let total = 0;
      let used: Exclude<ModelKind, "auto"> = m === "auto" ? "ets" : (m as Exclude<ModelKind, "auto">);
      for (let i = 0; i < folds; i++) {
        const trainLen = n - (folds - i) * h;
        if (trainLen < 8) continue;
        const sub: SeriesInput = { y: yAll.slice(0, trainLen) };
        let res: ForecastResult;
        try {
          res = forecast(sub, { model: m, horizon: h, period: period ?? "auto", level: 0.95, paths: 0, seed: seed + i });
        } catch {
          continue; // fold too short for this model — skip
        }
        used = res.model as Exclude<ModelKind, "auto">;
        for (let k = 0; k < h; k++) {
          const actual = yAll[trainLen + k];
          if (actual === undefined || !Number.isFinite(actual)) continue;
          const e = actual - at(res.point, k);
          se += e * e;
          ae += Math.abs(e);
          const den = Math.abs(actual) + Math.abs(at(res.point, k));
          if (den > 1e-12) {
            smape += (200 * Math.abs(e)) / den;
            smapeN++;
          }
          if (at(res.lower, k) <= actual && actual <= at(res.upper, k)) inside++;
          total++;
        }
      }
      if (total === 0) continue;
      const rmse = Math.sqrt(se / total);
      rows.push({
        model: used,
        folds,
        rmse: Number.isFinite(rmse) ? rmse : 0,
        mae: Number.isFinite(ae / total) ? ae / total : 0,
        smape: smapeN > 0 ? smape / smapeN : 0,
        coverage: total > 0 ? inside / total : 0,
      });
    }
    return { rows, horizon: h, folds };
  }

  function interpolate(series: SeriesInput, _opts?: InterpolateOptions): Float64Array {
    return interpMissing(series.y);
  }

  return {
    forecast,
    detectAnomalies,
    decompose,
    seasonality,
    changepoints,
    backtest,
    interpolate,
    version: "0.1.0-mock",
  };
}
