//! Holt–Winters ETS(A,Ad,A) per CONTRACT §4.4, plus the non-seasonal
//! ETS(A,Ad,N) variant. OLS init, Nelder–Mead fit with 3 restarts, one-step
//! fitted/residuals, forward simulation for bootstrap prediction intervals.

use crate::error::IsoclineError;
use crate::math::{nelder_mead, Rng};

/// Fitted ETS model.
#[derive(Debug, Clone)]
pub struct EtsFit {
    /// Smoothing parameter for level.
    pub alpha: f64,
    /// Smoothing parameter for trend.
    pub beta: f64,
    /// Smoothing parameter for seasonality (`None` for ETS(A,Ad,N)).
    pub gamma: Option<f64>,
    /// Damping parameter.
    pub phi: f64,
    /// Final level state.
    pub l: f64,
    /// Final (damped) trend state.
    pub b: f64,
    /// Final seasonal states, length `period` (empty when non-seasonal).
    pub s: Vec<f64>,
    /// One-step in-sample fitted values, length n.
    pub fitted: Vec<f64>,
    /// One-step in-sample residuals, length n.
    pub residuals: Vec<f64>,
    /// Sum of squared one-step errors.
    pub sse: f64,
    /// Seasonal period (0 when non-seasonal).
    pub period: usize,
    /// Number of observations.
    pub n: usize,
}

/// OLS init: line over the first `min(2p, n)` points gives (l0, b0); the
/// seasonal states are the per-phase means of the detrended values.
fn init_states(y: &[f64], p: usize) -> (f64, f64, Vec<f64>) {
    let n = y.len();
    // Line over the first min(2p, n) points (whole series when non-seasonal).
    let m = if p >= 2 { (2 * p).min(n).max(2) } else { n };
    // Plain OLS over x = 0..m.
    let xs: Vec<f64> = (0..m).map(|i| i as f64).collect();
    let (a, b) = {
        let mut sx = 0.0;
        let mut sxx = 0.0;
        let mut sy = 0.0;
        let mut sxy = 0.0;
        for i in 0..m {
            sx += xs[i];
            sxx += xs[i] * xs[i];
            sy += y[i];
            sxy += xs[i] * y[i];
        }
        let det = m as f64 * sxx - sx * sx;
        if det.abs() < 1e-12 {
            (sy / m as f64, 0.0)
        } else {
            let slope = (m as f64 * sxy - sx * sy) / det;
            (sy / m as f64 - slope * sx / m as f64, slope)
        }
    };
    let l0 = a;
    let b0 = b;
    if p < 2 {
        return (l0, b0, Vec::new());
    }
    let mut s = vec![0.0; p];
    let mut counts = vec![0usize; p];
    // Average the detrended first-season values over the first min(2p, n)
    // points (each phase gets up to 2 samples).
    for (i, &yi) in y.iter().enumerate().take(m) {
        let phase = i % p;
        s[phase] += yi - (l0 + b0 * i as f64);
        counts[phase] += 1;
    }
    for i in 0..p {
        if counts[i] > 0 {
            s[i] /= counts[i] as f64;
        }
    }
    (l0, b0, s)
}

/// One run of the ETS recursion. Returns fitted values, residuals, SSE and
/// final states.
#[allow(clippy::too_many_arguments)]
fn ets_filter(
    y: &[f64],
    l0: f64,
    b0: f64,
    s0: &[f64],
    alpha: f64,
    beta: f64,
    gamma: Option<f64>,
    phi: f64,
    p: usize,
) -> (Vec<f64>, Vec<f64>, f64, f64, f64, Vec<f64>) {
    let n = y.len();
    let seasonal = p >= 2 && !s0.is_empty();
    let mut l = l0;
    let mut b = b0;
    let mut s = s0.to_vec();
    let mut fitted = vec![0.0; n];
    let mut residuals = vec![0.0; n];
    let mut sse = 0.0;
    for t in 0..n {
        let phase = if seasonal { t % p } else { 0 };
        let s_cur = if seasonal { s[phase] } else { 0.0 };
        let f = l + phi * b + s_cur;
        fitted[t] = f;
        let e = y[t] - f;
        residuals[t] = e;
        sse += e * e;
        let l_new = alpha * (y[t] - s_cur) + (1.0 - alpha) * (l + phi * b);
        let b_new = beta * (l_new - l) + (1.0 - beta) * phi * b;
        if seasonal {
            let g = gamma.unwrap_or(0.0);
            s[phase] = g * (y[t] - l_new) + (1.0 - g) * s_cur;
        }
        l = l_new;
        b = b_new;
    }
    (fitted, residuals, sse, l, b, s)
}

fn fit_params(
    y: &[f64],
    l0: f64,
    b0: f64,
    s0: &[f64],
    p: usize,
    starts: &[(f64, f64, f64, f64)],
) -> (f64, f64, f64, f64, f64) {
    let seasonal = p >= 2 && !s0.is_empty();
    let bounds: Vec<(f64, f64)> = if seasonal {
        vec![(0.01, 0.99), (0.01, 0.5), (0.01, 0.99), (0.8, 0.999)]
    } else {
        vec![(0.01, 0.99), (0.01, 0.5), (0.8, 0.999)]
    };
    let mut best = (f64::INFINITY, starts[0].0, starts[0].1, starts[0].2, starts[0].3);
    for start in starts {
        let x0: Vec<f64> = if seasonal {
            vec![start.0, start.1, start.2, start.3]
        } else {
            vec![start.0, start.1, start.3]
        };
        let s0v = s0.to_vec();
        let yv = y;
        let mut objective = |x: &[f64]| -> f64 {
            let (alpha, beta, gamma, phi) = if seasonal {
                (x[0], x[1], Some(x[2]), x[3])
            } else {
                (x[0], x[1], None, x[2])
            };
            let (_, _, sse, _, _, _) =
                ets_filter(yv, l0, b0, &s0v, alpha, beta, gamma, phi, p);
            sse
        };
        let r = nelder_mead(&mut objective, &x0, &bounds);
        if r.fx < best.0 {
            let (a, b, g, ph) = if seasonal {
                (r.x[0], r.x[1], Some(r.x[2]), r.x[3])
            } else {
                (r.x[0], r.x[1], None, r.x[2])
            };
            best = (r.fx, a, b, g.unwrap_or(0.0), ph);
        }
    }
    best
}

/// Fit ETS(A,Ad,A) when `Some(p)` (requires `n >= 2p + 1`) or ETS(A,Ad,N)
/// when `None`. Three Nelder–Mead restarts, best SSE wins.
pub fn ets_fit(y: &[f64], period: Option<usize>) -> Result<EtsFit, IsoclineError> {
    let n = y.len();
    if n < 3 {
        return Err(IsoclineError::TooShort { n, need: 3 });
    }
    for &v in y {
        if !v.is_finite() {
            return Err(IsoclineError::BadParams("non-finite value in series".into()));
        }
    }
    let p = match period {
        Some(pv) => {
            if pv < 2 {
                return Err(IsoclineError::BadConfig("period must be >= 2".into()));
            }
            if n < 2 * pv + 1 {
                return Err(IsoclineError::BadConfig(
                    "seasonal ETS needs n >= 2*period + 1".into(),
                ));
            }
            pv
        }
        None => 0,
    };
    let (l0, b0, s0) = init_states(y, p);
    let seasonal = p >= 2;
    let starts: Vec<(f64, f64, f64, f64)> = if seasonal {
        vec![
            (0.3, 0.1, 0.3, 0.95),
            (0.1, 0.05, 0.1, 0.85),
            (0.6, 0.3, 0.6, 0.99),
        ]
    } else {
        vec![
            (0.3, 0.1, 0.0, 0.95),
            (0.1, 0.05, 0.0, 0.85),
            (0.6, 0.3, 0.0, 0.99),
        ]
    };
    let (_sse_best, alpha, beta, gamma, phi) = fit_params(y, l0, b0, &s0, p, &starts);
    let gamma_opt = if seasonal { Some(gamma) } else { None };
    let (fitted, residuals, sse, l, b, s) =
        ets_filter(y, l0, b0, &s0, alpha, beta, gamma_opt, phi, p);
    Ok(EtsFit {
        alpha,
        beta,
        gamma: gamma_opt,
        phi,
        l,
        b,
        s,
        fitted,
        residuals,
        sse,
        period: p,
        n,
    })
}

impl EtsFit {
    /// Deterministic point forecast: `l + (phi + phi^2 + ... + phi^j) b` plus
    /// the cyclic seasonal state.
    pub fn forecast(&self, h: usize) -> Vec<f64> {
        let mut out = vec![0.0; h];
        let n = self.n;
        let seasonal = self.period >= 2 && !self.s.is_empty();
        let mut phi_pow = 1.0;
        let mut phi_sum = 0.0;
        for (j, slot) in out.iter_mut().enumerate() {
            phi_pow *= self.phi;
            phi_sum += phi_pow;
            let base = self.l + phi_sum * self.b;
            *slot = if seasonal {
                base + self.s[(n + j) % self.period]
            } else {
                base
            };
        }
        out
    }

    /// Bootstrap simulation: evolve the model forward, feeding simulated
    /// observations `forecast + residual` with residuals resampled with
    /// replacement. Returns a flat `paths × h` row-major vector.
    pub fn simulate(
        &self,
        h: usize,
        residuals: &[f64],
        rng: &mut Rng,
        paths: usize,
    ) -> Vec<f64> {
        let seasonal = self.period >= 2 && !self.s.is_empty();
        let p = self.period.max(1);
        let fallback = [0.0f64];
        let resid = if residuals.is_empty() { &fallback[..] } else { residuals };
        let mut out = vec![0.0; paths * h];
        for path in 0..paths {
            let mut l = self.l;
            let mut b = self.b;
            let mut s = self.s.clone();
            let mut phi_pow = 1.0;
            let mut phi_sum = 0.0;
            for j in 0..h {
                phi_pow *= self.phi;
                phi_sum += phi_pow;
                let phase = if seasonal { (self.n + j) % p } else { 0 };
                let s_cur = if seasonal { s[phase] } else { 0.0 };
                let f = l + phi_sum * b + s_cur;
                let e = resid[rng.below(resid.len())];
                let obs = f + e;
                out[path * h + j] = obs;
                let l_new = self.alpha * (obs - s_cur) + (1.0 - self.alpha) * (l + self.phi * b);
                let b_new = self.beta * (l_new - l) + (1.0 - self.beta) * self.phi * b;
                if seasonal {
                    s[phase] = self.gamma.unwrap_or(0.0) * (obs - l_new)
                        + (1.0 - self.gamma.unwrap_or(0.0)) * s_cur;
                }
                l = l_new;
                b = b_new;
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::TAU;

    #[test]
    fn constant_series_flat_forecast() {
        let y = vec![10.0; 60];
        let fit = ets_fit(&y, None).unwrap();
        let f = fit.forecast(6);
        for v in &f {
            assert!((v - 10.0).abs() < 1e-6, "got {v}");
        }
        assert!(fit.sse < 1e-12);
    }

    #[test]
    fn nonseasonal_tracks_trend() {
        let y: Vec<f64> = (0..80).map(|i| 5.0 + 0.5 * i as f64).collect();
        let fit = ets_fit(&y, None).unwrap();
        let f = fit.forecast(10);
        for (j, v) in f.iter().enumerate() {
            let want = 5.0 + 0.5 * (80 + j) as f64;
            assert!((v - want).abs() < 1.5, "got {v} want {want}");
        }
    }

    #[test]
    fn seasonal_fit_beats_flat_on_sine() {
        let y: Vec<f64> = (0..240)
            .map(|i| 50.0 + 8.0 * (TAU * i as f64 / 24.0).sin())
            .collect();
        let fit = ets_fit(&y, Some(24)).unwrap();
        assert!(fit.gamma.is_some());
        let rmse = (fit.sse / fit.n as f64).sqrt();
        assert!(rmse < 2.0, "one-step rmse {rmse}");
        let f = fit.forecast(24);
        for (j, v) in f.iter().enumerate() {
            let want = 50.0 + 8.0 * (TAU * (240 + j) as f64 / 24.0).sin();
            assert!((v - want).abs() < 2.5, "j={j} got {v} want {want}");
        }
    }

    #[test]
    fn simulate_is_deterministic_and_finite() {
        let y: Vec<f64> = (0..120)
            .map(|i| 50.0 + 8.0 * (TAU * i as f64 / 12.0).sin())
            .collect();
        let fit = ets_fit(&y, Some(12)).unwrap();
        let mut r1 = Rng::new(99);
        let mut r2 = Rng::new(99);
        let s1 = fit.simulate(6, &fit.residuals, &mut r1, 50);
        let s2 = fit.simulate(6, &fit.residuals, &mut r2, 50);
        assert_eq!(s1, s2);
        assert_eq!(s1.len(), 300);
        assert!(s1.iter().all(|v| v.is_finite()));
    }

    #[test]
    fn too_short_and_bad_period() {
        assert!(matches!(
            ets_fit(&[1.0, 2.0], None),
            Err(IsoclineError::TooShort { .. })
        ));
        assert!(ets_fit(&[1.0; 10], Some(1)).is_err());
        assert!(ets_fit(&[1.0; 10], Some(8)).is_err());
    }
}
