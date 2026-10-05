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
// ---- v1.1: tabular detectors + auto-chart ----
{
  const a = Array.from({ length: 200 }, (_, i) => i + Math.sin(i));
  const b = a.map((v, i) => 3 * v + 7 + Math.cos(i) * 0.5);
  const c = engine.correlation(a, b);
  ok("correlation r ~ 1", c.r !== null && Math.abs(c.r - 1) < 0.01, `r=${c.r}`);
  ok("correlation fit", Math.abs(c.slope - 3) < 0.05 && Math.abs(c.intercept - 7) < 0.5, `slope=${c.slope.toFixed(3)} b=${c.intercept.toFixed(3)}`);
  ok("correlation significant", c.significant === true);
  const flatc = engine.correlation(a, new Array(200).fill(5));
  ok("correlation zero-variance -> r null", flatc.r === null && flatc.significant === false);

  const cats = [...Array(70).fill("nav-failure"), ...Array(30).fill("wheel-stall")];
  const m = engine.majority(cats, { threshold: 0.7 });
  ok("majority dominant 70%", m.dominant === "nav-failure" && Math.abs(m.dominantProportion - 0.7) < 1e-9 && m.isMajority === true, `${m.dominant} ${(m.dominantProportion * 100).toFixed(0)}%`);
  const mNo = engine.majority(cats, { threshold: 0.8 });
  ok("majority below threshold", mNo.isMajority === false);

  const devices = Array.from({ length: 12 }, (_, i) => `device-${i}`);
  const catCol = devices.flatMap((d) => Array(50).fill(d));
  const vals = catCol.map((c2, i) => 100 + Math.sin(i) * 5 + (c2 === "device-7" ? 300 : 0));
  const co = engine.categoryOutlier(catCol, vals, { agg: "mean" });
  const dev7 = co.categories.find((x) => x.label === "device-7");
  ok("category_outlier flags device-7", co.outlierCount === 1 && dev7?.isOutlier === true && dev7.direction === "high", `outliers=${co.outlierCount}`);
  ok("category_outlier fences ordered", co.lowerFence < co.q1 && co.q1 < co.q3 && co.q3 < co.upperFence);

  const lv = engine.lowVariance(Array.from({ length: 100 }, (_, i) => 42 + (i % 7) * 1e-9));
  ok("low_variance flat", lv.isFlat === true, `cv=${lv.cv}`);
  const lv2 = engine.lowVariance(Array.from({ length: 100 }, (_, i) => 50 + 8 * Math.sin((2 * Math.PI * i) / 24) + (Math.sin(i * 12.9898) * 0.5 + 0.5) * 3));
  ok("low_variance not flat", lv2.isFlat === false, `cv=${lv2.cv.toFixed(3)}`);

  ok("auto -> category_outlier", engine.autoChart({ categories: catCol, y: vals }).kind === "category_outlier");
  ok("auto -> majority", engine.autoChart({ categories: cats }).kind === "majority");
  ok("auto -> correlation", engine.autoChart({ y: a, y2: b }).kind === "correlation");
  ok("auto -> low_variance", engine.autoChart({ y: new Array(100).fill(42) }).kind === "low_variance");
  const autoTs = engine.autoChart({ y: Array.from(gen.y), t: Array.from(gen.t) });
  ok("auto -> forecast on seasonal data", autoTs.kind === "forecast" || autoTs.kind === "anomalies", autoTs.kind);
  ok("auto gives a reason", typeof autoTs.reason === "string" && autoTs.reason.length > 10);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
