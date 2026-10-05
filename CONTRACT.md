# Isocline — Cross-Package Contract (v1)

Isocline is a tiny, fast time-series engine: a dependency-free Rust core
(`crates/isocline-core`), flat-ABI WASM bindings (`crates/isocline-wasm`), a
zero-dependency TypeScript package (`packages/isocline`), an Observable Plot
visualization layer (`packages/isocline-plot`), and a Vite demo
(`packages/demo`).

This document is the **single source of truth** for shared types, the WASM
ABI, algorithm behavior, and theme tokens. If code and this document
disagree, this document wins — fix the code.

---

## 1. Repository layout & ownership

```
isocline/
├── Cargo.toml                  # workspace: members = ["crates/*"]
├── package.json                # npm workspaces: ["packages/*"]
├── tsconfig.base.json
├── CONTRACT.md                 # this file
├── crates/
│   ├── isocline-core/            # pure Rust algorithms (std only; rayon optional)
│   └── isocline-wasm/            # cdylib, flat C ABI, serde_json configs
├── packages/
│   ├── isocline/                 # npm "isocline": TS wrapper + wasm binary
│   │   └── src/
│   │       ├── types.ts        # shared contract types (checked in early)
│   │       ├── synth.ts        # seeded synthetic data (checked in early)
│   │       ├── abi.ts          # wasm loader + memory marshalling
│   │       ├── engine.ts       # high-level API
│   │       └── index.ts
│   ├── isocline-plot/            # npm "isocline-plot": Observable Plot marks/plots
│   └── demo/                   # Vite site, private
└── docs/
```

Package names (npm): `isocline` (core engine), `isocline-plot` (viz),
`isocline-demo` (private). Import in demo: `import { isocline } from "isocline"`,
`import * as PP from "isocline-plot"`.

## 2. Shared TypeScript types (`packages/isocline/src/types.ts`)

```ts
/** A univariate series. `t` is optional epoch-millis (regular spacing assumed
 *  when absent). `y` may contain NaN for missing values. */
export interface SeriesInput {
  y: Float64Array | number[];
  t?: Float64Array | number[];
}

export type ModelKind = "auto" | "stl_ets" | "ets" | "ar" | "snaive" | "naive";

export interface ForecastOptions {
  model?: ModelKind;            // default "auto"
  horizon?: number;             // default 24, 1..10000
  period?: number | "auto";     // default "auto"
  level?: number;               // PI coverage, default 0.95, (0,1)
  paths?: number;               // bootstrap simulation paths, default 200, 0..2000
  seed?: number;                // default 42 (determinism)
}

export interface Metrics { rmse: number; mae: number; smape: number; }

export interface ForecastResult {
  model: ModelKind;             // resolved model (never "auto")
  period: number | null;        // detected/used period, null if none
  horizon: number;
  level: number;
  point: Float64Array;          // length h
  lower: Float64Array;          // length h
  upper: Float64Array;          // length h
  fitted: Float64Array;         // length n, in-sample one-step fits
  residuals: Float64Array;      // length n
  paths: Float64Array | null;   // paths*h flat, null when paths=0
  pathsN: number;
  trend: Float64Array | null;   // length h, projected trend (stl_ets only)
  seasonal: Float64Array | null;// length h, seasonal projection (stl_ets/snaive)
  metrics: Metrics;             // in-sample one-step metrics
  params: Record<string, number>;
  warnings: string[];
}

export type AnomalyMethod = "stl" | "madz" | "iqr" | "ewma";

export interface AnomalyOptions {
  method?: AnomalyMethod;       // default "stl"
  period?: number | "auto";     // default "auto"; used by stl/madz/ewma
  threshold?: number;           // default: stl/madz 3.5 (modified z), iqr 1.5 (k), ewma 3.0 (L)
  lambda?: number;              // ewma only, default 0.3, (0,1]
  direction?: "both" | "high" | "low"; // default "both"
}

export interface Anomaly {
  index: number;                // index into y
  score: number;                // |modified z| or normalized stat (>= threshold)
  expected: number;             // model expectation at that index
  observed: number;             // y[index]
  direction: "spike" | "dip";
}

export interface AnomalyResult {
  method: AnomalyMethod;
  threshold: number;
  anomalies: Anomaly[];         // sorted by index
  scores: Float64Array;         // length n, signed score (positive = above expected)
  expected: Float64Array;       // length n
}

export interface DecomposeOptions {
  period?: number | "auto";     // default "auto"
  robust?: boolean;             // default true
  seasons?: number;             // inner iterations, default 3
}

export interface DecomposeResult {
  period: number;
  trend: Float64Array;          // length n
  seasonal: Float64Array;       // length n
  resid: Float64Array;          // length n
  seasonalStrength: number;     // 1 - var(resid)/var(seasonal+resid), clamped [0,1]
  robustWeights: Float64Array | null; // length n when robust
}

export interface SeasonalityOptions {
  maxPeriod?: number;           // default min(n/3, 8640), >= 2
}

export interface SeasonalityCandidate { period: number; strength: number; source: "acf" | "spectral"; }

export interface SeasonalityResult {
  bestPeriod: number | null;    // null if strength < 0.2
  strength: number;             // seasonal strength in [0,1]
  acf: Float64Array;            // autocorrelation, lags 0..maxLag
  lags: Float64Array;           // 0..maxLag
  periodogram: Float64Array;    // power, length maxLag+1
  frequencies: Float64Array;    // cycles/sample, length maxLag+1
  candidates: SeasonalityCandidate[]; // ranked, max 5
}

export interface ChangepointOptions {
  minSegment?: number;          // default 10
  maxChangepoints?: number;     // default 10
  threshold?: number;           // default 3.0 (sigma units)
}

export interface Changepoint { index: number; meanBefore: number; meanAfter: number; }

export interface ChangepointResult {
  changepoints: Changepoint[];  // sorted by index
  means: Float64Array;          // length n, step function of segment means
}

export interface BacktestOptions {
  models?: ModelKind[];         // default ["stl_ets","ets","ar","snaive"]
  horizon?: number;             // default 24
  folds?: number;               // default 3 (rolling origin)
  period?: number | "auto";
  seed?: number;
}

export interface BacktestRow extends Metrics {
  model: ModelKind;
  folds: number;
  coverage: number;             // fraction of actuals inside [lower,upper]
}

export interface BacktestResult { rows: BacktestRow[]; horizon: number; folds: number; }

export interface InterpolateOptions { method?: "linear"; } // default linear

export class IsoclineError extends Error {
  constructor(message: string, public code: IsoclineErrorCode) { super(message); }
}
export type IsoclineErrorCode = "badConfig" | "badOp" | "tooShort" | "badParams" | "internal";
```

### High-level engine API (`isocline` package)

```ts
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
export function loadIsocline(wasmBytes?: ArrayBuffer | Uint8Array): Promise<Isocline>;
```

All methods are synchronous after `loadIsocline()` resolves. Every input array
is copied into wasm memory per call; results are copied out (`.slice()`) so
 callers own them.

## 3. WASM flat ABI (`crates/isocline-wasm`)

No wasm-bindgen. Crate type `cdylib`, crate name `isocline_wasm`
(binary: `isocline_wasm.wasm`). Exports (C ABI, `#[no_mangle] extern "C"`):

```wasm
alloc(len: i32) -> i32                    // byte ptr, 8-aligned, len bytes
call(op: i32, cfg_ptr: i32, cfg_len: i32, y_ptr: i32, y_len: i32) -> i32
    // op: 0 forecast, 1 anomalies, 2 decompose, 3 seasonality,
    //     4 changepoints, 5 backtest, 6 interpolate
    // y: f64 little-endian array, y_len = element count
    // cfg: UTF-8 JSON matching the Options type above (snake_case keys)
    // returns 0 on success; 1 badConfig, 2 badOp, 3 tooShort, 4 badParams,
    //         5 internal
json_ptr() -> i32                          // → UTF-8 JSON result header
json_len() -> i32
version() -> i32                           // 1 (ABI version)
```

Result header JSON (success):

```json
{
  "ok": true,
  ...op-specific metadata (mirrors the TS result minus typed arrays)...,
  "channels": { "point": [byteOffset, elemCount], ... }
}
```

- Channels are `f64` arrays at 8-aligned byte offsets in linear memory.
- The engine keeps **one result arena alive until the next `call`**; the TS
  wrapper must construct `Float64Array(memory.buffer, off, len)` **after**
  `call` returns and `.slice()` immediately (memory may grow/detach).
- Failure header: `{"ok": false, "error": "...", "code": "badConfig"}`.
- Config JSON never contains arrays; only numbers/strings/bools/null.
  Never serialize NaN/Infinity into JSON (use null).
- Config keys are snake_case: `{ "model": "stl_ets", "horizon": 48,
  "period": null }` — `period: "auto"` becomes `period: null` in JSON.
- Unknown config keys are errors (`serde(deny_unknown_fields)`).

Build (no wasm-pack needed):

```sh
cargo build -p isocline-wasm --target wasm32-unknown-unknown --release
cp target/wasm32-unknown-unknown/release/isocline_wasm.wasm packages/isocline/dist/
```

Release profile (root Cargo.toml): `opt-level = "z"`, `lto = "fat"`,
`codegen-units = 1`, `panic = "abort"`, `strip = true`.

## 4. Algorithms (`crates/isocline-core`) — normative spec

All code std-only Rust, `f64`. Deterministic given `seed`. NaNs in input are
interpolated (linear) before any op except `interpolate` itself.

### 4.1 math primitives (`math.rs`)
- `fft` — iterative radix-2 Cooley–Tukey, bit-reversal, in-place on
  `Vec<Complex64>` (hand-rolled complex: re/im pairs).
- `acf(y, max_lag)` — via FFT (zero-pad to next pow2 ≥ 2n), normalized by n,
  `acf[k] = sum((y_i-mean)(y_{i+k}-mean)) / sum((y_i-mean)^2)`.
- `periodogram(y)` — FFT of mean-centered (and optionally 10% Tukey-tapered)
  y; power `|X_k|^2 / n`, frequencies `k / nfft`.
- `cholesky_solve(A, b)` — dense normal-equation solver with ridge 1e-8.
- `nelder_mead(f, x0, bounds)` — standard NM, reflection 1, expansion 2,
  contraction 0.5, shrink 0.5; initial simplex 5% perturbation; max 300 iters,
  tol 1e-6; parameters via sigmoid to enforce bounds.
- `xorshift_rng(seed)` — deterministic u64 → f64 in [0,1).
- `quantile(sorted, q)` — linear interpolation (type 7).
- `rolling_median(y, window)` — odd window centered; ends shrink window.
- `Box–Muller` normal sampling from the rng.

### 4.2 seasonality detection
1. Compute ACF and periodogram up to `max_lag = min(n/2, maxPeriod, 1024)`.
2. Spectral candidates: local peaks of periodogram; period = nfft/k; keep top
   3 with period ≤ maxPeriod and ≥ 2.
3. ACF candidates: positive local maxima of acf at lags ≥ 2.
4. Match: for each spectral candidate find nearest ACF peak within 5%;
   combined candidate strength = acf_peak_value (clamped [0,1]).
5. Best period = candidate with max strength. Run one quick STL pass
   (2 seasons, 2 inner iters, non-robust) at best period; final
   `strength = 1 - var(resid) / var(seasonal + resid)` clamped [0,1].
6. `bestPeriod = null` if strength < 0.2.

### 4.3 STL-style robust decomposition (`stl.rs`)
Classical STL simplified: local *linear* regression (LOESS degree 1, tri-cube
weights) instead of degree-2.
- Inner loop (repeat `seasons` times, default 3):
  1. detrend: `z = y - trend`
  2. cycle-subseries smoothing: for each phase `p in 0..period`, LOESS-deg1
     over that subseries (x = cycle index, y = z values) evaluated at every
     existing point — and (for forecasting) `h` steps beyond.
  3. low-pass: moving averages of lengths `period`, `period`, `2`+padding on
     the combined seasonal estimate → `seasonal_low`
  4. `seasonal = cycle_smoothed - seasonal_low`; `trend = LOESS-deg1 over
     deseasonalized (y - seasonal), span = period+1 centered`.
- Outer loop (3 passes when `robust`): bisquare weights
  `w = (1-(r/6MAD)^2)^2` on residuals from the last inner loop, folded into
  the LOESS weights; clamp weights to [0,1].
- `seasonalStrength` as above. Missing y (NaN) handled by interpolation
  before decompose (documented).
- `seasonal_project(h)` — the cycle-subseries LOESS evaluated h ahead.

### 4.4 ETS: Holt–Winters additive, damped (`ets.rs`)
- Model: ETS(A, Ad, A). States l (level), b (damped trend), s[i] seasonal.
  ```
  l_t = α(y_t − s_{t−p}) + (1−α)(l_{t−1} + φb_{t−1})
  b_t = β(l_t − l_{t−1}) + (1−β)φb_{t−1}
  s_t = γ(y_t − l_t) + (1−γ)s_{t−p}
  ŷ_{t+1} = l_t + φb_t + s_{t+1−p}
  ```
- Init: OLS line over first `min(2p, n)` points → intercept=l₀, slope=b₀;
  sᵢ = mean of first-season detrended values.
- Fit: Nelder–Mead on (α, β, γ, φ), bounds α,γ ∈ [0.01,0.99],
  β ∈ [0.01,0.5], φ ∈ [0.8,0.999], objective = SSE; 3 restarts
  (initial guesses: .3/.1/.3/.95 then best-of perturbations).
- Non-seasonal (no period): ETS(A,Ad,N) — drop s terms.
- Params reported: alpha, beta, gamma|null, phi.
- One-step fitted values & residuals retained for metrics + bootstrap.

### 4.5 AR(p) (`ar.rs`)
- Lag matrix OLS (via cholesky_solve), orders p = 1..min(20, n/4), choose by
  AICc = n·ln(SSE/n) + 2k + 2k(k+1)/(n−k−1).
- Optional seasonal terms: no (keep lean).
- Forecast: recursive. PI via residual bootstrap simulation.

### 4.6 Naive & SeasonalNaive
- naive: ŷ_{n+h} = y_n. snaive: ŷ_{n+h} = y_{n+h−p·⌈h/p⌉}. No params.
  PI: residual quantiles repeated (naive) / per-phase residual quantiles (snaive).

### 4.7 Forecast dispatch (`forecast.rs`)
- Resolve period ("auto" → seasonality detection; strength ≥ 0.2).
- Model selection ("auto"): seasonal strength ≥ 0.5 → `stl_ets`;
  0.2–0.5 → `ets`; else `ar` (or `ets` if n < 16).
- `stl_ets`: robust STL → seasonal projection (h); ETS(A,Ad,N) on
  deseasonalized (trend+resid); forecast = ets.point + seasonal_proj;
  PI/bootstrap on deseasonalized scale then re-seasonalized.
- `ets`: full seasonal HW when period exists else ETS(A,Ad,N).
- `ar`: AR(p) on (optionally) seasonally-adjusted data when period exists,
  re-seasonalized like stl_ets.
- Prediction intervals: bootstrap — simulate `paths` futures (default 200)
  by evolving the fitted model forward, adding residuals resampled with
  replacement (seeded rng); `lower/upper` = quantiles at (1−level)/2 and
  1−(1−level)/2; `point` = median of paths (for bootstrap models) — must lie
  within [lower, upper].
- Metrics (in-sample one-step): rmse, mae, smape
  (200·|y−ŷ|/(|y|+|ŷ|), skip when |y|+|ŷ| < 1e-12, report 0 if all skipped).
- Guards: seasonal models need n ≥ 2·period + 1, else emit warning
  `"insufficient data for seasonality; fell back to naive"` and use naive.
  AR needs n ≥ 8. All ops need n ≥ 3 else `tooShort` error.

### 4.8 Anomaly detection (`anomaly.rs`)
- `stl`: robust STL → residual r_t; modified z-score
  `mz = 0.6745·(r − median(r)) / MAD(r)`; flag |mz| > threshold (3.5).
  expected = trend + seasonal.
- `madz`: detrend via centered rolling median (window = period if known else
  11); modified z-score of the residual; flag > 3.5.
- `iqr`: Q1/Q3 of y (after optional detrend as madz); flag outside
  [Q1 − k·IQR, Q3 + k·IQR], k = 1.5. score = |y − median| / IQR·k
  (normalized so threshold k).
- `ewma`: z_t = λy_t + (1−λ)z_{t−1}; σ_z = σ_y·sqrt(λ/(2−λ)),
  σ_y = 1.4826·MAD(diff(y))/sqrt2 robust; flag |z − z̄| > L·σ_z, L = 3.
  Warmup: first max(period|11) points never flagged. expected = z_t.
- `direction` filters: "high" keeps spikes only, "low" dips only.
- `scores` output is the **signed** statistic (positive above expected).
  For iqr, signed distance in k units.

### 4.9 Changepoints (`changepoint.rs`)
Binary segmentation on mean shifts:
1. σ̂ = 1.4826·MAD(diff(y)) / √2 (robust, guard ≥ 1e-9).
2. For segment [a,b): split s maximizing
   `g(s) = √(n₁n₂/n)·|mean₁ − mean₂| / σ̂`, n₁ = s−a, n₂ = b−s.
3. Accept split if g > threshold (3.0) and n₁, n₂ ≥ minSegment (10);
   recurse on both halves until maxChangepoints (10) or no accepted split.
4. Output sorted changepoints + `means` step array (segment means).

### 4.10 Backtest (`backtest` in forecast.rs)
Rolling origin: last `folds × horizon` points held out; fold i trains on
`n − (folds − i)·h`, forecasts h. Aggregate mean metrics per model +
coverage (% actuals inside PI). Models: resolved concretely (auto resolved
once on full data). Also compute each model's in-sample metrics — no wait,
out-of-sample only.

### 4.11 Parallel feature (`rayon`, optional, off for wasm)
`batch_forecast(series: Vec<Series>, opts) -> Vec<ForecastResult>` etc.
behind `#[cfg(feature = "parallel")]`. Core stays `std`-only by default.

## 5. Synthetic data (`packages/isocline/src/synth.ts`) — provided

Seeded (mulberry32). `genSeries(opts)`:
`y[i] = base + trend·i + A·sin(2πi/p + φ) + A2·sin(4πi/p) + σ·randn()`
then inject `spikes | dips | shifts | drifts` (magnitude in σ units, counts
given) and poke `missing` NaNs. Returns
`{ y, t (epoch ms, hourly), anomalies: number[], changepoints: number[] }`
with ground-truth indices. Defaults: n=720, p=24, trend=0.02, A=8, A2=2,
σ=1.5, base=50, 3 spikes, 2 dips, 1 shift, 1 drift, 8 missing.

Rust unit tests embed the same equations (their own tiny generator) so both
sides test against identical ground truth patterns (constants in tests need
not match JS exactly — but the *shape* of the data must).

## 6. isocline-plot API (Observable Plot)

Peer dependency: `@observablehq/plot ^0.6`. Every function comes in two
forms: `*Marks(...)` returning `Plot.Markish[]` + partial plot options for
composition, and `*Plot(...)` returning a rendered `Plot.plot(...)` node.

```ts
import * as PP from "isocline-plot";

PP.forecastPlot(series, forecast, opts?)     // history + forecast + PI band + optional spaghetti paths
PP.forecastMarks(series, forecast, opts?)
PP.anomalyPlot(series, anomalyResult, opts?) // line + flagged points (spike ▲ red / dip ▼ blue) + expected line
PP.anomalyMarks(...)
PP.decomposePlot(decomp, opts?)              // 3 vertically-stacked facets: trend/seasonal/resid
PP.seasonalityPlot(seasonality, opts?)       // ACF + periodogram side-by-side, best period annotated
PP.changepointPlot(series, cpResult, opts?)  // line + step means + vertical rules at changepoints
PP.backtestPlot(backtest, opts?)             // metric heatmap (Plot.cell)
PP.isoclineTheme                              // shared dark plot defaults (see §7)
```

- All functions accept plain contract result objects — they must work with
  mocked data (types only import from `isocline` re-exported types; no runtime
  dep on `isocline`).
- Number formatting: 3 significant digits via helper `fmt`.
- Must handle `t` absent (use index as x, label "index").

## 7. Theme tokens (demo + plots, identical values)

```
--bg #0b0e14   --panel #11151f   --panel2 #161b26
--ink #e6edf3  --muted #8b98a9   --grid rgba(255,255,255,.07)
--cyan #22d3ee --violet #a78bfa  --amber #fbbf24
--red #f87171  --green #34d399
font: ui-monospace, SFMono-Regular, Menlo, monospace (numbers/labels)
      -apple-system, "Segoe UI", system-ui, sans-serif (prose)
radius: 10px; spacing: 8px grid
```

Plot defaults (`isoclineTheme`): dark background transparent (page provides
panel), ink #e6edf3 axis labels, muted #8b98a9 ticks, grid rgba(255,255,255,.07),
history line: cyan; forecast: violet dashed; PI band: violet 15% opacity;
anomaly spike: red, dip: #60a5fa; expected: amber dashed; changepoint rule:
amber dashed.

## 8. Demo (`packages/demo`)

Vite (v7) + vanilla TS. Tabs: **Forecast** (model picker, horizon/level
sliders, PI + spaghetti toggles, metrics chips), **Anomalies** (method
picker, threshold slider, expected-line toggle), **Decompose**, **Seasonality**
(ACF + periodogram), **Changepoints**, **Backtest** (leaderboard table +
coverage), **Benchmark** (runtime ms per op vs n; pure-JS snaive baseline).
Left sidebar: synth data controls (n, period, trend, noise σ, spike/dip/shift
counts, magnitude, seed) + regenerate button + mini sparkline of current
series. Hero header: "Isocline" + wasm size + ops/sec badges (filled at
runtime by integration). Engine access via `src/engine.ts` exposing
`getEngine(): Promise<Isocline>`; the mock implementation lives in
`src/engine-mock.ts` (same interface, clearly-marked synthetic outputs)
so the UI is fully buildable before the wasm package exists. Integration
replaces the mock with the real loader behind `?mock=1` escape hatch.

## 9. Verification gates

- `cargo test -p isocline-core` — algorithm tests incl.: recovers period 24 on
  synthetic; forecast beats snaive RMSE on trending seasonal synthetic;
  anomaly recall/precision ≥ 0.8 on injected ground truth; changepoint within
  ±3 of injected shift; PI empirically covers ~level on 200 sims; determinism
  (same seed → identical bytes of output channels).
- `node packages/isocline/test/smoke.mjs` — loads real wasm in Node, runs every
  op, asserts contract invariants (lengths, point within [lower,upper],
  finite metrics, determinism).
- `npm run build` at root builds everything; `npm run dev` serves demo.
- isocline-plot `tsc --noEmit` clean; visually verified in demo.

## 10. Non-goals (v1)

Multi-seasonality, Box-Cox, probabilistic (quantile) models other than
bootstrap, CSV loading, web workers (the engine is fast enough to stay
on-thread; hooks documented for future).

---

## 11. Tabular detectors + auto-chart (v1.1)

Non-temporal analytics over generic columns. Ops 7-10 use a second ABI entry:

```wasm
call2(op, cfg_ptr, cfg_len, y_ptr, y_len, y2_ptr, y2_len) -> status
// op: 7 correlation, 8 majority, 9 category_outlier, 10 low_variance
```

Category columns travel as f64 codes (u32-safe) in `y`, with the distinct
legend array in cfg JSON: `{"legend":["nav-failure",...]}`. `call2` follows
the same arena lifetime rules as `call`.

### correlation (7)
Inputs: two equal-length f64 arrays. Output JSON:
`{ok, n, r, t_stat, significant, slope, intercept}` — Pearson r; t-statistic
`t = r*sqrt((n-2)/(1-r^2))`; `significant` when |t| > 2 (normal approx);
slope/intercept from OLS of y2 on y. Needs n ≥ 3 (else `tooShort`), equal
lengths (else `badParams`), non-zero variance in both (else r = null → JSON
null, significant false).

### majority (8)
Inputs: category codes + legend. Cfg: `{"threshold": 0.5}` (null = default).
Output: `{ok, n, threshold, dominant, dominant_proportion, is_majority,
counts: [{label, count, proportion}] sorted desc}`. `dominant` null when n=0.
`is_majority` = dominant_proportion ≥ threshold.

### category_outlier (9) — Ava-style non-temporal IQR outlier
Inputs: category codes + legend (y), numeric values (y2). Cfg:
`{"agg":"sum"|"mean"|"count"|"median" (default "sum"), "factor": 1.5}`.
Aggregate values per category, quartiles (type 7) across categories,
fences Q1 − k·IQR / Q3 + k·IQR. Output: `{ok, agg, factor, q1, q3, iqr,
lower_fence, upper_fence, outlier_count, categories: [{label, value,
is_outlier, direction:"high"|"low"}] sorted by value desc}`. Needs ≥ 4
categories (else `tooShort`).

### low_variance (10)
Inputs: f64 values. Cfg: `{"max_cv": 0.01}`. Output: `{ok, n, mean, variance,
std_dev, cv, max_cv, is_flat}`. cv = std_dev / |mean| (mean ≈ 0 → absolute
std_dev check against 1e-9). `is_flat` = cv ≤ max_cv.

### TS engine surface (packages/isocline)

```ts
correlation(a: ArrayLike<number>, b: ArrayLike<number>): CorrelationResult;
majority(categories: ReadonlyArray<string>, opts?: { threshold?: number }): MajorityResult;
categoryOutlier(categories: ReadonlyArray<string>, values: ArrayLike<number>, opts?: { agg?: CategoryAgg; factor?: number }): CategoryOutlierResult;
lowVariance(values: ArrayLike<number>, opts?: { maxCv?: number }): LowVarianceResult;
autoChart(input: GenericSeries): AutoChartResult;   // TS-side dispatcher
```

`autoChart` heuristics (deterministic, explainable via `reason`):
1. categories + y present → category_outlier if outliers > 0, else majority
   if is_majority, else "distribution" (bar of aggregates).
2. y + y2 present → correlation (scatter is the chart).
3. y only: low_variance check first (flat wins) → else time-series pipeline:
   seasonality strength ≥ 0.2 → forecast + anomalies; else anomalies on raw.

### Plot layer (packages/isocline-plot)

`correlationPlot(a, b, res)` (scatter + fit + r annotation) ·
`majorityPlot(res)` (proportion bars, dominant highlighted, threshold rule) ·
`categoryOutlierPlot(res)` (dot-per-category + IQR fences, outliers colored) ·
`lowVariancePlot(values, res)` (line + mean band + cv annotation) ·
`autoChartPlot(input, auto, opts?)` (dispatches to the right renderer,
including the existing time-series plots).
