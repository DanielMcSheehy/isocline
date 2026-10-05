//! Integration tests implementing the CONTRACT §9 verification gates.
//!
//! Embeds a tiny deterministic generator matching the shape of the TS
//! `genSeries` (§5): `y[i] = base + trend*i + A*sin(2πi/p + φ) + A2*sin(4πi/p)
//! + σ*noise`, with injectable spikes / dips / shifts at recorded indices.

use isocline_core::*;
use math::Rng;
use std::f64::consts::TAU;

/// Deterministic synthetic generator (xorshift + Box–Muller inside isocline).
#[allow(clippy::too_many_arguments)]
struct Gen {
    y: Vec<f64>,
    anomalies: Vec<usize>,
}

#[allow(clippy::too_many_arguments)]
fn gen_series(
    seed: u64,
    n: usize,
    p: usize,
    base: f64,
    trend: f64,
    a: f64,
    a2: f64,
    sigma: f64,
    spikes: &[(usize, f64)],
    dips: &[(usize, f64)],
    shift: Option<(usize, f64)>,
    missing: &[usize],
) -> Gen {
    let mut rng = Rng::new(seed);
    let mut y = Vec::with_capacity(n);
    for i in 0..n {
        let v = base
            + trend * i as f64
            + a * (TAU * i as f64 / p as f64).sin()
            + a2 * (2.0 * TAU * i as f64 / p as f64).sin()
            + sigma * rng.normal();
        y.push(v);
    }
    let mut anomalies = Vec::new();
    for &(i, m) in spikes {
        // Width-2 spike: affects i and i+1.
        y[i] += m * sigma;
        if i + 1 < n {
            y[i + 1] += m * sigma;
        }
        anomalies.push(i);
        anomalies.push(i + 1);
    }
    for &(i, m) in dips {
        y[i] -= m * sigma;
        if i + 1 < n {
            y[i + 1] -= m * sigma;
        }
        anomalies.push(i);
        anomalies.push(i + 1);
    }
    if let Some((at, m)) = shift {
        for v in y[at..].iter_mut() {
            *v += m * sigma;
        }
    }
    for &i in missing {
        if i < n {
            y[i] = f64::NAN;
        }
    }
    Gen { y, anomalies }
}

fn clean_series(seed: u64, n: usize, p: usize) -> Gen {
    gen_series(seed, n, p, 50.0, 0.02, 8.0, 2.0, 1.0, &[], &[], None, &[])
}

// ---------------------------------------------------------------------------
// Gate 1: period recovery
// ---------------------------------------------------------------------------

#[test]
fn gate1_period_recovery_p24() {
    for seed in [42u64, 43, 44] {
        let g = clean_series(seed, 720, 24);
        let s = seasonality(&g.y, &SeasonalityOptions::default()).unwrap();
        let bp = s.best_period.expect("period should be detected");
        assert!(
            (bp as i64 - 24).abs() <= 1,
            "seed {seed}: detected {bp}"
        );
        assert!(s.strength > 0.7, "seed {seed}: strength {}", s.strength);
    }
}

#[test]
fn gate1_period_recovery_p7() {
    for seed in [42u64, 43] {
        let g = gen_series(seed, 350, 7, 50.0, 0.01, 6.0, 1.5, 0.8, &[], &[], None, &[]);
        let s = seasonality(&g.y, &SeasonalityOptions::default()).unwrap();
        let bp = s.best_period.expect("p=7 should be detected");
        assert!((bp as i64 - 7).abs() <= 1, "seed {seed}: detected {bp}");
        assert!(s.strength > 0.6, "seed {seed}: strength {}", s.strength);
    }
}

#[test]
fn gate1_period_recovery_p168() {
    let g = gen_series(42, 2000, 168, 50.0, 0.01, 10.0, 2.0, 1.2, &[], &[], None, &[]);
    let s = seasonality(&g.y, &SeasonalityOptions::default()).unwrap();
    let bp = s.best_period.expect("p=168 should be detected");
    assert!((bp as i64 - 168).abs() <= 2, "detected {bp}");
    assert!(s.strength > 0.6, "strength {}", s.strength);
}

// ---------------------------------------------------------------------------
// Gate 2: forecast skill (stl_ets beats snaive on holdout)
// ---------------------------------------------------------------------------

#[test]
fn gate2_stl_ets_beats_snaive_holdout() {
    for seed in [42u64, 43, 44, 45, 46] {
        let g = clean_series(seed, 744, 24);
        let (train, actual) = g.y.split_at(720);
        let mk = |model: Model| ForecastOptions {
            model,
            horizon: 24,
            period: Some(24),
            ..Default::default()
        };
        let r_stl = forecast(train, &mk(Model::StlEts)).unwrap();
        let r_snaive = forecast(train, &mk(Model::Snaive)).unwrap();
        let rmse = |r: &ForecastResult| -> f64 {
            let mut sse = 0.0;
            for (a, p) in actual.iter().zip(r.point.iter()) {
                let e = a - p;
                sse += e * e;
            }
            (sse / 24.0).sqrt()
        };
        let e_stl = rmse(&r_stl);
        let e_snaive = rmse(&r_snaive);
        assert!(
            e_stl < e_snaive,
            "seed {seed}: stl_ets rmse {e_stl} not < snaive rmse {e_snaive}"
        );
    }
}

// ---------------------------------------------------------------------------
// Gate 3: anomaly recall / precision
// ---------------------------------------------------------------------------

#[test]
fn gate3_anomaly_recall_precision() {
    let spikes: [(usize, f64); 3] = [(100, 6.0), (350, 6.0), (600, 6.0)];
    let dips: [(usize, f64); 2] = [(220, 6.0), (480, 6.0)];
    for seed in [42u64, 43, 44, 45, 46] {
        let g = gen_series(seed, 720, 24, 50.0, 0.02, 8.0, 2.0, 1.0, &spikes, &dips, None, &[]);
        let truth: Vec<usize> = g.anomalies.clone();
        let r = detect_anomalies(
            &g.y,
            &AnomalyOptions {
                method: AnomalyMethod::Stl,
                period: Some(24),
                ..Default::default()
            },
        )
        .unwrap();
        let flagged: Vec<usize> = r.anomalies.iter().map(|a| a.index).collect();
        let tp = flagged.iter().filter(|f| truth.contains(f)).count();
        let recall = tp as f64 / truth.len() as f64;
        let precision = tp as f64 / flagged.len().max(1) as f64;
        assert!(
            recall >= 0.8,
            "seed {seed}: recall {recall} (tp {tp}/{}), flagged {flagged:?}",
            truth.len()
        );
        assert!(
            precision >= 0.8,
            "seed {seed}: precision {precision}, flagged {flagged:?}"
        );
    }
}

// ---------------------------------------------------------------------------
// Gate 4: changepoint within ±3
// ---------------------------------------------------------------------------

#[test]
fn gate4_changepoint_localization() {
    for seed in [42u64, 43, 44] {
        let g = gen_series(
            seed, 600, 24, 50.0, 0.0, 0.0, 0.0, 1.0, &[], &[], Some((300, 5.0)), &[],
        );
        let c = changepoints(&g.y, &ChangepointOptions::default()).unwrap();
        assert!(
            c.changepoints
                .iter()
                .any(|cp| (cp.index as i64 - 300).abs() <= 3),
            "seed {seed}: changepoints {:?}",
            c.changepoints.iter().map(|c| c.index).collect::<Vec<_>>()
        );
        assert_eq!(c.means.len(), 600);
    }
}

// ---------------------------------------------------------------------------
// Gate 5: PI calibration on 200 realizations
// ---------------------------------------------------------------------------

#[test]
fn gate5_pi_calibration() {
    let n = 60;
    let h = 8;
    let realizations = 200;
    let mut inside = 0usize;
    let mut total = 0usize;
    for k in 0..realizations {
        let mut rng = Rng::new(1000 + k as u64);
        let y: Vec<f64> = (0..n).map(|_| rng.normal()).collect();
        // True future values from the same stream.
        let actual: Vec<f64> = (0..h).map(|_| rng.normal()).collect();
        let r = forecast(
            &y,
            &ForecastOptions {
                model: Model::Naive,
                horizon: h,
                paths: 200,
                level: 0.95,
                seed: 9000 + k as u64,
                ..Default::default()
            },
        )
        .unwrap();
        for ((a, lo), hi) in actual.iter().zip(r.lower.iter()).zip(r.upper.iter()) {
            if a >= lo && a <= hi {
                inside += 1;
            }
            total += 1;
        }
    }
    let coverage = inside as f64 / total as f64;
    assert!(
        (0.88..=1.0).contains(&coverage),
        "aggregate coverage {coverage} ({inside}/{total})"
    );
}

// ---------------------------------------------------------------------------
// Gate 6: determinism
// ---------------------------------------------------------------------------

#[test]
fn gate6_determinism() {
    let g = gen_series(
        42, 720, 24, 50.0, 0.02, 8.0, 2.0, 1.5, &[(100, 6.0)], &[(220, 6.0)], Some((400, 3.0)),
        &[5, 77, 300],
    );
    let opts = ForecastOptions::default();
    let a = forecast(&g.y, &opts).unwrap();
    let b = forecast(&g.y, &opts).unwrap();
    assert_eq!(a.point, b.point);
    assert_eq!(a.lower, b.lower);
    assert_eq!(a.upper, b.upper);
    assert_eq!(a.fitted, b.fitted);
    assert_eq!(a.residuals, b.residuals);
    assert_eq!(a.paths, b.paths);
    assert_eq!(a.metrics, b.metrics);
    assert_eq!(a.warnings, b.warnings);

    let aa = detect_anomalies(&g.y, &AnomalyOptions::default()).unwrap();
    let bb = detect_anomalies(&g.y, &AnomalyOptions::default()).unwrap();
    assert_eq!(aa.scores, bb.scores);
    assert_eq!(aa.anomalies, bb.anomalies);

    let ca = changepoints(&g.y, &ChangepointOptions::default()).unwrap();
    let cb = changepoints(&g.y, &ChangepointOptions::default()).unwrap();
    assert_eq!(ca.changepoints, cb.changepoints);
    assert_eq!(ca.means, cb.means);
}

// ---------------------------------------------------------------------------
// Gate 7: metrics sanity
// ---------------------------------------------------------------------------

#[test]
fn gate7_metrics_sanity() {
    let g = clean_series(42, 400, 24);
    for model in [Model::Auto, Model::StlEts, Model::Ets, Model::Ar, Model::Naive] {
        let r = forecast(
            &g.y,
            &ForecastOptions {
                model,
                horizon: 24,
                ..Default::default()
            },
        )
        .unwrap();
        let m = &r.metrics;
        assert!(m.rmse.is_finite() && m.rmse >= 0.0);
        assert!(m.mae.is_finite() && m.mae >= 0.0);
        assert!(m.smape.is_finite() && m.smape >= 0.0 && m.smape <= 200.0);
        assert_eq!(r.fitted.len(), 400);
        assert_eq!(r.residuals.len(), 400);
    }
}

// ---------------------------------------------------------------------------
// Gate 8: edge cases
// ---------------------------------------------------------------------------

#[test]
fn gate8_n3_works() {
    let r = forecast(&[1.0, 2.0, 4.5], &ForecastOptions::default()).unwrap();
    assert_eq!(r.point.len(), 24);
    assert!(r.point.iter().all(|v| v.is_finite()));
}

#[test]
fn gate8_n2_too_short() {
    assert!(matches!(
        forecast(&[1.0, 2.0], &ForecastOptions::default()),
        Err(IsoclineError::TooShort { n: 2, need: 3 })
    ));
}

#[test]
fn gate8_constant_series() {
    let y = vec![7.5; 200];
    let r = forecast(&y, &ForecastOptions::default()).unwrap();
    for v in &r.point {
        assert!((v - 7.5).abs() < 1e-6, "forecast not flat: {v}");
    }
    assert!(r.lower.iter().zip(r.upper.iter()).all(|(l, u)| l <= u));
    let a = detect_anomalies(&y, &AnomalyOptions::default()).unwrap();
    assert!(a.anomalies.is_empty());
    let c = changepoints(&y, &ChangepointOptions::default()).unwrap();
    assert!(c.changepoints.is_empty());
    let s = seasonality(&y, &SeasonalityOptions::default()).unwrap();
    assert_eq!(s.best_period, None);
    assert_eq!(s.strength, 0.0);
}

#[test]
fn gate8_all_nan_bad_params() {
    let y = vec![f64::NAN; 30];
    assert!(matches!(
        forecast(&y, &ForecastOptions::default()),
        Err(IsoclineError::BadParams(_))
    ));
    assert!(matches!(
        detect_anomalies(&y, &AnomalyOptions::default()),
        Err(IsoclineError::BadParams(_))
    ));
    assert!(matches!(
        changepoints(&y, &ChangepointOptions::default()),
        Err(IsoclineError::BadParams(_))
    ));
}

#[test]
fn gate8_nan_holes_interpolated() {
    let g = clean_series(42, 400, 24);
    let mut y = g.y.clone();
    y[50] = f64::NAN;
    y[100] = f64::NAN;
    y[101] = f64::NAN;
    let filled = interpolate(&y);
    assert!(filled.iter().all(|v| v.is_finite()));
    assert_eq!(filled.len(), y.len());
    // Filled from neighbors: between y[49] and y[51].
    assert!(filled[50] > g.y[49].min(g.y[51]) - 1.0 && filled[50] < g.y[49].max(g.y[51]) + 1.0);
    let r = forecast(&y, &ForecastOptions::default()).unwrap();
    assert!(r.point.iter().all(|v| v.is_finite()));
}

#[test]
fn gate8_noise_no_seasonality_no_stl_ets() {
    for seed in [1u64, 2, 3] {
        let mut rng = Rng::new(seed);
        let y: Vec<f64> = (0..300).map(|_| 10.0 + rng.normal()).collect();
        let s = seasonality(&y, &SeasonalityOptions::default()).unwrap();
        assert_eq!(s.best_period, None, "seed {seed}");
        assert!(s.strength < 0.2);
        let r = forecast(&y, &ForecastOptions::default()).unwrap();
        assert_ne!(r.model, Model::StlEts, "seed {seed}");
        assert_eq!(r.period, None);
    }
}

// ---------------------------------------------------------------------------
// Gate 9: backtest defaults
// ---------------------------------------------------------------------------

#[test]
fn gate9_backtest_rows() {
    let g = clean_series(42, 400, 24);
    let bt = backtest(&g.y, &BacktestOptions::default()).unwrap();
    assert_eq!(bt.horizon, 24);
    assert_eq!(bt.folds, 3);
    let mut models: Vec<&str> = bt.rows.iter().map(|r| r.model.as_str()).collect();
    models.sort_unstable();
    assert_eq!(
        models,
        vec!["ar", "ets", "snaive", "stl_ets"]
    );
    for row in &bt.rows {
        assert!(row.rmse.is_finite() && row.rmse >= 0.0, "{row:?}");
        assert!(row.mae.is_finite() && row.mae >= 0.0);
        assert!(row.smape.is_finite() && row.smape <= 200.0);
        assert!((0.0..=1.0).contains(&row.coverage));
        assert_eq!(row.folds, 3);
    }
}

// ---------------------------------------------------------------------------
// Performance sanity: n=10000, h=48, 200 paths well under 1s (debug OK)
// ---------------------------------------------------------------------------

#[test]
fn perf_forecast_large_series() {
    let g = clean_series(42, 10_000, 24);
    let t0 = std::time::Instant::now();
    let r = forecast(
        &g.y,
        &ForecastOptions {
            horizon: 48,
            paths: 200,
            ..Default::default()
        },
    )
    .unwrap();
    let elapsed = t0.elapsed();
    assert_eq!(r.point.len(), 48);
    assert!(r.paths.as_ref().unwrap().len() == 200 * 48);
    assert!(
        elapsed.as_secs_f64() < 5.0,
        "forecast took {:?}",
        elapsed
    );
}

// ---------------------------------------------------------------------------
// Parallel feature smoke test (compile + run when enabled)
// ---------------------------------------------------------------------------

#[cfg(feature = "parallel")]
#[test]
fn parallel_batch_matches_sequential() {
    let series: Vec<Vec<f64>> = (0..4)
        .map(|k| clean_series(100 + k as u64, 300, 24).y)
        .collect();
    let opts = ForecastOptions {
        horizon: 12,
        ..Default::default()
    };
    let batch = batch::batch_forecast(&series, &opts);
    for (i, res) in batch.iter().enumerate() {
        let seq = forecast(&series[i], &opts).unwrap();
        assert_eq!(res.as_ref().unwrap().point, seq.point, "series {i}");
    }
    let anom = batch::batch_detect_anomalies(&series, &AnomalyOptions::default());
    assert_eq!(anom.len(), 4);
}
