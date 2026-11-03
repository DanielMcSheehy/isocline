// Tabular detector visualizations (CONTRACT §11): correlation, majority,
// category outlier, low variance. Non-temporal — x is never a time axis.
import type { EChartsOption } from "echarts";
import type {
  CorrelationResult,
  MajorityResult,
  CategoryOutlierResult,
  LowVarianceResult,
} from "isocline";
import { C, isoclineTheme, grid, title, tooltip, xAxis, yAxis, fmt, fmtTick } from "./theme.js";
import { tipList, tipMarker, tipValue, type IsoclineSeriesOption, type TipParams } from "./util.js";
import { renderChart } from "./render.js";

export interface TabularVizOptions {
  height?: number;
  width?: number;
  xLabel?: string;
  yLabel?: string;
}

const INK_STROKE = C.bg; // dark halo around colored dots (matches anomaly/changepoint)

/** Headline in the top-right margin (the y-axis name owns the top-left). */
const headline = (text: string) => title(text, { left: undefined, right: 16, top: 4 });

/** Finite (a, b) pairs, aligned by index; NaN/Infinity filtered. */
function pairsOf(a: ArrayLike<number>, b: ArrayLike<number>): [number, number][] {
  const n = Math.min(a.length, b.length);
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const x = Number(a[i]);
    const y = Number(b[i]);
    if (Number.isFinite(x) && Number.isFinite(y)) out.push([x, y]);
  }
  return out;
}

function extentOf(values: number[]): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return Number.isFinite(lo) && Number.isFinite(hi) ? [lo, hi] : null;
}

/** Headline text: `r = 0.83 · n = 500 · significant`; r null → "r = —". */
export function correlationHeadline(res: CorrelationResult): string {
  const sig = res.significant ? "significant" : "not significant";
  return `r = ${fmt(res.r)} · n = ${fmt(res.n)} · ${sig}`;
}

export function correlationOption(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  res: CorrelationResult,
  opts: TabularVizOptions = {},
): EChartsOption {
  const pts = pairsOf(a, b);
  const xName = opts.xLabel ?? "a";
  const yName = opts.yLabel ?? "b";
  const series: IsoclineSeriesOption[] = [
    { type: "scatter", name: "pairs", data: pts, symbolSize: 5, itemStyle: { color: C.muted, opacity: 0.7 } },
  ];
  // OLS fit line across the a-domain (cyan); skipped when the domain is degenerate.
  const xs = extentOf(pts.map((p) => p[0]));
  const slope = Number(res.slope);
  const intercept = Number(res.intercept);
  if (xs && Number.isFinite(slope) && Number.isFinite(intercept) && xs[0] !== xs[1]) {
    series.push({
      type: "line",
      name: "OLS fit",
      data: xs.map((x) => [x, slope * x + intercept]),
      symbol: "none",
      silent: true,
      tooltip: { show: false },
      lineStyle: { color: C.cyan, width: 1.6 },
      z: 3,
    });
  }
  return {
    ...isoclineTheme,
    title: headline(correlationHeadline(res)),
    grid: grid(),
    tooltip: tooltip({
      trigger: "item",
      formatter: (p: TipParams | TipParams[]) =>
        tipList(p)
          .map((it) => `${xName} ${fmt(tipValue(it, 0))}<br/>${yName} ${fmt(tipValue(it, 1))}`)
          .join(""),
    }),
    xAxis: xAxis({ type: "value", name: xName, scale: true }),
    yAxis: yAxis({ type: "value", name: yName }),
    series,
  };
}

export function correlationPlot(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  res: CorrelationResult,
  opts: TabularVizOptions = {},
): HTMLElement {
  return renderChart(correlationOption(a, b, res, opts), { width: opts.width, height: opts.height ?? 320 });
}

/** `NN.N%` label text (spec form — one decimal, always with the % sign). */
function pctLabel(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

export interface MajorityRow {
  label: string;
  proportion: number;
}

export function majorityBars(res: MajorityResult): MajorityRow[] {
  return res.counts.map((c) => ({ label: c.label, proportion: c.proportion }));
}

/** Horizontal bars: category labels on y (first row on top), labelled at the bar end. */
export function horizontalBarsOption(
  rows: { label: string; value: number; color: string }[],
  o: { xName: string; xMax?: number; xFormatter: (v: number) => string; label: (v: number) => string; markLine?: IsoclineSeriesOption["markLine"] },
): EChartsOption {
  return {
    ...isoclineTheme,
    grid: grid({ top: 22, right: 56 }),
    tooltip: tooltip({
      trigger: "item",
      formatter: (p: TipParams | TipParams[]) =>
        tipList(p)
          .map((it) => `${tipMarker(it)}${it.name} ${o.label(Number(it.value))}`)
          .join(""),
    }),
    xAxis: xAxis({ type: "value", name: o.xName, min: 0, max: o.xMax, axisLabel: { formatter: o.xFormatter } }),
    yAxis: yAxis({ type: "category", data: rows.map((r) => r.label), inverse: true, name: "", axisTick: { show: false } }),
    series: [
      {
        type: "bar",
        name: "bars",
        data: rows.map((r) => ({ value: r.value, itemStyle: { color: r.color } })),
        barCategoryGap: "18%",
        label: { show: true, position: "right", color: C.ink, fontSize: 10, formatter: (p: TipParams) => o.label(Number(p.value)) },
        markLine: o.markLine,
      },
    ],
  };
}

export function majorityOption(res: MajorityResult, opts: TabularVizOptions = {}): EChartsOption {
  const rows = majorityBars(res).map((r) => ({
    label: r.label,
    value: r.proportion,
    color: r.label === res.dominant ? C.cyan : C.muted,
  }));
  return horizontalBarsOption(rows, {
    xName: opts.xLabel ?? "proportion",
    xMax: 1,
    xFormatter: (v) => `${Math.round(v * 100)}%`,
    label: pctLabel,
    // dashed rule at the majority threshold
    markLine: {
      silent: true,
      symbol: "none",
      lineStyle: { color: C.amber, type: [4, 3], width: 1.1 },
      // y is inverse (first row on top), so the line starts at the top edge
      label: { formatter: `threshold ${pctLabel(res.threshold)}`, color: C.amber, fontSize: 9, position: "start" },
      data: [{ xAxis: res.threshold }],
    },
  });
}

export function majorityPlot(res: MajorityResult, opts: TabularVizOptions = {}): HTMLElement {
  const height = opts.height ?? 44 + 26 * res.counts.length;
  return renderChart(majorityOption(res, opts), { width: opts.width, height });
}

/** Distance of a value from the [q1, q3] band, in IQR units ("z-score-ish"). */
function outlierDistance(value: number, res: CategoryOutlierResult): number {
  const iqr = res.iqr > 0 ? res.iqr : 1e-9;
  if (value > res.q3) return (value - res.q3) / iqr;
  if (value < res.q1) return (value - res.q1) / iqr;
  return 0;
}

export interface CategoryRow {
  label: string;
  value: number;
  isOutlier: boolean;
  direction: "high" | "low";
  dist: number;
}

export function categoryRows(res: CategoryOutlierResult): CategoryRow[] {
  return res.categories.map((c) => ({
    label: c.label,
    value: c.value,
    isOutlier: c.isOutlier,
    direction: c.direction,
    dist: outlierDistance(Number(c.value), res),
  }));
}

function outlierTitle(d: CategoryRow): string {
  if (!d.isOutlier) return `<b>${d.label}</b><br/>value ${fmt(d.value)}<br/>within fences`;
  const side = d.direction === "high" ? "above Q3" : "below Q1";
  return `<b>${d.label}</b><br/>value ${fmt(d.value)}<br/>${fmt(d.dist)}×IQR ${side}`;
}

export function categoryOutlierOption(res: CategoryOutlierResult, opts: TabularVizOptions = {}): EChartsOption {
  const rows = categoryRows(res);
  const dots = (name: string, data: CategoryRow[], color: string, size: number, opacity: number): IsoclineSeriesOption => ({
    type: "scatter",
    name,
    data: data.map((r) => [r.label, r.value]),
    symbolSize: size,
    itemStyle: { color, opacity, borderColor: INK_STROKE, borderWidth: 0.8 },
    z: 5,
    tooltip: {
      formatter: (p: TipParams | TipParams[]) =>
        tipList(p)
          .map((it) => data[it.dataIndex])
          .map((r) => (r ? outlierTitle(r) : ""))
          .join(""),
    },
  });
  const normal = dots("within", rows.filter((r) => !r.isOutlier), C.cyan, 6.4, 0.55);
  // shaded IQR band (q1..q3) spanning the full width, then dashed fences
  normal.markArea = {
    silent: true,
    itemStyle: { color: C.amber, opacity: 0.08 },
    data: [[{ yAxis: res.q1 }, { yAxis: res.q3 }]],
  };
  normal.markLine = {
    silent: true,
    symbol: "none",
    label: { show: false },
    lineStyle: { color: C.amber, type: [4, 3], width: 1.1 },
    data: [{ yAxis: res.lowerFence }, { yAxis: res.upperFence }],
  };
  const rotate = rows.some((r) => r.label.length > 8) ? 30 : 0;
  return {
    ...isoclineTheme,
    grid: grid(),
    tooltip: tooltip({ trigger: "item" }),
    xAxis: xAxis({
      type: "category",
      data: rows.map((r) => r.label),
      name: opts.xLabel ?? "",
      axisLabel: { rotate, interval: 0 },
    }),
    yAxis: yAxis({ type: "value", name: opts.yLabel ?? "value" }),
    series: [
      normal,
      dots("high", rows.filter((r) => r.isOutlier && r.direction === "high"), C.red, 8, 1),
      dots("low", rows.filter((r) => r.isOutlier && r.direction === "low"), C.blue, 8, 1),
    ],
  };
}

export function categoryOutlierPlot(res: CategoryOutlierResult, opts: TabularVizOptions = {}): HTMLElement {
  return renderChart(categoryOutlierOption(res, opts), { width: opts.width, height: opts.height ?? 320 });
}

export interface VariancePoint {
  x: number;
  y: number;
}

export function variancePoints(values: ArrayLike<number>): VariancePoint[] {
  const out: VariancePoint[] = [];
  for (let i = 0; i < values.length; i++) {
    const y = Number(values[i]);
    if (Number.isFinite(y)) out.push({ x: i, y });
  }
  return out;
}

/** `cv = 0.003 · flat` / `cv = 0.41 · not flat`. */
export function lowVarianceHeadline(res: LowVarianceResult): string {
  return `cv = ${fmt(res.cv)} · ${res.isFlat ? "flat" : "not flat"}`;
}

export function lowVarianceOption(
  values: ArrayLike<number>,
  res: LowVarianceResult,
  opts: TabularVizOptions = {},
): EChartsOption {
  const pts = variancePoints(values);
  const mean = Number(res.mean);
  const sd = Math.max(Number(res.stdDev) || 0, 0);
  const finite = Number.isFinite(mean) && Number.isFinite(sd);
  // y-domain padded ±max(3σ, 1e-9) so flatness is visible; widened (never
  // clipped) when the series itself strays beyond the band.
  const pad = Math.max(3 * sd, 1e-9);
  let lo = mean - pad;
  let hi = mean + pad;
  for (const p of pts) {
    if (p.y < lo) lo = p.y;
    if (p.y > hi) hi = p.y;
  }
  const yName = opts.yLabel ?? "value";
  return {
    ...isoclineTheme,
    title: headline(lowVarianceHeadline(res)),
    grid: grid(),
    tooltip: tooltip({
      trigger: "axis",
      axisPointer: { type: "line", lineStyle: { color: "rgba(255,255,255,0.25)" } },
      formatter: (p: TipParams | TipParams[]) =>
        tipList(p)
          .map((it) => `#${tipValue(it, 0)}<br/>${yName} ${fmtTick(tipValue(it, 1))}<br/>mean ${fmtTick(mean)} ± ${fmt(sd)}`)
          .join(""),
    }),
    xAxis: xAxis({ type: "value", name: opts.xLabel ?? "index", min: "dataMin", max: "dataMax" }),
    yAxis: yAxis({
      type: "value",
      name: yName,
      min: finite ? lo : undefined,
      max: finite ? hi : undefined,
      // the padded extent is not a round tick; label only the interior ticks
      axisLabel: { showMinLabel: !finite, showMaxLabel: !finite },
    }),
    series: [
      {
        type: "line",
        name: yName,
        data: pts.map((p) => [p.x, p.y]),
        symbol: "none",
        lineStyle: { color: C.muted, width: 1 },
        itemStyle: { color: C.muted },
        markArea:
          pts.length && finite
            ? {
                silent: true,
                itemStyle: { color: C.amber, opacity: 0.12 },
                // mean ± stdDev band, spanning the x-domain
                data: [[{ yAxis: mean - sd }, { yAxis: mean + sd }]],
              }
            : undefined,
        markLine: {
          silent: true,
          symbol: "none",
          label: { show: false },
          lineStyle: { color: C.amber, type: [4, 3], width: 1.1 },
          data: finite ? [{ yAxis: mean }] : [],
        },
      },
    ],
  };
}

export function lowVariancePlot(
  values: ArrayLike<number>,
  res: LowVarianceResult,
  opts: TabularVizOptions = {},
): HTMLElement {
  return renderChart(lowVarianceOption(values, res, opts), { width: opts.width, height: opts.height ?? 320 });
}
