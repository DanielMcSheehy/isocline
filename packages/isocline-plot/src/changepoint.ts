// Changepoint visualization: series + segment-mean steps + split rules.
import * as Plot from "@observablehq/plot";
import type { SeriesInput, ChangepointResult } from "isocline";
import { C, isoclineTheme, applyIsoclineCss, fmt } from "./theme.js";
import { toPoints, xScale } from "./util.js";
import type { MarkSpec } from "./forecast.js";

export interface ChangepointVizOptions {
  height?: number;
  width?: number;
  xLabel?: string;
  yLabel?: string;
}

export function changepointMarks(series: SeriesInput, res: ChangepointResult, opts: ChangepointVizOptions = {}): MarkSpec {
  const t = series.t;
  const xOf = (i: number): number | Date => (t ? new Date(Number(t[i])) : i);
  const meanRows = Array.from(res.means, (v, i) => ({ x: xOf(i), y: v })).filter((d) => Number.isFinite(d.y));
  const rules = res.changepoints.map((cp) => ({ x: xOf(cp.index), cp }));
  const marks: Plot.Markish[] = [
    Plot.ruleX(rules, { x: "x", stroke: C.amber, strokeDasharray: "5,4", strokeWidth: 1.1 }),
    Plot.line(meanRows, { x: "x", y: "y", stroke: C.amber, strokeWidth: 1.4, curve: "step-after", strokeOpacity: 0.9 }),
    Plot.line(toPoints(series), { x: "x", y: "y", stroke: C.cyan, strokeWidth: 1.1 }),
    Plot.dot(rules, { x: "x", y: (d: { x: number | Date; cp: { meanAfter: number } }) => d.cp.meanAfter, fill: C.amber, r: 3.2, stroke: "#0b0e14", strokeWidth: 0.8 }),
    Plot.tip(rules, {
      x: "x",
      y: (d: { cp: { meanAfter: number } }) => d.cp.meanAfter,
      anchor: "left",
      title: (d: { cp: { index: number; meanBefore: number; meanAfter: number } }) =>
        `#${d.cp.index}\nμ ${fmt(d.cp.meanBefore)} → ${fmt(d.cp.meanAfter)}`,
    }),
  ];
  const plotOptions: Partial<Plot.PlotOptions> = {
    ...isoclineTheme,
    x: { ...isoclineTheme.x, ...xScale(series, opts.xLabel), grid: true },
    y: { ...isoclineTheme.y, label: opts.yLabel ?? "value" },
    height: opts.height ?? 320,
  };
  if (opts.width) plotOptions.width = opts.width;
  return { marks, plotOptions };
}

export function changepointPlot(series: SeriesInput, res: ChangepointResult, opts: ChangepointVizOptions = {}): HTMLElement {
  applyIsoclineCss();
  const { marks, plotOptions } = changepointMarks(series, res, opts);
  const fig = Plot.plot({ ...plotOptions, marks } as Plot.PlotOptions);
  fig.classList.add("isocline-plot");
  return fig as HTMLElement;
}
