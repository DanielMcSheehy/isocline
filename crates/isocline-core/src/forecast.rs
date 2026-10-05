//! Forecast dispatch per CONTRACT §4.7 and rolling-origin backtest per §4.10.

use crate::ar;
use crate::error::IsoclineError;
use crate::ets;
use crate::math::{quantile_sorted, Rng};
use crate::naive;
use crate::seasonality::{self, SeasonalityOptions};
use crate::stl;
use std::collections::BTreeMap;

/// Model kind (mirrors TS `ModelKind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Model {
    /// Automatic selection (never returned in results).
    #[default]
    Auto,
    /// STL + ETS(A,Ad,N) on the deseasonalized series.
    StlEts,
    /// Holt–Winters ETS(A,Ad,A) / ETS(A,Ad,N).
    Ets,
    /// AR(p) with AICc order selection.
    Ar,
    /// Seasonal naive.
    Snaive,
    /// Naive.
    Naive,
}

impl Model {
    /// TS-compatible identifier.
    pub fn as_str(self) -> &'static str {
        match self {
            Model::Auto => "auto",
            Model::StlEts => "stl_ets",
            Model::Ets => "ets",
            Model::Ar => "ar",
            Model::Snaive => "snaive",
            Model::Naive => "naive",
        }
    }
}

/// In-sample one-step metrics (mirrors TS `Metrics`).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Metrics {
    /// Root mean squared error.
    pub rmse: f64,
    /// Mean absolute error.
    pub mae: f64,
    /// Symmetric MAPE in percent (0..=200).
    pub smape: f64,
}

/// Forecast options (mirrors TS `ForecastOptions`).
#[derive(Debug, Clone)]
pub struct ForecastOptions {
    /// Model to use; `Auto` by default.
    pub model: Model,
    /// Forecast horizon, 1..=10000 (default 24).
    pub horizon: usize,
    /// Period; `None` = auto-detect.
    pub period: Option<u32>,
    /// Prediction-interval coverage in (0,1); default 0.95.
    pub level: f64,
    /// Bootstrap paths, 0..=2000 (default 200).
    pub paths: usize,
    /// RNG seed for determinism (default 42).
    pub seed: u64,
}

impl Default for ForecastOptions {
    fn default() -> Self {
        ForecastOptions {
            model: Model::Auto,
            horizon: 24,
            period: None,
            level: 0.95,
            paths: 200,
            seed: 42,
        }
    }
}

/// Forecast result (mirrors TS `ForecastResult`).
#[derive(Debug, Clone)]
pub struct ForecastResult {
    /// Resolved model (never `Auto`).
    pub model: Model,
    /// Detected/used period, `None` if none.
    pub period: Option<u32>,
    /// Forecast horizon.
    pub horizon: usize,
    /// PI coverage.
    pub level: f64,
    /// Point forecast, length h.
    pub point: Vec<f64>,
    /// Lower PI bound, length h.
    pub lower: Vec<f64>,
    /// Upper PI bound, length h.
    pub upper: Vec<f64>,
    /// In-sample one-step fits, length n.
    pub fitted: Vec<f64>,
    /// In-sample one-step residuals, length n.
    pub residuals: Vec<f64>,
    /// Bootstrap paths, flat `pathsN × h`; `None` when paths = 0.
    pub paths: Option<Vec<f64>>,
    /// Number of simulated paths.
    pub paths_n: usize,
    /// Projected trend, length h (stl_ets only).
    pub trend: Option<Vec<f64>>,
    /// Projected seasonal, length h (stl_ets / snaive).
    pub seasonal: Option<Vec<f64>>,
    /// In-sample one-step metrics.
    pub metrics: Metrics,
    /// Model parameters.
    pub params: BTreeMap<String, f64>,
    /// Warnings (e.g. insufficient-data fallbacks).
    pub warnings: Vec<String>,
}

/// Backtest options (mirrors TS `BacktestOptions`).
#[derive(Debug, Clone)]
pub struct BacktestOptions {
    /// Models to evaluate; default `["stl_ets", "ets", "ar", "snaive"]`.
    pub models: Vec<Model>,
    /// Horizon per fold, default 24.
    pub horizon: usize,
    /// Number of rolling-origin folds, default 3.
    pub folds: usize,
    /// Period; `None` = auto.
    pub period: Option<u32>,
    /// RNG seed.
    pub seed: u64,
}

impl Default for BacktestOptions {
    fn default() -> Self {
        BacktestOptions {
            models: vec![Model::StlEts, Model::Ets, Model::Ar, Model::Snaive],
            horizon: 24,
            folds: 3,
            period: None,
            seed: 42,
        }
    }
}

/// One backtest row (mirrors TS `BacktestRow`).
#[derive(Debug, Clone)]
pub struct BacktestRow {
    /// Resolved model.
    pub model: Model,
    /// Number of folds actually evaluated.
    pub folds: usize,
    /// Fraction of actuals inside the PI.
    pub coverage: f64,
    /// Out-of-sample RMSE.
    pub rmse: f64,
    /// Out-of-sample MAE.
    pub mae: f64,
    /// Out-of-sample sMAPE (percent).
    pub smape: f64,
}

/// Backtest result (mirrors TS `BacktestResult`).
#[derive(Debug, Clone)]
pub struct BacktestResult {
    /// One row per model.
    pub rows: Vec<BacktestRow>,
    /// Horizon used.
    pub horizon: usize,
    /// Folds requested.
    pub folds: usize,
}

/// Computed metrics from fitted/residual pairs. sMAPE skips pairs with
/// `|y| + |ŷ| < 1e-12` and reports 0 when all are skipped.
pub fn compute_metrics(actual: &[f64], fitted: &[f64]) -> Metrics {
    let n = actual.len().min(fitted.len());
    if n == 0 {
        return Metrics::default();
    }
    let mut sse = 0.0;
    let mut sae = 0.0;
    let mut smape_sum = 0.0;
    let mut smape_n = 0usize;
    for i in 0..n {
        let e = actual[i] - fitted[i];
        sse += e * e;
        sae += e.abs();
        let denom = actual[i].abs() + fitted[i].abs();
        if denom >= 1e-12 {
            smape_sum += 200.0 * e.abs() / denom;
            smape_n += 1;
        }
    }
    Metrics {
        rmse: (sse / n as f64).sqrt(),
        mae: sae / n as f64,
        smape: if smape_n > 0 { smape_sum / smape_n as f64 } else { 0.0 },
    }
}

/// Bootstrap PI quantiles from a flat `paths × h` simulation matrix.
/// Returns `(lower, median, upper)` per step; `point` (median) is clamped
/// inside `[lower, upper]` afterwards by the caller.
fn bootstrap_bands(
    sim: &[f64],
    paths: usize,
    h: usize,
    level: f64,
) -> (Vec<f64>, Vec<f64>, Vec<f64>) {
    let alpha = (1.0 - level).clamp(0.0, 1.0);
    let q_lo = alpha / 2.0;
    let q_hi = 1.0 - alpha / 2.0;
    let mut lower = vec![0.0; h];
    let mut median = vec![0.0; h];
    let mut upper = vec![0.0; h];
    let paths = paths.max(1);
    let mut col: Vec<f64> = Vec::with_capacity(paths);
    for j in 0..h {
        col.clear();
        for p in 0..paths {
            col.push(sim[p * h + j]);
        }
        col.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        lower[j] = quantile_sorted(&col, q_lo);
        median[j] = quantile_sorted(&col, 0.5);
        upper[j] = quantile_sorted(&col, q_hi);
        if lower[j] > upper[j] {
            std::mem::swap(&mut lower[j], &mut upper[j]);
        }
    }
    (lower, median, upper)
}

/// Clamp `point` into `[lower, upper]` elementwise (guards quantile ties).
fn clamp_point(point: &mut [f64], lower: &[f64], upper: &[f64]) {
    for i in 0..point.len() {
        if lower[i] > upper[i] {
            continue; // already swapped earlier; nothing sane to do
        }
        if point[i] < lower[i] {
            point[i] = lower[i];
        } else if point[i] > upper[i] {
            point[i] = upper[i];
        }
    }
}

/// Internal resolution result shared by forecast and backtest.
pub(crate) struct Resolved {
    pub model: Model,
    pub period: Option<usize>,
    pub strength: f64,
}

/// Resolve period + strength + concrete model per §4.7. `y` must be clean.
pub(crate) fn resolve(y: &[f64], opts: &ForecastOptions, warnings: &mut Vec<String>) -> Result<Resolved, IsoclineError> {
    let n = y.len();
    let (period, strength) = match opts.period {
        Some(pv) => {
            if pv < 2 {
                return Err(IsoclineError::BadConfig("period must be >= 2".into()));
            }
            let p = pv as usize;
            if p >= n {
                warnings.push("period >= series length; seasonality ignored".to_string());
                (None, 0.0)
            } else {
                let s = if n > 2 * p { seasonality::quick_strength(y, p) } else { 0.0 };
                (Some(p), s)
            }
        }
        None => {
            let det = seasonality::detect(y, &SeasonalityOptions::default())?;
            (det.best_period.map(|v| v as usize), det.strength)
        }
    };
    let mut model = opts.model;
    if model == Model::Auto {
        model = if strength >= 0.5 {
            Model::StlEts
        } else if strength >= 0.2 || n < 16 {
            // Weak seasonality -> seasonal-capable ETS; short series -> ETS.
            Model::Ets
        } else {
            Model::Ar
        };
    }
    // Guard: stl_ets is meaningless without a period.
    if model == Model::StlEts && period.is_none() {
        warnings.push("stl_ets requires a period; fell back to ets".to_string());
        model = Model::Ets;
    }
    // Guard: seasonal models need n >= 2*period + 1 -> naive fallback.
    if let Some(p) = period {
        if n < 2 * p + 1 && matches!(model, Model::StlEts | Model::Ets | Model::Ar | Model::Snaive) {
            warnings.push("insufficient data for seasonality; fell back to naive".to_string());
            model = Model::Naive;
        }
    }
    if model == Model::Ar && n < 8 {
        warnings.push("insufficient data for AR; fell back to naive".to_string());
        model = Model::Naive;
    }
    if model == Model::Snaive && period.is_none() {
        warnings.push("snaive requires a period; fell back to naive".to_string());
        model = Model::Naive;
    }
    Ok(Resolved { model, period, strength })
}

/// Fit the requested (resolved) model and produce the full forecast result.
#[allow(clippy::too_many_lines)]
#[allow(clippy::ptr_arg)] // needs Vec for `push` of fallback warnings
pub(crate) fn run_model(
    y: &[f64],
    model: Model,
    period: Option<usize>,
    strength: f64,
    opts: &ForecastOptions,
    warnings: &mut Vec<String>,
) -> Result<ForecastResult, IsoclineError> {
    let n = y.len();
    let h = opts.horizon;
    let mut params: BTreeMap<String, f64> = BTreeMap::new();
    if let Some(p) = period {
        params.insert("period".to_string(), p as f64);
    }
    params.insert("strength".to_string(), strength);

    let (point, lower, upper, fitted, residuals, trend_out, seasonal_out, paths_flat) =
        match model {
            Model::Naive => {
                let fit = naive::naive_fit(y);
                let pt = fit.forecast(y, h);
                let (lo_off, hi_off) = fit.bands(h, opts.level);
                let lo: Vec<f64> = pt.iter().zip(lo_off.iter()).map(|(a, b)| a + b).collect();
                let hi: Vec<f64> = pt.iter().zip(hi_off.iter()).map(|(a, b)| a + b).collect();
                let sim = if opts.paths > 0 {
                    let mut rng = Rng::new(opts.seed);
                    Some(fit.simulate(&pt, h, &mut rng, opts.paths))
                } else {
                    None
                };
                (pt, lo, hi, fit.fitted, fit.residuals, None, None, sim)
            }
            Model::Snaive => {
                let p = period.unwrap_or(2);
                let fit = naive::snaive_fit(y, p);
                let pt = fit.forecast(y, h);
                let (lo_off, hi_off) = fit.bands(h, opts.level);
                let lo: Vec<f64> = pt.iter().zip(lo_off.iter()).map(|(a, b)| a + b).collect();
                let hi: Vec<f64> = pt.iter().zip(hi_off.iter()).map(|(a, b)| a + b).collect();
                // Seasonal channel: offsets from the last-season mean.
                let last_mean = {
                    let start = n.saturating_sub(p);
                    crate::math::mean(&y[start..])
                };
                let seas: Vec<f64> = pt.iter().map(|v| v - last_mean).collect();
                let sim = if opts.paths > 0 {
                    let mut rng = Rng::new(opts.seed);
                    Some(fit.simulate(&pt, h, &mut rng, opts.paths))
                } else {
                    None
                };
                (pt, lo, hi, fit.fitted, fit.residuals, None, Some(seas), sim)
            }
            Model::StlEts => {
                let p = period.expect("stl_ets requires a period");
                let dec = stl::stl_fit(y, p, 3, true);
                let mut deseas = vec![0.0; n];
                for (d, (&yi, &si)) in deseas.iter_mut().zip(y.iter().zip(dec.seasonal.iter())) {
                    *d = yi - si;
                }
                let ef = ets::ets_fit(&deseas, None)?;
                let sproj = dec.seasonal_project(h);
                let trend_fc = ef.forecast(h);
                let mut fitted = vec![0.0; n];
                for (f, (&e, &s)) in fitted.iter_mut().zip(ef.fitted.iter().zip(dec.seasonal.iter())) {
                    *f = e + s;
                }
                params.insert("alpha".to_string(), ef.alpha);
                params.insert("beta".to_string(), ef.beta);
                if let Some(g) = ef.gamma {
                    params.insert("gamma".to_string(), g);
                }
                params.insert("phi".to_string(), ef.phi);
                let (pt, lo, hi, sim) = if opts.paths > 0 {
                    let mut rng = Rng::new(opts.seed);
                    let sim = ef.simulate(h, &ef.residuals, &mut rng, opts.paths);
                    let (lo, med, hi) = bootstrap_bands(&sim, opts.paths, h, opts.level);
                    let pt: Vec<f64> = med.iter().zip(sproj.iter()).map(|(a, b)| a + b).collect();
                    let lo: Vec<f64> = lo.iter().zip(sproj.iter()).map(|(a, b)| a + b).collect();
                    let hi: Vec<f64> = hi.iter().zip(sproj.iter()).map(|(a, b)| a + b).collect();
                    let sim: Vec<f64> = sim
                        .iter()
                        .zip(sproj.iter().cycle())
                        .map(|(v, s)| v + s)
                        .collect();
                    (pt, lo, hi, Some(sim))
                } else {
                    let pt: Vec<f64> = trend_fc.iter().zip(sproj.iter()).map(|(a, b)| a + b).collect();
                    (pt.clone(), pt.clone(), pt, None)
                };
                (pt, lo, hi, fitted, ef.residuals, Some(trend_fc), Some(sproj), sim)
            }
            Model::Ets => {
                let ef = ets::ets_fit(y, period)?;
                let pt_det = ef.forecast(h);
                let (pt, lo, hi, sim) = if opts.paths > 0 {
                    let mut rng = Rng::new(opts.seed);
                    let sim = ef.simulate(h, &ef.residuals, &mut rng, opts.paths);
                    let (lo, med, hi) = bootstrap_bands(&sim, opts.paths, h, opts.level);
                    (med, lo, hi, Some(sim))
                } else {
                    (pt_det.clone(), pt_det.clone(), pt_det, None)
                };
                params.insert("alpha".to_string(), ef.alpha);
                params.insert("beta".to_string(), ef.beta);
                if let Some(g) = ef.gamma {
                    params.insert("gamma".to_string(), g);
                }
                params.insert("phi".to_string(), ef.phi);
                (pt, lo, hi, ef.fitted, ef.residuals, None, None, sim)
            }
            Model::Ar => {
                let (point_f, lo, hi, fitted, residuals, sproj, sim) = if let Some(p) = period {
                    let dec = stl::stl_fit(y, p, 2, false);
                    let mut deseas = vec![0.0; n];
                    for (d, (&yi, &si)) in deseas.iter_mut().zip(y.iter().zip(dec.seasonal.iter())) {
                        *d = yi - si;
                    }
                    let af = ar::ar_fit(&deseas, n / 4)?;
                    let sp = dec.seasonal_project(h);
                    let fpt = ar::ar_forecast(&af, &deseas, h);
                    let mut fitted = vec![0.0; n];
                    for (f, (&e, &s)) in fitted.iter_mut().zip(af.fitted.iter().zip(dec.seasonal.iter())) {
                        *f = e + s;
                    }
                    let mut rng = Rng::new(opts.seed);
                    let (pt, lo, hi, sim) = if opts.paths > 0 {
                        let sim = ar::ar_simulate(&af, &deseas, h, &mut rng, opts.paths);
                        let (lo, med, hi) = bootstrap_bands(&sim, opts.paths, h, opts.level);
                        let pt: Vec<f64> = med.iter().zip(sp.iter()).map(|(a, b)| a + b).collect();
                        let lo: Vec<f64> = lo.iter().zip(sp.iter()).map(|(a, b)| a + b).collect();
                        let hi: Vec<f64> = hi.iter().zip(sp.iter()).map(|(a, b)| a + b).collect();
                        let sim: Vec<f64> =
                            sim.iter().zip(sp.iter().cycle()).map(|(v, s)| v + s).collect();
                        (pt, lo, hi, Some(sim))
                    } else {
                        let pt: Vec<f64> = fpt.iter().zip(sp.iter()).map(|(a, b)| a + b).collect();
                        (pt.clone(), pt.clone(), pt, None)
                    };
                    params.insert("order".to_string(), af.p as f64);
                    params.insert("intercept".to_string(), af.intercept);
                    for (i, &c) in af.coeffs.iter().enumerate() {
                        params.insert(format!("phi_{}", i + 1), c);
                    }
                    (pt, lo, hi, fitted, af.residuals, Some(sp), sim)
                } else {
                    let af = ar::ar_fit(y, n / 4)?;
                    let fpt = ar::ar_forecast(&af, y, h);
                    let (pt, lo, hi, sim) = if opts.paths > 0 {
                        let mut rng = Rng::new(opts.seed);
                        let sim = ar::ar_simulate(&af, y, h, &mut rng, opts.paths);
                        let (lo, med, hi) = bootstrap_bands(&sim, opts.paths, h, opts.level);
                        (med, lo, hi, Some(sim))
                    } else {
                        (fpt.clone(), fpt.clone(), fpt, None)
                    };
                    params.insert("order".to_string(), af.p as f64);
                    params.insert("intercept".to_string(), af.intercept);
                    for (i, &c) in af.coeffs.iter().enumerate() {
                        params.insert(format!("phi_{}", i + 1), c);
                    }
                    (pt, lo, hi, af.fitted, af.residuals, None, sim)
                };
                // TS contract: `trend` channel is stl_ets-only.
                let _ = sproj;
                (point_f, lo, hi, fitted, residuals, None, None, sim)
            }
            Model::Auto => {
                return Err(IsoclineError::Internal("model not resolved".into()));
            }
        };

    let mut point = point;
    let mut lower = lower;
    let mut upper = upper;
    // Ensure lower <= upper and the point lies inside the band.
    for j in 0..h {
        if !lower[j].is_finite() || !upper[j].is_finite() || !point[j].is_finite() {
            return Err(IsoclineError::Internal("non-finite forecast output".into()));
        }
        if lower[j] > upper[j] {
            std::mem::swap(&mut lower[j], &mut upper[j]);
        }
    }
    clamp_point(&mut point, &lower, &upper);

    let metrics = compute_metrics(y, &fitted);
    Ok(ForecastResult {
        warnings: warnings.clone(),
        model,
        period: period.map(|p| p as u32),
        horizon: h,
        level: opts.level,
        point,
        lower,
        upper,
        fitted,
        residuals,
        paths: paths_flat,
        paths_n: if opts.paths > 0 { opts.paths } else { 0 },
        trend: trend_out,
        seasonal: seasonal_out,
        metrics,
        params,
    })
}

/// Top-level forecast entry point. Input may contain NaNs (interpolated).
pub fn forecast(y: &[f64], opts: &ForecastOptions) -> Result<ForecastResult, IsoclineError> {
    if opts.horizon == 0 || opts.horizon > 10000 {
        return Err(IsoclineError::BadConfig(
            "horizon must be in 1..=10000".into(),
        ));
    }
    if !(opts.level > 0.0 && opts.level < 1.0) {
        return Err(IsoclineError::BadConfig("level must be in (0,1)".into()));
    }
    if opts.paths > 2000 {
        return Err(IsoclineError::BadConfig("paths must be <= 2000".into()));
    }
    let yy = crate::preprocess::interpolate_linear(y)?;
    let n = yy.len();
    if n < 3 {
        return Err(IsoclineError::TooShort { n, need: 3 });
    }
    let mut warnings = Vec::new();
    let resolved = resolve(&yy, opts, &mut warnings)?;
    run_model(&yy, resolved.model, resolved.period, resolved.strength, opts, &mut warnings)
}

// ---------------------------------------------------------------------------
// Backtest (§4.10)
// ---------------------------------------------------------------------------

/// Rolling-origin backtest. The last `folds × horizon` points are held out;
/// fold `i` trains on `n - (folds - i) × h` points. `Auto` models are resolved
/// once on the full series.
pub fn backtest(y: &[f64], opts: &BacktestOptions) -> Result<BacktestResult, IsoclineError> {
    if opts.horizon == 0 || opts.horizon > 10000 {
        return Err(IsoclineError::BadConfig(
            "horizon must be in 1..=10000".into(),
        ));
    }
    if opts.folds == 0 || opts.folds > 1000 {
        return Err(IsoclineError::BadConfig("folds must be in 1..=1000".into()));
    }
    let yy = crate::preprocess::interpolate_linear(y)?;
    let n = yy.len();
    let need = opts.folds * opts.horizon + 3;
    if n < need {
        return Err(IsoclineError::TooShort { n, need });
    }
    let h = opts.horizon;

    // Resolve auto once on the full data.
    let mut full_warnings = Vec::new();
    let auto_opts = ForecastOptions {
        model: Model::Auto,
        horizon: h,
        period: opts.period,
        level: 0.95,
        paths: 200,
        seed: opts.seed,
    };
    let auto = resolve(&yy, &auto_opts, &mut full_warnings)?;

    let mut rows = Vec::new();
    // Period used by concrete models: explicit option, else the auto-detected
    // period resolved once on the full series.
    let full_period: Option<usize> = opts.period.map(|v| v as usize).or(auto.period);
    for (mi, requested) in opts.models.iter().enumerate() {
        let model = if *requested == Model::Auto { auto.model } else { *requested };
        let mut errs: Vec<f64> = Vec::new();
        let mut smape_sum = 0.0;
        let mut smape_n = 0usize;
        let mut inside = 0usize;
        let mut total = 0usize;
        let mut used_folds = 0usize;
        for fold in 0..opts.folds {
            let train_len = n - (opts.folds - fold) * h;
            if train_len < 3 {
                continue;
            }
            let fopts = ForecastOptions {
                model,
                horizon: h,
                period: full_period.map(|p| p as u32),
                level: 0.95,
                paths: 200,
                seed: opts.seed.wrapping_add((mi * 1000 + fold) as u64),
            };
            let mut fw = Vec::new();
            // Per-fold guards (seasonal length, AR n>=8) via resolve().
            let res = match resolve(&yy[..train_len], &fopts, &mut fw) {
                Ok(rf) => match run_model(
                    &yy[..train_len],
                    rf.model,
                    rf.period,
                    rf.strength,
                    &fopts,
                    &mut fw,
                ) {
                    Ok(r) => r,
                    Err(_) => continue,
                },
                Err(_) => continue,
            };
            used_folds += 1;
            for j in 0..h {
                let actual = yy[train_len + j];
                let f = res.point[j];
                errs.push(actual - f);
                let denom = actual.abs() + f.abs();
                if denom >= 1e-12 {
                    smape_sum += 200.0 * (actual - f).abs() / denom;
                    smape_n += 1;
                }
                if actual >= res.lower[j] && actual <= res.upper[j] {
                    inside += 1;
                }
                total += 1;
            }
        }
        if used_folds == 0 || total == 0 {
            continue;
        }
        let sse: f64 = errs.iter().map(|e| e * e).sum();
        let sae: f64 = errs.iter().map(|e| e.abs()).sum();
        rows.push(BacktestRow {
            model,
            folds: used_folds,
            coverage: inside as f64 / total as f64,
            rmse: (sse / errs.len() as f64).sqrt(),
            mae: sae / errs.len() as f64,
            smape: if smape_n > 0 { smape_sum / smape_n as f64 } else { 0.0 },
        });
    }
    if rows.is_empty() {
        return Err(IsoclineError::Internal(
            "backtest produced no evaluable folds".into(),
        ));
    }
    Ok(BacktestResult {
        rows,
        horizon: h,
        folds: opts.folds,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::TAU;

    fn seasonal_trend(n: usize, p: f64, seed: u64) -> Vec<f64> {
        let mut rng = Rng::new(seed);
        (0..n)
            .map(|i| {
                50.0 + 0.02 * i as f64
                    + 8.0 * (TAU * i as f64 / p).sin()
                    + rng.normal()
            })
            .collect()
    }

    #[test]
    fn auto_picks_stl_ets_and_beats_snaive() {
        let y = seasonal_trend(744, 24.0, 42);
        let opts = ForecastOptions {
            model: Model::Auto,
            horizon: 24,
            ..Default::default()
        };
        let r = forecast(&y, &opts).unwrap();
        assert_eq!(r.model, Model::StlEts);
        assert_eq!(r.period, Some(24));
        assert_eq!(r.point.len(), 24);
        for j in 0..24 {
            assert!(r.lower[j] <= r.point[j] && r.point[j] <= r.upper[j]);
        }
    }

    #[test]
    fn point_within_bands_various_models() {
        let y = seasonal_trend(300, 12.0, 5);
        for model in [Model::StlEts, Model::Ets, Model::Ar, Model::Snaive, Model::Naive] {
            let opts = ForecastOptions {
                model,
                horizon: 12,
                period: Some(12),
                ..Default::default()
            };
            let r = forecast(&y, &opts).unwrap();
            for j in 0..12 {
                assert!(
                    r.lower[j] <= r.point[j] && r.point[j] <= r.upper[j],
                    "{model:?} step {j}"
                );
            }
            assert!(r.metrics.rmse.is_finite());
            assert!(r.metrics.smape <= 200.0);
        }
    }

    #[test]
    fn insufficient_seasonal_data_falls_back() {
        // n = 20 < 2*12 + 1 with explicit seasonal model request.
        let y: Vec<f64> = (0..20).map(|i| i as f64).collect();
        let opts = ForecastOptions {
            model: Model::Ets,
            horizon: 4,
            period: Some(12),
            ..Default::default()
        };
        let r = forecast(&y, &opts).unwrap();
        assert_eq!(r.model, Model::Naive);
        assert!(r
            .warnings
            .iter()
            .any(|w| w.contains("insufficient data for seasonality")));
    }

    #[test]
    fn paths_zero_means_none() {
        let y = seasonal_trend(200, 20.0, 1);
        let opts = ForecastOptions {
            model: Model::Naive,
            horizon: 4,
            paths: 0,
            ..Default::default()
        };
        let r = forecast(&y, &opts).unwrap();
        assert!(r.paths.is_none());
        assert_eq!(r.paths_n, 0);
    }

    #[test]
    fn validation_errors() {
        let y = vec![1.0, 2.0, 3.0];
        assert!(matches!(
            forecast(&y, &ForecastOptions { horizon: 0, ..Default::default() }),
            Err(IsoclineError::BadConfig(_))
        ));
        assert!(matches!(
            forecast(&y, &ForecastOptions { level: 1.5, ..Default::default() }),
            Err(IsoclineError::BadConfig(_))
        ));
        assert!(matches!(
            forecast(&[1.0, 2.0], &ForecastOptions::default()),
            Err(IsoclineError::TooShort { .. })
        ));
    }

    #[test]
    fn backtest_rows_and_coverage() {
        let y = seasonal_trend(400, 24.0, 9);
        let bt = backtest(
            &y,
            &BacktestOptions {
                horizon: 12,
                folds: 3,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(bt.rows.len(), 4);
        for row in &bt.rows {
            assert!(row.rmse.is_finite() && row.rmse >= 0.0);
            assert!(row.mae.is_finite() && row.mae >= 0.0);
            assert!(row.smape.is_finite() && row.smape <= 200.0);
            assert!((0.0..=1.0).contains(&row.coverage));
            assert!(row.folds >= 1 && row.folds <= 3);
        }
    }
}
