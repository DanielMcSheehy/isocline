// Decomposition visualization: trend / seasonal / residual rows.
// Implemented as three stacked plots in one container (independent y scales —
// Plot facets share scales, which would crush resid against trend).
import * as Plot from "@observablehq/plot";
import type { SeriesInput, DecomposeResult } from "isocline";
import { C, isoclineTheme, applyIsoclineCss, fmt } from "./theme.js";
import { xScale } from "./util.js";

export interface DecomposeVizOptions {
  height?: number; // per row
  width?: number;
  xLabel?: string;
}

interface Row {
  x: number | Date;
  y: number;
}

function rows(series: SeriesInput, a: Float64Array | null): Row[] {
  if (!a) return [];
  const t = series.t;
  const out: Row[] = [];
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    if (v !== undefined && Number.isFinite(v) && Number.isFinite(Number(series.y[i]))) {
      out.push({ x: t ? new Date(Number(t[i])) : i, y: v });
    }
  }
  return out;
}

export function decomposePlot(series: SeriesInput, dec: DecomposeResult, opts: DecomposeVizOptions = {}): HTMLElement {
  applyIsoclineCss();
  const h = opts.height ?? 150;
  const defs: { label: string; data: Row[]; color: string; dash?: string }[] = [
    { label: "trend", data: rows(series, dec.trend), color: C.amber },
    { label: `seasonal · strength ${fmt(dec.seasonalStrength)}`, data: rows(series, dec.seasonal), color: C.cyan },
    { label: "residual", data: rows(series, dec.resid), color: C.muted },
  ];
  const container = document.createElement("div");
  container.className = "isocline-plot isocline-decompose";
  container.style.display = "flex";
  container.style.flexDirection = "column";
  container.style.gap = "6px";
  for (const d of defs) {
    const fig = Plot.plot({
      ...isoclineTheme,
      marginBottom: d === defs[defs.length - 1] ? 30 : 4,
      x:
        d === defs[defs.length - 1]
          ? { ...isoclineTheme.x, ...xScale(series, opts.xLabel), grid: true }
          : { ...isoclineTheme.x, axis: false },
      y: { ...isoclineTheme.y, label: d.label, grid: true, tickFormat: (v: number) => fmt(v) },
      height: h,
      ...(opts.width ? { width: opts.width } : {}),
      marks: [Plot.line(d.data, { x: "x", y: "y", stroke: d.color, strokeWidth: 1.1 })],
    } as Plot.PlotOptions);
    container.appendChild(fig as HTMLElement);
  }
  return container;
}
