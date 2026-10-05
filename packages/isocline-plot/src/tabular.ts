// Tabular detector visualizations (CONTRACT §11): correlation, majority,
// category outlier, low variance. Non-temporal — x is never a time axis.
import * as Plot from "@observablehq/plot";
import type {
  CorrelationResult,
  MajorityResult,
  CategoryOutlierResult,
  LowVarianceResult,
} from "isocline";
import { C, isoclineTheme, applyIsoclineCss, fmt } from "./theme.js";
import type { MarkSpec } from "./forecast.js";

export interface TabularVizOptions {
  height?: number;
  width?: number;
  xLabel?: string;
  yLabel?: string;
}

const INK_STROKE = "#0b0e14"; // dark halo around colored dots (matches anomaly/changepoint)

/** Finite (a, b) pairs, aligned by index; NaN/Infinity filtered. */
function pairsOf(a: ArrayLike<number>, b: ArrayLike<number>): { x: number; y: number }[] {
  const n = Math.min(a.length, b.length);
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const x = Number(a[i]);
    const y = Number(b[i]);
    if (Number.isFinite(x) && Number.isFinite(y)) out.push({ x, y });
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

export function correlationMarks(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  res: CorrelationResult,
  opts: TabularVizOptions = {},
): MarkSpec {
  const pts = pairsOf(a, b);
  const marks: Plot.Markish[] = [
    Plot.dot(pts, { x: "x", y: "y", fill: C.muted, fillOpacity: 0.7, r: 2.5 }),
  ];
  // OLS fit line across the a-domain (cyan); skipped when the domain is degenerate.
  const xs = extentOf(pts.map((p) => p.x));
  const slope = Number(res.slope);
  const intercept = Number(res.intercept);
  if (xs && Number.isFinite(slope) && Number.isFinite(intercept) && xs[0] !== xs[1]) {
    const fit = [
      { x: xs[0], y: slope * xs[0] + intercept },
      { x: xs[1], y: slope * xs[1] + intercept },
    ];
    marks.push(Plot.line(fit, { x: "x", y: "y", stroke: C.cyan, strokeWidth: 1.6 }));
  }
  marks.push(
    Plot.text([correlationHeadline(res)], {
      frameAnchor: "top-left",
      dx: 8,
      dy: 14,
      fontSize: 12,
      fill: C.ink,
    }),
  );
  const plotOptions: Partial<Plot.PlotOptions> = {
    ...isoclineTheme,
    x: { ...isoclineTheme.x, nice: true, label: opts.xLabel ?? "a" },
    y: { ...isoclineTheme.y, label: opts.yLabel ?? "b" },
    height: opts.height ?? 320,
  };
  if (opts.width) plotOptions.width = opts.width;
  return { marks, plotOptions };
}

export function correlationPlot(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  res: CorrelationResult,
  opts: TabularVizOptions = {},
): HTMLElement {
  applyIsoclineCss();
  const { marks, plotOptions } = correlationMarks(a, b, res, opts);
  const fig = Plot.plot({ ...plotOptions, marks } as Plot.PlotOptions);
  fig.classList.add("isocline-plot");
  return fig as HTMLElement;
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

export function majorityMarks(res: MajorityResult, opts: TabularVizOptions = {}): MarkSpec {
  const rows = majorityBars(res);
  const dom = res.dominant === null ? [] : rows.filter((r) => r.label === res.dominant);
  const rest = rows.filter((r) => r.label !== res.dominant);
  const marks: Plot.Markish[] = [
    Plot.barX(rest, { x: "proportion", y: "label", fill: C.muted }),
    Plot.barX(dom, { x: "proportion", y: "label", fill: C.cyan }),
    // dashed rule at the majority threshold
    Plot.ruleX([res.threshold], { stroke: C.amber, strokeDasharray: "4,3", strokeWidth: 1.1 }),
    Plot.text([{ x: res.threshold, t: `threshold ${pctLabel(res.threshold)}` }], {
      x: "x",
      text: "t",
      frameAnchor: "top",
      dy: 4,
      fontSize: 9,
      fill: C.amber,
    }),
    // right-margin percentage labels
    Plot.text(rows, { x: "proportion", y: "label", text: (d: MajorityRow) => pctLabel(d.proportion), textAnchor: "start", dx: 5, fill: C.ink, fontSize: 10 }),
  ];
  const plotOptions: Partial<Plot.PlotOptions> = {
    ...isoclineTheme,
    marginLeft: Math.max(isoclineTheme.marginLeft ?? 0, 92),
    marginRight: Math.max(isoclineTheme.marginRight ?? 0, 56),
    x: { ...isoclineTheme.x, domain: [0, 1], tickFormat: "%", label: opts.xLabel ?? "proportion", grid: true },
    // fixed domain keeps bar order identical to res.counts (desc) across both marks
    y: { ...isoclineTheme.y, grid: false, domain: rows.map((r) => r.label) },
    height: opts.height ?? 24 + 26 * rows.length,
  };
  if (opts.width) plotOptions.width = opts.width;
  return { marks, plotOptions };
}

export function majorityPlot(res: MajorityResult, opts: TabularVizOptions = {}): HTMLElement {
  applyIsoclineCss();
  const { marks, plotOptions } = majorityMarks(res, opts);
  const fig = Plot.plot({ ...plotOptions, marks } as Plot.PlotOptions);
  fig.classList.add("isocline-plot");
  return fig as HTMLElement;
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
  if (!d.isOutlier) return `${d.label}\nvalue ${fmt(d.value)}\nwithin fences`;
  const side = d.direction === "high" ? "above Q3" : "below Q1";
  return `${d.label}\nvalue ${fmt(d.value)}\n${fmt(d.dist)}×IQR ${side}`;
}

export function categoryOutlierMarks(res: CategoryOutlierResult, opts: TabularVizOptions = {}): MarkSpec {
  const rows = categoryRows(res);
  const normal = rows.filter((r) => !r.isOutlier);
  const high = rows.filter((r) => r.isOutlier && r.direction === "high");
  const low = rows.filter((r) => r.isOutlier && r.direction === "low");
  const marks: Plot.Markish[] = [
    // shaded IQR band (q1..q3) spanning the full width, then dashed fences
    Plot.rectY([{ y1: res.q1, y2: res.q3 }], {
      y1: "y1",
      y2: "y2",
      fill: C.amber,
      fillOpacity: 0.08,
    }),
    Plot.ruleY([res.lowerFence, res.upperFence], {
      stroke: C.amber,
      strokeDasharray: "4,3",
      strokeWidth: 1.1,
    }),
    Plot.dotX(normal, { x: "label", y: "value", fill: C.cyan, fillOpacity: 0.55, r: 3.2, stroke: INK_STROKE, strokeWidth: 0.8 }),
    Plot.dotX(high, { x: "label", y: "value", fill: C.red, r: 4, stroke: INK_STROKE, strokeWidth: 0.8 }),
    Plot.dotX(low, { x: "label", y: "value", fill: C.blue, r: 4, stroke: INK_STROKE, strokeWidth: 0.8 }),
  ];
  if (rows.length) {
    marks.push(
      Plot.tip(rows, { x: "label", y: "value", anchor: "bottom", title: outlierTitle }),
    );
  }
  const rotate = rows.some((r) => r.label.length > 8) ? 30 : 0;
  const plotOptions: Partial<Plot.PlotOptions> = {
    ...isoclineTheme,
    x: { ...isoclineTheme.x, tickRotate: rotate, label: opts.xLabel ?? "" },
    y: { ...isoclineTheme.y, nice: true, label: opts.yLabel ?? "value" },
    height: opts.height ?? 320,
  };
  if (opts.width) plotOptions.width = opts.width;
  return { marks, plotOptions };
}

export function categoryOutlierPlot(res: CategoryOutlierResult, opts: TabularVizOptions = {}): HTMLElement {
  applyIsoclineCss();
  const { marks, plotOptions } = categoryOutlierMarks(res, opts);
  const fig = Plot.plot({ ...plotOptions, marks } as Plot.PlotOptions);
  fig.classList.add("isocline-plot");
  return fig as HTMLElement;
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

export function lowVarianceMarks(
  values: ArrayLike<number>,
  res: LowVarianceResult,
  opts: TabularVizOptions = {},
): MarkSpec {
  const pts = variancePoints(values);
  const mean = Number(res.mean);
  const sd = Math.max(Number(res.stdDev) || 0, 0);
  const marks: Plot.Markish[] = [];
  if (pts.length && Number.isFinite(mean) && Number.isFinite(sd)) {
    // mean ± stdDev band, spanning the x-domain
    marks.push(
      Plot.areaY(
        [
          { x: pts[0]!.x, y1: mean - sd, y2: mean + sd },
          { x: pts[pts.length - 1]!.x, y1: mean - sd, y2: mean + sd },
        ],
        { x: "x", y1: "y1", y2: "y2", fill: C.amber, fillOpacity: 0.12, curve: "linear" },
      ),
    );
  }
  marks.push(
    Plot.ruleY([mean], { stroke: C.amber, strokeDasharray: "4,3", strokeWidth: 1.1 }),
    Plot.line(pts, { x: "x", y: "y", stroke: C.muted, strokeWidth: 1 }),
    Plot.text([lowVarianceHeadline(res)], {
      frameAnchor: "top-left",
      dx: 8,
      dy: 14,
      fontSize: 12,
      fill: C.ink,
    }),
  );
  // y-domain padded ±max(3σ, 1e-9) so flatness is visible; widened (never
  // clipped) when the series itself strays beyond the band.
  const pad = Math.max(3 * sd, 1e-9);
  let lo = mean - pad;
  let hi = mean + pad;
  for (const p of pts) {
    if (p.y < lo) lo = p.y;
    if (p.y > hi) hi = p.y;
  }
  const plotOptions: Partial<Plot.PlotOptions> = {
    ...isoclineTheme,
    x: { ...isoclineTheme.x, nice: true, label: opts.xLabel ?? "index" },
    y: { ...isoclineTheme.y, domain: [lo, hi], label: opts.yLabel ?? "value" },
    height: opts.height ?? 320,
  };
  if (opts.width) plotOptions.width = opts.width;
  return { marks, plotOptions };
}

export function lowVariancePlot(
  values: ArrayLike<number>,
  res: LowVarianceResult,
  opts: TabularVizOptions = {},
): HTMLElement {
  applyIsoclineCss();
  const { marks, plotOptions } = lowVarianceMarks(values, res, opts);
  const fig = Plot.plot({ ...plotOptions, marks } as Plot.PlotOptions);
  fig.classList.add("isocline-plot");
  return fig as HTMLElement;
}
