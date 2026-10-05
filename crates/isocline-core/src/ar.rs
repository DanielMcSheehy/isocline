//! AR(p) autoregression per CONTRACT §4.5: lag-matrix OLS via the Cholesky
//! normal-equation solver, AICc order selection, recursive multi-step forecast
//! and residual-bootstrap simulation.

use crate::error::IsoclineError;
use crate::math::{cholesky_solve, Rng};

/// Fitted AR(p) model with intercept.
#[derive(Debug, Clone)]
pub struct ArFit {
    /// Selected order.
    pub p: usize,
    /// Intercept (constant term).
    pub intercept: f64,
    /// AR coefficients, length p (`phi_1..phi_p`).
    pub coeffs: Vec<f64>,
    /// One-step in-sample fitted values (first p entries are y itself).
    pub fitted: Vec<f64>,
    /// One-step in-sample residuals (first p entries are 0).
    pub residuals: Vec<f64>,
    /// AICc of the selected order.
    pub aicc: f64,
}

const MAX_P: usize = 20;

/// Fit AR(p) with AICc order selection over `p = 1..=min(max_p, 20, n/4)`.
pub fn ar_fit(y: &[f64], max_p: usize) -> Result<ArFit, IsoclineError> {
    let n = y.len();
    if n < 8 {
        return Err(IsoclineError::TooShort { n, need: 8 });
    }
    for &v in y {
        if !v.is_finite() {
            return Err(IsoclineError::BadParams("non-finite value in series".into()));
        }
    }
    let p_cap = max_p.min(MAX_P).min(n / 4).max(1);

    struct Best {
        p: usize,
        intercept: f64,
        coeffs: Vec<f64>,
        aicc: f64,
    }
    let mut best: Option<Best> = None;

    for p in 1..=p_cap {
        let neff = n - p;
        let k = p + 1;
        if neff <= k + 1 {
            break;
        }
        // Normal equations for [1, y_{t-1..t-p}] -> y_t.
        let dim = k;
        let mut ata = vec![0.0; dim * dim];
        let mut atb = vec![0.0; dim];
        for t in p..n {
            let row: Vec<f64> = (1..=p).map(|i| y[t - i]).collect();
            let mut feats = Vec::with_capacity(dim);
            feats.push(1.0);
            feats.extend_from_slice(&row);
            for i in 0..dim {
                atb[i] += feats[i] * y[t];
                for j in 0..dim {
                    ata[i * dim + j] += feats[i] * feats[j];
                }
            }
        }
        let beta = match cholesky_solve(&ata, &atb, dim) {
            Ok(b) => b,
            Err(_) => continue,
        };
        if beta.iter().any(|v| !v.is_finite()) {
            continue;
        }
        let mut sse = 0.0;
        for t in p..n {
            let mut pred = beta[0];
            for i in 1..=p {
                pred += beta[i] * y[t - i];
            }
            let e = y[t] - pred;
            sse += e * e;
        }
        if !sse.is_finite() {
            continue;
        }
        let sse_c = sse.max(1e-12);
        let aicc = neff as f64 * (sse_c / neff as f64).ln()
            + 2.0 * k as f64
            + 2.0 * (k as f64) * (k as f64 + 1.0) / (neff - k - 1) as f64;
        if best.as_ref().is_none_or(|b| aicc < b.aicc) {
            best = Some(Best {
                p,
                intercept: beta[0],
                coeffs: beta[1..].to_vec(),
                aicc,
            });
        }
    }

    let best = match best {
        Some(b) => b,
        None => return Err(IsoclineError::Internal("AR order selection failed".into())),
    };

    let mut fitted = vec![0.0; n];
    let mut residuals = vec![0.0; n];
    let p0 = best.p.min(n);
    fitted[..p0].copy_from_slice(&y[..p0]);
    for t in best.p..n {
        let mut pred = best.intercept;
        for (i, &c) in best.coeffs.iter().enumerate() {
            pred += c * y[t - 1 - i];
        }
        fitted[t] = pred;
        residuals[t] = y[t] - pred;
    }
    Ok(ArFit {
        p: best.p,
        intercept: best.intercept,
        coeffs: best.coeffs,
        fitted,
        residuals,
        aicc: best.aicc,
    })
}

/// Recursive multi-step point forecast.
pub fn ar_forecast(fit: &ArFit, y: &[f64], h: usize) -> Vec<f64> {
    let mut hist: Vec<f64> = y.to_vec();
    let mut out = vec![0.0; h];
    for slot in out.iter_mut() {
        let mut pred = fit.intercept;
        for (i, &c) in fit.coeffs.iter().enumerate() {
            let idx = hist.len() - 1 - i;
            pred += c * hist[idx];
        }
        *slot = pred;
        hist.push(pred);
    }
    out
}

/// Residual-bootstrap simulation of `paths` futures; flat `paths × h`.
pub fn ar_simulate(fit: &ArFit, y: &[f64], h: usize, rng: &mut Rng, paths: usize) -> Vec<f64> {
    let mut resid: Vec<f64> = fit
        .residuals
        .iter()
        .copied()
        .filter(|v| v.is_finite())
        .collect();
    if resid.is_empty() {
        resid.push(0.0);
    }
    let mut out = vec![0.0; paths * h];
    for path in 0..paths {
        let mut hist: Vec<f64> = y.to_vec();
        for j in 0..h {
            let mut pred = fit.intercept;
            for (i, &c) in fit.coeffs.iter().enumerate() {
                let idx = hist.len() - 1 - i;
                pred += c * hist[idx];
            }
            let e = resid[rng.below(resid.len())];
            let obs = pred + e;
            out[path * h + j] = obs;
            hist.push(obs);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ar1(phi: f64, n: usize, sigma: f64, seed: u64) -> Vec<f64> {
        let mut rng = Rng::new(seed);
        let mut y = Vec::with_capacity(n);
        let mut x = 0.0;
        for _ in 0..n {
            x = phi * x + sigma * rng.normal();
            y.push(x);
        }
        y
    }

    #[test]
    fn recovers_ar1_coefficient() {
        let y = ar1(0.8, 600, 1.0, 42);
        let fit = ar_fit(&y, 20).unwrap();
        assert!(fit.p <= 4, "selected order too high: {}", fit.p);
        assert!(
            (fit.coeffs[0] - 0.8).abs() < 0.12,
            "phi_1 = {}",
            fit.coeffs[0]
        );
    }

    #[test]
    fn forecast_bounded_by_stationarity() {
        let y = ar1(0.5, 300, 1.0, 7);
        let fit = ar_fit(&y, 20).unwrap();
        let f = ar_forecast(&fit, &y, 12);
        for v in &f {
            assert!(v.is_finite());
            assert!(v.abs() < 20.0, "explosion in forecast: {v}");
        }
    }

    #[test]
    fn simulate_deterministic() {
        let y = ar1(0.6, 200, 1.0, 3);
        let fit = ar_fit(&y, 5).unwrap();
        let mut r1 = Rng::new(5);
        let mut r2 = Rng::new(5);
        let s1 = ar_simulate(&fit, &y, 8, &mut r1, 20);
        let s2 = ar_simulate(&fit, &y, 8, &mut r2, 20);
        assert_eq!(s1, s2);
        assert_eq!(s1.len(), 160);
    }

    #[test]
    fn too_short() {
        assert!(matches!(
            ar_fit(&[1.0; 7], 20),
            Err(IsoclineError::TooShort { .. })
        ));
    }
}
