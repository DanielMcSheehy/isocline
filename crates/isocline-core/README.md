# isocline-core

Fast, dependency-free time-series forecasting and anomaly detection in pure
Rust. The crate is `std`-only with zero required dependencies; `rayon` is
available only behind the optional `parallel` feature for batch workloads.
Everything operates on a univariate `&[f64]` series, is deterministic given
the same seed, and never panics on any input.

This crate is the algorithmic heart of Isocline. The WASM bindings
(`crates/isocline-wasm`) and the TypeScript package (`packages/isocline`)
are thin layers over this API.

## Operations

| Function | What it does |
|---|---|
| `forecast(y, &ForecastOptions)` | Point forecast + bootstrap prediction intervals, seven model families |
| `detect_anomalies(y, &AnomalyOptions)` | Four anomaly detectors over a series |
| `decompose(y, &DecomposeOptions)` | STL-style robust trend/seasonal/residual decomposition |
| `seasonality(y, &SeasonalityOptions)` | ACF + periodogram seasonality detection |
| `changepoints(y, &ChangepointOptions)` | Binary-segmentation mean-shift detection |
| `backtest(y, &BacktestOptions)` | Rolling-origin model comparison with PI coverage |
| `interpolate(y)` | Fill NaN holes by linear interpolation |

## Algorithm inventory

- **STL-style robust decomposition** - local *linear* (degree-1) LOESS with
  tri-cube weights, cycle-subseries smoothing, low-pass filter, and a bisquare
  robust outer loop. Includes out-of-sample LOESS: `seasonal_project(h)`
  evaluates the cycle-subseries smoother `h` steps beyond the data, which is
  what makes seasonal forecasting work without refitting.
- **Holt–Winters ETS(A,Ad,A)** - additive damped-trend exponential smoothing,
  fitted by Nelder–Mead on (alpha, beta, gamma, phi) with bounds enforced via
  sigmoid mapping; 3 restarts. Falls back to ETS(A,Ad,N) without a period.
- **AR(p)** - ordinary least squares over a lag matrix, order selected by AICc
  over p = 1..min(20, n/4); recursive forecasting.
- **Naive / Seasonal-naive** - parameter-free baselines used as fallbacks and
  benchmarks.
- **FFT-based ACF and periodogram** - radix-2 Cooley–Tukey, zero-padded to the
  next power of two; spectral and ACF peak candidates are matched to rank
  seasonal periods (optional 10% Tukey taper on the periodogram).
- **Four anomaly detectors** - STL-residual modified z-score, modified
  z-score on a rolling-median detrend, IQR fences, and an EWMA control chart.
- **Binary-segmentation changepoints** - mean-shift gain statistic with a
  robust noise estimate.
- **Rolling-origin backtesting** - last `folds x horizon` points held out;
  per-model RMSE / MAE / sMAPE plus empirical PI coverage.
- **Bootstrap prediction intervals** - `paths` futures simulated by evolving
  the fitted model with residuals resampled (with replacement) from a seeded
  xorshift RNG; intervals are the empirical quantiles.

## Usage

```rust
use isocline_core::*;

// Synthetic hourly-ish series: level + trend + daily seasonality.
let mut y = Vec::with_capacity(240);
for i in 0..240 {
    y.push(50.0 + 0.02 * i as f64
        + 8.0 * (std::f64::consts::TAU * i as f64 / 24.0).sin());
}
y[120] += 40.0; // inject a spike

// Forecast with bootstrap prediction intervals.
let opts = ForecastOptions { horizon: 24, ..Default::default() };
let fc = forecast(&y, &opts).unwrap();
assert_eq!(fc.point.len(), 24);
for j in 0..24 {
    assert!(fc.lower[j] <= fc.point[j] && fc.point[j] <= fc.upper[j]);
}
println!("model = {:?}, rmse = {}", fc.model, fc.metrics.rmse);

// Detect the spike.
let a = detect_anomalies(&y, &AnomalyOptions::default()).unwrap();
assert!(a.anomalies.iter().any(|an| an.index == 120));

// Decompose and inspect seasonal strength.
let d = decompose(&y, &DecomposeOptions::default()).unwrap();
assert_eq!(d.period, 24);
println!("seasonal strength = {}", d.seasonal_strength);
```

Every option struct implements `Default` with sensible values
(`horizon: 24`, `level: 0.95`, `paths: 200`, `seed: 42`, ...), so the
`..Default::default()` pattern covers most call sites. Inputs may contain
`NaN`: every operation except `interpolate` fills missing values by linear
interpolation first.

## Scaling up

The core is single-threaded by default and stays `std`-only. For server-side
batch workloads, enable the `parallel` feature and use the batch functions:

```toml
[dependencies]
isocline-core = { version = "0.1", features = ["parallel"] }
```

```rust
use isocline_core::batch::batch_forecast;

let results = batch_forecast(&many_series, &ForecastOptions::default());
```

`batch_forecast` and `batch_detect_anomalies` fan out over rayon; each series
runs the identical deterministic algorithm, so batch results match sequential
runs exactly. The feature is off for the WASM target.

## Choosing a model

| Situation | Model |
|---|---|
| Clear, stable seasonality (strength >= 0.5) | `stl_ets` - robust STL + ETS on the deseasonalized series |
| Weak-to-moderate seasonality (0.2–0.5) | `ets` - full seasonal Holt–Winters |
| Little or no seasonality, short series | `ar` (AICc-selected), or `ets` when n < 16 |
| Baseline / sanity check | `snaive` (seasonal) or `naive` |

With `Model::Auto` (the default) the dispatch follows exactly this heuristic
using the detected seasonal strength. Seasonal models require
`n >= 2*period + 1`; otherwise the engine warns and falls back to naive.

## Test gates

`cargo test -p isocline-core` (and `cargo test --workspace`) runs the
verification gates in `tests/integration.rs`:

- **Period recovery** - seasonality detection recovers p = 24, 7, and 168
  on synthetic series (within a small tolerance), with strength > 0.6.
- **Forecast quality** - `stl_ets` beats `snaive` on a holdout of trending
  seasonal data.
- **Anomaly recall/precision** - >= 0.8 on injected ground-truth events.
- **Changepoint localization** - detected within ±3 of the injected shift.
- **PI calibration** - empirical coverage of the nominal-0.95 interval over
  200 simulated realizations lands in [0.88, 1.0].
- **Determinism** - same seed produces byte-identical output channels.
- **Edge cases** - n = 3 forecasts, n = 2 is `TooShort`, constant series
  yields a flat forecast with no anomalies/changepoints/seasonality.
