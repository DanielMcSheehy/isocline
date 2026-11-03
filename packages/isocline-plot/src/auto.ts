// Auto-chart dispatcher (CONTRACT §11): maps an AutoChartResult onto the right
// option builder. Import direction is one-way: auto → tabular/forecast/anomaly;
// nothing here is imported by those modules (no cycles).
import type { EChartsOption } from "echarts";
import type { GenericSeries, AutoChartResult, SeriesInput } from "isocline";
import { C, isoclineTheme, grid, tooltip, xAxis, yAxis, fmt, fmtTick } from "./theme.js";
import { tipList, type TipParams } from "./util.js";
import { renderChart } from "./render.js";
import { forecastOption, type ForecastVizOptions } from "./forecast.js";
import { anomalyOption, type AnomalyVizOptions } from "./anomaly.js";
import {
  correlationOption,
  majorityOption,
  categoryOutlierOption,
  lowVarianceOption,
  horizontalBarsOption,
  type TabularVizOptions,
} from "./tabular.js";

export type AutoChartVizOptions = ForecastVizOptions &
  AnomalyVizOptions &
  TabularVizOptions;

const HIST_BINS = 24;

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

/** Categories behind a "distribution" chart (per-category aggregates from auto.categoryOutlier). */
function distBars(auto: AutoChartResult): DistBar[] {
  return (auto.categoryOutlier?.categories ?? []).map((c) => ({ label: c.label, value: Number(c.value) }));
}

/** "distribution" for categorical input: majority-shaped bars of the per-category aggregates, cyan, fmt labels. */
function distributionBarsOption(bars: DistBar[], opts: AutoChartVizOptions): EChartsOption {
  return horizontalBarsOption(
    bars.map((b) => ({ ...b, color: C.cyan })),
    { xName: opts.yLabel ?? "value", xFormatter: fmtTick, label: fmt },
  );
}

/** "distribution" for pure numeric input: equal-width histogram (24 bins), cyan. */
function distributionHistogramOption(values: number[], opts: AutoChartVizOptions): EChartsOption {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!values.length) {
    lo = 0;
    hi = 1;
  }
  const width = hi > lo ? (hi - lo) / HIST_BINS : 1;
  const counts = new Array<number>(HIST_BINS).fill(0);
  for (const v of values) counts[Math.min(HIST_BINS - 1, Math.floor((v - lo) / width))]! += 1;
  const edges = Array.from({ length: HIST_BINS }, (_, k) => [lo + k * width, lo + (k + 1) * width] as const);
  // Decimals resolving the bin width (fmt's 3 sig digits would merge the bins of a narrow range).
  const dec = Math.max(0, Math.min(6, 1 - Math.floor(Math.log10(width))));
  const edgeLabel = (v: number) => fmtTick(Number(v.toFixed(dec)));
  return {
    ...isoclineTheme,
    grid: grid(),
    tooltip: tooltip({
      trigger: "item",
      formatter: (p: TipParams | TipParams[]) =>
        tipList(p)
          .map((it) => {
            const e = edges[it.dataIndex];
            return e ? `[${edgeLabel(e[0])}, ${edgeLabel(e[1])})<br/>count ${it.value}` : "";
          })
          .join(""),
    }),
    xAxis: xAxis({
      type: "category",
      name: opts.xLabel ?? "value",
      data: edges.map((e) => edgeLabel((e[0] + e[1]) / 2)),
      axisTick: { alignWithLabel: true },
    }),
    yAxis: yAxis({ type: "value", name: opts.yLabel ?? "count", min: 0, scale: false }),
    series: [
      {
        type: "bar",
        name: "count",
        data: counts,
        barCategoryGap: "6%",
        itemStyle: { color: C.cyan, opacity: 0.85 },
      },
    ],
  };
}

/** Chosen option plus its bar-row count (bar charts grow with their rows). */
interface AutoPick {
  option: EChartsOption;
  rows: number | null;
}

function pick(input: GenericSeries, auto: AutoChartResult, opts: AutoChartVizOptions): AutoPick {
  const series = auto.series ?? asSeries(input);
  switch (auto.kind) {
    case "forecast":
      if (auto.forecast && series) return { option: forecastOption(series, auto.forecast, opts), rows: null };
      break;
    case "anomalies":
      if (auto.anomalies && series) return { option: anomalyOption(series, auto.anomalies, opts), rows: null };
      break;
    case "correlation":
      if (auto.correlation) return { option: correlationOption(input.y ?? [], input.y2 ?? [], auto.correlation, opts), rows: null };
      break;
    case "majority":
      if (auto.majority) return { option: majorityOption(auto.majority, opts), rows: auto.majority.counts.length };
      break;
    case "category_outlier":
      if (auto.categoryOutlier) return { option: categoryOutlierOption(auto.categoryOutlier, opts), rows: null };
      break;
    case "low_variance":
      if (auto.lowVariance && input.y !== undefined) return { option: lowVarianceOption(input.y, auto.lowVariance, opts), rows: null };
      break;
    case "distribution":
    default:
      break;
  }
  // "distribution", or missing pieces for the requested kind — fall back to
  // the distribution chart of whatever numeric data is available.
  const bars = distBars(auto);
  return bars.length
    ? { option: distributionBarsOption(bars, opts), rows: bars.length }
    : { option: distributionHistogramOption(finiteValues(input.y), opts), rows: null };
}

/** Option for an auto-chart: dispatch on auto.kind to the matching family; never throws. */
export function autoChartOption(input: GenericSeries, auto: AutoChartResult, opts: AutoChartVizOptions = {}): EChartsOption {
  return pick(input, auto, opts).option;
}

/** Render an auto-chart: dispatch on auto.kind to the matching plot family. */
export function autoChartPlot(input: GenericSeries, auto: AutoChartResult, opts: AutoChartVizOptions = {}): HTMLElement {
  const { option, rows } = pick(input, auto, opts);
  return renderChart(option, { width: opts.width, height: opts.height ?? (rows === null ? 320 : 44 + 26 * rows) });
}
