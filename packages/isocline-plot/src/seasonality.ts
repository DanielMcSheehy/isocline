// Seasonality visualization: ACF (lollipop + confidence band) and periodogram,
// best period annotated. Two side-by-side plots (independent x scales).
import * as Plot from "@observablehq/plot";
import type { SeasonalityResult } from "isocline";
import { C, isoclineTheme, applyIsoclineCss, fmt } from "./theme.js";

export interface SeasonalityVizOptions {
  height?: number;
  width?: number; // per panel
}

export function seasonalityPlot(res: SeasonalityResult, opts: SeasonalityVizOptions = {}): HTMLElement {
  applyIsoclineCss();
  const h = opts.height ?? 260;
  const n = res.acf.length; // ≈ effective sample size at lag 0
  const ci = 1.96 / Math.sqrt(Math.max(8, n));
  const acfData = Array.from(res.acf, (v, k) => ({ lag: Number(res.lags[k] ?? k), acf: v }));
  const pgData: { period: number; power: number }[] = [];
  for (let k = 1; k < res.periodogram.length; k++) {
    const f = res.frequencies[k];
    const p = res.periodogram[k];
    if (f !== undefined && p !== undefined && f > 0 && Number.isFinite(p) && p >= 0) {
      pgData.push({ period: 1 / f, power: p });
    }
  }

  const acfPlot = Plot.plot({
    ...isoclineTheme,
    x: { ...isoclineTheme.x, grid: true, label: "lag", nice: true },
    y: { ...isoclineTheme.y, grid: true, label: "autocorrelation" },
    height: h,
    ...(opts.width ? { width: opts.width } : {}),
    marks: [
      Plot.ruleY([-ci, ci], { stroke: C.grid, strokeDasharray: "4,3" }),
      Plot.ruleY([0], { stroke: C.muted, strokeOpacity: 0.4 }),
      Plot.link(acfData, { x1: "lag", y1: 0, x2: "lag", y2: "acf", stroke: C.cyan, strokeOpacity: 0.55, strokeWidth: 1.4 }),
      Plot.dot(acfData, { x: "lag", y: "acf", fill: C.cyan, r: 1.6 }),
      ...(res.bestPeriod != null
        ? [Plot.dot([{ lag: res.bestPeriod, acf: res.acf[res.bestPeriod] ?? 0 }], { x: "lag", y: "acf", fill: C.amber, r: 4, stroke: "#0b0e14" })]
        : []),
    ],
  } as Plot.PlotOptions);

  const pgPlot = Plot.plot({
    ...isoclineTheme,
    x: { ...isoclineTheme.x, grid: true, label: "period (samples, log)", type: "log", domain: pgData.length ? [Math.max(1.5, Math.min(...pgData.map((d) => d.period))), Math.max(...pgData.map((d) => d.period))] : [1, 10] },
    y: { ...isoclineTheme.y, grid: true, label: "spectral power" },
    height: h,
    ...(opts.width ? { width: opts.width } : {}),
    marks: [
      Plot.areaY(pgData, { x: "period", y: "power", fill: C.violet, fillOpacity: 0.18, curve: "step" }),
      Plot.line(pgData, { x: "period", y: "power", stroke: C.violet, strokeWidth: 1.2, curve: "step" }),
      ...(res.bestPeriod != null
        ? [
            Plot.ruleX([res.bestPeriod], { stroke: C.amber, strokeDasharray: "5,4", strokeWidth: 1.2 }),
            Plot.text([{ period: res.bestPeriod, power: 0 }], {
              x: "period",
              y: "power",
              text: () => `p ≈ ${res.bestPeriod}`,
              fill: C.amber,
              dy: 16,
              dx: -6,
              fontSize: 11,
            }),
          ]
        : []),
    ],
  } as Plot.PlotOptions);

  const container = document.createElement("div");
  container.className = "isocline-plot isocline-seasonality";
  container.style.display = "flex";
  container.style.gap = "10px";
  container.style.alignItems = "flex-start";
  container.style.flexWrap = "wrap";
  (acfPlot as HTMLElement).style.flex = "1 1 380px";
  (pgPlot as HTMLElement).style.flex = "1 1 380px";
  container.appendChild(acfPlot as HTMLElement);
  container.appendChild(pgPlot as HTMLElement);
  return container;
}

/** Candidate chips data for callers (CONTRACT §6 helper). */
export function seasonalityCandidates(res: SeasonalityResult): { period: number; strength: number; source: string }[] {
  return res.candidates.map((c) => ({ ...c }));
}
