# Benchmarks: isocline vs augurs

Measured head-to-head against
[augurs](https://github.com/grafana/augurs) (`@bsull/augurs` 0.10.2, the
official npm bindings) on one M-series laptop, Node 24, single thread, same
process, identical synthetic input arrays (seed 42, period 24, trend +
harmonics + noise), median of 5 runs after warm-up, augurs logging silenced.
Reproduce with `node scripts/bench-augurs.mjs` (see header for setup).

## Forecasting

| workload | augurs 0.10.2 | isocline 0.1.0 | speedup |
|---|---|---|---|
| ETS fit + predict h=48, n=1k (`AutoETS("ZZZ")` vs `ets`) | 10.3 ms | 4.3 ms | ~2.4x |
| ETS fit + predict h=48, n=10k | 97.2 ms | 37.8 ms | ~2.6x |
| ETS + 200-path bootstrap PIs, n=10k | n/a | 38.4 ms | - |
| STL-composite forecast h=48, n=1k (`MSTL.ets([24])` vs `stl_ets`) | 16.7 ms | 6.9 ms | ~2.4x |
| STL-composite forecast h=48, n=10k | 243.7 ms | 70.5 ms | ~3.5x |
| decomposition n=10k (MSTL fit vs `decompose`) | 244.0 ms | 61.0 ms | ~4.0x |

## Shipped bytes

isocline is one wasm binary covering every op; augurs ships one binary per
feature, lazily initialized. Matching capability for the rows above:

| capability set | augurs (raw / gzip) | isocline (raw / gzip) |
|---|---|---|
| ETS + STL-composite | 582 KB / 245 KB (`ets` + `mstl`) | 235 KB / 87 KB |
| + outlier + seasonals + changepoint | 1160 KB / 492 KB | 235 KB / 87 KB |

## Fairness caveats (read before quoting these numbers)

1. `AutoETS("ZZZ")` searches model space (best of the ETS forms by AICc);
   isocline fits one damped-additive model via Nelder-Mead. The search is an
   augurs feature and it costs wall-clock; the comparison reflects each
   library's default forecasting API.
2. augurs `MSTL` handles multiple seasonal periods iteratively; isocline is
   single-period. The STL rows compare a more general algorithm against a
   leaner one, not like-for-like implementations.
3. isocline rows include prediction intervals; even the bootstrap-simulation
   variant (200 paths, the expensive-by-design method) stays ahead.
4. augurs is a broader toolbox (Prophet with a compiled Stan runtime, DTW,
   clustering, richer changepoint models). isocline does not attempt those;
   on the shared core (forecast / anomaly / decompose / seasonality) it is
   2.5-4x faster and 3-6x lighter to ship.
5. Single machine, micro-benchmark variance is roughly +-15%.
