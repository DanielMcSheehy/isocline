// Forecast visualization: history + point forecast + PI band + bootstrap paths.
import * as Plot from "@observablehq/plot";
import type { SeriesInput, ForecastResult } from "isocline";
import { C, isoclineTheme, applyIsoclineCss } from "./theme.js";
import { toPoints, xScale, futureX, type Pt } from "./util.js";

export interface ForecastVizOptions {
  paths?: boolean; // draw bootstrap sample paths (default false)
  showComponents?: boolean; // draw projected trend/seasonal when present
  showBand?: boolean; // draw PI band (default true)
  height?: number;
  width?: number;
  xLabel?: string;
  yLabel?: string;
  title?: string;
}

export interface MarkSpec {
  marks: Plot.Markish[];
  plotOptions: Partial<Plot.PlotOptions>;
}

function forecastData(series: SeriesInput, fc: ForecastResult): { fpts: Pt[]; band: { x: number | Date; lo: number; hi: number }[]; pathLines: { x: number | Date; y: number; path: number }[]; trend: Pt[]; seasonal: Pt[] } {
  const hist = toPoints(series);
  const last = hist[hist.length - 1];
  const fpts: Pt[] = last ? [{ ...last }, ...Array.from({ length: fc.horizon }, (_, k) => ({ x: futureX(series, k), y: fc.point[k] ?? NaN, i: last.i + 1 + k }))] : [];
  const band = Array.from({ length: fc.horizon }, (_, k) => ({
    x: futureX(series, k),
    lo: fc.lower[k] ?? NaN,
    hi: fc.upper[k] ?? NaN,
  }));
  const pathLines: { x: number | Date; y: number; path: number }[] = [];
  if (fc.paths) {
    const nDraw = Math.min(60, fc.pathsN || 0);
    const stride = Math.max(1, Math.ceil((fc.pathsN || 0) / nDraw));
    for (let p = 0; p < nDraw; p++) {
      const off = p * stride * fc.horizon;
      for (let k = 0; k < fc.horizon; k++) {
        const v = fc.paths[off + k];
        if (v !== undefined && Number.isFinite(v)) pathLines.push({ x: futureX(series, k), y: v, path: p });
      }
    }
  }
  const proj = (a: Float64Array | null): Pt[] =>
    a ? Array.from({ length: fc.horizon }, (_, k) => ({ x: futureX(series, k), y: a[k] ?? NaN, i: k })) : [];
  return { fpts, band, pathLines, trend: proj(fc.trend), seasonal: proj(fc.seasonal) };
}

export function forecastMarks(series: SeriesInput, fc: ForecastResult, opts: ForecastVizOptions = {}): MarkSpec {
  const { showBand = true } = opts;
  const { fpts, band, pathLines, trend, seasonal } = forecastData(series, fc);
  const splitX = fpts.length ? (fpts[0] as { x: number | Date }).x : 0;
  const marks: Plot.Markish[] = [
    Plot.ruleX([splitX], { stroke: C.grid, strokeWidth: 1 }),
  ];
  if (showBand && band.length) {
    marks.push(Plot.areaY(band, { x: "x", y1: "lo", y2: "hi", fill: C.violet, fillOpacity: 0.15, curve: "linear" }));
  }
  if (opts.paths && pathLines.length) {
    marks.push(Plot.line(pathLines, { x: "x", y: "y", z: "path", stroke: C.violet, strokeOpacity: 0.12, strokeWidth: 0.7 }));
  }
  if (opts.showComponents && trend.length) {
    marks.push(Plot.line(trend, { x: "x", y: "y", stroke: C.amber, strokeDasharray: "4,3", strokeWidth: 1.2 }));
  }
  if (opts.showComponents && seasonal.length) {
    marks.push(Plot.line(seasonal, { x: "x", y: "y", stroke: C.green, strokeWidth: 1.2 }));
  }
  marks.push(
    Plot.line(toPoints(series), { x: "x", y: "y", stroke: C.cyan, strokeWidth: 1.2 }),
    Plot.line(fpts, { x: "x", y: "y", stroke: C.violet, strokeDasharray: "5,4", strokeWidth: 1.6 }),
    Plot.dot([fpts[fpts.length - 1]], { x: "x", y: "y", fill: C.violet, r: 2.5 }),
  );
  const plotOptions: Partial<Plot.PlotOptions> = {
    ...isoclineTheme,
    x: { ...isoclineTheme.x, ...xScale(series, opts.xLabel), grid: true },
    y: { ...isoclineTheme.y, label: opts.yLabel ?? "value" },
    height: opts.height ?? 320,
  };
  if (opts.width) plotOptions.width = opts.width;
  if (opts.title) plotOptions.title = opts.title;
  return { marks, plotOptions };
}

export function forecastPlot(series: SeriesInput, fc: ForecastResult, opts: ForecastVizOptions = {}): HTMLElement {
  applyIsoclineCss();
  const { marks, plotOptions } = forecastMarks(series, fc, opts);
  const fig = Plot.plot({ ...plotOptions, marks } as Plot.PlotOptions);
  fig.classList.add("isocline-plot");
  return fig as HTMLElement;
}
