// Anomaly visualization: series + expected line + flagged spike/dip points.
import * as Plot from "@observablehq/plot";
import type { SeriesInput, AnomalyResult } from "isocline";
import { C, isoclineTheme, applyIsoclineCss, fmt } from "./theme.js";
import { toPoints, xScale } from "./util.js";
import type { MarkSpec } from "./forecast.js";

export interface AnomalyVizOptions {
  showExpected?: boolean; // default true
  height?: number;
  width?: number;
  xLabel?: string;
  yLabel?: string;
}

export function anomalyMarks(series: SeriesInput, res: AnomalyResult, opts: AnomalyVizOptions = {}): MarkSpec {
  const { showExpected = true } = opts;
  const pts = toPoints(series);
  const t = series.t;
  const xOf = (i: number): number | Date => (t ? new Date(Number(t[i])) : i);
  const expected = pts
    .filter((p) => Number.isFinite(res.expected[p.i]))
    .map((p) => ({ x: p.x, y: Number(res.expected[p.i]) }));
  const flagged = res.anomalies.map((a) => ({
    x: xOf(a.index),
    y: a.observed,
    i: a.index,
    dir: a.direction,
    score: a.score,
    exp: a.expected,
  }));
  const spikes = flagged.filter((d) => d.dir === "spike");
  const dips = flagged.filter((d) => d.dir === "dip");
  const marks: Plot.Markish[] = [];
  if (showExpected && expected.length) {
    marks.push(Plot.line(expected, { x: "x", y: "y", stroke: C.amber, strokeDasharray: "3,4", strokeWidth: 1 }));
  }
  marks.push(
    Plot.line(pts, { x: "x", y: "y", stroke: C.cyan, strokeWidth: 1.2 }),
    Plot.dot(spikes, { x: "x", y: "y", symbol: "triangle", fill: C.red, stroke: "#0b0e14", strokeWidth: 0.8, r: 4.5 }),
    Plot.dot(dips, { x: "x", y: "y", symbol: "triangle2", fill: C.blue, stroke: "#0b0e14", strokeWidth: 0.8, r: 4.5 }),
    Plot.tip(flagged, {
      x: "x",
      y: "y",
      anchor: "top",
      title: (d: (typeof flagged)[number]) =>
        `#${d.i} · ${d.dir}\nobserved ${fmt(d.y)}\nexpected ${fmt(d.exp)}\nscore ${fmt(d.score)}`,
    }),
  );
  const plotOptions: Partial<Plot.PlotOptions> = {
    ...isoclineTheme,
    x: { ...isoclineTheme.x, ...xScale(series, opts.xLabel), grid: true },
    y: { ...isoclineTheme.y, label: opts.yLabel ?? "value" },
    height: opts.height ?? 320,
  };
  if (opts.width) plotOptions.width = opts.width;
  return { marks, plotOptions };
}

export function anomalyPlot(series: SeriesInput, res: AnomalyResult, opts: AnomalyVizOptions = {}): HTMLElement {
  applyIsoclineCss();
  const { marks, plotOptions } = anomalyMarks(series, res, opts);
  const fig = Plot.plot({ ...plotOptions, marks } as Plot.PlotOptions);
  fig.classList.add("isocline-plot");
  return fig as HTMLElement;
}

/** Small stat helper for legends: split of flagged points by direction. */
export function anomalySplit(res: AnomalyResult): { spikes: number; dips: number } {
  let spikes = 0;
  let dips = 0;
  for (const a of res.anomalies) a.direction === "spike" ? spikes++ : dips++;
  return { spikes, dips };
}
