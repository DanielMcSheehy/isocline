//! Seasonality detection per CONTRACT §4.2: ACF + periodogram candidates,
//! 5% matching, quick-STL strength check.

use crate::error::IsoclineError;
use crate::math;
use crate::stl;

/// Options for seasonality detection (mirrors TS `SeasonalityOptions`).
#[derive(Debug, Clone, Default)]
pub struct SeasonalityOptions {
    /// Maximum period to consider; `None` = auto (`min(n/3, 8640)`, >= 2).
    pub max_period: Option<u32>,
}

/// Source of a seasonality candidate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeasonSource {
    /// Candidate found by an ACF local maximum.
    Acf,
    /// Candidate found by a periodogram local peak.
    Spectral,
}

/// A ranked seasonality candidate (mirrors TS `SeasonalityCandidate`).
#[derive(Debug, Clone, PartialEq)]
pub struct SeasonalityCandidate {
    /// Candidate period (cycles).
    pub period: f64,
    /// Combined strength in [0, 1] (matched ACF peak value).
    pub strength: f64,
    /// Where the candidate came from.
    pub source: SeasonSource,
}

/// Result of seasonality detection (mirrors TS `SeasonalityResult`).
#[derive(Debug, Clone)]
pub struct SeasonalityResult {
    /// Best period, `None` when strength < 0.2 (TS `null`).
    pub best_period: Option<u32>,
    /// Seasonal strength in [0, 1].
    pub strength: f64,
    /// Autocorrelation, lags 0..=max_lag.
    pub acf: Vec<f64>,
    /// Lag indices 0..=max_lag as f64.
    pub lags: Vec<f64>,
    /// Periodogram power, length max_lag + 1.
    pub periodogram: Vec<f64>,
    /// Frequencies (cycles/sample), length max_lag + 1.
    pub frequencies: Vec<f64>,
    /// Ranked candidates (at most 5).
    pub candidates: Vec<SeasonalityCandidate>,
}

/// Strength of a candidate period via one quick non-robust STL pass
/// (2 seasons, 2 inner iterations). Used both by detection and by the
/// forecast dispatcher for explicit periods.
pub fn quick_strength(y: &[f64], period: usize) -> f64 {
    let n = y.len();
    if n < 3 || period < 2 || period >= n {
        return 0.0;
    }
    let fit = stl::stl_fit(y, period, 2, false);
    stl::strength_from_parts(y, &fit.seasonal, &fit.resid)
}

/// Full detection pipeline. Input must be NaN-free (callers interpolate).
pub fn detect(y: &[f64], opts: &SeasonalityOptions) -> Result<SeasonalityResult, IsoclineError> {
    let n = y.len();
    if n < 3 {
        return Err(IsoclineError::TooShort { n, need: 3 });
    }
    let max_period_auto = (n / 3).clamp(2, 8640);
    let max_period = match opts.max_period {
        Some(mp) => (mp as usize).max(2).min(n.saturating_sub(2)).max(2),
        None => max_period_auto,
    };
    let max_lag = (n / 2).min(max_period).clamp(1, 1024);

    let acf_vals = math::acf(y, max_lag);
    let lags: Vec<f64> = (0..acf_vals.len()).map(|k| k as f64).collect();

    let (power_full, freqs_full) = math::periodogram(y);
    let nfft = math::next_pow2(n.max(2));

    // --- Spectral candidates: local peaks of the periodogram, top 3.
    let mut spectral: Vec<(usize, f64)> = Vec::new(); // (k, power)
    for k in 2..power_full.len().saturating_sub(1) {
        if power_full[k] > power_full[k - 1] && power_full[k] >= power_full[k + 1] {
            spectral.push((k, power_full[k]));
        }
    }
    spectral.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let mut spectral_periods: Vec<f64> = Vec::new();
    for &(k, _) in &spectral {
        let period = nfft as f64 / k as f64;
        if period >= 2.0 && period <= max_period as f64 {
            spectral_periods.push(period);
            if spectral_periods.len() == 3 {
                break;
            }
        }
    }

    // --- ACF candidates: positive local maxima at lags >= 2.
    let lag_top = acf_vals.len().saturating_sub(1); // effective max lag
    let mut acf_peaks: Vec<usize> = Vec::new();
    for lag in 2..lag_top {
        if acf_vals[lag] > acf_vals[lag - 1] && acf_vals[lag] >= acf_vals[lag + 1] && acf_vals[lag] > 0.0
        {
            acf_peaks.push(lag);
        }
    }

    // --- Match: spectral period -> nearest ACF peak within 5%. The combined
    // candidate uses the ACF peak lag (integer precision, far better than the
    // spectral bin resolution nfft/k) with strength = ACF peak value.
    let mut candidates: Vec<SeasonalityCandidate> = Vec::new();
    for period in &spectral_periods {
        let mut best: Option<(usize, f64)> = None;
        for &lag in &acf_peaks {
            let rel = (lag as f64 - period).abs() / period;
            if rel <= 0.05 {
                let v = acf_vals[lag].clamp(0.0, 1.0);
                if best.is_none() || v > best.unwrap().1 {
                    best = Some((lag, v));
                }
            }
        }
        if let Some((lag, strength)) = best {
            let cand = SeasonalityCandidate {
                period: lag as f64,
                strength,
                source: SeasonSource::Spectral,
            };
            if !candidates
                .iter()
                .any(|c: &SeasonalityCandidate| (c.period - cand.period).abs() < 1e-9)
            {
                candidates.push(cand);
            }
        }
    }
    // If spectral matching found nothing, fall back to ACF candidates directly
    // so strongly autocorrelated (non-sinusoidal) series are still detected.
    if candidates.is_empty() {
        for &lag in acf_peaks.iter().take(3) {
            candidates.push(SeasonalityCandidate {
                period: lag as f64,
                strength: acf_vals[lag].clamp(0.0, 1.0),
                source: SeasonSource::Acf,
            });
        }
    }
    candidates.sort_by(|a, b| b.strength.partial_cmp(&a.strength).unwrap_or(std::cmp::Ordering::Equal));
    candidates.truncate(5);

    // --- Best period + quick STL strength.
    let (best_period, strength) = match candidates.first() {
        None => (None, 0.0),
        Some(best) => {
            let p = (best.period.round() as usize).clamp(2, max_period);
            let s = quick_strength(y, p);
            if s >= 0.2 {
                (Some(p as u32), s)
            } else {
                (None, s)
            }
        }
    };

    // Trim periodogram/frequencies to max_lag + 1 entries (TS contract shape).
    let plen = (max_lag + 1).min(power_full.len());
    let mut periodogram = power_full[..plen].to_vec();
    periodogram[0] = 0.0; // DC term is not informative
    let frequencies = freqs_full[..plen].to_vec();

    Ok(SeasonalityResult {
        best_period,
        strength,
        acf: acf_vals,
        lags,
        periodogram,
        frequencies,
        candidates,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::TAU;

    fn seasonal(n: usize, p: f64, a: f64, sigma: f64, seed: u64) -> Vec<f64> {
        let mut rng = math::Rng::new(seed);
        (0..n)
            .map(|i| {
                let v = a * (TAU * i as f64 / p).sin();
                v + sigma * rng.normal()
            })
            .collect()
    }

    #[test]
    fn detects_period_24() {
        let y = seasonal(720, 24.0, 8.0, 1.0, 42);
        let r = detect(&y, &SeasonalityOptions::default()).unwrap();
        assert_eq!(r.best_period, Some(24));
        assert!(r.strength > 0.7, "strength was {}", r.strength);
        assert!(!r.candidates.is_empty());
        assert_eq!(r.acf.len(), r.lags.len());
        assert_eq!(r.periodogram.len(), r.frequencies.len());
    }

    #[test]
    fn noise_has_no_seasonality() {
        let mut rng = math::Rng::new(3);
        let y: Vec<f64> = (0..400).map(|_| rng.normal()).collect();
        let r = detect(&y, &SeasonalityOptions::default()).unwrap();
        assert_eq!(r.best_period, None);
        assert!(r.strength < 0.2);
    }

    #[test]
    fn constant_series_strength_zero() {
        let y = vec![5.0; 100];
        let r = detect(&y, &SeasonalityOptions::default()).unwrap();
        assert_eq!(r.best_period, None);
        assert_eq!(r.strength, 0.0);
    }

    #[test]
    fn too_short_errors() {
        assert!(matches!(
            detect(&[1.0, 2.0], &SeasonalityOptions::default()),
            Err(IsoclineError::TooShort { .. })
        ));
    }
}
