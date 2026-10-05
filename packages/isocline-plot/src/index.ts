// isocline-plot — Observable Plot visualization layer for isocline results.
// Two API forms per family (CONTRACT §6):
//   *Marks(...)  → { marks: Plot.Markish[], plotOptions } for composition
//   *Plot(...)   → rendered HTMLElement via Plot.plot
import * as Plot from "@observablehq/plot";

export * from "./theme.js";
export * from "./util.js";
export { forecastMarks, forecastPlot, type ForecastVizOptions, type MarkSpec } from "./forecast.js";
export { anomalyMarks, anomalyPlot, anomalySplit, type AnomalyVizOptions } from "./anomaly.js";
export { decomposePlot, type DecomposeVizOptions } from "./decompose.js";
export { seasonalityPlot, seasonalityCandidates, type SeasonalityVizOptions } from "./seasonality.js";
export { changepointMarks, changepointPlot, type ChangepointVizOptions } from "./changepoint.js";
export { backtestPlot, backtestWinner, type BacktestVizOptions } from "./backtest.js";

/** Thin wrapper: theme-first Plot.plot. */
export function plot(spec: Partial<Plot.PlotOptions> = {}): HTMLElement {
  const fig = Plot.plot(spec);
  fig.classList.add("isocline-plot");
  return fig as HTMLElement;
}
