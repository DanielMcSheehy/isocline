// Auto-chart dispatcher (CONTRACT §11): maps an AutoChartResult onto the right
// renderer. Import direction is one-way: auto → tabular/forecast/anomaly;
// nothing here is imported by those modules (no cycles).
import * as Plot from "@observablehq/plot";
import type { GenericSeries, AutoChartResult, SeriesInput } from "isocline";
import { C, isoclineTheme, applyIsoclineCss, fmt } from "./theme.js";
import { forecastPlot, type ForecastVizOptions } from "./forecast.js";
import { anomalyPlot, type AnomalyVizOptions } from "./anomaly.js";
import {
  correlationPlot,
  majorityPlot,
  categoryOutlierPlot,
  lowVariancePlot,
  type TabularVizOptions,
} from "./tabular.js";

export type AutoChartVizOptions = ForecastVizOptions &
  AnomalyVizOptions &
  TabularVizOptions;

/** Explanation chip text for the rendered auto chart. */
export function autoChartReason(auto: AutoChartResult): string {
  return auto.reason;
}

/** Narrow a GenericSeries to a SeriesInput (y is required on SeriesInput).
 *  Cast needed: GenericSeries.y is ArrayLike<number> while SeriesInput.y is
 *  Float64Array | number[] (dist/types.d.ts) — runtime shape is compatible. */
function asSeries(g: GenericSeries): SeriesInput | null {
  if (g.y === undefined) return null;
  return {
    y: g.y as Float64Array | number[],
    t: g.t as Float64Array | number[] | undefined,
  };
}

function finiteValues(v: ArrayLike<number> | undefined): number[] {
  if (!v) return [];
  const out: number[] = [];
  for (let i = 0; i < v.length; i++) {
    const x = Number(v[i]);
    if (Number.isFinite(x)) out.push(x);
  }
  return out;
}

interface DistBar {
  label: string;
  value: number;
}

/** "distribution" for categorical input: majorityPlot-shaped bars of the
 *  per-category aggregates (from auto.categoryOutlier), cyan, fmt labels. */
function distributionBarsMarks(
  bars: DistBar[],
  opts: AutoChartVizOptions,
): { marks: Plot.Markish[]; plotOptions: Partial<Plot.PlotOptions> } {
  const marks: Plot.Markish[] = [
    Plot.barX(bars, { x: "value", y: "label", fill: C.cyan }),
    Plot.text(bars, {
      x: "value",
      y: "label",
      text: (d: DistBar) => fmt(d.value),
      textAnchor: "start",
      dx: 5,
      fill: C.ink,
      fontSize: 10,
    }),
  ];
  const max = bars.reduce((m, b) => Math.max(m, b.value), 0);
  const plotOptions: Partial<Plot.PlotOptions> = {
    ...isoclineTheme,
    marginLeft: Math.max(isoclineTheme.marginLeft ?? 0, 92),
    marginRight: Math.max(isoclineTheme.marginRight ?? 0, 48),
    x: { ...isoclineTheme.x, nice: true, domain: [0, max > 0 ? max * 1.08 : 1], label: opts.yLabel ?? "value", grid: true },
    y: { ...isoclineTheme.y, grid: false, domain: bars.map((b) => b.label) },
    height: opts.height ?? 24 + 26 * bars.length,
  };
  if (opts.width) plotOptions.width = opts.width;
  return { marks, plotOptions };
}

/** "distribution" for pure numeric input: binned histogram (24 bins), cyan. */
function distributionHistogram(
  values: number[],
  opts: AutoChartVizOptions,
): { marks: Plot.Markish[]; plotOptions: Partial<Plot.PlotOptions> } {
  const data = values.map((y, i) => ({ i, y }));
  const marks: Plot.Markish[] = [
    Plot.rectY(
      data,
      {
        ...Plot.binX({ y: "count" }, { x: "y", thresholds: 24 }),
        fill: C.cyan,
        fillOpacity: 0.85,
      },
    ),
  ];
  const plotOptions: Partial<Plot.PlotOptions> = {
    ...isoclineTheme,
    x: { ...isoclineTheme.x, nice: true, label: opts.xLabel ?? "value" },
    y: { ...isoclineTheme.y, label: opts.yLabel ?? "count" },
    height: opts.height ?? 320,
  };
  if (opts.width) plotOptions.width = opts.width;
  return { marks, plotOptions };
}

function distributionChart(input: GenericSeries, auto: AutoChartResult, opts: AutoChartVizOptions): HTMLElement {
  const cats = auto.categoryOutlier?.categories;
  const bars: DistBar[] = (cats ?? []).map((c) => ({ label: c.label, value: Number(c.value) }));
  const spec = bars.length
    ? distributionBarsMarks(bars, opts)
    : distributionHistogram(finiteValues(input.y), opts);
  const fig = Plot.plot({ ...spec.plotOptions, marks: spec.marks } as Plot.PlotOptions);
  fig.classList.add("isocline-plot");
  return fig as HTMLElement;
}

/** Render an auto-chart: dispatch on auto.kind to the matching plot family. */
export function autoChartPlot(input: GenericSeries, auto: AutoChartResult, opts: AutoChartVizOptions = {}): HTMLElement {
  applyIsoclineCss();
  const series = auto.series ?? asSeries(input);
  switch (auto.kind) {
    case "forecast":
      if (auto.forecast && series) return forecastPlot(series, auto.forecast, opts);
      break;
    case "anomalies":
      if (auto.anomalies && series) return anomalyPlot(series, auto.anomalies, opts);
      break;
    case "correlation":
      if (auto.correlation) return correlationPlot(input.y ?? [], input.y2 ?? [], auto.correlation, opts);
      break;
    case "majority":
      if (auto.majority) return majorityPlot(auto.majority, opts);
      break;
    case "category_outlier":
      if (auto.categoryOutlier) return categoryOutlierPlot(auto.categoryOutlier, opts);
      break;
    case "low_variance":
      if (auto.lowVariance && input.y !== undefined) return lowVariancePlot(input.y, auto.lowVariance, opts);
      break;
    case "distribution":
    default:
      return distributionChart(input, auto, opts);
  }
  // Missing pieces for the requested kind — fall back to the distribution
  // chart of whatever numeric data is available (never throws).
  return distributionChart(input, auto, opts);
}
