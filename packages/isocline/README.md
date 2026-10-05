# isocline

Tiny, fast time-series forecasting and anomaly detection for the web. A
zero-dependency TypeScript wrapper around a 240 KB raw / 88 KB gzip WASM
engine (Rust core, flat ABI, no JS runtime required). For comparison, the
augurs suite ships roughly a 1 MB wasm binary; isocline fits in about a
quarter of that.

- Forecasting (STL+ETS, Holt–Winters, AR, naive/snaive) with bootstrap
  prediction intervals
- Four anomaly detectors
- Seasonal decomposition, seasonality detection, changepoint detection
- Rolling-origin backtesting
- NaN interpolation

The engine is fully synchronous after loading: every method returns its
result immediately.

## Install

```sh
npm install isocline
```

The npm package ships the compiled `isocline.wasm` next to the JS
(`packages/isocline/dist/isocline.wasm`), so no build step or toolchain is
needed at install time.

## Loading the engine

```ts
import { loadIsocline } from "isocline";

const iso = await loadIsocline(); // resolves once; reuse the instance
```

`loadIsocline(wasmBytes?)` accepts optional explicit bytes:

- **Browser (default)** - fetches the sibling `./isocline.wasm` asset
  relative to the module URL (works with Vite, webpack asset modules, CDNs).
- **Node (default)** - falls back to `node:fs/promises` on the same URL.
- **Custom bytes** - pass an `ArrayBuffer | Uint8Array` to bundle or fetch
  the binary yourself (e.g. inlined, or from your own CDN with SRI).

`loadIsocline` verifies the wasm module's ABI version (must be `1`) and
throws `IsoclineError` with code `"internal"` on mismatch.

For example data, the package also exports `genSeries` - a seeded synthetic
generator with ground-truth anomaly/changepoint labels (used below).

## API

All methods take `series: { y: Float64Array | number[]; t?: ... }`. `t` is
optional epoch-millis (regular spacing is assumed when absent); `y` may
contain `NaN`, which is linearly interpolated before every operation except
`interpolate` itself. Input arrays are copied into wasm memory per call;
result arrays are copied out (`.slice()`), so **callers own every returned
`Float64Array`**.

### `forecast(series, opts?)` → `ForecastResult`

```ts
import { genSeries } from "isocline";

const { y } = genSeries({ n: 720, period: 24 });
const fc = iso.forecast({ y }, {
  model: "auto",   // "auto" | "stl_ets" | "ets" | "ar" | "snaive" | "naive"
  horizon: 48,     // 1..10000
  period: "auto",  // or a number
  level: 0.95,     // PI coverage
  paths: 200,      // bootstrap paths, 0..2000 (0 disables)
  seed: 42,
});
console.log(fc.model, fc.period, fc.metrics.rmse);
// fc.point/lower/upper: length horizon; fc.fitted/residuals: length n
// fc.paths: pathsN x horizon flat (null when paths=0)
// fc.trend/fc.seasonal: length-horizon projections (model-dependent)
console.log(fc.params, fc.warnings);
```

| Option | Type | Default | Description |
|---|---|---|---|
| `model` | `ModelKind` | `"auto"` | `"auto"`, `"stl_ets"`, `"ets"`, `"ar"`, `"snaive"`, `"naive"` |
| `horizon` | `number` | `24` | Steps ahead, 1..10000 |
| `period` | `number \| "auto"` | `"auto"` | Seasonal period; `"auto"` detects it |
| `level` | `number` | `0.95` | Prediction-interval coverage, in (0,1) |
| `paths` | `number` | `200` | Bootstrap simulation paths, 0..2000 |
| `seed` | `number` | `42` | RNG seed for the bootstrap |

### `detectAnomalies(series, opts?)` → `AnomalyResult`

```ts
const res = iso.detectAnomalies({ y }, { method: "stl", threshold: 3.5 });
for (const a of res.anomalies) {
  // a.index, a.score, a.expected, a.observed, a.direction ("spike" | "dip")
}
res.scores;   // Float64Array length n, signed (positive = above expected)
res.expected; // Float64Array length n, model expectation
```

| Option | Type | Default | Description |
|---|---|---|---|
| `method` | `"stl" \| "madz" \| "iqr" \| "ewma"` | `"stl"` | Detector family |
| `period` | `number \| "auto"` | `"auto"` | Used by `stl`/`madz`/`ewma` |
| `threshold` | `number` | `3.5` (stl/madz), `1.5` (iqr), `3.0` (ewma) | Flagging threshold in each detector's statistic |
| `lambda` | `number` | `0.3` | EWMA smoothing weight, in (0,1] |
| `direction` | `"both" \| "high" \| "low"` | `"both"` | Keep spikes/dips only |

### `decompose(series, opts?)` → `DecomposeResult`

```ts
const d = iso.decompose({ y }, { robust: true, seasons: 3 });
d.period;            // number (period used)
d.trend; d.seasonal; d.resid;   // Float64Array length n each
d.seasonalStrength;  // 1 - var(resid)/var(seasonal+resid), in [0,1]
d.robustWeights;     // Float64Array | null (robust bisquare weights)
```

| Option | Type | Default | Description |
|---|---|---|---|
| `period` | `number \| "auto"` | `"auto"` | Falls back to a default period when nothing is detected |
| `robust` | `boolean` | `true` | Bisquare robust outer loop |
| `seasons` | `number` | `3` | Inner (linear) iterations, 1..100 |

### `seasonality(series, opts?)` → `SeasonalityResult`

```ts
const s = iso.seasonality({ y }, { maxPeriod: 128 });
s.bestPeriod;  // number | null (null when strength < 0.2)
s.strength;    // seasonal strength in [0,1]
s.acf; s.lags; s.periodogram; s.frequencies; // diagnostics for plotting
s.candidates;  // ranked [{ period, strength, source: "acf" | "spectral" }]
```

| Option | Type | Default | Description |
|---|---|---|---|
| `maxPeriod` | `number` | `min(n/3, 8640)` | Largest lag/period examined, >= 2 |

### `changepoints(series, opts?)` → `ChangepointResult`

```ts
const cp = iso.changepoints({ y }, { threshold: 3.0, minSegment: 10 });
cp.changepoints; // [{ index, meanBefore, meanAfter }] sorted by index
cp.means;        // Float64Array length n, step function of segment means
```

| Option | Type | Default | Description |
|---|---|---|---|
| `minSegment` | `number` | `10` | Minimum points on each side of a split |
| `maxChangepoints` | `number` | `10` | Recursion cap |
| `threshold` | `number` | `3.0` | Split gain in robust sigma units |

### `backtest(series, opts?)` → `BacktestResult`

```ts
const bt = iso.backtest({ y }, { models: ["stl_ets", "ets", "ar", "snaive"], horizon: 24, folds: 3 });
for (const row of bt.rows) {
  // row.model, row.rmse, row.mae, row.smape, row.folds, row.coverage
}
```

Rolling-origin evaluation: the last `folds x horizon` points are held out;
each fold trains on the prefix and forecasts `horizon` steps. `coverage` is
the fraction of actuals inside the prediction interval. `"auto"` models are
resolved once on the full series so every fold uses the same model.

| Option | Type | Default | Description |
|---|---|---|---|
| `models` | `ModelKind[]` | `["stl_ets","ets","ar","snaive"]` | Models to compare |
| `horizon` | `number` | `24` | Forecast horizon per fold |
| `folds` | `number` | `3` | Number of rolling-origin folds |
| `period` | `number \| "auto"` | `"auto"` | Seasonal period |
| `seed` | `number` | `42` | Bootstrap seed |

### `interpolate(series, opts?)` → `Float64Array`

```ts
const filled = iso.interpolate({ y }); // length n, NaNs filled linearly
```

| Option | Type | Default | Description |
|---|---|---|---|
| `method` | `"linear"` | `"linear"` | Only linear is implemented |

### `iso.version` → `string`

Package/engine version string (currently `"0.1.0"`).

## Errors

All failures throw `IsoclineError` with a `code` property:

| Code | Meaning |
|---|---|
| `badConfig` | Malformed options (should be impossible via the typed API) |
| `badOp` | Unknown operation (internal) |
| `tooShort` | Series has fewer than 3 usable points |
| `badParams` | Value out of range (bad model name, horizon > 10000, all-NaN input, ...) |
| `internal` | ABI mismatch or unexpected engine error |

```ts
import { IsoclineError } from "isocline";
try {
  iso.forecast({ y: [1, 2] });
} catch (e) {
  if (e instanceof IsoclineError && e.code === "tooShort") { /* ... */ }
}
```

## Determinism

Every op is deterministic given the same inputs and `seed` (default 42):
the bootstrap uses a seeded xorshift RNG, and the same seed reproduces
byte-identical `point`/`lower`/`upper`/`paths`. Run the same call twice and
you get the same forecast - there is no hidden global RNG state.

## Performance tips

- **`paths` drives cost.** Prediction intervals come from simulating
  `paths` futures; 200 is a good default, drop to 50–100 or `0` for
  interactive explorations, raise it for tighter interval tails.
- **NaNs are interpolated** before every op - cheap, but pass clean data
  when you can.
- Reuse one engine instance; loading compiles the wasm module once.
- Larger `horizon` costs little beyond the bootstrap; `backtest` cost is
  roughly `models x folds` forecasts.

## WASM size and ABI

The bundled binary is **240 KB raw / 88 KB gzip**. The underlying ABI is
versioned (`version() === 1`) and checked at load time; results are copied
out of linear memory so callers own their arrays. See
`crates/isocline-wasm/README.md` for the full ABI, or `docs/ARCHITECTURE.md`
for the layer diagram.
