//! # isocline-core
//!
//! Fast, dependency-free time-series forecasting and anomaly detection.
//! Pure `std` Rust; `rayon` is available only behind the optional `parallel`
//! feature (see the `batch` module).
//!
//! The crate exposes six operations over a univariate `&[f64]` series:
//! forecasting with bootstrap prediction intervals, anomaly detection,
//! seasonal decomposition, seasonality detection, changepoint detection,
//! rolling-origin backtesting, plus NaN interpolation. All operations are
//! deterministic given the same seed and never panic on any input.
//!
//! Inputs may contain `NaN` (missing values); every operation except
//! [`interpolate`] fills them by linear interpolation first.
//!
//! # Examples
//!
//! Build a synthetic seasonal series and forecast it:
//!
//! ```
//! use isocline_core::*;
//!
//! let mut y = Vec::with_capacity(120);
//! for i in 0..120 {
//!     y.push(10.0 + 0.05 * i as f64
//!         + 4.0 * (std::f64::consts::TAU * i as f64 / 24.0).sin());
//! }
//! let opts = ForecastOptions { horizon: 12, ..Default::default() };
//! let r = forecast(&y, &opts).unwrap();
//!
//! assert_eq!(r.point.len(), 12);
//! assert_eq!(r.lower.len(), 12);
//! assert_eq!(r.upper.len(), 12);
//! for j in 0..12 {
//!     assert!(r.lower[j] <= r.point[j] && r.point[j] <= r.upper[j]);
//! }
//! assert!(r.metrics.rmse.is_finite() && r.metrics.rmse >= 0.0);
//! assert!(r.metrics.smape <= 200.0);
//!
//! // Determinism: same seed, same bytes.
//! let r2 = forecast(&y, &opts).unwrap();
//! assert_eq!(r.point, r2.point);
//! ```
//!
//! Detect anomalies and changepoints:
//!
//! ```
//! use isocline_core::*;
//!
//! let mut y: Vec<f64> = (0..240).map(|i| 50.0 + (i % 24) as f64).collect();
//! y[120] += 40.0;
//! let a = detect_anomalies(&y, &AnomalyOptions::default()).unwrap();
//! assert!(a.anomalies.iter().any(|an| an.index == 120));
//!
//! let c = changepoints(&y, &ChangepointOptions::default()).unwrap();
//! assert_eq!(c.means.len(), 240);
//! ```

pub mod anomaly;
pub mod ar;
#[cfg(feature = "parallel")]
pub mod batch;
pub mod changepoint;
pub mod error;
pub mod ets;
pub mod forecast;
pub mod math;
pub mod naive;
pub mod preprocess;
pub mod seasonality;
pub mod stl;

pub use anomaly::{
    detect_anomalies, Anomaly, AnomalyDirection, AnomalyMethod, AnomalyOptions, AnomalyResult,
    Direction,
};
pub use changepoint::{detect_changepoints, Changepoint, ChangepointOptions, ChangepointResult};
pub use error::IsoclineError;
pub use forecast::{
    backtest, forecast, BacktestOptions, BacktestResult, BacktestRow, ForecastOptions,
    ForecastResult, Metrics, Model,
};
pub use math::{nelder_mead, Rng};
pub use preprocess::interpolate_linear;
pub use seasonality::{
    detect as detect_seasonality, SeasonalityCandidate, SeasonalityOptions, SeasonalityResult,
    SeasonSource,
};
pub use stl::{stl_fit, StlFit};
use std::collections::BTreeMap;

/// Crate version.
pub const VERSION: &str = "0.1.0";

/// Decompose a series into trend / seasonal / residual (mirrors TS
/// `decompose`). Input may contain NaNs (interpolated first).
///
/// When `period` is auto and no seasonality is detected, a fallback period of
/// `max(2, min(n/3, 8640))` is used so a decomposition is always returned.
pub fn decompose(
    y: &[f64],
    opts: &DecomposeOptions,
) -> Result<DecomposeResult, IsoclineError> {
    if opts.seasons == 0 || opts.seasons > 100 {
        return Err(IsoclineError::BadConfig(
            "seasons must be in 1..=100".into(),
        ));
    }
    let yy = preprocess::interpolate_linear(y)?;
    let n = yy.len();
    if n < 3 {
        return Err(IsoclineError::TooShort { n, need: 3 });
    }
    let period: usize = match opts.period {
        Some(pv) => {
            if pv < 2 {
                return Err(IsoclineError::BadConfig("period must be >= 2".into()));
            }
            (pv as usize).min(n)
        }
        None => {
            let det = seasonality::detect(&yy, &SeasonalityOptions::default())?;
            det.best_period
                .map(|v| v as usize)
                .unwrap_or_else(|| (n / 3).clamp(2, 8640).min(n.max(2)))
        }
    };
    let fit = stl::stl_fit(&yy, period, opts.seasons, opts.robust);
    Ok(DecomposeResult {
        period: fit.period as u32,
        trend: fit.trend,
        seasonal: fit.seasonal,
        resid: fit.resid,
        seasonal_strength: fit.seasonal_strength,
        robust_weights: fit.robust_weights,
    })
}

/// Options for [`decompose`] (mirrors TS `DecomposeOptions`).
#[derive(Debug, Clone)]
pub struct DecomposeOptions {
    /// Period; `None` = auto-detect (with a fallback period when nothing is
    /// detected).
    pub period: Option<u32>,
    /// Run the bisquare robust outer loop (default true).
    pub robust: bool,
    /// Inner iterations (default 3).
    pub seasons: usize,
}

impl Default for DecomposeOptions {
    fn default() -> Self {
        DecomposeOptions {
            period: None,
            robust: true,
            seasons: 3,
        }
    }
}

/// Result of [`decompose`] (mirrors TS `DecomposeResult`).
#[derive(Debug, Clone)]
pub struct DecomposeResult {
    /// Period used.
    pub period: u32,
    /// Trend component, length n.
    pub trend: Vec<f64>,
    /// Seasonal component, length n.
    pub seasonal: Vec<f64>,
    /// Remainder, length n.
    pub resid: Vec<f64>,
    /// `1 - var(resid)/var(seasonal+resid)` clamped to [0, 1].
    pub seasonal_strength: f64,
    /// Bisquare robust weights when `robust` was requested.
    pub robust_weights: Option<Vec<f64>>,
}

/// Detect seasonality (mirrors TS `seasonality`). Input may contain NaNs.
pub fn seasonality(
    y: &[f64],
    opts: &SeasonalityOptions,
) -> Result<SeasonalityResult, IsoclineError> {
    let yy = preprocess::interpolate_linear(y)?;
    seasonality::detect(&yy, opts)
}

/// Convenience alias matching the TS engine naming.
pub fn changepoints(
    y: &[f64],
    opts: &ChangepointOptions,
) -> Result<ChangepointResult, IsoclineError> {
    changepoint::detect_changepoints(y, opts)
}

/// Fill NaN holes by linear interpolation; returns a filled copy of `y`.
pub fn interpolate(y: &[f64]) -> Vec<f64> {
    preprocess::interpolate_linear(y).unwrap_or_else(|_| y.to_vec())
}

/// Parameters of a forecast result as a plain map (helper for bindings).
pub fn params_map(r: &ForecastResult) -> BTreeMap<String, f64> {
    r.params.clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_constant() {
        assert_eq!(VERSION, "0.1.0");
    }

    #[test]
    fn interpolate_passthrough_and_all_nan() {
        assert_eq!(interpolate(&[1.0, f64::NAN, 3.0]), vec![1.0, 2.0, 3.0]);
        // All-NaN input is passed through unchanged by `interpolate` itself.
        let out = interpolate(&[f64::NAN; 2]);
        assert!(out.iter().all(|v| v.is_nan()));
    }

    #[test]
    fn decompose_end_to_end() {
        use std::f64::consts::TAU;
        let y: Vec<f64> = (0..240)
            .map(|i| 3.0 * (TAU * i as f64 / 24.0).sin())
            .collect();
        let d = decompose(&y, &DecomposeOptions::default()).unwrap();
        assert_eq!(d.period, 24);
        assert!(d.seasonal_strength > 0.9);
        assert!(d.robust_weights.is_some());
    }

    #[test]
    fn ops_handle_nan_input() {
        use std::f64::consts::TAU;
        let mut y: Vec<f64> = (0..200)
            .map(|i| 3.0 * (TAU * i as f64 / 20.0).sin())
            .collect();
        y[10] = f64::NAN;
        y[11] = f64::NAN;
        let r = forecast(&y, &ForecastOptions::default()).unwrap();
        assert_eq!(r.point.len(), 24);
        let d = decompose(&y, &DecomposeOptions::default()).unwrap();
        assert!(d.resid.iter().all(|v| v.is_finite()));
        let c = changepoints(&y, &ChangepointOptions::default()).unwrap();
        assert!(c.means.iter().all(|v| v.is_finite()));
        let s = seasonality(&y, &SeasonalityOptions::default()).unwrap();
        assert!(s.strength.is_finite());
    }

    #[test]
    fn all_nan_forecast_is_bad_params() {
        let y = [f64::NAN; 10];
        assert!(matches!(
            forecast(&y, &ForecastOptions::default()),
            Err(IsoclineError::BadParams(_))
        ));
    }
}
