// isocline-plot — Apache ECharts visualization layer for isocline results.
// Two API forms per family (CONTRACT §6):
//   *Option(...) → EChartsOption for composition (setOption / renderChart / renderSVG)
//   *Plot(...)   → mounted HTMLElement (div.isocline-plot) via renderChart

export * from "./theme.js";
export { toPoints, xOf, seriesXAxis, stepOf, futureX, isArray, type Pt, type IsoclineSeriesOption } from "./util.js";
export { registerECharts, renderChart, disposePlots, renderSVG, type RenderChartOptions } from "./render.js";
export { forecastOption, forecastPlot, type ForecastVizOptions } from "./forecast.js";
export { anomalyOption, anomalyPlot, anomalySplit, type AnomalyVizOptions } from "./anomaly.js";
export { decomposeOption, decomposePlot, decomposeHeight, type DecomposeVizOptions } from "./decompose.js";
export { seasonalityOption, seasonalityPlot, seasonalityCandidates, type SeasonalityVizOptions } from "./seasonality.js";
export { changepointOption, changepointPlot, type ChangepointVizOptions } from "./changepoint.js";
export { backtestOption, backtestPlot, backtestWinner, type BacktestVizOptions } from "./backtest.js";
export {
  correlationOption,
  correlationPlot,
  correlationHeadline,
  majorityOption,
  majorityPlot,
  majorityBars,
  categoryOutlierOption,
  categoryOutlierPlot,
  categoryRows,
  lowVarianceOption,
  lowVariancePlot,
  lowVarianceHeadline,
  variancePoints,
  type TabularVizOptions,
  type MajorityRow,
  type CategoryRow,
  type VariancePoint,
} from "./tabular.js";
export { autoChartOption, autoChartPlot, autoChartReason, type AutoChartVizOptions } from "./auto.js";
