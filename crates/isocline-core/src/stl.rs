//! Robust STL-style decomposition per CONTRACT §4.3.
//!
//! Classical STL simplified to degree-1 local linear regression (LOESS deg 1,
//! tri-cube weights): cycle-subseries smoothing of the detrended series,
//! a low-pass chain (MA of `period`, `period`, 2+padding), and LOESS trend on
//! the deseasonalized series. Robustness via a bisquare outer loop with
//! 6·MAD scaling.

use crate::math;

/// Default span (in points) of the nearest-neighbor window used for the
/// cycle-subseries LOESS. Full classical spans scale quadratically; a bounded
/// nearest-neighbor window keeps the same local-linear behavior at O(n) cost.
const SEASONAL_SPAN_CAP: usize = 31;

/// Fit of the STL-style decomposition.
#[derive(Debug, Clone)]
pub struct StlFit {
    /// Trend component, length n.
    pub trend: Vec<f64>,
    /// Seasonal component, length n.
    pub seasonal: Vec<f64>,
    /// Remainder `y - trend - seasonal`, length n.
    pub resid: Vec<f64>,
    /// `1 - var(resid) / var(seasonal + resid)` clamped to [0, 1].
    pub seasonal_strength: f64,
    /// Final bisquare robust weights (when `robust` was requested).
    pub robust_weights: Option<Vec<f64>>,
    /// Detrended series `y - trend` from the final inner pass (for projection).
    pub(crate) detrended: Vec<f64>,
    /// Final low-pass component (for projection).
    pub(crate) lowpass: Vec<f64>,
    /// Period used.
    pub period: usize,
}

/// Seasonal strength from in-sample parts. `y` provides the data scale guard
/// (a constant series has strength 0 by definition).
pub fn strength_from_parts(y: &[f64], seasonal: &[f64], resid: &[f64]) -> f64 {
    if math::variance(y) <= 1e-30 {
        return 0.0;
    }
    let vr = math::variance(resid);
    let mut sres = vec![0.0; seasonal.len()];
    for i in 0..sres.len() {
        sres[i] = seasonal[i] + resid[i];
    }
    let vs = math::variance(&sres);
    if vs <= 1e-30 {
        return 0.0;
    }
    (1.0 - vr / vs).clamp(0.0, 1.0)
}

/// LOESS degree-1 evaluation on a uniformly-indexed subseries
/// (`vals[j]` at x = j) using a nearest-neighbor window with tri-cube weights.
/// `rw` carries optional robustness weights parallel to `vals`.
///
/// The evaluation is **out-of-sample**: when `xq` coincides with a data point,
/// that point is excluded from its own fit. This keeps the residuals of the
/// decomposition honest (uncompressed) estimates of the noise, which the
/// anomaly scoring and robustness weights rely on.
fn loess_deg1(vals: &[f64], xq: f64, span: usize, rw: Option<&[f64]>) -> f64 {
    let m = vals.len();
    if m == 0 {
        return 0.0;
    }
    if m == 1 {
        return vals[0];
    }
    let span = span.clamp(2, m);
    // Center of the window: nearest index to xq, clamped into range so that
    // extrapolation queries anchor at the series end.
    let ci = (xq.round() as isize).clamp(0, m as isize - 1) as usize;
    let self_idx: Option<usize> = {
        let r = xq.round();
        if (xq - r).abs() < 1e-9 && r >= 0.0 && (r as usize) < m {
            Some(r as usize)
        } else {
            None
        }
    };
    let half = span / 2;
    let mut lo = ci.saturating_sub(half);
    let hi = (lo + span).min(m);
    lo = hi.saturating_sub(span);
    let dmax = ((lo as f64 - xq).abs()).max((hi as f64 - 1.0 - xq).abs());
    if dmax <= 1e-12 {
        return vals[ci];
    }
    let mut xs = Vec::with_capacity(hi - lo);
    let mut ys = Vec::with_capacity(hi - lo);
    let mut ws = Vec::with_capacity(hi - lo);
    let mut wsum = 0.0;
    let mut ysum = 0.0;
    for j in lo..hi {
        if Some(j) == self_idx {
            continue;
        }
        let d = (j as f64 - xq).abs() / dmax;
        let mut w = if d < 1.0 {
            let t = 1.0 - d * d * d;
            t * t * t
        } else {
            0.0
        };
        if let Some(r) = rw {
            w *= r[j];
        }
        if w > 0.0 {
            wsum += w;
            ysum += w * vals[j];
            xs.push(j as f64);
            ys.push(vals[j]);
            ws.push(w);
        }
    }
    if xs.is_empty() {
        // Degenerate window (only the excluded point had support): fall back
        // to the weighted mean of the remaining window, or the point itself.
        return if wsum > 0.0 {
            ysum / wsum
        } else {
            vals[ci]
        };
    }
    let (a, b) = math::weighted_linfit(&xs, &ys, &ws);
    a + b * xq
}

/// LOESS degree-1 smoothing of a full series with span `span` (nearest-
/// neighbor windows, centered for interior points, shrinking at the ends).
fn loess_smooth(y: &[f64], span: usize, rw: Option<&[f64]>) -> Vec<f64> {
    let n = y.len();
    let mut out = vec![0.0; n];
    let span = span.clamp(2, n.max(2));
    for (i, slot) in out.iter_mut().enumerate() {
        *slot = loess_deg1(y, i as f64, span, rw);
    }
    out
}

/// Centered moving average. The window shrinks at the ends of the input; for
/// even `w` the effective window is `w + 1` points (order-w MA). Callers that
/// need boundary-correct values pass a pre-extended series (see `stl_fit`).
fn centered_ma(y: &[f64], w: usize) -> Vec<f64> {
    let n = y.len();
    let mut out = vec![0.0; n];
    if n == 0 {
        return out;
    }
    let half = (w.max(1)) / 2;
    for (i, slot) in out.iter_mut().enumerate() {
        let lo = i.saturating_sub(half);
        let hi = (i + half + 1).min(n);
        let cnt = (hi - lo) as f64;
        *slot = y[lo..hi].iter().sum::<f64>() / cnt;
    }
    out
}

/// Extract the subseries of phase `f` (indices f, f+p, f+2p, ...) from `src`
/// into `buf` (reused), returning the robust weights for those indices.
fn extract_phase(src: &[f64], f: usize, p: usize, buf: &mut Vec<f64>, wbuf: &mut Vec<f64>, rw: Option<&[f64]>) {
    buf.clear();
    wbuf.clear();
    let mut idx = f;
    while idx < src.len() {
        buf.push(src[idx]);
        if let Some(r) = rw {
            wbuf.push(r[idx]);
        }
        idx += p;
    }
}

/// Fit the decomposition. `period` must be >= 2 and callers must ensure
/// `period <= n` (it is clamped defensively). `seasons` = inner iterations,
/// `robust` = run 3 bisquare outer passes.
pub fn stl_fit(y: &[f64], period: usize, seasons: usize, robust: bool) -> StlFit {
    let n = y.len();
    let p = period.max(2).min(n.max(1));
    let seasons = seasons.max(1);
    let span = (p + 1).min(n.max(2));

    let mut trend = loess_smooth(y, span, None);
    let mut seasonal = vec![0.0; n];
    let mut seasonal_raw = vec![0.0; n];
    let mut lowpass = vec![0.0; n];
    let mut weights: Option<Vec<f64>> = None;
    let mut sub_buf: Vec<f64> = Vec::new();
    let mut sub_w: Vec<f64> = Vec::new();
    let mut detrended = vec![0.0; n];

    let outer_passes = if robust { 3 } else { 0 };
    for outer in 0..=outer_passes {
        if outer > 0 {
            let resid: Vec<f64> = (0..n)
                .map(|i| y[i] - trend[i] - seasonal[i])
                .collect();
            let scale = 6.0 * math::mad_or_fallback(&resid);
            let w: Vec<f64> = resid
                .iter()
                .map(|&r| {
                    let u = (r / scale).abs();
                    let v = 1.0 - u * u;
                    if v <= 0.0 {
                        0.0
                    } else {
                        v * v
                    }
                })
                .collect();
            weights = Some(w);
        }
        let rw = weights.as_deref();
        for _ in 0..seasons {
            // 1) detrend
            for i in 0..n {
                detrended[i] = y[i] - trend[i];
            }
            // 2) cycle-subseries smoothing of the detrended series.
            //    Per-phase subseries are extracted once per inner pass.
            let mut phase_vals: Vec<Vec<f64>> = Vec::with_capacity(p);
            let mut phase_rw: Vec<Vec<f64>> = Vec::with_capacity(p);
            for f in 0..p {
                extract_phase(&detrended, f, p, &mut sub_buf, &mut sub_w, rw);
                phase_vals.push(sub_buf.clone());
                if rw.is_some() {
                    phase_rw.push(sub_w.clone());
                }
            }
            let rw_at = |phase: usize| -> Option<&[f64]> {
                if rw.is_some() {
                    Some(phase_rw[phase].as_slice())
                } else {
                    None
                }
            };
            for i in 0..n {
                seasonal_raw[i] =
                    loess_deg1(&phase_vals[i % p], (i / p) as f64, SEASONAL_SPAN_CAP, rw_at(i % p));
            }
            // 3) low-pass chain: MA(p), MA(p), MA(2) over the seasonal series
            //    extended by one full cycle on each side (classical "2 +
            //    padding" — the extension comes from the same subseries LOESS
            //    evaluated one cycle before the start / after the end).
            let mut ext = vec![0.0; n + 2 * p];
            for k in 0..p {
                ext[k] = loess_deg1(&phase_vals[k], -1.0, SEASONAL_SPAN_CAP, rw_at(k));
            }
            ext[p..p + n].copy_from_slice(&seasonal_raw);
            for j in 0..p {
                let t = n + j;
                let phase = t % p;
                let cyc = (t - phase) / p;
                ext[p + n + j] = loess_deg1(&phase_vals[phase], cyc as f64, SEASONAL_SPAN_CAP, rw_at(phase));
            }
            let ma1 = centered_ma(&ext, p);
            let ma2 = centered_ma(&ma1, p);
            let lp_ext = centered_ma(&ma2, 2);
            lowpass.copy_from_slice(&lp_ext[p..p + n]);
            // 4) seasonal + trend refresh
            for i in 0..n {
                seasonal[i] = seasonal_raw[i] - lowpass[i];
            }
            let mut deseas = vec![0.0; n];
            for i in 0..n {
                deseas[i] = y[i] - seasonal[i];
            }
            trend = loess_smooth(&deseas, span, rw);
        }
    }

    let resid: Vec<f64> = (0..n).map(|i| y[i] - trend[i] - seasonal[i]).collect();
    let strength = strength_from_parts(y, &seasonal, &resid);
    StlFit {
        trend,
        seasonal,
        resid,
        seasonal_strength: strength,
        robust_weights: if robust { weights } else { None },
        detrended,
        lowpass,
        period: p,
    }
}

impl StlFit {
    /// Project the seasonal component `h` steps past the end of the series:
    /// the cycle-subseries LOESS evaluated at future cycle positions, minus a
    /// linear extrapolation of the low-pass component (so the projection lives
    /// on the same scale as the in-sample `seasonal`).
    pub fn seasonal_project(&self, h: usize) -> Vec<f64> {
        let n = self.detrended.len();
        let p = self.period;
        let mut out = vec![0.0; h];
        if h == 0 || n == 0 {
            return out;
        }
        // Pre-extract per-phase subseries of the detrended series.
        let mut phase_vals: Vec<Vec<f64>> = Vec::with_capacity(p);
        for f in 0..p {
            let mut v = Vec::new();
            let mut idx = f;
            while idx < n {
                v.push(self.detrended[idx]);
                idx += p;
            }
            phase_vals.push(v);
        }
        // Low-pass slope for de-biasing the projection.
        let lp_slope = if n >= 2 {
            self.lowpass[n - 1] - self.lowpass[n - 2]
        } else {
            0.0
        };
        // Clamp the projection to a sane range derived from the in-sample
        // seasonal component (guards long-horizon extrapolation blowups).
        let smin = self.seasonal.iter().cloned().fold(f64::INFINITY, f64::min);
        let smax = self.seasonal.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        let range = smax - smin;
        let lo_lim = smin - range - 1e-9;
        let hi_lim = smax + range + 1e-9;
        for (s, slot) in out.iter_mut().enumerate() {
            let t = n + s;
            let phase = t % p;
            let cycle = (t / p) as f64;
            let vals = &phase_vals[phase];
            let raw = if vals.is_empty() {
                0.0
            } else {
                loess_deg1(vals, cycle, SEASONAL_SPAN_CAP, None)
            };
            *slot = (raw - (self.lowpass[n - 1] + (s + 1) as f64 * lp_slope)).clamp(lo_lim, hi_lim);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::TAU;

    fn series(n: usize, p: f64, a: f64, trend: f64, seed: u64) -> Vec<f64> {
        let mut rng = math::Rng::new(seed);
        (0..n)
            .map(|i| {
                trend * i as f64 + a * (TAU * i as f64 / p).sin() + 0.3 * rng.normal()
            })
            .collect()
    }

    #[test]
    fn recovers_clean_seasonal() {
        let n = 480;
        let p = 24;
        let y: Vec<f64> = (0..n)
            .map(|i| 5.0 * (TAU * i as f64 / p as f64).sin())
            .collect();
        let fit = stl_fit(&y, p, 2, false);
        assert!(fit.seasonal_strength > 0.95, "strength {}", fit.seasonal_strength);
        for i in 0..n {
            let want = 5.0 * (TAU * i as f64 / p as f64).sin();
            // Boundary cycles tolerate the (classical) STL end effect; the
            // interior tolerates the deg-1 trend/seasonal competition.
            let tol = if i < (3 * p) / 2 || i + (3 * p) / 2 > n { 1.5 } else { 1.0 };
            assert!(
                (fit.seasonal[i] - want).abs() < tol,
                "i={i} got {} want {want}",
                fit.seasonal[i]
            );
        }
        for i in 0..n {
            let tol = if i < (3 * p) / 2 || i + (3 * p) / 2 > n { 1.5 } else { 1.0 };
            assert!((fit.trend[i] - 0.0).abs() < tol, "trend[{i}] = {}", fit.trend[i]);
        }
    }

    #[test]
    fn noisy_seasonal_strength_high() {
        let y = series(480, 24.0, 6.0, 0.02, 42);
        let fit = stl_fit(&y, 24, 3, true);
        assert!(fit.seasonal_strength > 0.7, "strength {}", fit.seasonal_strength);
        let w = fit.robust_weights.expect("robust weights present");
        assert_eq!(w.len(), y.len());
        assert!(w.iter().all(|&v| (0.0..=1.0).contains(&v)));
    }

    #[test]
    fn constant_series_decomposes_to_zero() {
        let fit = stl_fit(&[7.0; 120], 10, 2, true);
        assert_eq!(fit.seasonal_strength, 0.0);
        assert!(fit.seasonal.iter().all(|&v| v.abs() < 1e-9));
        assert!(fit.resid.iter().all(|&v| v.abs() < 1e-9));
    }

    #[test]
    fn projection_stays_bounded() {
        let y = series(480, 24.0, 6.0, 0.02, 7);
        let fit = stl_fit(&y, 24, 3, false);
        let proj = fit.seasonal_project(48);
        assert_eq!(proj.len(), 48);
        let smin = fit.seasonal.iter().cloned().fold(f64::INFINITY, f64::min);
        let smax = fit.seasonal.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        for v in &proj {
            assert!(v.is_finite());
            assert!(*v >= smin - (smax - smin) - 1e-6);
            assert!(*v <= smax + (smax - smin) + 1e-6);
        }
    }

    #[test]
    fn tiny_input_no_panic() {
        let fit = stl_fit(&[1.0, 2.0, 3.0], 5, 2, true);
        assert_eq!(fit.trend.len(), 3);
        assert!(fit.seasonal_project(4).len() == 4);
    }
}
