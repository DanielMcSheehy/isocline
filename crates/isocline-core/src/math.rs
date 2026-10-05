//! Hand-rolled numerical primitives: FFT, ACF, periodogram, Cholesky solver,
//! Nelder–Mead, seeded RNG (xorshift64\*\*), Box–Muller normals, type-7
//! quantiles, centered rolling median, MAD and weighted linear regression.
//!
//! Everything is `std`-only and deterministic.

use crate::error::IsoclineError;
use std::f64::consts::{PI, TAU};

// ---------------------------------------------------------------------------
// Minimal complex numbers (re/im pairs)
// ---------------------------------------------------------------------------

/// Minimal complex number used by the FFT.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Complex {
    /// Real part.
    pub re: f64,
    /// Imaginary part.
    pub im: f64,
}

impl Complex {
    /// Construct from real and imaginary parts.
    pub const fn new(re: f64, im: f64) -> Self {
        Complex { re, im }
    }
    /// Complex zero.
    pub const ZERO: Complex = Complex { re: 0.0, im: 0.0 };
    #[inline]
    fn add(self, o: Complex) -> Complex {
        Complex::new(self.re + o.re, self.im + o.im)
    }
    #[inline]
    fn sub(self, o: Complex) -> Complex {
        Complex::new(self.re - o.re, self.im - o.im)
    }
    #[inline]
    fn mul(self, o: Complex) -> Complex {
        Complex::new(
            self.re * o.re - self.im * o.im,
            self.re * o.im + self.im * o.re,
        )
    }
    /// Squared modulus.
    #[inline]
    pub fn norm_sqr(self) -> f64 {
        self.re * self.re + self.im * self.im
    }
}

/// Smallest power of two `>= n` (at least 1).
pub fn next_pow2(n: usize) -> usize {
    let mut p = 1usize;
    while p < n {
        p <<= 1;
    }
    p
}

/// In-place iterative radix-2 Cooley–Tukey FFT with bit reversal.
/// Length must be a power of two (panics in debug if not; guarded by callers).
pub fn fft(a: &mut [Complex]) {
    fft_inner(a, false);
}

/// In-place inverse FFT (with 1/n normalization).
pub fn ifft(a: &mut [Complex]) {
    fft_inner(a, true);
}

fn fft_inner(a: &mut [Complex], inverse: bool) {
    let n = a.len();
    if n <= 1 {
        return;
    }
    debug_assert!(n.is_power_of_two(), "fft length must be a power of two");
    // Bit-reversal permutation.
    let mut j = 0usize;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j |= bit;
        if i < j {
            a.swap(i, j);
        }
    }
    let sign = if inverse { 1.0 } else { -1.0 };
    let mut len = 2usize;
    while len <= n {
        let half = len >> 1;
        let ang = sign * TAU / len as f64;
        let mut start = 0usize;
        while start < n {
            for k in 0..half {
                let wk = Complex::new((ang * k as f64).cos(), (ang * k as f64).sin());
                let u = a[start + k];
                let v = a[start + k + half].mul(wk);
                a[start + k] = u.add(v);
                a[start + k + half] = u.sub(v);
            }
            start += len;
        }
        len <<= 1;
    }
    if inverse {
        let inv = 1.0 / n as f64;
        for x in a.iter_mut() {
            x.re *= inv;
            x.im *= inv;
        }
    }
}

// ---------------------------------------------------------------------------
// Basic statistics
// ---------------------------------------------------------------------------

/// Arithmetic mean (0 for empty input).
pub fn mean(v: &[f64]) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    v.iter().sum::<f64>() / v.len() as f64
}

/// Population variance (sum of squared deviations / n; 0 for n < 2).
pub fn variance(v: &[f64]) -> f64 {
    let n = v.len();
    if n < 2 {
        return 0.0;
    }
    let m = mean(v);
    v.iter().map(|&x| (x - m) * (x - m)).sum::<f64>() / n as f64
}

/// Median of an unsorted slice (copies + sorts). Average of the two central
/// values for even lengths.
pub fn median(v: &[f64]) -> f64 {
    if v.is_empty() {
        return f64::NAN;
    }
    let mut s = v.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    median_sorted(&s)
}

/// Median of a pre-sorted slice.
pub fn median_sorted(sorted: &[f64]) -> f64 {
    let m = sorted.len();
    if m == 0 {
        return f64::NAN;
    }
    if m % 2 == 1 {
        sorted[m / 2]
    } else {
        0.5 * (sorted[m / 2 - 1] + sorted[m / 2])
    }
}

/// MAD = median absolute deviation from the median.
pub fn mad(v: &[f64]) -> f64 {
    let m = median(v);
    if m.is_nan() {
        return f64::NAN;
    }
    median(&v.iter().map(|&x| (x - m).abs()).collect::<Vec<f64>>())
}

/// MAD with the documented fallback chain: MAD -> mean absolute deviation ->
/// epsilon 1e-9. Never returns 0 or NaN for finite input.
pub fn mad_or_fallback(v: &[f64]) -> f64 {
    if v.is_empty() {
        return 1e-9;
    }
    let m = median(v);
    let absdev: Vec<f64> = v.iter().map(|&x| (x - m).abs()).collect();
    let md = median(&absdev);
    if md.is_finite() && md > 1e-12 {
        return md;
    }
    let mmean = mean(&absdev);
    if mmean.is_finite() && mmean > 1e-12 {
        return mmean;
    }
    1e-9
}

// ---------------------------------------------------------------------------
// ACF & periodogram (via FFT)
// ---------------------------------------------------------------------------

/// Autocorrelation function via FFT, lags `0..=max_lag`.
/// `acf[k] = sum((y_i-mean)(y_{i+k}-mean)) / sum((y_i-mean)^2)`.
pub fn acf(y: &[f64], max_lag: usize) -> Vec<f64> {
    let n = y.len();
    let m = max_lag.min(n.saturating_sub(1));
    let mut out = vec![0.0; m + 1];
    if n == 0 {
        return out;
    }
    let mu = mean(y);
    let centered: Vec<f64> = y.iter().map(|&v| v - mu).collect();
    let c0: f64 = centered.iter().map(|&v| v * v).sum();
    out[0] = 1.0;
    if c0 <= 1e-30 {
        // Constant series: ACF undefined; return 1 at lag 0, 0 elsewhere.
        return out;
    }
    let nfft = next_pow2(2 * n);
    let mut buf = vec![Complex::ZERO; nfft];
    for (i, &v) in centered.iter().enumerate() {
        buf[i] = Complex::new(v, 0.0);
    }
    fft(&mut buf);
    for c in buf.iter_mut() {
        *c = Complex::new(c.norm_sqr(), 0.0);
    }
    ifft(&mut buf);
    for k in 1..=m {
        out[k] = (buf[k].re / c0).clamp(-1.0, 1.0);
    }
    out
}

/// Periodogram of `y`: mean-centered, 10% Tukey taper, power `|X_k|^2 / n`.
/// Returns `(power, frequencies)` for `k = 0..=nfft/2`, `freq[k] = k / nfft`.
pub fn periodogram(y: &[f64]) -> (Vec<f64>, Vec<f64>) {
    let n = y.len();
    if n == 0 {
        return (Vec::new(), Vec::new());
    }
    let nfft = next_pow2(n.max(2));
    let mu = mean(y);
    let mut buf = vec![Complex::ZERO; nfft];
    // 10% total taper (5% per end), Tukey window.
    let m_end = ((n as f64 * 0.05).floor() as usize).max(1);
    for (i, &v) in y.iter().enumerate() {
        let mut w = 1.0;
        if i < m_end {
            w = 0.5 * (1.0 - (PI * i as f64 / m_end as f64).cos());
        } else if i + m_end > n - 1 {
            let j = (n - 1 - i) as f64;
            w = 0.5 * (1.0 - (PI * j / m_end as f64).cos());
        }
        buf[i] = Complex::new((v - mu) * w, 0.0);
    }
    fft(&mut buf);
    let half = nfft / 2;
    let mut power = Vec::with_capacity(half + 1);
    let mut freqs = Vec::with_capacity(half + 1);
    let inv = 1.0 / n as f64;
    for (k, c) in buf[..=half].iter().enumerate() {
        power.push(c.norm_sqr() * inv);
        freqs.push(k as f64 / nfft as f64);
    }
    (power, freqs)
}

// ---------------------------------------------------------------------------
// Dense Cholesky normal-equation solver
// ---------------------------------------------------------------------------

/// Solve the symmetric positive-definite system `A x = b` (A row-major n×n)
/// via Cholesky decomposition with a 1e-8 (scale-aware) ridge on the diagonal.
/// Escalates the ridge if a pivot is non-positive; returns `Internal` when the
/// system cannot be solved.
pub fn cholesky_solve(a: &[f64], b: &[f64], n_dim: usize) -> Result<Vec<f64>, IsoclineError> {
    let n = n_dim;
    if a.len() != n * n || b.len() != n {
        return Err(IsoclineError::Internal(
            "cholesky_solve: dimension mismatch".into(),
        ));
    }
    if n == 0 {
        return Ok(Vec::new());
    }
    let diag_max = (0..n).map(|i| a[i * n + i].abs()).fold(0.0f64, f64::max);
    let base_ridge = 1e-8 * (1.0 + diag_max);
    let mut ridge = base_ridge;
    for _attempt in 0..6 {
        let mut m = vec![0.0; n * n];
        for i in 0..n {
            for j in 0..n {
                m[i * n + j] = a[i * n + j];
            }
            m[i * n + i] += ridge;
        }
        // Cholesky: m = L L^T, L lower-triangular.
        let mut ok = true;
        for i in 0..n {
            for j in 0..=i {
                let mut sum = m[i * n + j];
                for k in 0..j {
                    sum -= m[i * n + k] * m[j * n + k];
                }
                if i == j {
                    if sum <= 0.0 {
                        ok = false;
                        break;
                    }
                    m[i * n + i] = sum.sqrt();
                } else {
                    m[i * n + j] = sum / m[j * n + j];
                }
            }
            if !ok {
                break;
            }
        }
        if ok {
            // Forward solve L z = b.
            let mut z = vec![0.0; n];
            for i in 0..n {
                let mut sum = b[i];
                for k in 0..i {
                    sum -= m[i * n + k] * z[k];
                }
                z[i] = sum / m[i * n + i];
            }
            // Backward solve L^T x = z.
            let mut x = vec![0.0; n];
            for i in (0..n).rev() {
                let mut sum = z[i];
                for k in (i + 1)..n {
                    sum -= m[k * n + i] * x[k];
                }
                x[i] = sum / m[i * n + i];
            }
            if x.iter().all(|v| v.is_finite()) {
                return Ok(x);
            }
        }
        ridge *= 100.0;
    }
    Err(IsoclineError::Internal(
        "cholesky_solve: matrix not solvable".into(),
    ))
}

// ---------------------------------------------------------------------------
// Nelder–Mead with sigmoid-bounded parameters
// ---------------------------------------------------------------------------

#[inline]
fn sigmoid(u: f64) -> f64 {
    if u >= 0.0 {
        let z = (-u).exp();
        1.0 / (1.0 + z)
    } else {
        let z = u.exp();
        z / (1.0 + z)
    }
}

#[inline]
fn logit(p: f64) -> f64 {
    let p = p.clamp(1e-9, 1.0 - 1e-9);
    (p / (1.0 - p)).ln()
}

/// Map an unbounded parameter vector through sigmoids into `bounds` and
/// evaluate the objective.
fn eval(f: &mut dyn FnMut(&[f64]) -> f64, u: &[f64], bounds: &[(f64, f64)]) -> f64 {
    let x: Vec<f64> = u
        .iter()
        .zip(bounds.iter())
        .map(|(&ui, &(lo, hi))| lo + (hi - lo) * sigmoid(ui))
        .collect();
    f(&x)
}

/// Result of a Nelder–Mead optimization.
#[derive(Debug, Clone)]
pub struct NmResult {
    /// Best parameter vector (in original bounded space).
    pub x: Vec<f64>,
    /// Objective value at `x`.
    pub fx: f64,
}

/// Nelder–Mead minimization of `f` over box `bounds`.
///
/// Parameters are mapped through a sigmoid so the optimizer works in an
/// unbounded space. Standard coefficients: reflection 1, expansion 2,
/// contraction 0.5, shrink 0.5; initial simplex perturbs `x0` by 5% per
/// dimension; at most 300 iterations, convergence tolerance 1e-6 on the
/// objective spread.
pub fn nelder_mead(
    f: &mut dyn FnMut(&[f64]) -> f64,
    x0: &[f64],
    bounds: &[(f64, f64)],
) -> NmResult {
    let n_dim = x0.len();
    let map = |u: &[f64]| -> Vec<f64> {
        u.iter()
            .zip(bounds.iter())
            .map(|(&ui, &(lo, hi))| lo + (hi - lo) * sigmoid(ui))
            .collect()
    };
    let unmap = |x: &[f64]| -> Vec<f64> {
        x.iter()
            .zip(bounds.iter())
            .map(|(&xi, &(lo, hi))| {
                let t = ((xi - lo) / (hi - lo)).clamp(1e-9, 1.0 - 1e-9);
                logit(t)
            })
            .collect()
    };

    let u0 = unmap(x0);
    let mut simplex: Vec<Vec<f64>> = Vec::with_capacity(n_dim + 1);
    simplex.push(u0.clone());
    for i in 0..n_dim {
        let mut u = u0.clone();
        let step = 0.05 * (1.0 + u[i].abs());
        u[i] += step;
        simplex.push(u);
    }
    let mut fvals: Vec<f64> = simplex
        .iter()
        .map(|u| {
            let x = map(u);
            f(&x)
        })
        .collect();

    let max_iter = 300;
    let tol = 1e-6;
    for _ in 0..max_iter {
        // Sort vertices by objective (ascending).
        let mut order: Vec<usize> = (0..simplex.len()).collect();
        order.sort_by(|&i, &j| {
            fvals[i]
                .partial_cmp(&fvals[j])
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let sorted: Vec<Vec<f64>> = order.iter().map(|&i| simplex[i].clone()).collect();
        let sf: Vec<f64> = order.iter().map(|&i| fvals[i]).collect();
        simplex = sorted;
        fvals = sf;

        let worst = simplex.len() - 1;
        if (fvals[worst] - fvals[0]).abs() <= tol * (1.0 + fvals[0].abs()) {
            break;
        }
        // Centroid of all but the worst vertex.
        let m = worst;
        let mut centroid = vec![0.0; n_dim];
        for v in &simplex[..m] {
            for (c, &u) in centroid.iter_mut().zip(v.iter()) {
                *c += u / m as f64;
            }
        }
        let wv = &simplex[worst];
        let reflect = |coef: f64| -> Vec<f64> {
            (0..n_dim)
                .map(|i| centroid[i] + coef * (centroid[i] - wv[i]))
                .collect()
        };
        let do_shrink =
            |f: &mut dyn FnMut(&[f64]) -> f64, simplex: &mut [Vec<f64>], fvals: &mut [f64]| {
                let best = simplex[0].clone();
                for i in 1..simplex.len() {
                    for (vi, &b) in simplex[i].iter_mut().zip(best.iter()) {
                        *vi = *vi + 0.5 * (b - *vi);
                    }
                    fvals[i] = eval(f, &simplex[i], bounds);
                }
            };

        let r = reflect(1.0);
        let fr = eval(f, &r, bounds);
        if fr < fvals[0] {
            let e = reflect(2.0);
            let fe = eval(f, &e, bounds);
            if fe < fr {
                simplex[worst] = e;
                fvals[worst] = fe;
            } else {
                simplex[worst] = r;
                fvals[worst] = fr;
            }
        } else if fr < fvals[worst - 1] {
            simplex[worst] = r;
            fvals[worst] = fr;
        } else if fr < fvals[worst] {
            // Outside contraction.
            let o = reflect(0.5);
            let fo = eval(f, &o, bounds);
            if fo <= fr {
                simplex[worst] = o;
                fvals[worst] = fo;
            } else {
                do_shrink(f, &mut simplex, &mut fvals);
            }
        } else {
            // Inside contraction.
            let c = reflect(-0.5);
            let fc = eval(f, &c, bounds);
            if fc < fvals[worst] {
                simplex[worst] = c;
                fvals[worst] = fc;
            } else {
                do_shrink(f, &mut simplex, &mut fvals);
            }
        }
    }

    // Pick best vertex.
    let mut best = 0;
    for i in 1..fvals.len() {
        if fvals[i] < fvals[best] {
            best = i;
        }
    }
    NmResult {
        x: map(&simplex[best]),
        fx: fvals[best],
    }
}

// ---------------------------------------------------------------------------
// Seeded RNG: xorshift64** + Box–Muller
// ---------------------------------------------------------------------------

/// Deterministic xorshift64\*\* RNG producing f64 in [0,1) and normals.
#[derive(Debug, Clone)]
pub struct Rng {
    s: u64,
    cached_normal: Option<f64>,
}

impl Rng {
    /// Create an RNG from a seed (seed 0 is remapped to a nonzero constant).
    pub fn new(seed: u64) -> Self {
        Rng {
            s: if seed == 0 { 0x9E37_79B9_7F4A_7C15 } else { seed },
            cached_normal: None,
        }
    }

    /// Next raw u64 (xorshift64\*\*).
    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.s;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.s = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    /// Uniform f64 in [0, 1).
    pub fn next_f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }

    /// Uniform index in [0, n). Returns 0 when n == 0.
    pub fn below(&mut self, n: usize) -> usize {
        if n == 0 {
            return 0;
        }
        (self.next_u64() % n as u64) as usize
    }

    /// Standard normal via Box–Muller (second variate cached per-RNG).
    pub fn normal(&mut self) -> f64 {
        if let Some(v) = self.cached_normal.take() {
            return v;
        }
        // u1 in (0, 1] so that ln is finite.
        let u1 = 1.0 - self.next_f64();
        let u2 = self.next_f64();
        let r = (-2.0 * u1.ln()).sqrt();
        let a = TAU * u2;
        self.cached_normal = Some(r * a.sin());
        r * a.cos()
    }
}

// ---------------------------------------------------------------------------
// Type-7 quantile on pre-sorted slice
// ---------------------------------------------------------------------------

/// Type-7 (linear interpolation) quantile of a pre-sorted slice.
/// `q` is clamped to [0, 1]. Returns NaN for empty input.
pub fn quantile_sorted(sorted: &[f64], q: f64) -> f64 {
    let n = sorted.len();
    if n == 0 {
        return f64::NAN;
    }
    if n == 1 {
        return sorted[0];
    }
    let q = q.clamp(0.0, 1.0);
    let h = (n - 1) as f64 * q;
    let lo = h.floor() as usize;
    let hi = (lo + 1).min(n - 1);
    let frac = h - lo as f64;
    sorted[lo] + frac * (sorted[hi] - sorted[lo])
}

// ---------------------------------------------------------------------------
// Centered rolling median
// ---------------------------------------------------------------------------

/// Centered rolling median. `window` is treated as centered; the effective
/// window shrinks at both ends (so the output has the same length as `y`).
pub fn rolling_median(y: &[f64], window: usize) -> Vec<f64> {
    let n = y.len();
    let mut out = vec![0.0; n];
    if n == 0 {
        return out;
    }
    let half = window / 2;
    let mut buf: Vec<f64> = Vec::with_capacity(window + 1);
    for (i, slot) in out.iter_mut().enumerate() {
        let lo = i.saturating_sub(half);
        let hi = (i + half + 1).min(n);
        buf.clear();
        buf.extend_from_slice(&y[lo..hi]);
        buf.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        *slot = median_sorted(&buf);
    }
    out
}

// ---------------------------------------------------------------------------
// Weighted linear regression helper (degree-1 LOESS building block)
// ---------------------------------------------------------------------------

/// Weighted degree-1 linear fit: returns `(intercept, slope)` minimizing
/// `sum w_i (y_i - a - b x_i)^2`. Falls back to `(weighted mean, 0)` when the
/// system is degenerate.
pub fn weighted_linfit(x: &[f64], y: &[f64], w: &[f64]) -> (f64, f64) {
    debug_assert_eq!(x.len(), y.len());
    debug_assert_eq!(x.len(), w.len());
    let mut sw = 0.0;
    let mut swx = 0.0;
    let mut swy = 0.0;
    let mut swxx = 0.0;
    let mut swxy = 0.0;
    for i in 0..x.len() {
        let wi = w[i];
        if wi <= 0.0 || wi.is_nan() {
            continue;
        }
        sw += wi;
        swx += wi * x[i];
        swy += wi * y[i];
        swxx += wi * x[i] * x[i];
        swxy += wi * x[i] * y[i];
    }
    if sw <= 1e-30 {
        return (0.0, 0.0);
    }
    let det = sw * swxx - swx * swx;
    let scale = sw.abs() * swxx.abs() + swx.abs() * swx.abs() + 1e-30;
    if det.abs() <= 1e-12 * scale {
        return (swy / sw, 0.0);
    }
    let a = (swy * swxx - swx * swxy) / det;
    let b = (sw * swxy - swx * swy) / det;
    (a, b)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fft_roundtrip() {
        let n = 16;
        let mut data: Vec<Complex> = (0..n)
            .map(|i| Complex::new((TAU * i as f64 / 4.0).sin(), 0.0))
            .collect();
        let orig = data.clone();
        fft(&mut data);
        ifft(&mut data);
        for i in 0..n {
            assert!((data[i].re - orig[i].re).abs() < 1e-12);
            assert!(data[i].im.abs() < 1e-12);
        }
        // Frequency spike at k=4 for a pure sine of period 4.
        let mut d: Vec<Complex> = (0..n)
            .map(|i| Complex::new((TAU * i as f64 / 4.0).sin(), 0.0))
            .collect();
        fft(&mut d);
        let peak = (0..n).map(|k| (k, d[k].norm_sqr())).fold((0, 0.0), |a, b| if b.1 > a.1 { b } else { a });
        assert_eq!(peak.0, 4);
    }

    #[test]
    fn acf_of_periodic_series_peaks_at_period() {
        let n = 480;
        let p = 24.0;
        let y: Vec<f64> = (0..n)
            .map(|i| (TAU * i as f64 / p).sin())
            .collect();
        let a = acf(&y, 60);
        assert!((a[0] - 1.0).abs() < 1e-9);
        // Lag 24 is a strong local maximum (global argmax can be lag 1 for
        // short-lag attenuation (n-k)/n, hence the local-max check).
        assert!(a[24] > 0.9, "acf[24] = {}", a[24]);
        assert!(a[24] > a[23] && a[24] > a[25]);
        assert!(a[48] > 0.85);
    }

    #[test]
    fn acf_constant_series_is_safe() {
        let a = acf(&[5.0; 10], 5);
        assert_eq!(a[0], 1.0);
        assert!(a[1..].iter().all(|&v| v == 0.0));
    }

    #[test]
    fn periodogram_finds_frequency() {
        let n = 256;
        let y: Vec<f64> = (0..n).map(|i| (TAU * i as f64 / 16.0).cos()).collect();
        let (power, freqs) = periodogram(&y);
        let kbest = (1..power.len())
            .map(|k| (k, power[k]))
            .fold((1, 0.0), |a, b| if b.1 > a.1 { b } else { a });
        assert!((freqs[kbest.0] - 1.0 / 16.0).abs() < 1e-9);
    }

    #[test]
    fn cholesky_solves_system() {
        // A = [[4, 1], [1, 3]], b = [1, 2] -> x = [1/11, 7/11]
        let a = [4.0, 1.0, 1.0, 3.0];
        let b = [1.0, 2.0];
        let x = cholesky_solve(&a, &b, 2).unwrap();
        // Tolerance accounts for the documented 1e-8-scale ridge.
        assert!((x[0] - 1.0 / 11.0).abs() < 1e-6);
        assert!((x[1] - 7.0 / 11.0).abs() < 1e-6);
    }

    #[test]
    fn nelder_mead_minimizes_quadratic() {
        let mut f = |x: &[f64]| (x[0] - 0.7).powi(2) + (x[1] + 0.2).powi(2) + 1.0;
        let bounds = [(-5.0, 5.0), (-5.0, 5.0)];
        let r = nelder_mead(&mut f, &[0.0, 0.0], &bounds);
        // tol 1e-6 on the objective spread bounds |x - x*| at ~sqrt(tol).
        assert!((r.x[0] - 0.7).abs() < 5e-3, "x0={:?}", r.x);
        assert!((r.x[1] + 0.2).abs() < 5e-3, "x1={:?}", r.x);
        assert!(r.fx < 1.0 + 1e-4);
        // Respects bounds.
        let mut g = |x: &[f64]| -x[0];
        let r2 = nelder_mead(&mut g, &[0.0], &[(0.0, 3.0)]);
        assert!(r2.x[0] >= 0.0 - 1e-9 && r2.x[0] <= 3.0 + 1e-9);
    }

    #[test]
    fn rng_deterministic_and_normal_finite() {
        let mut r1 = Rng::new(42);
        let mut r2 = Rng::new(42);
        for _ in 0..1000 {
            assert_eq!(r1.next_f64(), r2.next_f64());
        }
        let mut r = Rng::new(7);
        for _ in 0..1000 {
            let z = r.normal();
            assert!(z.is_finite());
        }
        let mut r3 = Rng::new(7);
        let s: f64 = (0..10000).map(|_| r3.next_f64()).sum();
        let m = s / 10000.0;
        assert!((m - 0.5).abs() < 0.02, "mean of uniform was {m}");
        let mut r4 = Rng::new(11);
        let vals: Vec<f64> = (0..20000).map(|_| r4.normal()).collect();
        let mu = mean(&vals);
        let sd = variance(&vals).sqrt();
        assert!((mu - 0.0).abs() < 0.05);
        assert!((sd - 1.0).abs() < 0.05);
    }

    #[test]
    fn quantile_type7() {
        let s = [1.0, 2.0, 3.0, 4.0];
        assert_eq!(quantile_sorted(&s, 0.0), 1.0);
        assert_eq!(quantile_sorted(&s, 1.0), 4.0);
        assert!((quantile_sorted(&s, 0.25) - 1.75).abs() < 1e-12);
        assert!((quantile_sorted(&s, 0.5) - 2.5).abs() < 1e-12);
    }

    #[test]
    fn rolling_median_shrinks_at_ends() {
        let out = rolling_median(&[5.0, 1.0, 9.0, 2.0, 8.0], 3);
        assert_eq!(out.len(), 5);
        assert_eq!(out[0], 3.0); // median(5,1)
        assert_eq!(out[1], 5.0); // median(5,1,9)
        assert_eq!(out[2], 2.0); // median(1,9,2)
        assert_eq!(out[3], 8.0); // median(9,2,8)
        assert_eq!(out[4], 5.0); // median(2,8)
        assert_eq!(rolling_median(&[], 3).len(), 0);
    }

    #[test]
    fn mad_fallback_chain() {
        assert!(mad_or_fallback(&[3.0; 10]) > 0.0); // falls to 1e-9
        assert!(mad_or_fallback(&[1.0, 2.0, 100.0]) > 0.0);
        assert_eq!(mad_or_fallback(&[]), 1e-9);
    }

    #[test]
    fn weighted_linfit_exact() {
        let x: Vec<f64> = (0..10).map(|i| i as f64).collect();
        let y: Vec<f64> = x.iter().map(|&v| 2.0 + 3.0 * v).collect();
        let w = vec![1.0; 10];
        let (a, b) = weighted_linfit(&x, &y, &w);
        assert!((a - 2.0).abs() < 1e-9);
        assert!((b - 3.0).abs() < 1e-9);
        // Zero weights -> fallback
        let w0 = vec![0.0; 10];
        let (a2, b2) = weighted_linfit(&x, &y, &w0);
        assert_eq!(a2, 0.0);
        assert_eq!(b2, 0.0);
    }

    #[test]
    fn next_pow2_basics() {
        assert_eq!(next_pow2(1), 1);
        assert_eq!(next_pow2(5), 8);
        assert_eq!(next_pow2(1024), 1024);
    }
}
