//! Non-temporal (tabular) detectors over generic columns (CONTRACT §11):
//!
//! * [`correlation`] — Pearson r between two equal-length columns, with a
//!   t-statistic significance test and the OLS line of `b` on `a`.
//! * [`majority`] — dominant-label counts and proportions.
//! * [`category_outlier`] — per-category aggregates flagged against type-7
//!   quartile fences (Ava-style non-temporal IQR outliers).
//! * [`low_variance`] — flat-series detection via coefficient of variation.
//!
//! All functions are deterministic, `std`-only, and never panic on any input.
//! Unlike the temporal ops, tabular inputs are raw columns: no NaN
//! interpolation is performed; non-finite inputs are rejected with
//! [`IsoclineError::BadParams`].
//!
//! # Example
//!
//! ```
//! use isocline_core::*;
//!
//! let a: Vec<f64> = (1..=5).map(|i| i as f64).collect();
//! let b: Vec<f64> = a.iter().map(|&x| 2.0 * x + 1.0).collect();
//! let r = correlation(&a, &b).unwrap();
//! assert!((r.r.unwrap() - 1.0).abs() < 1e-12);
//! assert!(r.significant);
//! assert!((r.slope - 2.0).abs() < 1e-12);
//! assert!((r.intercept - 1.0).abs() < 1e-12);
//! ```

use crate::error::IsoclineError;
use crate::math::{mean, quantile_sorted};

// ---------------------------------------------------------------------------
// correlation
// ---------------------------------------------------------------------------

/// Result of [`correlation`].
#[derive(Debug, Clone, PartialEq)]
pub struct CorrelationResult {
    /// Number of paired observations.
    pub n: usize,
    /// Pearson correlation coefficient; `None` when either input has zero
    /// variance.
    pub r: Option<f64>,
    /// t-statistic `t = r*sqrt((n-2)/(1-r^2))`; `None` when `r` is `None`.
    pub t_stat: Option<f64>,
    /// `|t| > 2.0` (normal approximation). Always `false` when `t_stat` is
    /// `None`.
    pub significant: bool,
    /// OLS slope of `b` on `a` (0 when `a` has zero variance).
    pub slope: f64,
    /// OLS intercept of `b` on `a` (mean of `b` when `a` has zero variance).
    pub intercept: f64,
}

/// Pearson correlation of two equal-length columns plus the OLS line of `b`
/// on `a`.
///
/// Requires `n >= 3` (else [`IsoclineError::TooShort`]), equal lengths and
/// all-finite values (else [`IsoclineError::BadParams`]). When either column
/// has zero variance, `r`/`t_stat` are `None` and `significant` is `false`,
/// but `slope` (0) and `intercept` (mean of `b`) are still reported. The
/// computation is two-pass (centered sums), so it is numerically stable.
pub fn correlation(a: &[f64], b: &[f64]) -> Result<CorrelationResult, IsoclineError> {
    if a.len() < 3 {
        return Err(IsoclineError::TooShort {
            n: a.len(),
            need: 3,
        });
    }
    if a.len() != b.len() {
        return Err(IsoclineError::BadParams(format!(
            "correlation: length mismatch (a: {}, b: {})",
            a.len(),
            b.len()
        )));
    }
    if a.iter().any(|v| !v.is_finite()) || b.iter().any(|v| !v.is_finite()) {
        return Err(IsoclineError::BadParams(
            "correlation: inputs must be finite (no NaN/Inf)".into(),
        ));
    }
    let n = a.len();
    let ma = mean(a);
    let mb = mean(b);
    let mut sxx = 0.0;
    let mut syy = 0.0;
    let mut sxy = 0.0;
    for i in 0..n {
        let da = a[i] - ma;
        let db = b[i] - mb;
        sxx += da * da;
        syy += db * db;
        sxy += da * db;
    }
    // Relative zero-variance guards: centered sums of squares are compared
    // against the total sums of squares so scale (e.g. values ~1e6) does not
    // defeat the test through floating-point noise.
    let sa2: f64 = a.iter().map(|&v| v * v).sum();
    let sb2: f64 = b.iter().map(|&v| v * v).sum();
    let zero_var_a = sxx == 0.0 || sxx <= 1e-12 * sa2;
    let zero_var_b = syy == 0.0 || syy <= 1e-12 * sb2;

    if zero_var_a || zero_var_b {
        return Ok(CorrelationResult {
            n,
            r: None,
            t_stat: None,
            significant: false,
            slope: 0.0,
            intercept: mb,
        });
    }

    let r = (sxy / (sxx.sqrt() * syy.sqrt())).clamp(-1.0, 1.0);
    // Guard the (1 - r^2) denominator; r is clamped so this stays finite.
    let denom = (1.0 - r * r).max(1e-15);
    let t = r * ((n - 2) as f64 / denom).sqrt();
    let slope = sxy / sxx;
    let intercept = mb - slope * ma;
    Ok(CorrelationResult {
        n,
        r: Some(r),
        t_stat: Some(t),
        significant: t.abs() > 2.0,
        slope,
        intercept,
    })
}

// ---------------------------------------------------------------------------
// majority
// ---------------------------------------------------------------------------

/// One label's tally inside [`MajorityResult`].
#[derive(Debug, Clone, PartialEq)]
pub struct MajorityCount {
    /// The category label.
    pub label: String,
    /// Number of occurrences.
    pub count: usize,
    /// `count / n`.
    pub proportion: f64,
}

/// Result of [`majority`].
#[derive(Debug, Clone, PartialEq)]
pub struct MajorityResult {
    /// Total number of labels.
    pub n: usize,
    /// Effective (clamped) threshold in `(0, 1]`.
    pub threshold: f64,
    /// Most frequent label (`None` when the input is empty). Ties are broken
    /// by ascending label.
    pub dominant: Option<String>,
    /// Proportion of the dominant label (0 when the input is empty).
    pub dominant_proportion: f64,
    /// `dominant_proportion >= threshold`.
    pub is_majority: bool,
    /// Per-label counts sorted by count descending, ties by label ascending.
    pub counts: Vec<MajorityCount>,
}

/// Clamp a proportion-like parameter into the valid `(0, 1]` range.
///
/// Non-finite, zero, or negative values are clamped to the strictest valid
/// value `1.0`; values in `(0, 1]` pass through; values above 1 are clamped
/// to 1.
fn clamp_unit(x: f64) -> f64 {
    if !x.is_finite() || x <= 0.0 {
        1.0
    } else {
        x.min(1.0)
    }
}

/// Dominant-label analysis of a categorical column.
///
/// `threshold` is clamped into `(0, 1]`: non-finite, zero, or negative values
/// become `1.0` (the strictest threshold), and values above 1 become `1.0`.
/// The reported [`MajorityResult::threshold`] is the clamped value. Empty
/// input yields `n == 0`, `dominant == None`, and `is_majority == false`.
pub fn majority(labels: &[String], threshold: f64) -> MajorityResult {
    let threshold = clamp_unit(threshold);
    let n = labels.len();
    if n == 0 {
        return MajorityResult {
            n,
            threshold,
            dominant: None,
            dominant_proportion: 0.0,
            is_majority: false,
            counts: Vec::new(),
        };
    }
    let mut tally: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for l in labels {
        *tally.entry(l.as_str()).or_insert(0) += 1;
    }
    let mut counts: Vec<MajorityCount> = tally
        .into_iter()
        .map(|(label, count)| MajorityCount {
            label: label.to_string(),
            count,
            proportion: count as f64 / n as f64,
        })
        .collect();
    // Count descending, ties by label ascending (deterministic).
    counts.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.label.cmp(&b.label)));
    let dominant_proportion = counts[0].proportion;
    MajorityResult {
        n,
        threshold,
        dominant: Some(counts[0].label.clone()),
        dominant_proportion,
        is_majority: dominant_proportion >= threshold,
        counts,
    }
}

// ---------------------------------------------------------------------------
// category_outlier
// ---------------------------------------------------------------------------

/// Aggregation applied per category before outlier detection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CategoryAgg {
    /// Sum of the category's values.
    Sum,
    /// Mean of the category's values.
    Mean,
    /// Number of values in the category.
    Count,
    /// Median (type-7 quantile at 0.5) of the category's values.
    Median,
}

/// Direction of an outlier relative to the IQR fences.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CategoryDirection {
    /// Above the upper fence.
    High,
    /// Below the lower fence.
    Low,
}

/// One category's aggregate and outlier verdict inside
/// [`CategoryOutlierResult`].
#[derive(Debug, Clone, PartialEq)]
pub struct CategoryPoint {
    /// The category label.
    pub label: String,
    /// Aggregated value (per `agg`).
    pub value: f64,
    /// Whether the value lies outside the fences.
    pub is_outlier: bool,
    /// Which fence was crossed (meaningful only when `is_outlier`).
    pub direction: CategoryDirection,
}

/// Result of [`category_outlier`].
#[derive(Debug, Clone, PartialEq)]
pub struct CategoryOutlierResult {
    /// Aggregation used.
    pub agg: CategoryAgg,
    /// Effective (clamped) fence factor.
    pub factor: f64,
    /// Type-7 first quartile of the per-category aggregates.
    pub q1: f64,
    /// Type-7 third quartile of the per-category aggregates.
    pub q3: f64,
    /// `q3 - q1`.
    pub iqr: f64,
    /// `q1 - factor * iqr`.
    pub lower_fence: f64,
    /// `q3 + factor * iqr`.
    pub upper_fence: f64,
    /// Number of categories outside the fences.
    pub outlier_count: usize,
    /// Per-category points sorted by value descending (ties by label
    /// ascending).
    pub categories: Vec<CategoryPoint>,
}

/// Ava-style non-temporal IQR outliers over per-category aggregates.
///
/// `labels` and `values` must have equal lengths (else
/// [`IsoclineError::BadParams`]); values must be finite. At least 4 distinct
/// categories are required (else [`IsoclineError::TooShort`]). Each category's
/// values are aggregated per `agg`, quartiles are computed with type-7 linear
/// interpolation across the per-category aggregate values, and a category is
/// flagged when its aggregate lies outside `q1 - factor*iqr` or
/// `q3 + factor*iqr`.
///
/// `factor` is clamped into `[0.1, 1e6]`: non-finite or values below 0.1
/// become 0.1, and infinite values become 1e6 (so fences stay finite). The
/// reported [`CategoryOutlierResult::factor`] is the clamped value.
pub fn category_outlier(
    labels: &[String],
    values: &[f64],
    agg: CategoryAgg,
    factor: f64,
) -> Result<CategoryOutlierResult, IsoclineError> {
    if labels.len() != values.len() {
        return Err(IsoclineError::BadParams(format!(
            "category_outlier: length mismatch (labels: {}, values: {})",
            labels.len(),
            values.len()
        )));
    }
    if values.iter().any(|v| !v.is_finite()) {
        return Err(IsoclineError::BadParams(
            "category_outlier: values must be finite (no NaN/Inf)".into(),
        ));
    }
    // Clamp the factor into a sane, finite range; report the clamped value.
    let factor = if !factor.is_finite() || factor < 0.1 {
        0.1
    } else {
        factor.min(1e6)
    };

    // Deterministic grouping (BTreeMap keeps labels in a fixed order).
    let mut groups: std::collections::BTreeMap<&str, Vec<f64>> = std::collections::BTreeMap::new();
    for (l, v) in labels.iter().zip(values.iter()) {
        groups.entry(l.as_str()).or_default().push(*v);
    }
    if groups.len() < 4 {
        return Err(IsoclineError::TooShort {
            n: groups.len(),
            need: 4,
        });
    }

    let mut aggs: Vec<(String, f64)> = groups
        .into_iter()
        .map(|(label, vals)| {
            let value = match agg {
                CategoryAgg::Sum => vals.iter().sum(),
                CategoryAgg::Mean => {
                    let s: f64 = vals.iter().sum();
                    s / vals.len() as f64
                }
                CategoryAgg::Count => vals.len() as f64,
                CategoryAgg::Median => {
                    let mut s = vals;
                    s.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
                    quantile_sorted(&s, 0.5)
                }
            };
            (label.to_string(), value)
        })
        .collect();

    // Type-7 quartiles over the aggregate values.
    let mut sorted: Vec<f64> = aggs.iter().map(|(_, v)| *v).collect();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let q1 = quantile_sorted(&sorted, 0.25);
    let q3 = quantile_sorted(&sorted, 0.75);
    let iqr = q3 - q1;
    let lower_fence = q1 - factor * iqr;
    let upper_fence = q3 + factor * iqr;

    // Sort by value descending, ties by label ascending (deterministic).
    aggs.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.0.cmp(&b.0))
    });

    let mut outlier_count = 0usize;
    let categories = aggs
        .into_iter()
        .map(|(label, value)| {
            let (is_outlier, direction) = if value > upper_fence {
                (true, CategoryDirection::High)
            } else if value < lower_fence {
                (true, CategoryDirection::Low)
            } else {
                (false, CategoryDirection::High)
            };
            if is_outlier {
                outlier_count += 1;
            }
            CategoryPoint {
                label,
                value,
                is_outlier,
                direction,
            }
        })
        .collect();

    Ok(CategoryOutlierResult {
        agg,
        factor,
        q1,
        q3,
        iqr,
        lower_fence,
        upper_fence,
        outlier_count,
        categories,
    })
}

// ---------------------------------------------------------------------------
// low_variance
// ---------------------------------------------------------------------------

/// Result of [`low_variance`].
#[derive(Debug, Clone, PartialEq)]
pub struct LowVarianceResult {
    /// Number of values.
    pub n: usize,
    /// Arithmetic mean.
    pub mean: f64,
    /// Population variance (divisor `n`).
    pub variance: f64,
    /// Population standard deviation.
    pub std_dev: f64,
    /// Coefficient of variation `std_dev / |mean|`. When `|mean| < 1e-12`
    /// this falls back to `std_dev` itself (CV is undefined for a zero mean).
    pub cv: f64,
    /// Effective (clamped) `max_cv` threshold in `(0, 1]`.
    pub max_cv: f64,
    /// Flatness verdict: `cv <= max_cv`, or `std_dev < 1e-9` when the mean is
    /// ~0 (see [`LowVarianceResult::cv`]).
    pub is_flat: bool,
}

/// Flat-series (low-variance) detection via the coefficient of variation.
///
/// Requires `n >= 2` (else [`IsoclineError::TooShort`]) and finite values
/// (else [`IsoclineError::BadParams`]). `max_cv` is clamped into `(0, 1]`
/// with the same rule as [`majority`]'s threshold; the clamped value is
/// reported. When the mean is ~zero (`|mean| < 1e-12`) the CV is replaced by
/// the absolute standard deviation and flatness becomes `std_dev < 1e-9`.
pub fn low_variance(values: &[f64], max_cv: f64) -> Result<LowVarianceResult, IsoclineError> {
    if values.len() < 2 {
        return Err(IsoclineError::TooShort {
            n: values.len(),
            need: 2,
        });
    }
    if values.iter().any(|v| !v.is_finite()) {
        return Err(IsoclineError::BadParams(
            "low_variance: values must be finite (no NaN/Inf)".into(),
        ));
    }
    let max_cv = clamp_unit(max_cv);
    let n = values.len();
    let m = mean(values);
    let var = values.iter().map(|&v| (v - m) * (v - m)).sum::<f64>() / n as f64;
    let sd = var.sqrt();
    let (cv, is_flat) = if m.abs() < 1e-12 {
        // CV is undefined at a zero mean: fall back to an absolute check.
        (sd, sd < 1e-9)
    } else {
        let cv = sd / m.abs();
        (cv, cv <= max_cv)
    };
    Ok(LowVarianceResult {
        n,
        mean: m,
        variance: var,
        std_dev: sd,
        cv,
        max_cv,
        is_flat,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::Rng;

    fn labels(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    // -- correlation --------------------------------------------------------

    #[test]
    fn correlation_perfect_linear() {
        let a: Vec<f64> = (1..=5).map(|i| i as f64).collect();
        let b: Vec<f64> = a.iter().map(|&x| 2.0 * x + 1.0).collect();
        let r = correlation(&a, &b).unwrap();
        assert_eq!(r.n, 5);
        assert!((r.r.unwrap() - 1.0).abs() < 1e-12);
        assert!(r.significant);
        assert!((r.slope - 2.0).abs() < 1e-12);
        assert!((r.intercept - 1.0).abs() < 1e-12);
        // Hand-computed t for r=1 uses the denominator guard; just check the
        // magnitude is large.
        assert!(r.t_stat.unwrap() > 100.0);
    }

    #[test]
    fn correlation_anticorrelated() {
        let a: Vec<f64> = (0..10).map(|i| i as f64).collect();
        let b: Vec<f64> = a.iter().map(|&x| -3.0 * x + 7.0).collect();
        let r = correlation(&a, &b).unwrap();
        assert!((r.r.unwrap() + 1.0).abs() < 1e-12);
        assert!(r.significant);
        assert!((r.slope + 3.0).abs() < 1e-12);
        assert!((r.intercept - 7.0).abs() < 1e-12);
    }

    #[test]
    fn correlation_independent_noise_is_weak() {
        let mut rng = Rng::new(1234);
        let a: Vec<f64> = (0..200).map(|_| rng.normal()).collect();
        let b: Vec<f64> = (0..200).map(|_| rng.normal()).collect();
        let r = correlation(&a, &b).unwrap();
        let rv = r.r.unwrap();
        assert!(rv.abs() < 0.3, "r = {rv}");
        assert!(!r.significant, "t = {}", r.t_stat.unwrap());
    }

    #[test]
    fn correlation_known_dataset_hand_computed() {
        // x = [1,2,3,4], y = [2,4,5,4] (classic textbook example):
        // mean_x = 2.5, mean_y = 3.75, sxy = 3.5, sxx = 5, syy = 4.75
        // r = 3.5 / sqrt(5 * 4.75) = 0.718185...
        let a = vec![1.0, 2.0, 3.0, 4.0];
        let b = vec![2.0, 4.0, 5.0, 4.0];
        let r = correlation(&a, &b).unwrap();
        let expected = 3.5 / (5.0f64 * 4.75).sqrt();
        assert!((r.r.unwrap() - expected).abs() < 1e-12);
        let t = expected * (2.0f64 / (1.0 - expected * expected)).sqrt();
        assert!((r.t_stat.unwrap() - t).abs() < 1e-12);
        assert!((r.slope - 0.7).abs() < 1e-12);
        assert!((r.intercept - 2.0).abs() < 1e-12);
    }

    #[test]
    fn correlation_zero_variance_inputs() {
        let a = vec![5.0; 6];
        let b = vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0];
        let r = correlation(&a, &b).unwrap();
        assert_eq!(r.r, None);
        assert_eq!(r.t_stat, None);
        assert!(!r.significant);
        assert_eq!(r.slope, 0.0);
        assert_eq!(r.intercept, 3.5); // mean of b
        // And the mirror case: constant b.
        let r2 = correlation(&b, &a).unwrap();
        assert_eq!(r2.r, None);
        assert_eq!(r2.slope, 0.0);
        assert_eq!(r2.intercept, 5.0);
    }

    #[test]
    fn correlation_error_paths() {
        assert!(matches!(
            correlation(&[1.0, 2.0], &[1.0, 2.0]),
            Err(IsoclineError::TooShort { n: 2, need: 3 })
        ));
        let a = vec![1.0, 2.0, 3.0];
        let b = vec![1.0, 2.0];
        assert!(matches!(
            correlation(&a, &b),
            Err(IsoclineError::BadParams(_))
        ));
        let nan = vec![1.0, f64::NAN, 3.0];
        assert!(matches!(
            correlation(&nan, &a),
            Err(IsoclineError::BadParams(_))
        ));
        assert!(matches!(
            correlation(&a, &nan),
            Err(IsoclineError::BadParams(_))
        ));
    }

    // -- majority -----------------------------------------------------------

    #[test]
    fn majority_basic_split() {
        let mut ls = vec!["a"; 7];
        ls.extend(vec!["b"; 3]);
        let ls = labels(&ls);
        let m = majority(&ls, 0.5);
        assert_eq!(m.n, 10);
        assert_eq!(m.dominant.as_deref(), Some("a"));
        assert!((m.dominant_proportion - 0.7).abs() < 1e-12);
        assert!(m.is_majority);
        assert_eq!(m.counts.len(), 2);
        assert_eq!(m.counts[0].label, "a");
        assert_eq!(m.counts[0].count, 7);
        assert_eq!(m.counts[1].label, "b");
        assert_eq!(m.counts[1].count, 3);
    }

    #[test]
    fn majority_threshold_boundaries() {
        let mut ls = vec!["a"; 7];
        ls.extend(vec!["b"; 3]);
        let ls = labels(&ls);
        // 0.7 >= 0.7 -> true
        assert!(majority(&ls, 0.7).is_majority);
        // 0.7 < 0.7 + eps -> false just above the boundary
        assert!(!majority(&ls, 0.71).is_majority);
        // Clamped above 1 -> still valid, false for a 70% share.
        let m = majority(&ls, 5.0);
        assert_eq!(m.threshold, 1.0);
        assert!(!m.is_majority);
        // Non-finite / non-positive thresholds clamp to 1.0.
        assert_eq!(majority(&ls, f64::NAN).threshold, 1.0);
        assert_eq!(majority(&ls, 0.0).threshold, 1.0);
        assert_eq!(majority(&ls, -1.0).threshold, 1.0);
        // With threshold 1.0 the 100%-a case is still a majority.
        let all_a = labels(&["a"; 4]);
        assert!(majority(&all_a, 1.0).is_majority);
    }

    #[test]
    fn majority_ties_broken_by_label() {
        let ls = labels(&["y", "x", "y", "x", "y", "x", "x", "y", "x", "y"]);
        let m = majority(&ls, 0.5);
        assert_eq!(m.dominant.as_deref(), Some("x"));
        assert_eq!(m.counts[0].label, "x");
        assert_eq!(m.counts[1].label, "y");
        assert_eq!(m.counts[0].count, 5);
    }

    #[test]
    fn majority_empty_input() {
        let m = majority(&[], 0.5);
        assert_eq!(m.n, 0);
        assert_eq!(m.dominant, None);
        assert_eq!(m.dominant_proportion, 0.0);
        assert!(!m.is_majority);
        assert!(m.counts.is_empty());
    }

    // -- category_outlier ---------------------------------------------------

    /// 12 categories of 4 values each ~N(100, 5); one category is injected
    /// with a different constant value.
    fn twelve_categories(injected: f64) -> (Vec<String>, Vec<f64>, String) {
        let mut rng = Rng::new(99);
        let mut ls = Vec::new();
        let mut vs = Vec::new();
        let injected_label = "c11".to_string();
        for c in 0..12 {
            let label = format!("c{c:02}");
            for _ in 0..4 {
                ls.push(label.clone());
                if label == injected_label {
                    vs.push(injected);
                } else {
                    vs.push(100.0 + 5.0 * rng.normal());
                }
            }
        }
        (ls, vs, injected_label)
    }

    #[test]
    fn category_outlier_sum_flags_high() {
        let (ls, vs, injected) = twelve_categories(400.0);
        let r = category_outlier(&ls, &vs, CategoryAgg::Sum, 1.5).unwrap();
        assert_eq!(r.agg, CategoryAgg::Sum);
        assert_eq!(r.factor, 1.5);
        assert_eq!(r.outlier_count, 1, "aggregates: {:?}", r.categories);
        assert!(r.q1 < r.q3);
        assert!((r.iqr - (r.q3 - r.q1)).abs() < 1e-12);
        assert!((r.lower_fence - (r.q1 - 1.5 * r.iqr)).abs() < 1e-12);
        assert!((r.upper_fence - (r.q3 + 1.5 * r.iqr)).abs() < 1e-12);
        // Sorted by value descending.
        for w in r.categories.windows(2) {
            assert!(w[0].value >= w[1].value);
        }
        let top = &r.categories[0];
        assert_eq!(top.label, injected);
        assert!(top.is_outlier);
        assert_eq!(top.direction, CategoryDirection::High);
        assert!((top.value - 1600.0).abs() < 1e-9);
        // Everyone else is a non-outlier near 400.
        assert!(r.categories[1..].iter().all(|c| !c.is_outlier));
    }

    #[test]
    fn category_outlier_low_direction() {
        let (ls, vs, injected) = twelve_categories(-300.0);
        let r = category_outlier(&ls, &vs, CategoryAgg::Sum, 1.5).unwrap();
        assert_eq!(r.outlier_count, 1);
        let last = r.categories.last().unwrap();
        assert_eq!(last.label, injected);
        assert!(last.is_outlier);
        assert_eq!(last.direction, CategoryDirection::Low);
    }

    #[test]
    fn category_outlier_median_agg() {
        let (ls, vs, injected) = twelve_categories(400.0);
        let r = category_outlier(&ls, &vs, CategoryAgg::Median, 1.5).unwrap();
        assert_eq!(r.agg, CategoryAgg::Median);
        assert_eq!(r.outlier_count, 1);
        let top = r
            .categories
            .iter()
            .find(|c| c.label == injected)
            .unwrap();
        assert!(top.is_outlier);
        assert!((top.value - 400.0).abs() < 1e-9);
        assert!((r.categories.last().unwrap().value - 100.0).abs() < 30.0);
    }

    #[test]
    fn category_outlier_mean_and_count_agg() {
        let (ls, vs, injected) = twelve_categories(400.0);
        let m = category_outlier(&ls, &vs, CategoryAgg::Mean, 1.5).unwrap();
        assert_eq!(m.outlier_count, 1);
        let top = m.categories.iter().find(|c| c.label == injected).unwrap();
        assert!((top.value - 400.0).abs() < 1e-9);
        // Count agg: every category has exactly 4 values -> no outliers.
        let c = category_outlier(&ls, &vs, CategoryAgg::Count, 1.5).unwrap();
        assert_eq!(c.outlier_count, 0);
        assert!(c.categories.iter().all(|p| (p.value - 4.0).abs() < 1e-12));
        // Constant aggregates: iqr = 0, fences equal the value, none flagged.
        let c2 = category_outlier(&ls, &vs, CategoryAgg::Count, 3.0).unwrap();
        assert_eq!(c2.iqr, 0.0);
        assert_eq!(c2.outlier_count, 0);
    }

    #[test]
    fn category_outlier_error_paths() {
        // Fewer than 4 distinct categories.
        let ls = labels(&["a", "a", "b", "b", "c", "c"]);
        let vs = vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0];
        assert!(matches!(
            category_outlier(&ls, &vs, CategoryAgg::Sum, 1.5),
            Err(IsoclineError::TooShort { n: 3, need: 4 })
        ));
        // Length mismatch.
        let ls4 = labels(&["a", "b", "c", "d"]);
        assert!(matches!(
            category_outlier(&ls4, &[1.0, 2.0], CategoryAgg::Sum, 1.5),
            Err(IsoclineError::BadParams(_))
        ));
        // Non-finite values.
        let vs4 = vec![1.0, f64::NAN, 3.0, 4.0];
        assert!(matches!(
            category_outlier(&ls4, &vs4, CategoryAgg::Sum, 1.5),
            Err(IsoclineError::BadParams(_))
        ));
        // Factor clamping: reported factor is the clamped one.
        let ls8 = labels(&["a", "a", "b", "b", "c", "c", "d", "d"]);
        let vs_ok = vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0];
        let r = category_outlier(&ls8, &vs_ok, CategoryAgg::Sum, -2.0).unwrap();
        assert_eq!(r.factor, 0.1);
        let r2 = category_outlier(&ls8, &vs_ok, CategoryAgg::Sum, f64::NAN).unwrap();
        assert_eq!(r2.factor, 0.1);
    }

    // -- low_variance -------------------------------------------------------

    #[test]
    fn low_variance_constant_series() {
        let r = low_variance(&[7.5; 50], 0.01).unwrap();
        assert_eq!(r.n, 50);
        assert!((r.mean - 7.5).abs() < 1e-12);
        assert_eq!(r.variance, 0.0);
        assert_eq!(r.std_dev, 0.0);
        assert_eq!(r.cv, 0.0);
        assert!(r.is_flat);
    }

    #[test]
    fn low_variance_scaled_constant_is_flat() {
        let vs: Vec<f64> = (0..40).map(|i| 1e6 + (i % 2) as f64).collect();
        let r = low_variance(&vs, 0.01).unwrap();
        // sd of {1e6, 1e6+1} alternating = 0.5, cv ~ 5e-7 << 0.01.
        assert!((r.std_dev - 0.5).abs() < 1e-6);
        assert!(r.cv < 0.01);
        assert!(r.is_flat);
    }

    #[test]
    fn low_variance_noisy_series_not_flat() {
        let mut rng = Rng::new(7);
        let vs: Vec<f64> = (0..200).map(|_| 100.0 + 50.0 * rng.normal()).collect();
        let r = low_variance(&vs, 0.01).unwrap();
        // cv ~ 0.5 for sd 50 around mean 100.
        assert!((r.cv - 0.5).abs() < 0.1, "cv = {}", r.cv);
        assert!(!r.is_flat);
        // With a loose threshold the same series counts as flat.
        assert!(low_variance(&vs, 1.0).unwrap().is_flat);
    }

    #[test]
    fn low_variance_near_zero_mean() {
        // Exactly zero mean: CV falls back to std_dev.
        let r = low_variance(&[-1.0, 1.0, -1.0, 1.0], 0.01).unwrap();
        assert_eq!(r.mean, 0.0);
        assert!((r.cv - 1.0).abs() < 1e-12);
        assert!(!r.is_flat); // sd = 1 >= 1e-9
        // Constant zeros: flat under the absolute check.
        let r2 = low_variance(&[0.0; 10], 0.01).unwrap();
        assert_eq!(r2.cv, 0.0);
        assert!(r2.is_flat);
        // Tiny noise around zero stays non-flat (absolute branch).
        let r3 = low_variance(&[1e-6, -1e-6, 1e-6, -1e-6], 0.01).unwrap();
        assert!(r3.mean.abs() < 1e-12);
        assert!((r3.cv - r3.std_dev).abs() < 1e-18);
        assert!(!r3.is_flat);
        assert!(r3.cv.is_finite());
    }

    #[test]
    fn low_variance_error_paths() {
        assert!(matches!(
            low_variance(&[1.0], 0.01),
            Err(IsoclineError::TooShort { n: 1, need: 2 })
        ));
        assert!(matches!(
            low_variance(&[1.0, f64::NAN], 0.01),
            Err(IsoclineError::BadParams(_))
        ));
        assert!(matches!(
            low_variance(&[f64::INFINITY, 1.0], 0.01),
            Err(IsoclineError::BadParams(_))
        ));
        // max_cv clamping is reported.
        let r = low_variance(&[1.0, 2.0], f64::NAN).unwrap();
        assert_eq!(r.max_cv, 1.0);
        let r2 = low_variance(&[1.0, 2.0], 0.0).unwrap();
        assert_eq!(r2.max_cv, 1.0);
        let r3 = low_variance(&[1.0, 2.0], 42.0).unwrap();
        assert_eq!(r3.max_cv, 1.0);
    }
}
