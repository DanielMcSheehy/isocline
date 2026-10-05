//! Mean-shift changepoint detection per CONTRACT §4.9: binary segmentation
//! with a robust sigma-hat, gain statistic, threshold 3.0, minSegment 10,
//! maxChangepoints 10 and a step-function `means` output.

use crate::error::IsoclineError;
use crate::math;

/// Changepoint options (mirrors TS `ChangepointOptions`).
#[derive(Debug, Clone)]
pub struct ChangepointOptions {
    /// Minimum segment length on each side of a split (default 10).
    pub min_segment: usize,
    /// Maximum number of changepoints (default 10).
    pub max_changepoints: usize,
    /// Gain threshold in sigma units (default 3.0).
    pub threshold: f64,
}

impl Default for ChangepointOptions {
    fn default() -> Self {
        ChangepointOptions {
            min_segment: 10,
            max_changepoints: 10,
            threshold: 3.0,
        }
    }
}

/// A single changepoint (mirrors TS `Changepoint`).
#[derive(Debug, Clone, PartialEq)]
pub struct Changepoint {
    /// Index of the first point of the segment after the shift.
    pub index: usize,
    /// Mean of the segment before the shift.
    pub mean_before: f64,
    /// Mean of the segment after the shift.
    pub mean_after: f64,
}

/// Result (mirrors TS `ChangepointResult`).
#[derive(Debug, Clone)]
pub struct ChangepointResult {
    /// Detected changepoints, sorted by index.
    pub changepoints: Vec<Changepoint>,
    /// Step function of segment means, length n.
    pub means: Vec<f64>,
}

/// Detect changepoints. Input may contain NaNs (interpolated).
pub fn detect_changepoints(
    y: &[f64],
    opts: &ChangepointOptions,
) -> Result<ChangepointResult, IsoclineError> {
    let yy = crate::preprocess::interpolate_linear(y)?;
    let n = yy.len();
    if n < 3 {
        return Err(IsoclineError::TooShort { n, need: 3 });
    }
    let min_seg = opts.min_segment.max(1);
    let threshold = if opts.threshold.is_finite() && opts.threshold > 0.0 {
        opts.threshold
    } else {
        3.0
    };

    // Robust sigma from first differences. Strict MAD here: MAD(diff) == 0
    // (e.g. constant or piecewise-constant data) -> no changepoints per spec.
    let mut diffs = vec![0.0; n.saturating_sub(1)];
    for i in 1..n {
        diffs[i - 1] = yy[i] - yy[i - 1];
    }
    let mad = math::mad(&diffs);
    if !mad.is_finite() || mad <= 0.0 {
        let mu = math::mean(&yy);
        return Ok(ChangepointResult {
            changepoints: Vec::new(),
            means: vec![mu; n],
        });
    }
    let sigma = (1.4826 * mad / 2.0f64.sqrt()).max(1e-9);

    // Binary segmentation (depth-first via explicit stack).
    let mut changepoints: Vec<Changepoint> = Vec::new();
    let mut stack: Vec<(usize, usize)> = vec![(0, n)];
    while let Some((a, b)) = stack.pop() {
        if changepoints.len() >= opts.max_changepoints {
            break;
        }
        let seg_len = b - a;
        if seg_len < 2 * min_seg {
            continue;
        }
        let n_seg = seg_len as f64;
        let total: f64 = yy[a..b].iter().sum();
        // Scan split positions s in [a + min_seg, b - min_seg).
        let mut best_g = threshold;
        let mut best_s: Option<usize> = None;
        let mut best_means = (0.0, 0.0);
        let mut left_sum: f64 = 0.0;
        for s in a..b {
            // After processing index s-1, left_sum = sum(y[a..s]).
            if s > a {
                left_sum += yy[s - 1];
            }
            let n1 = (s - a) as f64;
            if s < a + min_seg {
                continue;
            }
            if s > b - min_seg {
                break;
            }
            let n2 = n_seg - n1;
            let m1 = left_sum / n1;
            let m2 = (total - left_sum) / n2;
            let g = (n1 * n2 / n_seg).sqrt() * (m1 - m2).abs() / sigma;
            if g > best_g {
                best_g = g;
                best_s = Some(s);
                best_means = (m1, m2);
            }
        }
        if let Some(s) = best_s {
            changepoints.push(Changepoint {
                index: s,
                mean_before: best_means.0,
                mean_after: best_means.1,
            });
            stack.push((a, s));
            stack.push((s, b));
        }
    }

    changepoints.sort_by_key(|c| c.index);

    // Step-function means.
    let mut means = vec![0.0; n];
    let mut bounds: Vec<usize> = vec![0];
    bounds.extend(changepoints.iter().map(|c| c.index));
    bounds.push(n);
    for w in bounds.windows(2) {
        let (a, b) = (w[0], w[1]);
        if b <= a {
            continue;
        }
        let mu = math::mean(&yy[a..b]);
        for v in means[a..b].iter_mut() {
            *v = mu;
        }
    }

    Ok(ChangepointResult {
        changepoints,
        means,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::Rng;

    #[test]
    fn finds_injected_shift() {
        let mut rng = Rng::new(42);
        let mut y: Vec<f64> = (0..400).map(|_| rng.normal()).collect();
        for v in y[200..].iter_mut() {
            *v += 5.0;
        }
        let r = detect_changepoints(&y, &ChangepointOptions::default()).unwrap();
        assert!(
            r.changepoints.iter().any(|c| (c.index as i64 - 200).abs() <= 3),
            "changepoints at {:?}",
            r.changepoints.iter().map(|c| c.index).collect::<Vec<_>>()
        );
        assert_eq!(r.means.len(), 400);
    }

    #[test]
    fn pure_noise_mostly_clean() {
        let mut rng = Rng::new(1);
        let y: Vec<f64> = (0..300).map(|_| rng.normal()).collect();
        let r = detect_changepoints(&y, &ChangepointOptions::default()).unwrap();
        // Threshold 3 keeps spurious splits rare.
        assert!(r.changepoints.len() <= 2, "too many: {}", r.changepoints.len());
    }

    #[test]
    fn constant_series_no_changepoints() {
        let r = detect_changepoints(&[4.0; 100], &ChangepointOptions::default()).unwrap();
        assert!(r.changepoints.is_empty());
        assert!(r.means.iter().all(|&m| (m - 4.0).abs() < 1e-12));
    }

    #[test]
    fn piecewise_constant_handled() {
        // MAD of diffs is 0 here -> no changepoints, no panic.
        let mut y = vec![1.0; 50];
        y.extend(vec![9.0; 50]);
        let r = detect_changepoints(&y, &ChangepointOptions::default()).unwrap();
        assert!(r.changepoints.is_empty());
        assert!(r.means.iter().all(|&m| (m - 5.0).abs() < 1e-12));
    }

    #[test]
    fn respects_min_segment() {
        let mut rng = Rng::new(2);
        let mut y: Vec<f64> = (0..300).map(|_| rng.normal()).collect();
        for v in y[120..140].iter_mut() {
            *v += 10.0; // too-short bump, min_segment 10 allows exactly this
        }
        // No panic; segments smaller than 2*min_segment are not split.
        let _ = detect_changepoints(&y, &ChangepointOptions::default()).unwrap();
    }
}
