# isocline-plot examples

A single page rendering every visualization (forecast, anomalies, decompose,
seasonality, changepoints, backtest, the tabular detectors and every
auto-chart kind) with Apache ECharts against pure-TS mock results — no wasm
engine required. It also shows composition (`forecastOption` + echarts
`setOption`) and anomaly tooltip `explanations`. Run from the repo root:

```sh
npm run preview -w isocline-plot
# → vite dev server serving examples/
```

Or build statically:

```sh
npx vite build examples --config examples/vite.config.ts
```

The mocks in `mocks.ts` are contract-shaped but deliberately simple
(snaive-style forecasting, rolling-median anomaly scores, etc.) — they exist
to exercise every code path of the option builders, not to be accurate.
