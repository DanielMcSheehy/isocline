//! Input preprocessing: linear interpolation of NaN holes.

use crate::error::IsoclineError;

/// Fill NaN values by linear interpolation between the nearest valid
/// neighbors. Leading (trailing) NaNs are filled with the first (last) valid
/// value. Returns `BadParams` when every value is NaN (or input is empty).
pub fn interpolate_linear(y: &[f64]) -> Result<Vec<f64>, IsoclineError> {
    let n = y.len();
    if n == 0 {
        return Err(IsoclineError::BadParams("empty series".into()));
    }
    let mut out = y.to_vec();
    // Index of last valid value seen.
    let mut last_valid: Option<usize> = None;
    let mut i = 0;
    while i < n {
        if out[i].is_finite() {
            last_valid = Some(i);
            i += 1;
            continue;
        }
        // Start of a NaN (or non-finite) run.
        let start = i;
        while i < n && !out[i].is_finite() {
            i += 1;
        }
        // `start..i` are NaN.
        match last_valid {
            None => {
                // Leading run: fill with the first valid value after it.
                if i >= n {
                    return Err(IsoclineError::BadParams(
                        "series contains only NaN values".into(),
                    ));
                }
                let v = out[i];
                for slot in out[..i].iter_mut() {
                    *slot = v;
                }
            }
            Some(prev) => {
                if i >= n {
                    // Trailing run: fill with the last valid value.
                    let v = out[prev];
                    for slot in out[start..].iter_mut() {
                        *slot = v;
                    }
                } else {
                    // Interior run: linear interpolation between neighbors.
                    let left = out[prev];
                    let right = out[i];
                    let span = (i - prev) as f64;
                    for (k, idx) in (start..i).enumerate() {
                        let t = (k + 1) as f64 / span;
                        out[idx] = left + t * (right - left);
                    }
                }
            }
        }
        last_valid = Some(i);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fills_interior_holes() {
        let y = [1.0, f64::NAN, f64::NAN, 4.0];
        let out = interpolate_linear(&y).unwrap();
        assert_eq!(out, vec![1.0, 2.0, 3.0, 4.0]);
    }

    #[test]
    fn fills_leading_and_trailing() {
        let y = [f64::NAN, f64::NAN, 3.0, f64::NAN];
        let out = interpolate_linear(&y).unwrap();
        assert_eq!(out, vec![3.0, 3.0, 3.0, 3.0]);
    }

    #[test]
    fn all_nan_is_bad_params() {
        assert!(interpolate_linear(&[f64::NAN; 3]).is_err());
        assert!(interpolate_linear(&[]).is_err());
    }

    #[test]
    fn clean_series_unchanged() {
        let y = [1.0, 2.5, -3.0];
        let out = interpolate_linear(&y).unwrap();
        assert_eq!(out, vec![1.0, 2.5, -3.0]);
    }
}
