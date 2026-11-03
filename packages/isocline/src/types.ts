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

export interface AnomalyOptions extends TimeWindow {
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
  anomalies: Anomaly[]; // sorted by index; only those inside `window` when one was requested
  scores: Float64Array; // length n, signed score (positive = above expected)
  expected: Float64Array; // length n
  window?: AppliedWindow; // present when a TimeWindow (lookback/since/lastPoints) was applied
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

/** The high-level engine interface (see CONTRACT.md §2 and §11). */
export interface Isocline {
  forecast(series: SeriesInput, opts?: ForecastOptions): ForecastResult;
  detectAnomalies(series: SeriesInput, opts?: AnomalyOptions): AnomalyResult;
  decompose(series: SeriesInput, opts?: DecomposeOptions): DecomposeResult;
  seasonality(series: SeriesInput, opts?: SeasonalityOptions): SeasonalityResult;
  changepoints(series: SeriesInput, opts?: ChangepointOptions): ChangepointResult;
  backtest(series: SeriesInput, opts?: BacktestOptions): BacktestResult;
  interpolate(series: SeriesInput, opts?: InterpolateOptions): Float64Array;
  correlation(a: ArrayLike<number>, b: ArrayLike<number>): CorrelationResult;
  majority(categories: ReadonlyArray<string>, opts?: { threshold?: number }): MajorityResult;
  categoryOutlier(
    categories: ReadonlyArray<string>,
    values: ArrayLike<number>,
    opts?: { agg?: CategoryAgg; factor?: number },
  ): CategoryOutlierResult;
  lowVariance(values: ArrayLike<number>, opts?: { maxCv?: number }): LowVarianceResult;
  autoChart(input: GenericSeries, opts?: AutoChartOptions): AutoChartResult;
  readonly version: string;
}

export type LoadIsocline = (wasmBytes?: ArrayBuffer | Uint8Array) => Promise<Isocline>;

// --- v1.1: tabular detectors + auto-chart (CONTRACT §11) ---

export interface CorrelationResult {
  n: number;
  r: number | null; // Pearson; null when either input has zero variance
  tStat: number | null;
  significant: boolean; // |t| > 2 (normal approximation)
  slope: number; // OLS fit of b on a
  intercept: number;
}

export interface MajorityResult {
  n: number;
  threshold: number; // default 0.5
  dominant: string | null;
  dominantProportion: number;
  isMajority: boolean;
  counts: { label: string; count: number; proportion: number }[]; // sorted desc
}

export type CategoryAgg = "sum" | "mean" | "count" | "median";

export interface CategoryOutlierResult {
  agg: CategoryAgg;
  factor: number; // IQR multiplier, default 1.5
  q1: number;
  q3: number;
  iqr: number;
  lowerFence: number;
  upperFence: number;
  outlierCount: number;
  categories: { label: string; value: number; isOutlier: boolean; direction: "high" | "low" }[]; // sorted by value desc
}

export interface LowVarianceResult {
  n: number;
  mean: number;
  variance: number;
  stdDev: number;
  cv: number; // coefficient of variation (std_dev / |mean|)
  maxCv: number; // default 0.01
  isFlat: boolean;
}

/** Generic column-oriented input for auto-charting. */
export interface GenericSeries {
  y?: ArrayLike<number>; // numeric measure (or the time series)
  y2?: ArrayLike<number>; // second numeric measure (scatter/correlation)
  categories?: ReadonlyArray<string>; // categorical dimension aligned with y
  t?: ArrayLike<number>; // optional timestamps for the y series
}

export type AutoChartKind =
  | "forecast"
  | "anomalies"
  | "correlation"
  | "majority"
  | "category_outlier"
  | "low_variance"
  | "distribution";

export interface AutoChartOptions {
  forecastHorizon?: number; // default 48
  majorityThreshold?: number; // default 0.5
}

export interface AutoChartResult {
  kind: AutoChartKind;
  reason: string; // human-readable explanation of why this chart
  correlation?: CorrelationResult;
  majority?: MajorityResult;
  categoryOutlier?: CategoryOutlierResult;
  lowVariance?: LowVarianceResult;
  forecast?: ForecastResult;
  anomalies?: AnomalyResult;
  series?: SeriesInput; // echoed time-series input for time-series kinds
}

// --- v1.2: time windows, anomaly explanations, auto-detect (CONTRACT §12) ---

export type DurationUnit = "ms" | "s" | "m" | "h" | "d" | "w" | "mo" | "y";
/** e.g. "90s", "15m", "24h", "7d", "2w", "1mo", "1y". `m` = minutes, `mo` = calendar months. */
export type DurationString = `${number}${DurationUnit}`;
/** Milliseconds, or a DurationString. */
export type Duration = number | DurationString;
/** Epoch milliseconds, a Date, or an ISO-8601 string. */
export type TimeLike = number | Date | string;

/** Post-result filter: detection always runs on the full history (so seasonality
 *  and baselines stay intact); only the reported findings are restricted. */
export interface TimeWindow {
  /** Keep results in [now − lookback, now]. Needs timestamps. */
  lookback?: Duration;
  /** Keep results at or after this instant. Needs timestamps. Combined with lookback → the later bound wins. */
  since?: TimeLike;
  /** Reference "now" for lookback. Default: wall clock (Date.now()). "latest" = the newest timestamp in the data. */
  now?: TimeLike | "latest";
  /** Keep results among the last N samples. Works without timestamps. */
  lastPoints?: number;
}

export interface AppliedWindow {
  from: number | null; // epoch ms, inclusive
  to: number | null; // epoch ms, inclusive
  lastPoints: number | null;
  total: number; // results before filtering
  kept: number; // results after filtering
}

export type Severity = "low" | "medium" | "high";

export interface ExplainOptions {
  name?: string; // subject used in sentences, default "series"
  period?: number | null; // seasonal period the detector used (wording only)
  changepoints?: ChangepointResult; // level shifts for "coincides with a shift" context
  formatTime?: (ms: number) => string; // default formatTimestamp (UTC)
}

export interface AnomalyExplanation {
  index: number;
  t: number | null;
  when: string; // formatted time, or "index N"
  direction: "spike" | "dip";
  severity: Severity;
  observed: number;
  expected: number;
  delta: number; // observed − expected
  deltaPct: number | null; // delta / |expected|, null when expected ≈ 0
  score: number;
  threshold: number;
  run: { start: number; end: number; length: number }; // consecutive flagged points, same direction
  levelShift: { index: number; when: string; meanBefore: number; meanAfter: number } | null;
  extreme: "max" | "min" | null; // global max/min of the series
  headline: string; // one line: what happened
  reasons: string[]; // plain-language why, most important first
  text: string; // headline + reasons
}

export type FindingKind = "anomaly" | "frequency_outlier" | "category_outlier";

export interface FindingAt {
  index: number; // index in the analyzed series (bucket index for frequency outliers)
  t: number | null; // epoch ms when timestamped
  label: string; // formatted time or "index N"
}

interface FindingBase {
  subject: string; // e.g. "cpu", "cpu · device-3", "error_code=E42"
  measure: string | null;
  category: string | null;
  severity: Severity;
  score: number; // detector score (|modified z|, IQR distance, …)
  threshold: number;
  summary: string; // "Anomaly detected for cpu at 2026-10-14 13:00 UTC: spike, 182 vs ~120 expected (+52%)"
  explanation: string; // why, in plain language
}

export interface AnomalyFinding extends FindingBase {
  kind: "anomaly";
  at: FindingAt;
  direction: "spike" | "dip";
  observed: number;
  expected: number;
  method: AnomalyMethod;
  details: AnomalyExplanation;
}

export interface FrequencyOutlierFinding extends FindingBase {
  kind: "frequency_outlier";
  category: string;
  at: FindingAt | null; // null when events carry no timestamps (whole-dataset rarity/dominance)
  direction: "high" | "low";
  count: number;
  expected: number; // expected count per bucket (timed) or median category count (untimed)
  bucketMs: number | null;
  details: AnomalyExplanation | null;
}

export interface CategoryOutlierFinding extends FindingBase {
  kind: "category_outlier";
  category: string;
  at: null;
  direction: "high" | "low";
  value: number;
  agg: CategoryAgg;
  fence: number; // the fence that was crossed
  median: number; // midpoint of the IQR band, for context
}

export type Finding = AnomalyFinding | FrequencyOutlierFinding | CategoryOutlierFinding;

/** Arbitrary input for `detect`: a bare numeric array, column-oriented
 *  GenericSeries ({ y, y2?, categories?, t? }), or an array of records. */
export type DetectInput = ArrayLike<number> | GenericSeries | ReadonlyArray<Record<string, unknown>>;

export interface RowFields {
  time?: string; // default: inferred (Date / ISO string / epoch-ms column, or a name like "t", "time", "timestamp")
  value?: string | readonly string[]; // default: every numeric column
  category?: string; // default: first string column with 2..n/2 distinct values
}

export interface DetectOptions<K extends FindingKind = FindingKind> extends TimeWindow {
  kinds?: readonly K[]; // default all
  name?: string; // subject for unnamed numeric input, default "series"
  fields?: RowFields;
  anomaly?: Omit<AnomalyOptions, keyof TimeWindow>; // default { method: "stl" }
  frequency?: {
    bucket?: Duration; // default: auto (coarsest of 1s…1w giving ≥ 100 buckets)
    maxCategories?: number; // default 50 most frequent
    minPoissonZ?: number; // default 3: |count − expected| / √expected must also clear this
  };
  categories?: { agg?: CategoryAgg; factor?: number }; // default sum, 1.5
  context?: boolean; // default true: run seasonality + changepoints for richer explanations
  minSeverity?: Severity; // default "low" (everything)
  sort?: "severity" | "recent"; // default "severity"
  limit?: number; // default: no limit
  formatTime?: (ms: number) => string; // default formatTimestamp (UTC)
}

export interface AnalyzedTarget {
  subject: string;
  kind: "series" | "frequency" | "categories";
  points: number;
}

export interface DetectReport<K extends FindingKind = FindingKind> {
  headline: string; // "3 anomalies and 1 frequency outlier in the last 30d" / "No anomalies detected …"
  summary: string; // headline + one line per finding
  findings: Extract<Finding, { kind: K }>[];
  counts: Record<FindingKind, number>;
  window: AppliedWindow | null;
  analyzed: AnalyzedTarget[];
  skipped: { subject: string; reason: string }[];
}
