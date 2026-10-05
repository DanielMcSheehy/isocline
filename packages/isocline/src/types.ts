// Shared Isocline contract types. Mirrors CONTRACT.md §2 — keep in sync.

/** A univariate series. `t` is optional epoch-millis (regular spacing assumed
 *  when absent). `y` may contain NaN for missing values. */
export interface SeriesInput {
  y: Float64Array | number[];
  t?: Float64Array | number[];
}

export type ModelKind = "auto" | "stl_ets" | "ets" | "ar" | "snaive" | "naive";

export interface ForecastOptions {
  model?: ModelKind; // default "auto"
  horizon?: number; // default 24, 1..10000
  period?: number | "auto"; // default "auto"
  level?: number; // PI coverage, default 0.95, (0,1)
  paths?: number; // bootstrap simulation paths, default 200, 0..2000
  seed?: number; // default 42 (determinism)
}

export interface Metrics {
  rmse: number;
  mae: number;
  smape: number;
}

export interface ForecastResult {
  model: ModelKind; // resolved model (never "auto")
  period: number | null; // detected/used period, null if none
  horizon: number;
  level: number;
  point: Float64Array; // length h
  lower: Float64Array; // length h
  upper: Float64Array; // length h
  fitted: Float64Array; // length n, in-sample one-step fits
  residuals: Float64Array; // length n
  paths: Float64Array | null; // paths*h flat, null when paths=0
  pathsN: number;
  trend: Float64Array | null; // length h, projected trend (stl_ets only)
  seasonal: Float64Array | null; // length h, seasonal projection (stl_ets/snaive)
  metrics: Metrics; // in-sample one-step metrics
  params: Record<string, number>;
  warnings: string[];
}

export type AnomalyMethod = "stl" | "madz" | "iqr" | "ewma";

export interface AnomalyOptions {
  method?: AnomalyMethod; // default "stl"
  period?: number | "auto"; // default "auto"; used by stl/madz/ewma
  threshold?: number; // default: stl/madz 3.5 (modified z), iqr 1.5 (k), ewma 3.0 (L)
  lambda?: number; // ewma only, default 0.3, (0,1]
  direction?: "both" | "high" | "low"; // default "both"
}

export interface Anomaly {
  index: number; // index into y
  score: number; // |modified z| or normalized stat (>= threshold)
  expected: number; // model expectation at that index
  observed: number; // y[index]
  direction: "spike" | "dip";
}

export interface AnomalyResult {
  method: AnomalyMethod;
  threshold: number;
  anomalies: Anomaly[]; // sorted by index
  scores: Float64Array; // length n, signed score (positive = above expected)
  expected: Float64Array; // length n
}

export interface DecomposeOptions {
  period?: number | "auto"; // default "auto"
  robust?: boolean; // default true
  seasons?: number; // inner iterations, default 3
}

export interface DecomposeResult {
  period: number;
  trend: Float64Array; // length n
  seasonal: Float64Array; // length n
  resid: Float64Array; // length n
  seasonalStrength: number; // 1 - var(resid)/var(seasonal+resid), clamped [0,1]
  robustWeights: Float64Array | null; // length n when robust
}

export interface SeasonalityOptions {
  maxPeriod?: number; // default min(n/3, 8640), >= 2
}

export interface SeasonalityCandidate {
  period: number;
  strength: number;
  source: "acf" | "spectral";
}

export interface SeasonalityResult {
  bestPeriod: number | null; // null if strength < 0.2
  strength: number; // seasonal strength in [0,1]
  acf: Float64Array; // autocorrelation, lags 0..maxLag
  lags: Float64Array; // 0..maxLag
  periodogram: Float64Array; // power, length maxLag+1
  frequencies: Float64Array; // cycles/sample, length maxLag+1
  candidates: SeasonalityCandidate[]; // ranked, max 5
}

export interface ChangepointOptions {
  minSegment?: number; // default 10
  maxChangepoints?: number; // default 10
  threshold?: number; // default 3.0 (sigma units)
}

export interface Changepoint {
  index: number;
  meanBefore: number;
  meanAfter: number;
}

export interface ChangepointResult {
  changepoints: Changepoint[]; // sorted by index
  means: Float64Array; // length n, step function of segment means
}

export interface BacktestOptions {
  models?: ModelKind[]; // default ["stl_ets","ets","ar","snaive"]
  horizon?: number; // default 24
  folds?: number; // default 3 (rolling origin)
  period?: number | "auto";
  seed?: number;
}

export interface BacktestRow extends Metrics {
  model: ModelKind;
  folds: number;
  coverage: number; // fraction of actuals inside [lower,upper]
}

export interface BacktestResult {
  rows: BacktestRow[];
  horizon: number;
  folds: number;
}

export interface InterpolateOptions {
  method?: "linear"; // default linear
}

export type IsoclineErrorCode = "badConfig" | "badOp" | "tooShort" | "badParams" | "internal";

export class IsoclineError extends Error {
  constructor(message: string, public code: IsoclineErrorCode) {
    super(message);
    this.name = "IsoclineError";
  }
}

/** The high-level engine interface (see CONTRACT.md §2). */
export interface Isocline {
  forecast(series: SeriesInput, opts?: ForecastOptions): ForecastResult;
  detectAnomalies(series: SeriesInput, opts?: AnomalyOptions): AnomalyResult;
  decompose(series: SeriesInput, opts?: DecomposeOptions): DecomposeResult;
  seasonality(series: SeriesInput, opts?: SeasonalityOptions): SeasonalityResult;
  changepoints(series: SeriesInput, opts?: ChangepointOptions): ChangepointResult;
  backtest(series: SeriesInput, opts?: BacktestOptions): BacktestResult;
  interpolate(series: SeriesInput, opts?: InterpolateOptions): Float64Array;
  readonly version: string;
}

export type LoadIsocline = (wasmBytes?: ArrayBuffer | Uint8Array) => Promise<Isocline>;
