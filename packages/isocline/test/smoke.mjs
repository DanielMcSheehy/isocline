// Node smoke test: loads the real wasm engine and asserts contract invariants.
// Run: npm run test:smoke  (from repo root, after npm run build:wasm + build:pythia→build:isocline)
import { loadIsocline, genSeries } from "../dist/index.js";

let passed = 0;
let failed = 0;
const ok = (name, cond, detail = "") => {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name} ${detail}`);
  }
};
const eq = (a, b) => a === b;
const close = (a, b, tol) => Math.abs(a - b) <= tol;

const gen = genSeries({ n: 720, period: 24, seed: 42 });
const series = { y: gen.y, t: gen.t };

console.log("loading engine…");
const engine = await loadIsocline();
ok("engine version", eq(engine.version, "0.1.0"));

// ---- forecast ----
{
  const fc = engine.forecast(series, { model: "stl_ets", horizon: 48, paths: 100, seed: 7 });
  ok("forecast lengths", fc.point.length === 48 && fc.lower.length === 48 && fc.upper.length === 48 && fc.fitted.length === 720 && fc.residuals.length === 720, JSON.stringify({ h: fc.horizon, p: fc.point.length, f: fc.fitted.length }));
  ok("point within PI", fc.point.every((v, i) => v >= fc.lower[i] - 1e-9 && v <= fc.upper[i] + 1e-9));
  ok("PI ordered", fc.lower.every((v, i) => v <= fc.upper[i]));
  ok("metrics finite", [fc.metrics.rmse, fc.metrics.mae, fc.metrics.smape].every((v) => Number.isFinite(v) && v >= 0), JSON.stringify(fc.metrics));
  ok("period detected", fc.period !== null && close(fc.period, 24, 1), `got ${fc.period}`);
  ok("paths shape", fc.paths !== null && fc.paths.length === 100 * 48, `got ${fc.paths?.length}`);
  ok("trend/seasonal projections", (fc.trend?.length ?? 0) === 48 && (fc.seasonal?.length ?? 0) === 48);
  const fc2 = engine.forecast(series, { model: "stl_ets", horizon: 48, paths: 100, seed: 7 });
  ok("determinism", fc.point.every((v, i) => v === fc2.point[i]) && Array.from(fc.paths ?? []).every((v, i) => v === fc2.paths[i]));
  const auto = engine.forecast(series, { horizon: 24 });
  ok("auto model resolves", auto.model !== "auto" && auto.point.length === 24, `model=${auto.model}`);
}

// ---- anomalies ----
{
  const res = engine.detectAnomalies(series, { method: "stl" });
  ok("anomaly channels", res.scores.length === 720 && res.expected.length === 720);
  ok("anomalies sorted", res.anomalies.every((a, i) => i === 0 || res.anomalies[i - 1].index < a.index));
  const truth = new Set();
  for (const i of gen.anomalies) { truth.add(i); truth.add(i + 1); } // width-2 events
  const hit = (i) => truth.has(i) || truth.has(i - 1) || truth.has(i + 1);
  const tp = res.anomalies.filter((a) => hit(a.index)).length;
  const recall = tp / Math.max(1, gen.anomalies.length);
  const precision = tp / Math.max(1, res.anomalies.length);
  ok("anomaly recall ≥ 0.8", recall >= 0.8, `recall=${recall.toFixed(2)} (${tp}/${gen.anomalies.length})`);
  ok("anomaly precision ≥ 0.5", precision >= 0.5, `precision=${precision.toFixed(2)} (${res.anomalies.length} flagged)`);
}

// ---- decompose ----
{
  const dec = engine.decompose(series, {});
  ok("decompose lengths", dec.trend.length === 720 && dec.seasonal.length === 720 && dec.resid.length === 720);
  const filled = engine.interpolate(series, {});
  ok("additive identity (vs interpolated y)", Array.from({ length: 720 }, (_, i) => Math.abs(filled[i] - dec.trend[i] - dec.seasonal[i] - dec.resid[i])).every((v) => v < 1e-6));
  ok("seasonal strength", dec.seasonalStrength > 0.5 && dec.seasonalStrength <= 1, `got ${dec.seasonalStrength.toFixed(2)}`);
}

// ---- seasonality ----
{
  const s = engine.seasonality(series, {});
  ok("acf lag0 ≈ 1", close(s.acf[0], 1, 0.01), `got ${s.acf[0]}`);
  ok("acf/periodogram lengths", s.acf.length === s.lags.length && s.periodogram.length === s.frequencies.length && s.acf.length >= 24);
  ok("best period 24±1", s.bestPeriod !== null && close(s.bestPeriod, 24, 1), `got ${s.bestPeriod}`);
}

// ---- changepoints ----
{
  const cp = engine.changepoints(series, {});
  ok("changepoint found", cp.changepoints.length >= 1, `got ${cp.changepoints.length}`);
  const shiftIdx = gen.changepoints[0];
  const near = cp.changepoints.some((c) => Math.abs(c.index - shiftIdx) <= 5);
  ok(`shift detected within ±5 of ${shiftIdx}`, near, JSON.stringify(cp.changepoints.map((c) => c.index)));
  ok("means step array", cp.means.length === 720);
}

// ---- backtest ----
{
  const bt = engine.backtest(series, { horizon: 24, folds: 3 });
  ok("backtest rows", bt.rows.length >= 4, `got ${bt.rows.length}`);
  ok("coverage in [0,1]", bt.rows.every((r) => r.coverage >= 0 && r.coverage <= 1));
  ok("metrics finite", bt.rows.every((r) => [r.rmse, r.mae, r.smape].every((v) => Number.isFinite(v) && v >= 0)));
}

// ---- interpolate ----
{
  const filled = engine.interpolate(series, {});
  ok("no NaNs after interpolate", filled.every((v) => Number.isFinite(v)));
  ok("interpolate length", filled.length === 720);
}

// ---- errors ----
{
  let threw = null;
  try { engine.forecast({ y: [1, 2] }, {}); } catch (e) { threw = e; }
  ok("tooShort error", threw !== null && threw.code === "tooShort", threw ? `code=${threw.code}` : "no throw");
  let badCfg = null;
  try { engine.forecast(series, { horizon: -5 }); } catch (e) { badCfg = e; }
  ok("badParams on horizon<1", badCfg !== null && (badCfg.code === "badParams" || badCfg.code === "badConfig"), badCfg ? `code=${badCfg.code}` : "no throw");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
