//! Naive and seasonal-naive models per CONTRACT §4.6, with residual-quantile
//! prediction intervals (per-phase for seasonal naive).

use crate::math::{quantile_sorted, Rng};

/// Fitted naive / seasonal-naive model (in-sample one-step fits + residuals).
#[derive(Debug, Clone)]
pub struct NaiveFit {
    /// In-sample fitted values, length n.
    pub fitted: Vec<f64>,
    /// In-sample residuals, length n (leading entries padded with 0).
    pub residuals: Vec<f64>,
    /// Period (0 for plain naive).
    pub period: usize,
}

/// Plain naive: `fitted[t] = y[t-1]`.
pub fn naive_fit(y: &[f64]) -> NaiveFit {
    let n = y.len();
    let mut fitted = vec![0.0; n];
    let mut residuals = vec![0.0; n];
    fitted[0] = y[0];
    for t in 1..n {
        fitted[t] = y[t - 1];
        residuals[t] = y[t] - fitted[t];
    }
    NaiveFit {
        fitted,
        residuals,
        period: 0,
    }
}

/// Seasonal naive: `fitted[t] = y[t - p]` for `t >= p`.
pub fn snaive_fit(y: &[f64], p: usize) -> NaiveFit {
    let n = y.len();
    let p = p.max(1).min(n.max(1));
    let mut fitted = vec![0.0; n];
    let mut residuals = vec![0.0; n];
    let p0 = p.min(n);
    fitted[..p0].copy_from_slice(&y[..p0]);
    for t in p..n {
        fitted[t] = y[t - p];
        residuals[t] = y[t] - fitted[t];
    }
    NaiveFit {
        fitted,
        residuals,
        period: p,
    }
}

impl NaiveFit {
    /// Point forecast for steps 1..=h. Seasonal naive repeats the final
    /// observed season: `point[j] = y[n - p + (j mod p)]`.
    pub fn forecast(&self, y: &[f64], h: usize) -> Vec<f64> {
        let n = y.len();
        let mut out = vec![0.0; h];
        if n == 0 {
            return out;
        }
        if self.period < 2 {
            for v in out.iter_mut() {
                *v = y[n - 1];
            }
        } else {
            let p = self.period.min(n);
            for (j, v) in out.iter_mut().enumerate() {
                *v = y[n - p + j % p];
            }
        }
        out
    }

    /// Prediction interval bands from residual quantiles. For seasonal naive
    /// the quantiles are computed per phase of the forecast timestamp.
    /// Returns `(lower_offsets, upper_offsets)` to be added to the point.
    pub fn bands(&self, h: usize, level: f64) -> (Vec<f64>, Vec<f64>) {
        let alpha = (1.0 - level).clamp(0.0, 1.0);
        let q_lo = alpha / 2.0;
        let q_hi = 1.0 - alpha / 2.0;
        let n = self.residuals.len();
        let p = self.period;
        let mut lower = vec![0.0; h];
        let mut upper = vec![0.0; h];
        if p < 2 {
            let mut sorted: Vec<f64> = self.residuals[1..].to_vec();
            if sorted.is_empty() {
                sorted.push(0.0);
            }
            sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let lo = quantile_sorted(&sorted, q_lo);
            let hi = quantile_sorted(&sorted, q_hi);
            for v in lower.iter_mut() {
                *v = lo;
            }
            for v in upper.iter_mut() {
                *v = hi;
            }
        } else {
            // Per-phase residual quantiles.
            let mut by_phase: Vec<Vec<f64>> = vec![Vec::new(); p];
            for t in p..n {
                by_phase[t % p].push(self.residuals[t]);
            }
            // Global fallback for phases without residuals.
            let mut all: Vec<f64> = self.residuals[p..].to_vec();
            if all.is_empty() {
                all.push(0.0);
            }
            all.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let n_future = self.fitted.len(); // series length
            for j in 0..h {
                let phase = (n_future + j) % p;
                let mut vals = by_phase[phase].clone();
                if vals.len() < 2 {
                    lower[j] = quantile_sorted(&all, q_lo);
                    upper[j] = quantile_sorted(&all, q_hi);
                } else {
                    vals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
                    lower[j] = quantile_sorted(&vals, q_lo);
                    upper[j] = quantile_sorted(&vals, q_hi);
                }
            }
        }
        (lower, upper)
    }

    /// Simple bootstrap paths for naive-type models: point + resampled
    /// residual per step. Flat `paths × h`.
    pub fn simulate(&self, point: &[f64], h: usize, rng: &mut Rng, paths: usize) -> Vec<f64> {
        let n = self.residuals.len();
        let p = self.period.max(1);
        let mut out = vec![0.0; paths * h];
        // Build per-phase residual pool (or global for naive).
        let pool: Vec<Vec<f64>> = if p < 2 {
            vec![self.residuals[1.min(n)..].to_vec()]
        } else {
            let mut v = vec![Vec::new(); p];
            for t in p..n {
                v[t % p].push(self.residuals[t]);
            }
            v
        };
        for path in 0..paths {
            for j in 0..h {
                let phase = if p < 2 { 0 } else { (n + j) % p };
                let source = if pool[phase].is_empty() {
                    &pool[0]
                } else {
                    &pool[phase]
                };
                let e = if source.is_empty() {
                    0.0
                } else {
                    source[rng.below(source.len())]
                };
                out[path * h + j] = point[j] + e;
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn naive_forecast_is_last_value() {
        let y = [1.0, 2.0, 3.0, 4.0, 5.0];
        let fit = naive_fit(&y);
        let f = fit.forecast(&y, 3);
        assert_eq!(f, vec![5.0, 5.0, 5.0]);
        assert_eq!(fit.fitted[4], 4.0);
        assert_eq!(fit.residuals[4], 1.0);
    }

    #[test]
    fn snaive_repeats_last_season() {
        let p = 4;
        let y: Vec<f64> = (0..16).map(|i| i as f64).collect();
        let fit = snaive_fit(&y, p);
        let f = fit.forecast(&y, 6);
        // Steps 1..4 repeat y[12..16]; step 5 wraps to y[12] again.
        assert_eq!(f[0], 12.0);
        assert_eq!(f[1], 13.0);
        assert_eq!(f[2], 14.0);
        assert_eq!(f[3], 15.0);
        assert_eq!(f[4], 12.0);
        assert_eq!(f[5], 13.0);
    }

    #[test]
    fn bands_bracket_residuals() {
        let y: Vec<f64> = (0..50).map(|i| (i % 7) as f64).collect();
        let fit = snaive_fit(&y, 7);
        let (lo, hi) = fit.bands(5, 0.95);
        assert_eq!(lo.len(), 5);
        for j in 0..5 {
            assert!(lo[j] <= hi[j]);
        }
    }

    #[test]
    fn snaive_simulate_deterministic() {
        let y: Vec<f64> = (0..40).map(|i| (i % 5) as f64).collect();
        let fit = snaive_fit(&y, 5);
        let pt = fit.forecast(&y, 4);
        let mut r1 = Rng::new(1);
        let mut r2 = Rng::new(1);
        let s1 = fit.simulate(&pt, 4, &mut r1, 10);
        let s2 = fit.simulate(&pt, 4, &mut r2, 10);
        assert_eq!(s1, s2);
        assert_eq!(s1.len(), 40);
    }
}
