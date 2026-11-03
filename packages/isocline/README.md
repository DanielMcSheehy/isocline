# isocline

Tiny, fast time-series forecasting and anomaly detection for the web. A
zero-dependency TypeScript wrapper around a 240 KB raw / 88 KB gzip WASM
engine (Rust core, flat ABI, no JS runtime required). For comparison, the
augurs suite ships roughly a 1 MB wasm binary; isocline fits in about a
quarter of that.

- Forecasting (STL+ETS, Holt–Winters, AR, naive/snaive) with bootstrap
  prediction intervals
- Four anomaly detectors, with lookback/time-window filtering and
  plain-language "why" explanations
- `detect()`: point it at arbitrary data (arrays, columns, records) and get
  typed anomaly / frequency-outlier / category-outlier findings with
  one-line summaries
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
| `lookback` | `Duration` | - | Post-result filter: keep anomalies in `[now − lookback, now]`. Needs `t`. |
| `since` | `TimeLike` | - | Keep anomalies at/after this instant (later of `since` and the lookback start wins). Needs `t`. |
| `now` | `TimeLike \| "latest"` | `Date.now()` | Reference for `lookback`; `"latest"` = newest timestamp in `t` (for historical data) |
| `lastPoints` | `number` | - | Keep anomalies among the last N samples (works without `t`) |

The window never changes detection: the detector always sees the full
history (so seasonality and baselines stay intact) and only `anomalies` is
filtered; `scores`/`expected` stay full length and `res.window` reports
`{ from, to, lastPoints, total, kept }`. `Duration` is milliseconds or a
string such as `"90s"`, `"15m"`, `"24h"`, `"7d"`, `"2w"`, `"1mo"`, `"1y"`
(`m` = minutes, `mo`/`y` are UTC calendar months/years). Asking for
`lookback`/`since` on a series without `t` throws `badParams`.

```ts
// "were there anomalies in the past month?"
const recent = iso.detectAnomalies({ y, t }, { lookback: "1mo" });
if (recent.anomalies.length) alert(`${recent.window!.kept} of ${recent.window!.total} anomalies in the last month`);
```

### `explainAnomalies(series, result, opts?)` → `AnomalyExplanation[]`

`explainAnomalies(series, result, opts?)` turns each flagged point into
plain language (pure function, no engine call):

```ts
import { explainAnomalies, genSeries } from "isocline";

const { y, t } = genSeries({ n: 720, period: 24, seed: 42 });
const res = iso.detectAnomalies({ y, t });
const why = explainAnomalies({ y, t }, res, {
  name: "checkout latency",
  period: iso.seasonality({ y, t }).bestPeriod,  // optional: names the cycle
  changepoints: iso.changepoints({ y, t }),     // optional: level-shift context
});
why[0].text;
// "Dip in checkout latency at 2026-10-11 16:00 UTC: 49.3 vs ~57.9 expected (-15%).
//  The expected value already includes the trend and the usual 24-step cycle, so
//  neither explains it: the leftover deviation is 5.59 robust standard deviations
//  below normal (1.60× the 3.50 cut-off). It is part of a 2-point drop from
//  2026-10-11 16:00 UTC to 2026-10-11 17:00 UTC, so this looks like a sustained
//  event rather than a single bad reading."
```

Each `AnomalyExplanation` also carries the structured facts behind the
sentence: `severity` (`"low" | "medium" | "high"` from score ÷ threshold:
<1.5×, <2.5×, else), `delta`, `deltaPct`, `run` (the consecutive flagged
stretch it belongs to), `levelShift` (a same-direction changepoint at the
start of a sustained run), `extreme` (series max/min), `headline`,
`reasons[]`. Pass the explanations to `isocline-plot`'s `anomalyPlot(…, {
explanations })` to show them in tooltips.

### `detect(engine, input, opts?)` → `DetectReport`

Hand it arbitrary data and get typed findings, each with a one-line
`summary` and a plain-language `explanation`:

```ts
import { detect } from "isocline";

// rows: [{ timestamp: "2026-10-04T00:00:00.000Z", device: "device-0", cpu: 41.2 }, …]
// time / numeric / category columns are inferred
const report = detect(iso, rows, { lookback: "1mo" });
report.headline; // "6 anomalies and 1 category outlier detected in the last month (checked 6 series + 1 category comparison)."
report.summary;  // headline + one "- …" line per finding
for (const f of report.findings) {
  f.summary;     // "Anomaly detected for cpu · device-3 at 2026-11-02 04:00 UTC: spike, 84.9 vs ~48.0 expected (+77%)."
  if (f.kind === "anomaly") f.details.run; // narrowed by `kind`
}

// only time-series anomalies, typed as AnomalyFinding[]
const only = detect(iso, { y, t }, { kinds: ["anomaly"], lookback: "7d", minSeverity: "medium" });
```

What runs depends on the input shape:

| Input | Analyses | Finding kinds |
|---|---|---|
| `number[]` / `Float64Array` / `{ y, t? }` | anomaly detection per numeric column | `anomaly` |
| numeric + category + time (records or `{ y, categories, t }`) | anomalies per (measure, category) series; category aggregates vs peers (IQR) | `anomaly`, `category_outlier` |
| numeric + category, no time | category aggregates vs peers | `category_outlier` |
| events: category (or nothing) + time, no numbers | per-category event counts bucketed over time, anomalies on the counts with a Poisson guard | `frequency_outlier` (with `at`) |
| category only, no time | category counts vs peers (IQR) | `frequency_outlier` (no `at`) |

Records inference: the time column is the first named like
`t`/`ts`/`time`/`timestamp`/`date`/`created_at`… or holding `Date`s/ISO
strings (epoch seconds are converted to ms); every all-numeric column is a
measure; the category is the first string column with at most n/2 distinct
values. Override with `fields: { time, value, category }`. Series with
fewer than 8 finite points (or that the engine rejects) land in
`report.skipped` instead of throwing.

| Option | Default | Description |
|---|---|---|
| `lookback` / `since` / `now` / `lastPoints` | - | Same post-result window as `detectAnomalies`; category comparisons aggregate only rows inside the window |
| `kinds` | all | Restrict analyses and narrow the findings type |
| `name` | `"series"` | Subject for unnamed numeric input |
| `fields` | inferred | `{ time?, value?, category? }` for records |
| `anomaly` | `{ method: "stl" }` | Any `AnomalyOptions` except the window |
| `frequency` | auto bucket, 50 categories, `minPoissonZ: 3` | `{ bucket?: Duration, maxCategories?, minPoissonZ? }`; auto bucket = coarsest of 1s…1w giving ≥ 100 buckets |
| `categories` | `{ agg: "sum", factor: 1.5 }` | Aggregation and IQR multiplier for category comparisons |
| `context` | `true` | Also run seasonality + changepoints per series for richer explanations |
| `minSeverity` | `"low"` | Drop findings below this severity |
| `sort` | `"severity"` | Or `"recent"` (newest first) |
| `limit` | none | Cap `findings` (headline/`counts` still count everything) |
| `formatTime` | UTC `YYYY-MM-DD HH:MM UTC` | Timestamp formatter for all text |

`DetectReport`: `headline`, `summary`, `findings` (discriminated union
`AnomalyFinding | FrequencyOutlierFinding | CategoryOutlierFinding`, every
one with `subject`, `measure`, `category`, `at`, `severity`, `score`,
`threshold`, `summary`, `explanation`), `counts` per kind, `window`
(`{ from, to, lastPoints, total, kept }` when a window was set),
`analyzed`, `skipped`. Helpers `filterAnomalies`, `formatTimestamp`,
`formatNumber`, `severityOf`, `durationMs`, `subtractDuration`, `toEpochMs`
are exported too.

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
