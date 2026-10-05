// High-level Isocline engine: typed API over the flat wasm ABI (CONTRACT §2/§3).
import { Abi, OP, instantiate, defaultWasmBytes } from "./abi.js";
import {
  IsoclineError,
  type AnomalyOptions,
  type AnomalyResult,
  type AutoChartOptions,
  type AutoChartResult,
  type BacktestOptions,
  type BacktestResult,
  type CategoryAgg,
  type CategoryOutlierResult,
  type ChangepointOptions,
  type ChangepointResult,
  type CorrelationResult,
  type DecomposeOptions,
  type DecomposeResult,
  type ForecastOptions,
  type ForecastResult,
  type GenericSeries,
  type InterpolateOptions,
  type Isocline,
  type LowVarianceResult,
  type MajorityResult,
  type Metrics,
  type ModelKind,
  type SeasonalityOptions,
  type SeasonalityResult,
  type SeriesInput,
} from "./types.js";

const VERSION = "0.1.0";

/** period: "auto" → null in JSON (CONTRACT §3). */
const p = (period: number | "auto" | undefined): number | null =>
  period === undefined || period === "auto" ? null : period;

function num(x: unknown, fallback: number): number {
  return typeof x === "number" && Number.isFinite(x) ? x : fallback;
}

function asF64(x: unknown): Float64Array {
  return x instanceof Float64Array ? x : Float64Array.from(x as ArrayLike<number>);
}

function cleanArray(x: unknown): number[] {
  return Array.isArray(x) ? x.filter((v) => typeof v === "number") : [];
}

function finiteOrNull(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

export class WasmIsocline implements Isocline {
  readonly version = VERSION;
  constructor(private abi: Abi) {}

  forecast(series: SeriesInput, opts: ForecastOptions = {}): ForecastResult {
    const cfg = JSON.stringify({
      model: opts.model ?? "auto",
      horizon: opts.horizon ?? 24,
      period: p(opts.period),
      level: opts.level ?? 0.95,
      paths: opts.paths ?? 200,
      seed: opts.seed ?? 42,
    });
    const h = this.abi.call(OP.forecast, cfg, series.y);
    const metrics = (h.metrics ?? {}) as Record<string, unknown>;
    const paths = h.channels && "paths" in h.channels ? this.abi.channel(h, "paths") : null;
    return {
      model: (h.model as ModelKind) ?? "naive",
      period: finiteOrNull(h.period),
      horizon: num(h.horizon, 24),
      level: num(h.level, 0.95),
      point: this.abi.channel(h, "point"),
      lower: this.abi.channel(h, "lower"),
      upper: this.abi.channel(h, "upper"),
      fitted: this.abi.channel(h, "fitted"),
      residuals: this.abi.channel(h, "residuals"),
      paths: paths && paths.length ? paths : null,
      pathsN: num(h.paths_n, paths ? paths.length / Math.max(1, num(h.horizon, 24)) : 0),
      trend: h.channels && "trend" in h.channels ? this.abi.channel(h, "trend") : null,
      seasonal: h.channels && "seasonal" in h.channels ? this.abi.channel(h, "seasonal") : null,
      metrics: {
        rmse: num((metrics as { rmse?: number }).rmse, NaN),
        mae: num((metrics as { mae?: number }).mae, NaN),
        smape: num((metrics as { smape?: number }).smape, NaN),
      } satisfies Metrics,
      params: (h.params as Record<string, number>) ?? {},
      warnings: Array.isArray(h.warnings) ? (h.warnings as string[]) : [],
    };
  }

  detectAnomalies(series: SeriesInput, opts: AnomalyOptions = {}): AnomalyResult {
    const cfg = JSON.stringify({
      method: opts.method ?? "stl",
      period: p(opts.period),
      threshold: opts.threshold ?? null,
      lambda: opts.lambda ?? null,
      direction: opts.direction ?? "both",
    });
    const h = this.abi.call(OP.anomalies, cfg, series.y);
    const anomalies = Array.isArray(h.anomalies) ? (h.anomalies as Record<string, unknown>[]) : [];
    return {
      method: (h.method as AnomalyResult["method"]) ?? "stl",
      threshold: num(h.threshold, 3.5),
      anomalies: anomalies.map((a) => ({
        index: num(a.index, 0),
        score: num(a.score, 0),
        expected: num(a.expected, NaN),
        observed: num(a.observed, NaN),
        direction: a.direction === "dip" ? "dip" : "spike",
      })),
      scores: this.abi.channel(h, "scores"),
      expected: this.abi.channel(h, "expected"),
    };
  }

  decompose(series: SeriesInput, opts: DecomposeOptions = {}): DecomposeResult {
    const cfg = JSON.stringify({
      period: p(opts.period),
      robust: opts.robust ?? true,
      seasons: opts.seasons ?? 3,
    });
    const h = this.abi.call(OP.decompose, cfg, series.y);
    return {
      period: num(h.period, 0),
      trend: this.abi.channel(h, "trend"),
      seasonal: this.abi.channel(h, "seasonal"),
      resid: this.abi.channel(h, "resid"),
      seasonalStrength: num(h.seasonal_strength, 0),
      robustWeights: h.channels && "weights" in h.channels ? this.abi.channel(h, "weights") : null,
    };
  }

  seasonality(series: SeriesInput, opts: SeasonalityOptions = {}): SeasonalityResult {
    const cfg = JSON.stringify({ max_period: opts.maxPeriod ?? null });
    const h = this.abi.call(OP.seasonality, cfg, series.y);
    const candidates = Array.isArray(h.candidates) ? (h.candidates as Record<string, unknown>[]) : [];
    return {
      bestPeriod: finiteOrNull(h.best_period),
      strength: num(h.strength, 0),
      acf: this.abi.channel(h, "acf"),
      lags: this.abi.channel(h, "lags"),
      periodogram: this.abi.channel(h, "periodogram"),
      frequencies: this.abi.channel(h, "frequencies"),
      candidates: candidates.map((c) => ({
        period: num(c.period, 0),
        strength: num(c.strength, 0),
        source: c.source === "spectral" ? "spectral" : "acf",
      })),
    };
  }

  changepoints(series: SeriesInput, opts: ChangepointOptions = {}): ChangepointResult {
    const cfg = JSON.stringify({
      min_segment: opts.minSegment ?? null,
      max_changepoints: opts.maxChangepoints ?? null,
      threshold: opts.threshold ?? null,
    });
    const h = this.abi.call(OP.changepoints, cfg, series.y);
    const cps = Array.isArray(h.changepoints) ? (h.changepoints as Record<string, unknown>[]) : [];
    return {
      changepoints: cps.map((c) => ({
        index: num(c.index, 0),
        meanBefore: num(c.mean_before, NaN),
        meanAfter: num(c.mean_after, NaN),
      })),
      means: this.abi.channel(h, "means"),
    };
  }

  backtest(series: SeriesInput, opts: BacktestOptions = {}): BacktestResult {
    const cfg = JSON.stringify({
      models: opts.models ?? ["stl_ets", "ets", "ar", "snaive"],
      horizon: opts.horizon ?? 24,
      folds: opts.folds ?? 3,
      period: p(opts.period),
      seed: opts.seed ?? 42,
    });
    const h = this.abi.call(OP.backtest, cfg, series.y);
    const rows = Array.isArray(h.rows) ? (h.rows as Record<string, unknown>[]) : [];
    return {
      horizon: num(h.horizon, 24),
      folds: num(h.folds, 3),
      rows: rows.map((r) => ({
        model: (r.model as ModelKind) ?? "naive",
        folds: num(r.folds, 0),
        rmse: num(r.rmse, NaN),
        mae: num(r.mae, NaN),
        smape: num(r.smape, NaN),
        coverage: num(r.coverage, NaN),
      })),
    };
  }

  interpolate(series: SeriesInput, _opts: InterpolateOptions = {}): Float64Array {
    const h = this.abi.call(OP.interpolate, "{}", series.y);
    return this.abi.channel(h, "y");
  }

  // --- v1.1 tabular detectors (CONTRACT §11) ---

  correlation(a: ArrayLike<number>, b: ArrayLike<number>): CorrelationResult {
    const h = this.abi.call2(OP.correlation, "{}", a, b);
    return {
      n: num(h.n, 0),
      r: finiteOrNull(h.r),
      tStat: finiteOrNull(h.t_stat),
      significant: h.significant === true,
      slope: num(h.slope, 0),
      intercept: num(h.intercept, 0),
    };
  }

  majority(categories: ReadonlyArray<string>, opts: { threshold?: number } = {}): MajorityResult {
    const { codes, legend } = factorize(categories);
    const cfg = JSON.stringify({ threshold: opts.threshold ?? null, legend });
    const h = this.abi.call2(OP.majority, cfg, codes);
    const counts = Array.isArray(h.counts) ? (h.counts as Record<string, unknown>[]) : [];
    return {
      n: num(h.n, 0),
      threshold: num(h.threshold, 0.5),
      dominant: typeof h.dominant === "string" ? h.dominant : null,
      dominantProportion: num(h.dominant_proportion, 0),
      isMajority: h.is_majority === true,
      counts: counts.map((c) => ({
        label: String(c.label ?? "?"),
        count: num(c.count, 0),
        proportion: num(c.proportion, 0),
      })),
    };
  }

  categoryOutlier(
    categories: ReadonlyArray<string>,
    values: ArrayLike<number>,
    opts: { agg?: CategoryAgg; factor?: number } = {},
  ): CategoryOutlierResult {
    const { codes, legend } = factorize(categories);
    if (values.length !== categories.length) {
      throw new IsoclineError("categoryOutlier: categories and values must be equal length", "badParams");
    }
    const cfg = JSON.stringify({ agg: opts.agg ?? null, factor: opts.factor ?? null, legend });
    const h = this.abi.call2(OP.categoryOutlier, cfg, codes, values);
    const cats = Array.isArray(h.categories) ? (h.categories as Record<string, unknown>[]) : [];
    return {
      agg: (h.agg as CategoryAgg) ?? "sum",
      factor: num(h.factor, 1.5),
      q1: num(h.q1, NaN),
      q3: num(h.q3, NaN),
      iqr: num(h.iqr, NaN),
      lowerFence: num(h.lower_fence, NaN),
      upperFence: num(h.upper_fence, NaN),
      outlierCount: num(h.outlier_count, 0),
      categories: cats.map((c) => ({
        label: String(c.label ?? "?"),
        value: num(c.value, NaN),
        isOutlier: c.is_outlier === true,
        direction: c.direction === "low" ? "low" : "high",
      })),
    };
  }

  lowVariance(values: ArrayLike<number>, opts: { maxCv?: number } = {}): LowVarianceResult {
    const cfg = JSON.stringify({ max_cv: opts.maxCv ?? null });
    const h = this.abi.call2(OP.lowVariance, cfg, values);
    return {
      n: num(h.n, 0),
      mean: num(h.mean, NaN),
      variance: num(h.variance, NaN),
      stdDev: num(h.std_dev, NaN),
      cv: num(h.cv, NaN),
      maxCv: num(h.max_cv, 0.01),
      isFlat: h.is_flat === true,
    };
  }

  autoChart(input: GenericSeries, opts: AutoChartOptions = {}): AutoChartResult {
    const cats = input.categories;
    const y = input.y;
    const y2 = input.y2;

    if (cats && cats.length > 0 && y && y.length === cats.length) {
      const co = this.categoryOutlier(cats, y);
      if (co.outlierCount > 0) {
        const names = co.categories.filter((c) => c.isOutlier).map((c) => c.label).slice(0, 3).join(", ");
        return {
          kind: "category_outlier",
          reason: `${co.outlierCount} of ${co.categories.length} categories sit outside the IQR fences by ${co.agg} (${names})`,
          categoryOutlier: co,
        };
      }
      const mj = this.majority(cats, { threshold: opts.majorityThreshold ?? 0.5 });
      if (mj.isMajority && mj.dominant) {
        return {
          kind: "majority",
          reason: `"${mj.dominant}" dominates: ${(mj.dominantProportion * 100).toFixed(1)}% of ${mj.n} events (threshold ${(mj.threshold * 100).toFixed(0)}%)`,
          majority: mj,
        };
      }
      return {
        kind: "distribution",
        reason: "no IQR outliers and no dominant category - showing the per-category distribution",
        categoryOutlier: co,
      };
    }

    if (cats && cats.length > 0 && !y) {
      const mj = this.majority(cats, { threshold: opts.majorityThreshold ?? 0.5 });
      if (mj.isMajority && mj.dominant) {
        return {
          kind: "majority",
          reason: `"${mj.dominant}" dominates: ${(mj.dominantProportion * 100).toFixed(1)}% of ${mj.n} events`,
          majority: mj,
        };
      }
      return { kind: "distribution", reason: "categorical column with no majority - showing counts", majority: mj };
    }

    if (y && y2 && y.length === y2.length && y.length >= 3) {
      const c = this.correlation(y, y2);
      return {
        kind: "correlation",
        reason: c.significant && c.r !== null
          ? `two numeric measures correlate: Pearson r = ${c.r.toFixed(2)} over n = ${c.n}`
          : "two numeric measures, no significant correlation - scatter",
        correlation: c,
      };
    }

    if (y && y.length >= 3) {
      let yy = Array.from(y as ArrayLike<number>);
      if (yy.some((v) => !Number.isFinite(v))) {
        yy = Array.from(this.interpolate({ y: yy }));
      }
      const lv = this.lowVariance(yy);
      if (lv.isFlat) {
        return {
          kind: "low_variance",
          reason: `measure is essentially flat: cv ${lv.cv.toExponential(1)} <= ${lv.maxCv}`,
          lowVariance: lv,
        };
      }
      const series: SeriesInput = {
        y: yy,
        ...(input.t ? { t: Array.from(input.t as ArrayLike<number>) } : {}),
      };
      const an = this.detectAnomalies(series);
      const s = this.seasonality(series);
      const fc = this.forecast(series, { horizon: opts.forecastHorizon ?? 48 });
      if (s.strength >= 0.2) {
        return {
          kind: "forecast",
          reason: `seasonality detected (period ${s.bestPeriod}, strength ${s.strength.toFixed(2)}) - forecasting with ${fc.model}`,
          forecast: fc,
          anomalies: an,
          series,
        };
      }
      return {
        kind: "anomalies",
        reason: `no seasonal structure (strength ${s.strength.toFixed(2)}) - screening for anomalies: ${an.anomalies.length} flagged`,
        anomalies: an,
        series,
      };
    }

    throw new IsoclineError("autoChart: provide y (time series), y+y2 (two measures), or categories(+y)", "badParams");
  }
}

/** Load the engine. Pass explicit bytes, or let it fetch the sibling wasm asset. */
export async function loadIsocline(wasmBytes?: ArrayBuffer | Uint8Array): Promise<Isocline> {
  const bytes = wasmBytes ?? (await defaultWasmBytes());
  const abi = await instantiate(bytes);
  if (abi.exports.version() !== 1) {
    throw new IsoclineError(`ABI version mismatch: engine ${abi.exports.version()}, wrapper 1`, "internal");
  }
  return new WasmIsocline(abi);
}

// re-export helpers used by tests
export { asF64, cleanArray };

/** Factorize a string column into u32-safe f64 codes + distinct legend. */
function factorize(categories: ReadonlyArray<string>): { codes: Float64Array; legend: string[] } {
  const map = new Map<string, number>();
  const legend: string[] = [];
  const codes = new Float64Array(categories.length);
  for (let i = 0; i < categories.length; i++) {
    const c = categories[i] ?? "";
    let idx = map.get(c);
    if (idx === undefined) {
      idx = legend.length;
      legend.push(c);
      map.set(c, idx);
    }
    codes[i] = idx;
  }
  return { codes, legend };
}
