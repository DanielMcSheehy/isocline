# Isocline Algorithms - A Math Guide

This is the user-facing guide to what the engine actually computes. It
mirrors `CONTRACT.md` §4 and the doc comments in `crates/isocline-core`;
when those change, this document changes. All code is std-only Rust, all
arithmetic is `f64`, and every operation is deterministic given the same
seed. Inputs containing `NaN` are filled by linear interpolation before any
operation except `interpolate` itself.

Contents:

1. [Seasonality detection](#1-seasonality-detection)
2. [STL-style decomposition](#2-stl-style-decomposition)
3. [ETS: Holt–Winters with damped trend](#3-ets-holtwinters-with-damped-trend)
4. [AR(p)](#4-arp)
5. [Naive and seasonal-naive](#5-naive-and-seasonal-naive)
6. [Model dispatch](#6-model-dispatch)
7. [Bootstrap prediction intervals](#7-bootstrap-prediction-intervals)
8. [Anomaly detectors](#8-anomaly-detectors)
9. [Changepoints: binary segmentation](#9-changepoints-binary-segmentation)
10. [Backtesting](#10-backtesting)
11. [Metrics](#11-metrics)

---

## 1. Seasonality detection

**What it does.** Finds the dominant seasonal period `p` (e.g. 24 for
hourly data with a daily cycle) and scores how strongly seasonal the series
is. Used by `seasonality()` and by every `"auto"` period/model decision.

**How.**

1. Compute the ACF and periodogram up to
   `max_lag = min(n/2, maxPeriod, 1024)`.
2. **ACF via FFT**: the series is mean-centered and zero-padded to the next
   power of two ≥ 2n; the autocovariance comes from the inverse FFT of the
   power spectrum, normalized so

   ```
   acf[k] = Σᵢ (yᵢ − ȳ)(yᵢ₊ₖ − ȳ) / Σᵢ (yᵢ − ȳ)²
   ```

3. **Periodogram**: FFT of mean-centered (and optionally 10% Tukey-tapered)
   data; power `|X_k|² / n` at frequencies `k / nfft`.
4. Candidate periods come from two sources: local peaks of the periodogram
   (period = `nfft/k`, top 3 with `2 ≤ period ≤ maxPeriod`) and positive
   local maxima of the ACF at lags ≥ 2. Each spectral candidate is matched
   to the nearest ACF peak within 5%; the matched candidate's strength is
   the ACF peak value clamped to [0, 1].
5. The best candidate is refined with one quick non-robust STL pass (2
   seasons, 2 inner iterations) and the final **seasonal strength** is

   ```
   strength = 1 − var(resid) / var(seasonal + resid),  clamped to [0, 1]
   ```

6. `bestPeriod = null` when `strength < 0.2`.

**When to trust it.** Strength > 0.7 is a strongly seasonal series;
0.2–0.5 is weak seasonality where a seasonal model still helps but STL
separation adds little; below 0.2 the engine treats the series as
non-seasonal. The test gates verify recovery of p = 24, 7, and 168 on
synthetic data.

## 2. STL-style decomposition

**What it does.** Splits `y` into trend + seasonal + residual
(`decompose()`), robustly, with an optional out-of-sample seasonal
projection used for forecasting.

**How.** Classical STL, simplified: local **linear** regression (LOESS
degree 1 with tri-cube weights) instead of degree 2.

Inner loop (repeated `seasons` times, default 3):

1. Detrend: `z = y − trend`.
2. **Cycle-subseries smoothing**: for each phase `p ∈ 0..period`, LOESS-1
   fits that subseries (x = cycle index, y = the z values at that phase)
   and is evaluated at every existing point - and, for forecasting, `h`
   steps beyond the data. This out-of-sample LOESS evaluation is what
   produces `seasonal_project(h)` without refitting anything.
3. **Low-pass**: moving averages of lengths `period`, `period`, `2` (with
   padding) applied to the combined seasonal estimate → `seasonal_low`.
4. Update: `seasonal = cycle_smoothed − seasonal_low`;
   `trend = LOESS-1(y − seasonal)` with a centered span of `period + 1`.

Outer loop (3 passes when `robust = true`, the default): bisquare weights

```
w = (1 − (r / 6·MAD)²)²   (clamped to [0,1])
```

computed from the residuals of the last inner loop, folded into all LOESS
weights. This is what stops spikes and dips from leaking into the trend.

The reported `seasonalStrength` is the same statistic as in §1. Missing
values are interpolated before decomposing.

## 3. ETS: Holt–Winters with damped trend

**What it does.** Exponential smoothing with an additive error, damped
additive trend, and additive seasonality - model **ETS(A, Ad, A)** - fitted
end-to-end numerically. Used by `model: "ets"` and inside `stl_ets`.

State equations (`l` = level, `b` = damped trend, `s[i]` = seasonal state
for phase `i`, period `p`):

```
l_t = α(y_t − s_{t−p}) + (1 − α)(l_{t−1} + φ·b_{t−1})
b_t = β(l_t − l_{t−1}) + (1 − β)·φ·b_{t−1}
s_t = γ(y_t − l_t) + (1 − γ)·s_{t−p}

ŷ_{t+1} = l_t + φ·b_t + s_{t+1−p}
```

Without a detected period the seasonal terms drop out (ETS(A,Ad,N)).

**Initialization.** An OLS line over the first `min(2p, n)` points gives
the initial level (intercept) and trend (slope); the initial seasonal
states are the means of the first season's detrended values.

**Fitting.** Nelder–Mead minimizes the one-step SSE over
`(α, β, γ, φ)` with bounds `α, γ ∈ [0.01, 0.99]`, `β ∈ [0.01, 0.5]`,
`φ ∈ [0.8, 0.999]`, enforced by mapping the parameters through a sigmoid.
The NM setup: reflection 1, expansion 2, contraction 0.5, shrink 0.5;
initial simplex from a 5% perturbation; at most 300 iterations, tolerance
1e-6; **3 restarts** from `.3/.1/.3/.95` and perturbed bests to avoid local
minima. Reported `params`: `alpha`, `beta`, `gamma` (null when
non-seasonal), `phi`. One-step fitted values and residuals are retained for
metrics and the bootstrap.

## 4. AR(p)

**What it does.** Autoregression of order p by ordinary least squares,
order picked automatically. Used by `model: "ar"`.

- Build the lag matrix; solve the normal equations with a dense Cholesky
  solver (ridge 1e-8 for stability).
- Try every order `p = 1..min(20, n/4)` and pick the one minimizing

  ```
  AICc = n·ln(SSE/n) + 2k + 2k(k+1)/(n − k − 1)
  ```

  with `k = p + 1` parameters.
- Forecasting is recursive: predict one step, feed it back in.
- No seasonal terms are fitted (seasonal adjustment happens upstream via
  STL when a period exists). Prediction intervals come from the residual
  bootstrap (§7). Requires `n ≥ 8`.

## 5. Naive and seasonal-naive

Parameter-free baselines - important both as fallbacks and as the bar any
fancier model must beat:

- **naive**: `ŷ_{n+h} = y_n`.
- **snaive**: `ŷ_{n+h} = y_{n+h − p·⌈h/p⌉}` (repeat the last season).

Intervals: naive uses repeated overall residual quantiles; snaive uses
per-phase residual quantiles (so each phase of the season carries its own
uncertainty). No parameters are reported.

## 6. Model dispatch

`model: "auto"` resolves in two steps:

1. Resolve the period (`period: "auto"` runs §1; a period is adopted when
   strength ≥ 0.2).
2. Pick the model from seasonal strength:

| Seasonal strength | Model chosen |
|---|---|
| ≥ 0.5 | `stl_ets` |
| 0.2 – 0.5 | `ets` |
| < 0.2 | `ar` (or `ets` when n < 16) |

- **`stl_ets`**: robust STL (§2) → seasonal projection `h` ahead;
  ETS(A,Ad,N) fits the deseasonalized (trend + resid) series; the forecast
  is `ets.point + seasonal_proj`, and bootstrap intervals are simulated on
  the deseasonalized scale, then re-seasonalized.
- **`ets`**: full seasonal Holt–Winters when a period exists, otherwise
  ETS(A,Ad,N).
- **`ar`**: AR(p) on seasonally-adjusted data when a period exists,
  re-seasonalized like `stl_ets`.

Guards: seasonal models need `n ≥ 2·period + 1` (otherwise the engine warns
`"insufficient data for seasonality; fell back to naive"` and uses naive);
AR needs `n ≥ 8`; everything needs `n ≥ 3` or the call fails with
`tooShort`.

## 7. Bootstrap prediction intervals

Every model gets intervals the same way, which is the point: no
per-model distributional assumptions.

1. Resample the model's one-step residuals **with replacement** using the
   seeded xorshift RNG (`seed`, default 42).
2. Simulate `paths` futures (default 200, up to 2000) by evolving the
   fitted model forward, adding one resampled residual per step.
3. For each horizon step, `lower` / `upper` are the empirical quantiles at
   `(1 − level)/2` and `1 − (1 − level)/2` (quantiles computed by linear
   interpolation, type 7).
4. `point` is the **median of the simulated paths** for bootstrap models,
   and must lie within `[lower, upper]` (the smoke tests assert this).

Calibration is tested empirically: across 200 simulated realizations of
synthetic data, the empirical coverage of the nominal-0.95 interval lands
in **[0.88, 1.0]**. Set `paths: 0` to skip simulation entirely (interval
arrays come back at zero length).

Normal sampling inside the simulators uses Box–Muller on the same seeded
uniform stream.

## 8. Anomaly detectors

Four detectors, all sharing the same result shape: a list of flagged
`{index, score, expected, observed, direction}` plus the full signed
`scores` array (positive = above expected). The `direction` option filters
`"spike"` / `"dip"`.

### `stl` - STL residual modified z-score (default)

Robust STL (§2) → residual `r_t`; modified z-score

```
mz = 0.6745 · (r − median(r)) / MAD(r)
```

where MAD is the median absolute deviation (0.6745 scales it to a
standard-deviation equivalent for Gaussian data). Flag `|mz| > threshold`
(default 3.5). `expected = trend + seasonal` - the most interpretable
"what should have happened" line.

### `madz` - modified z on rolling-median detrend

Detrend with a centered rolling median (window = the period when known,
else 11; the window shrinks at the ends), then modified z-score of the
residual as above, flag > 3.5. Cheaper than STL and robust to trend.

### `iqr` - interquartile-range fences

Compute Q1/Q3 (of y, after optional detrending as in `madz`); flag points
outside

```
[Q1 − k·IQR,  Q3 + k·IQR],   k = threshold (default 1.5)
```

`score` is the signed distance in k units, normalized so the threshold
semantics match.

### `ewma` - EWMA control chart

```
z_t = λ·y_t + (1 − λ)·z_{t−1},   λ = lambda (default 0.3, in (0,1])
σ_z = σ_y · sqrt(λ / (2 − λ))
σ_y = 1.4826 · MAD(diff(y)) / √2    (robust, from first differences)
```

Flag `|z_t − z̄| > L·σ_z` with `L = threshold` (default 3.0). The first
`max(period, 11)` points are warmup and never flagged. `expected = z_t`  - 
this detector is aimed at slow drifts and sustained small shifts, the
opposite regime from the spike-hunting STL detector.

## 9. Changepoints: binary segmentation

Mean-shift detection by recursive splitting (`changepoints()`):

1. Estimate noise robustly: `σ̂ = 1.4826 · MAD(diff(y)) / √2` (guard
   `σ̂ ≥ 1e-9`).
2. For a segment `[a, b)`, evaluate every split `s` with the gain statistic

   ```
   g(s) = √(n₁·n₂/n) · |mean₁ − mean₂| / σ̂,    n₁ = s − a,  n₂ = b − s
   ```

   The `√(n₁n₂/n)` factor penalizes lopsided splits.
3. Accept the maximizing split when `g > threshold` (default 3.0, in sigma
   units) and both sides have at least `minSegment` (default 10) points.
4. Recurse on both halves until `maxChangepoints` (default 10) is reached
   or no split is accepted. Output: sorted `{index, meanBefore, meanAfter}`
   and a `means` step array of segment means over the whole series.

The test gate verifies localization within ±3 of an injected level shift.

## 10. Backtesting

Rolling-origin evaluation (`backtest()`): the last `folds × horizon` points
are held out; fold `i` trains on the first `n − (folds − i)·horizon` points
and forecasts `horizon` steps. Metrics are aggregated across folds per
model - out-of-sample only, no in-sample numbers are mixed in. Each row
reports `rmse`, `mae`, `smape`, the fold count, and `coverage`: the
fraction of held-out actuals that fell inside the model's prediction
interval (a second, data-driven check on §7's calibration). `"auto"` is
resolved once on the full series so every fold of a run uses the same
model.

## 11. Metrics

In-sample one-step metrics on the training data (and the same definitions
per fold in backtesting):

| Metric | Definition |
|---|---|
| `rmse` | `√(mean((y − ŷ)²))` |
| `mae` | `mean(\|y − ŷ\|)` |
| `smape` | `200 · \|y − ŷ\| / (\|y\| + \|ŷ\|)` per point, averaged |

sMAPE is skipped when `|y| + |ŷ| < 1e-12` and reported as 0 if all points
are skipped; its range is [0, 200]. sMAPE is symmetric, so it is the
fairest of the three when the series crosses zero or spans several orders
of magnitude; RMSE punishes large misses hardest; MAE is the most robust
to outliers.

## Practical selection summary

- Strong, stable seasonality → `stl_ets` (strength ≥ 0.5).
- Weak-to-moderate seasonality → `ets` (0.2–0.5).
- Little seasonality, n ≥ 16 → `ar`; very short series → `ets`.
- Spiky outliers → anomaly `stl`; slow drifts → `ewma`; no seasonality and
  speed matters → `madz` or `iqr`.
- Always sanity-check against `snaive`: if a model cannot beat it in
  `backtest`, do not ship it. The test gates enforce exactly that for
  `stl_ets` on trending seasonal data.
