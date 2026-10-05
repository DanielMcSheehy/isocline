//! Anomaly detection per CONTRACT §4.8: four methods (`stl`, `madz`, `iqr`,
//! `ewma`), direction filtering, signed scores, expected values.

use crate::error::IsoclineError;
use crate::math;
use crate::seasonality::{self, SeasonalityOptions};
use crate::stl;

/// Anomaly method (mirrors TS `AnomalyMethod`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum AnomalyMethod {
    /// Robust STL residual modified z-score (default).
    #[default]
    Stl,
    /// Rolling-median detrend + modified z-score.
    MadZ,
    /// Interquartile-range fences.
    Iqr,
    /// EWMA control chart.
    Ewma,
}

impl AnomalyMethod {
    /// TS-compatible identifier.
    pub fn as_str(self) -> &'static str {
        match self {
            AnomalyMethod::Stl => "stl",
            AnomalyMethod::MadZ => "madz",
            AnomalyMethod::Iqr => "iqr",
            AnomalyMethod::Ewma => "ewma",
        }
    }
    /// Default threshold per method: 3.5 / 3.5 / 1.5 / 3.0.
    pub fn default_threshold(self) -> f64 {
        match self {
            AnomalyMethod::Stl | AnomalyMethod::MadZ => 3.5,
            AnomalyMethod::Iqr => 1.5,
            AnomalyMethod::Ewma => 3.0,
        }
    }
}

/// Direction filter (mirrors TS `direction` option).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Direction {
    /// Keep both spikes and dips (default).
    #[default]
    Both,
    /// Keep spikes only.
    High,
    /// Keep dips only.
    Low,
}

/// Direction of a single anomaly (mirrors TS `Anomaly.direction`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnomalyDirection {
    /// Above expectation.
    Spike,
    /// Below expectation.
    Dip,
}

/// Anomaly options (mirrors TS `AnomalyOptions`).
#[derive(Debug, Clone)]
pub struct AnomalyOptions {
    /// Method; default `Stl`.
    pub method: AnomalyMethod,
    /// Period; `None` = auto.
    pub period: Option<u32>,
    /// Threshold; `None` = method default.
    pub threshold: Option<f64>,
    /// EWMA lambda in (0, 1]; default 0.3.
    pub lambda: Option<f64>,
    /// Direction filter; default both.
    pub direction: Direction,
}

impl Default for AnomalyOptions {
    fn default() -> Self {
        AnomalyOptions {
            method: AnomalyMethod::Stl,
            period: None,
            threshold: None,
            lambda: None,
            direction: Direction::Both,
        }
    }
}

/// A single detected anomaly (mirrors TS `Anomaly`).
#[derive(Debug, Clone, PartialEq)]
pub struct Anomaly {
    /// Index into the input series.
    pub index: usize,
    /// Positive score (>= threshold).
    pub score: f64,
    /// Model expectation at that index.
    pub expected: f64,
    /// Observed value.
    pub observed: f64,
    /// Spike or dip.
    pub direction: AnomalyDirection,
}

/// Result (mirrors TS `AnomalyResult`).
#[derive(Debug, Clone)]
pub struct AnomalyResult {
    /// Method used.
    pub method: AnomalyMethod,
    /// Threshold used.
    pub threshold: f64,
    /// Detected anomalies, sorted by index.
    pub anomalies: Vec<Anomaly>,
    /// Signed score per point, length n (positive = above expected).
    pub scores: Vec<f64>,
    /// Model expectation per point, length n.
    pub expected: Vec<f64>,
}

/// Top-level anomaly detection. Input may contain NaNs (interpolated).
pub fn detect_anomalies(
    y: &[f64],
    opts: &AnomalyOptions,
) -> Result<AnomalyResult, IsoclineError> {
    let yy = crate::preprocess::interpolate_linear(y)?;
    let n = yy.len();
    if n < 3 {
        return Err(IsoclineError::TooShort { n, need: 3 });
    }
    let method = opts.method;
    let threshold = opts.threshold.unwrap_or_else(|| method.default_threshold());
    if !threshold.is_finite() || threshold <= 0.0 {
        return Err(IsoclineError::BadConfig("threshold must be > 0".into()));
    }

    // Resolve the period once (auto-detection); None means "no seasonality".
    let period: Option<usize> = match opts.period {
        Some(pv) => {
            if pv < 2 {
                return Err(IsoclineError::BadConfig("period must be >= 2".into()));
            }
            if (pv as usize) < n {
                Some(pv as usize)
            } else {
                None
            }
        }
        None => seasonality::detect(&yy, &SeasonalityOptions::default())
            .ok()
            .and_then(|r| r.best_period)
            .map(|v| v as usize),
    };

    let (expected, scores): (Vec<f64>, Vec<f64>) = match method {
        AnomalyMethod::Stl => {
            // STL when enough data for the detected period; otherwise fall
            // back to rolling-median detrending (same scorer as madz).
            if let Some(p) = period.filter(|&p| n > 2 * p) {
                let dec = stl::stl_fit(&yy, p, 3, true);
                let expected: Vec<f64> = (0..n)
                    .map(|i| dec.trend[i] + dec.seasonal[i])
                    .collect();
                let resid: Vec<f64> = (0..n).map(|i| yy[i] - expected[i]).collect();
                let scores = modified_z(&resid);
                (expected, scores)
            } else {
                let w = detrend_window(period);
                let expected = math::rolling_median(&yy, w);
                let resid: Vec<f64> = (0..n).map(|i| yy[i] - expected[i]).collect();
                let scores = modified_z(&resid);
                (expected, scores)
            }
        }
        AnomalyMethod::MadZ => {
            let w = detrend_window(period);
            let expected = math::rolling_median(&yy, w);
            let resid: Vec<f64> = (0..n).map(|i| yy[i] - expected[i]).collect();
            let scores = modified_z(&resid);
            (expected, scores)
        }
        AnomalyMethod::Iqr => {
            let w = detrend_window(period);
            let expected = math::rolling_median(&yy, w);
            let detrended: Vec<f64> = (0..n).map(|i| yy[i] - expected[i]).collect();
            let mut sorted = detrended.clone();
            sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let med = math::median_sorted(&sorted);
            let q1 = math::quantile_sorted(&sorted, 0.25);
            let q3 = math::quantile_sorted(&sorted, 0.75);
            let iqr = q3 - q1;
            let scores = if iqr <= 1e-12 {
                vec![0.0; n]
            } else {
                detrended
                    .iter()
                    .map(|&d| (d - med) / iqr)
                    .collect()
            };
            (expected, scores)
        }
        AnomalyMethod::Ewma => {
            let lambda = opts.lambda.unwrap_or(0.3);
            if !(lambda > 0.0 && lambda <= 1.0) {
                return Err(IsoclineError::BadConfig("lambda must be in (0,1]".into()));
            }
            // sigma_y = 1.4826 * MAD(diff(y)) / sqrt(2)
            let mut diffs = vec![0.0; n.saturating_sub(1)];
            for i in 1..n {
                diffs[i - 1] = yy[i] - yy[i - 1];
            }
            let sigma_y = (1.4826 * math::mad_or_fallback(&diffs) / 2.0f64.sqrt()).max(1e-9);
            let sigma_z = sigma_y * (lambda / (2.0 - lambda)).sqrt();
            let mut z = vec![0.0; n];
            z[0] = yy[0];
            for i in 1..n {
                z[i] = lambda * yy[i] + (1.0 - lambda) * z[i - 1];
            }
            let center = math::median(&z);
            let scores: Vec<f64> = z.iter().map(|&v| (v - center) / sigma_z).collect();
            (z, scores)
        }
    };

    // Warmup window for ewma: first max(period, 11) points never flagged.
    let warmup = if method == AnomalyMethod::Ewma {
        period.unwrap_or(11).max(11)
    } else {
        0
    };

    let mut anomalies = Vec::new();
    for i in warmup..n {
        let s = scores[i];
        if !s.is_finite() {
            continue;
        }
        // Flag rule: |normalized signed score| > threshold. For `iqr` the
        // score is (d - median)/IQR in k units; because median <= q3 and
        // q1 <= median, |score| > k implies the point is beyond the
        // corresponding fence (and vice versa up to the median/quartile gap),
        // so a single threshold test covers the fence semantics.
        if s.abs() > threshold {
            anomalies.push(Anomaly {
                index: i,
                score: s.abs(),
                expected: expected[i],
                observed: yy[i],
                direction: if s >= 0.0 {
                    AnomalyDirection::Spike
                } else {
                    AnomalyDirection::Dip
                },
            });
        }
    }

    // Direction filter.
    anomalies.retain(|a| match opts.direction {
        Direction::Both => true,
        Direction::High => a.direction == AnomalyDirection::Spike,
        Direction::Low => a.direction == AnomalyDirection::Dip,
    });

    Ok(AnomalyResult {
        method,
        threshold,
        anomalies,
        scores,
        expected,
    })
}

/// Rolling-median detrend window: the period (made odd) or 11.
fn detrend_window(period: Option<usize>) -> usize {
    let w = period.unwrap_or(11);
    if w.is_multiple_of(2) {
        w + 1
    } else {
        w.max(3)
    }
}

/// Modified z-score: `0.6745 * (x - median(x)) / MAD(x)` with the documented
/// MAD fallback chain.
fn modified_z(x: &[f64]) -> Vec<f64> {
    let med = math::median(x);
    let scale = math::mad_or_fallback(x);
    x.iter().map(|&v| 0.6745 * (v - med) / scale).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::TAU;

    fn seasonal(n: usize, p: f64, seed: u64) -> Vec<f64> {
        let mut rng = math::Rng::new(seed);
        (0..n)
            .map(|i| 50.0 + 8.0 * (TAU * i as f64 / p).sin() + rng.normal())
            .collect()
    }

    #[test]
    fn stl_finds_injected_spikes_and_dips() {
        let mut y = seasonal(720, 24.0, 42);
        let truth = [100usize, 101, 300, 301, 500];
        y[100] += 6.0;
        y[101] += 6.0;
        y[300] -= 6.0;
        y[301] -= 6.0;
        y[500] += 6.0;
        let r = detect_anomalies(&y, &AnomalyOptions::default()).unwrap();
        assert_eq!(r.method, AnomalyMethod::Stl);
        assert!((r.threshold - 3.5).abs() < 1e-12);
        let flagged: Vec<usize> = r.anomalies.iter().map(|a| a.index).collect();
        let hits = truth.iter().filter(|t| flagged.contains(t)).count();
        assert!(hits as f64 / truth.len() as f64 >= 0.8, "recall {hits}/5");
        let fp = flagged.iter().filter(|f| !truth.contains(f)).count();
        assert!(
            fp as f64 / flagged.len().max(1) as f64 <= 0.2,
            "precision violated: {fp} false positives of {}",
            flagged.len()
        );
        // Signed scores positive above expected.
        for a in &r.anomalies {
            assert_eq!(a.score, r.scores[a.index].abs());
            assert_eq!(a.observed, y[a.index]);
        }
    }

    #[test]
    fn direction_filter() {
        let mut y = seasonal(360, 24.0, 7);
        y[50] += 10.0;
        y[100] -= 10.0;
        let hi = detect_anomalies(
            &y,
            &AnomalyOptions {
                direction: Direction::High,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(hi.anomalies.iter().all(|a| a.direction == AnomalyDirection::Spike));
        let lo = detect_anomalies(
            &y,
            &AnomalyOptions {
                direction: Direction::Low,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(lo.anomalies.iter().all(|a| a.direction == AnomalyDirection::Dip));
    }

    #[test]
    fn constant_series_no_anomalies() {
        let r = detect_anomalies(&[5.0; 100], &AnomalyOptions::default()).unwrap();
        assert!(r.anomalies.is_empty());
        assert!(r.scores.iter().all(|&s| s == 0.0));
    }

    #[test]
    fn all_methods_run_and_produce_shapes() {
        let y = seasonal(300, 12.0, 3);
        for method in [
            AnomalyMethod::Stl,
            AnomalyMethod::MadZ,
            AnomalyMethod::Iqr,
            AnomalyMethod::Ewma,
        ] {
            let r = detect_anomalies(
                &y,
                &AnomalyOptions {
                    method,
                    ..Default::default()
                },
            )
            .unwrap();
            assert_eq!(r.scores.len(), 300);
            assert_eq!(r.expected.len(), 300);
            assert!(r.anomalies.windows(2).all(|w| w[0].index < w[1].index));
        }
    }

    #[test]
    fn ewma_warmup_never_flagged() {
        let mut y = seasonal(200, 11.0, 11);
        y[5] += 20.0; // inside warmup
        let r = detect_anomalies(
            &y,
            &AnomalyOptions {
                method: AnomalyMethod::Ewma,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(r.anomalies.iter().all(|a| a.index >= 11));
    }

    #[test]
    fn bad_lambda_rejected() {
        let y = vec![1.0, 2.0, 3.0, 4.0];
        assert!(matches!(
            detect_anomalies(
                &y,
                &AnomalyOptions {
                    method: AnomalyMethod::Ewma,
                    lambda: Some(0.0),
                    ..Default::default()
                }
            ),
            Err(IsoclineError::BadConfig(_))
        ));
    }
}
