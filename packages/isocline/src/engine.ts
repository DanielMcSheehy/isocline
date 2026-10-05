// High-level Isocline engine: typed API over the flat wasm ABI (CONTRACT §2/§3).
import { Abi, OP, instantiate, defaultWasmBytes } from "./abi.js";
import {
  IsoclineError,
  type AnomalyOptions,
  type AnomalyResult,
  type BacktestOptions,
  type BacktestResult,
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
