//! Batch operations behind the optional `parallel` feature (rayon).
//! Each series is processed independently with the same deterministic
//! single-threaded algorithms, so results are identical to sequential runs.

use crate::anomaly::{AnomalyOptions, AnomalyResult};
use crate::error::IsoclineError;
use crate::forecast::{ForecastOptions, ForecastResult};

use rayon::prelude::*;

/// Forecast many series in parallel.
pub fn batch_forecast(
    series: &[Vec<f64>],
    opts: &ForecastOptions,
) -> Vec<Result<ForecastResult, IsoclineError>> {
    series
        .par_iter()
        .map(|y| crate::forecast(y, opts))
        .collect()
}

/// Detect anomalies in many series in parallel.
pub fn batch_detect_anomalies(
    series: &[Vec<f64>],
    opts: &AnomalyOptions,
) -> Vec<Result<AnomalyResult, IsoclineError>> {
    series
        .par_iter()
        .map(|y| crate::detect_anomalies(y, opts))
        .collect()
}
