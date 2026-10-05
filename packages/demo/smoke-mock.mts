// Node smoke test for the mock engine's contract invariants (dev-only;
// bundled with esbuild and run via node — not part of the vite app).
import { createMockEngine } from "./src/engine-mock.js";
import { genSeries } from "isocline";

const eng = createMockEngine();
let failures = 0;
function check(name: string, ok: boolean): void {
  if (!ok) {
    failures++;
    console.error("FAIL", name);
  } else {
    console.log("ok  ", name);
  }
}
const finite = (a: ArrayLike<number>): boolean => Array.prototype.every.call(a, (v) => Number.isFinite(v));

const data = genSeries({ n: 720, seed: 42 });
const series = { y: data.y, t: data.t };

// forecast
const fc = eng.forecast(series, { horizon: 48, paths: 200, seed: 42 });
check("forecast lengths", fc.point.length === 48 && fc.lower.length === 48 && fc.upper.length === 48 && fc.fitted.length === 720 && fc.residuals.length === 720);
check("forecast paths shape", fc.paths !== null && fc.paths!.length === 200 * 48);
check("point within [lower,upper]", Array.from(fc.point).every((p, i) => p >= fc.lower[i]! - 1e-12 && p <= fc.upper[i]! + 1e-12));
check("forecast finite metrics", finite([fc.metrics.rmse, fc.metrics.mae, fc.metrics.smape]));
check("model resolved (never auto)", fc.model !== "auto");
const fc2 = eng.forecast(series, { horizon: 48, paths: 200, seed: 42 });
check("forecast deterministic", fc2.point.every((v, i) => v === fc.point[i]) && fc2.lower.every((v, i) => v === fc.lower[i]));
check("auto detects period 24", fc.period === 24);
const fcPaths0 = eng.forecast(series, { paths: 0 });
check("paths=0 → null", fcPaths0.paths === null);

// anomalies
const an = eng.detectAnomalies(series, { method: "madz", threshold: 3.5 });
check("anomalies sorted by index", an.anomalies.every((a, i) => i === 0 || a.index > an.anomalies[i - 1]!.index));
check("anomaly scores ≥ threshold", an.anomalies.every((a) => a.score > an.threshold));
check("scores/expected lengths", an.scores.length === 720 && an.expected.length === 720);
for (const m of ["stl", "madz", "iqr", "ewma"] as const) {
  const r = eng.detectAnomalies(series, { method: m });
  check(`anomaly method ${m} finds events`, r.anomalies.length > 0);
}

// decompose
const dc = eng.decompose(series);
check("decompose lengths", dc.trend.length === 720 && dc.seasonal.length === 720 && dc.resid.length === 720);
check("decompose strength in [0,1]", dc.seasonalStrength >= 0 && dc.seasonalStrength <= 1);
check("decompose period detected", dc.period === 24);
check("robust weights present", dc.robustWeights !== null && dc.robustWeights!.length === 720);

// seasonality
const ss = eng.seasonality(series, { maxPeriod: 168 });
check("seasonality best period 24", ss.bestPeriod === 24);
check("acf/lags lengths", ss.acf.length === ss.lags.length && ss.acf.length === 169);
check("periodogram/frequencies lengths", ss.periodogram.length === ss.frequencies.length);
check("candidates ≤ 5", ss.candidates.length <= 5 && ss.candidates.length > 0);
check("seasonality strength high", ss.strength > 0.5);

// changepoints
const cp = eng.changepoints(series);
check("changepoints sorted", cp.changepoints.every((c, i) => i === 0 || c.index > cp.changepoints[i - 1]!.index));
check("means step array length", cp.means.length === 720);
check("shift found near 0.6n", cp.changepoints.some((c) => Math.abs(c.index - Math.floor(720 * 0.6)) < 10));

// backtest
const bt = eng.backtest(series, { models: ["stl_ets", "ets", "ar", "snaive", "naive"], horizon: 24, folds: 3 });
check("backtest rows", bt.rows.length === 5);
check("backtest metrics finite + coverage", bt.rows.every((r) => Number.isFinite(r.rmse) && Number.isFinite(r.mae) && Number.isFinite(r.smape) && r.coverage >= 0 && r.coverage <= 1));

// interpolate
const interp = eng.interpolate(series);
check("interpolate fills NaNs", Array.prototype.every.call(interp, (v) => Number.isFinite(v)) && interp.length === 720);

// tooShort guard
let threw = false;
try {
  eng.forecast({ y: [1, 2] });
} catch {
  threw = true;
}
check("tooShort error on n<3", threw);

check("mock version string", eng.version === "0.1.0-mock");

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nall mock-engine invariant checks passed");
