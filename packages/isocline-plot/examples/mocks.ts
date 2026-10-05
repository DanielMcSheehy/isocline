// Plausible mock results (pure TS) to exercise every isocline-plot code path
// before the wasm engine lands. Contract-shaped, clearly not production math.
import { genSeries, mulberry32 } from "isocline";
import type {
  ForecastResult,
  AnomalyResult,
  DecomposeResult,
  SeasonalityResult,
  ChangepointResult,
  BacktestResult,
  SeriesInput,
  CorrelationResult,
  MajorityResult,
  CategoryOutlierResult,
  LowVarianceResult,
  AutoChartResult,
  AutoChartKind,
} from "isocline";

const P = 24;
const H = 48;

export function mockSeries(): SeriesInput & { truth: ReturnType<typeof genSeries> } {
  const g = genSeries({ n: 720, period: P, seed: 7 });
  return { y: g.y, t: g.t, truth: g };
}

function std(v: Float64Array): number {
  let m = 0;
  for (const x of v) m += x;
  m /= v.length;
  let s = 0;
  for (const x of v) s += (x - m) ** 2;
  return Math.sqrt(s / v.length);
}

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? 0;
  return a + (b - a) * (pos - lo);
}

export function mockForecast(s: SeriesInput): ForecastResult {
  const rng = mulberry32(42);
  const y = s.y;
  const n = y.length;
  const point = new Float64Array(H);
  const drift = ((y[n - 1] ?? 0) - (y[n - 25] ?? 0)) / P / P;
  for (let k = 0; k < H; k++) point[k] = (y[n - P + (k % P)] ?? 0) + drift * k * 0.9;
  // residual σ from snaive in-sample
  const resid: number[] = [];
  for (let i = P; i < n; i++) resid.push(Number(y[i]) - Number(y[i - P]));
  const sorted = [...resid].sort((a, b) => a - b);
  const pathsN = 200;
  const paths = new Float64Array(pathsN * H);
  for (let p = 0; p < pathsN; p++) {
    let carry = 0;
    for (let k = 0; k < H; k++) {
      const r = sorted[Math.floor(rng() * sorted.length)] ?? 0;
      carry = 0.6 * carry + r;
      paths[p * H + k] = point[k] + carry;
    }
  }
  const lower = new Float64Array(H);
  const upper = new Float64Array(H);
  for (let k = 0; k < H; k++) {
    const col = Array.from({ length: pathsN }, (_, p) => paths[p * H + k]).sort((a, b) => a - b);
    lower[k] = quantile(col, 0.025);
    upper[k] = quantile(col, 0.975);
    point[k] = quantile(col, 0.5);
  }
  const fitted = new Float64Array(n);
  const res = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    fitted[i] = i >= P ? Number(y[i - P]) : Number(y[i]);
    res[i] = Number(y[i]) - fitted[i];
  }
  const sigma = std(res);
  const seasonal = new Float64Array(H);
  for (let k = 0; k < H; k++) seasonal[k] = (point[k] ?? 0) - (y[n - P + (k % P)] ?? 0);
  const trend = new Float64Array(H);
  for (let k = 0; k < H; k++) trend[k] = (point[k] ?? 0) - (seasonal[k] ?? 0);
  return {
    model: "stl_ets",
    period: P,
    horizon: H,
    level: 0.95,
    point,
    lower,
    upper,
    fitted,
    residuals: res,
    paths,
    pathsN,
    trend,
    seasonal,
    metrics: { rmse: sigma, mae: sigma * 0.8, smape: 2.3 },
    params: { alpha: 0.41, beta: 0.03, gamma: 0.28, phi: 0.96 },
    warnings: [],
  };
}

export function mockAnomalies(s: SeriesInput): AnomalyResult {
  const y = s.y;
  const n = y.length;
  const win = P;
  const expected = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    let c = 0;
    for (let k = -win; k <= win; k++) {
      const j = i + k;
      if (j >= 0 && j < n && Number.isFinite(y[j])) {
        acc += Number(y[j]);
        c++;
      }
    }
    expected[i] = acc / Math.max(1, c);
  }
  const r = Array.from({ length: n }, (_, i) => Number(y[i]) - expected[i]);
  const med = quantile([...r].sort((a, b) => a - b), 0.5);
  const mad = quantile([...r.map((v) => Math.abs(v - med))].sort((a, b) => a - b), 0.5) || 1e-9;
  const scores = new Float64Array(n);
  const anomalies: import("isocline").Anomaly[] = [];
  for (let i = 0; i < n; i++) {
    scores[i] = (0.6745 * (r[i]! - med)) / mad;
    if (Math.abs(scores[i]!) > 3.5 && Number.isFinite(y[i])) {
      anomalies.push({ index: i, score: Math.abs(scores[i]!), expected: expected[i]!, observed: Number(y[i]), direction: scores[i]! > 0 ? "spike" : "dip" });
    }
  }
  return { method: "stl", threshold: 3.5, anomalies, scores, expected };
}

export function mockDecompose(s: SeriesInput): DecomposeResult {
  const y = s.y;
  const n = y.length;
  const trend = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    let c = 0;
    for (let k = -P; k <= P; k++) {
      const j = i + k;
      if (j >= 0 && j < n && Number.isFinite(y[j])) {
        acc += Number(y[j]);
        c++;
      }
    }
    trend[i] = acc / Math.max(1, c);
  }
  const seasonal = new Float64Array(n);
  const phaseSum = new Float64Array(P);
  const phaseCnt = new Float64Array(P);
  for (let i = 0; i < n; i++) {
    const p = i % P;
    phaseSum[p]! += Number(y[i]) - trend[i]!;
    phaseCnt[p]!++;
  }
  for (let i = 0; i < n; i++) seasonal[i] = phaseSum[i % P]! / Math.max(1, phaseCnt[i % P]!);
  const resid = new Float64Array(n);
  for (let i = 0; i < n; i++) resid[i] = Number(y[i]) - trend[i]! - seasonal[i]!;
  const vr = std(resid) ** 2;
  const vsr = std(Float64Array.from(seasonal, (v) => v + (resid[0] ?? 0))) ** 2;
  return {
    period: P,
    trend,
    seasonal,
    resid,
    seasonalStrength: Math.max(0, Math.min(1, 1 - vr / Math.max(1e-9, vsr))),
    robustWeights: new Float64Array(n).fill(1),
  };
}

export function mockSeasonality(s: SeriesInput): SeasonalityResult {
  const y = Array.from(s.y, (v) => (Number.isFinite(v) ? v : 0));
  const n = y.length;
  const maxLag = Math.min(96, Math.floor(n / 2));
  const m = y.reduce((a, b) => a + b, 0) / n;
  const denom = y.reduce((a, b) => a + (b - m) ** 2, 0) || 1;
  const acf = new Float64Array(maxLag + 1);
  for (let k = 0; k <= maxLag; k++) {
    let acc = 0;
    for (let i = 0; i + k < n; i++) acc += (y[i]! - m) * (y[i + k]! - m);
    acf[k] = acc / denom;
  }
  const lags = Float64Array.from({ length: maxLag + 1 }, (_, k) => k);
  const nfft = 2048;
  const pow = new Float64Array(maxLag + 1);
  const freq = new Float64Array(maxLag + 1);
  // crude periodogram via ACF DFT (good enough for a mock)
  for (let k = 1; k <= maxLag; k++) {
    let acc = 0;
    for (let t = 1; t <= maxLag; t++) acc += (acf[t] ?? 0) * Math.cos((2 * Math.PI * k * t) / nfft);
    pow[k] = Math.abs(acc);
    freq[k] = k / nfft;
  }
  let best = 0;
  let bestV = 0;
  for (let k = 2; k <= maxLag; k++) {
    const v = Math.max(0, acf[k] ?? 0) * (pow[k] ?? 0);
    if (v > bestV) {
      bestV = v;
      best = k;
    }
  }
  const strength = Math.max(0, Math.min(1, (acf[best] ?? 0) * 1.1));
  return {
    bestPeriod: strength >= 0.2 ? best : null,
    strength,
    acf,
    lags,
    periodogram: pow,
    frequencies: freq,
    candidates: [
      { period: best, strength, source: "acf" },
      { period: Math.round(1 / (freq[1] ?? 1e-9)), strength: strength * 0.6, source: "spectral" },
    ],
  };
}

export function mockChangepoints(s: SeriesInput): ChangepointResult {
  const y = Array.from(s.y, (v) => (Number.isFinite(v) ? v : 0));
  const n = y.length;
  const cps: { index: number; meanBefore: number; meanAfter: number }[] = [];
  const seg = [0];
  // single-pass CUSUM-ish split
  let acc = 0;
  let mu = y[0] ?? 0;
  const sigma = std(Float64Array.from(y)) || 1e-9;
  for (let i = 1; i < n; i++) {
    acc += (y[i]! - mu) / sigma;
    if (Math.abs(acc) > n * 0.02 && i - seg[seg.length - 1]! > 60) {
      const before = y.slice(seg[seg.length - 1], i).reduce((a, b) => a + b, 0) / (i - seg[seg.length - 1]!);
      const after = y.slice(i, Math.min(n, i + 60)).reduce((a, b) => a + b, 0) / Math.min(60, n - i);
      cps.push({ index: i, meanBefore: before, meanAfter: after });
      seg.push(i);
      acc = 0;
      mu = after;
    } else {
      mu = mu * 0.99 + y[i]! * 0.01;
    }
  }
  const means = new Float64Array(n);
  let cur = 0;
  for (let i = 0; i < n; i++) {
    if (cur < cps.length && cps[cur]!.index <= i) cur++;
    const lo = cur === 0 ? 0 : cps[cur - 1]!.index;
    const hi = cur === cps.length ? n : cps[cur]!.index;
    let acc2 = 0;
    for (let j = lo; j < hi; j++) acc2 += y[j]!;
    means[i] = acc2 / Math.max(1, hi - lo);
  }
  return { changepoints: cps.slice(0, 10), means };
}

export function mockBacktest(): BacktestResult {
  const rows = [
    { model: "stl_ets" as const, folds: 3, rmse: 1.82, mae: 1.41, smape: 2.1, coverage: 0.94 },
    { model: "ets" as const, folds: 3, rmse: 2.35, mae: 1.86, smape: 2.9, coverage: 0.89 },
    { model: "ar" as const, folds: 3, rmse: 2.71, mae: 2.12, smape: 3.4, coverage: 0.85 },
    { model: "snaive" as const, folds: 3, rmse: 3.02, mae: 2.44, smape: 3.9, coverage: 0.81 },
  ];
  return { rows, horizon: 24, folds: 3 };
}

// ---- tabular detectors (CONTRACT §11) --------------------------------------

/** Correlated (a, b) sample + honest Pearson r / OLS computed from the data. */
export function mockCorrelation(n = 500): { a: number[]; b: number[]; res: CorrelationResult } {
  const rng = mulberry32(11);
  const a: number[] = [];
  const b: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = rng() * 100;
    a.push(x);
    b.push(2.1 * x + 5 + (rng() - 0.5) * 60);
  }
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    cov += (a[i]! - ma) * (b[i]! - mb);
    va += (a[i]! - ma) ** 2;
    vb += (b[i]! - mb) ** 2;
  }
  const r = cov / Math.sqrt(va * vb);
  const slope = cov / va;
  const intercept = mb - slope * ma;
  const tStat = Math.abs(r) * Math.sqrt((n - 2) / Math.max(1e-12, 1 - r * r));
  return {
    a,
    b,
    res: { n, r, tStat, significant: tStat > 2, slope, intercept },
  };
}

export function mockMajority(): MajorityResult {
  const raw: [string, number][] = [
    ["success", 640],
    ["timeout", 180],
    ["rate-limit", 120],
    ["validation", 60],
  ];
  const n = raw.reduce((s, [, c]) => s + c, 0);
  const counts = raw
    .map(([label, count]) => ({ label, count, proportion: count / n }))
    .sort((x, y) => y.count - x.count);
  return {
    n,
    threshold: 0.5,
    dominant: counts[0]?.label ?? null,
    dominantProportion: counts[0]?.proportion ?? 0,
    isMajority: (counts[0]?.proportion ?? 0) >= 0.5,
    counts,
  };
}

/** Type-7 quantile (linear interpolation) over a sorted copy. */
function quantileType7(values: number[], q: number): number {
  const sorted = [...values].sort((x, y) => x - y);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? a;
  return a + (b - a) * (pos - lo);
}

export function mockCategoryOutlier(): CategoryOutlierResult {
  const raw: [string, number][] = [
    ["checkout", 412],
    ["search", 108],
    ["upload", 121],
    ["auth", 97],
    ["email", 6],
    ["reports", 113],
    ["export", 84],
    ["media", 102],
  ];
  const values = raw.map(([, v]) => v);
  const q1 = quantileType7(values, 0.25);
  const q3 = quantileType7(values, 0.75);
  const iqr = q3 - q1;
  const lowerFence = q1 - 1.5 * iqr;
  const upperFence = q3 + 1.5 * iqr;
  const categories = raw
    .map(([label, value]) => ({
      label,
      value,
      isOutlier: value > upperFence || value < lowerFence,
      direction: value > q3 ? ("high" as const) : ("low" as const),
    }))
    .sort((x, y) => y.value - x.value);
  return {
    agg: "sum",
    factor: 1.5,
    q1,
    q3,
    iqr,
    lowerFence,
    upperFence,
    outlierCount: categories.filter((c) => c.isOutlier).length,
    categories,
  };
}

export function mockLowVariance(n = 120): { values: number[]; res: LowVarianceResult } {
  const rng = mulberry32(3);
  const values = Array.from({ length: n }, () => 42 + (rng() - 0.5) * 0.06);
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const stdDev = Math.sqrt(variance);
  const cv = stdDev / Math.abs(mean || 1e-9);
  const maxCv = 0.01;
  return {
    values,
    res: { n, mean, variance, stdDev, cv, maxCv, isFlat: cv <= maxCv },
  };
}

// ---- auto-chart (CONTRACT §11) ---------------------------------------------

export function mockAuto(kind: AutoChartKind, series: SeriesInput, deps: {
  forecast: ForecastResult;
  anomalies: AnomalyResult;
}): AutoChartResult {
  const reason: Record<AutoChartKind, string> = {
    forecast: "seasonality strength 0.91 ≥ 0.2 → forecast + anomalies",
    anomalies: "aperiodic series → anomaly detection on raw",
    correlation: "y + y2 present → correlation (scatter is the chart)",
    majority: "categories present · dominant 64% ≥ threshold 0.5",
    category_outlier: "categories present · 2 IQR outliers detected",
    low_variance: "cv 0.0004 ≤ max_cv 0.01 → flat wins",
    distribution: "categories present · no outliers · no majority → distribution",
  };
  const base: AutoChartResult = { kind, reason: reason[kind] };
  switch (kind) {
    case "forecast":
      return { ...base, series, forecast: deps.forecast };
    case "anomalies":
      return { ...base, series, anomalies: deps.anomalies };
    case "correlation":
      // caller supplies the columns as input {y: a, y2: b} to autoChartPlot
      return { ...base, correlation: mockCorrelation().res };
    case "majority":
      return { ...base, majority: mockMajority() };
    case "category_outlier":
      return { ...base, categoryOutlier: mockCategoryOutlier() };
    case "low_variance":
      return { ...base, lowVariance: mockLowVariance().res };
    case "distribution":
      return { ...base, categoryOutlier: mockCategoryOutlier() };
  }
}
