// Head-to-head: @bsull/augurs 0.10.2 vs isocline 0.1.0, same process, same data.
// Setup: npm i --no-save @bsull/augurs   (installs without touching package.json)
// Then:  node scripts/bench-augurs.mjs    (run from the repo root)
import { readFileSync } from "node:fs";
import { initSync as initEts, initLogging, AutoETS } from "@bsull/augurs/ets";
import { initSync as initMstl, MSTL } from "@bsull/augurs/mstl";

initEts(readFileSync("node_modules/@bsull/augurs/ets_bg.wasm"));
initMstl(readFileSync("node_modules/@bsull/augurs/mstl_bg.wasm"));
initLogging({ level: "error" });

const { loadIsocline } = await import(
  "/Users/mcsheehy/.zcode/workspace/default/isocline/packages/isocline/dist/index.js"
);
const engine = await loadIsocline(
  readFileSync("/Users/mcsheehy/.zcode/workspace/default/isocline/packages/isocline/dist/isocline.wasm"),
);

// genSeries port (seed 42) — same synthetic shape the isocline tests/demo use
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gen(n, seed = 42, period = 24) {
  const rng = mulberry32(seed);
  const y = new Float64Array(n);
  let u = 0, v = 0;
  const randn = () => { while (!u) u = rng(); while (!v) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const phase = rng() * Math.PI * 2;
  for (let i = 0; i < n; i++) y[i] = 50 + 0.02 * i + 8 * Math.sin((2 * Math.PI * i) / period + phase) + 2 * Math.sin((4 * Math.PI * i) / period) + 1.5 * randn();
  return y;
}

const med = (fn, warm = 2, reps = 5) => {
  for (let i = 0; i < warm; i++) fn();
  const t = [];
  for (let i = 0; i < reps; i++) { const a = performance.now(); fn(); t.push(performance.now() - a); }
  t.sort((a, b) => a - b);
  return t[Math.floor(reps / 2)].toFixed(1);
};

const H = 48;
for (const n of [1000, 10000]) {
  const y = gen(n);
  console.log(`\n=== n=${n}  horizon=${H}  level=0.95 (median ms) ===`);

  // ETS
  console.log("augurs  AutoETS(24,'ZZZ') fit+predict :", med(() => { const m = new AutoETS(24, "ZZZ"); m.fit(y); m.predict(H, 0.95); m.free(); }));
  console.log("isocline ets fit+predict (paths=0)    :", med(() => engine.forecast({ y }, { model: "ets", horizon: H, paths: 0 })));
  console.log("isocline ets fit+predict (+200 paths) :", med(() => engine.forecast({ y }, { model: "ets", horizon: H, paths: 200 })));

  // STL-composite forecasting
  console.log("augurs  MSTL.ets([24]) fit+predict    :", med(() => { const m = MSTL.ets([24]); m.fit(y); m.predict(H, 0.95); m.free(); }));
  console.log("isocline stl_ets fit+predict (p=0)    :", med(() => engine.forecast({ y }, { model: "stl_ets", horizon: H, paths: 0 })));

  // anomaly-adjacent: augurs MSTL fit only vs isocline decompose (both are the 'understand the series' op)
  console.log("augurs  MSTL fit only                 :", med(() => { const m = MSTL.ets([24]); m.fit(y); m.free(); }));
  console.log("isocline decompose                    :", med(() => engine.decompose({ y }, {})));
}
