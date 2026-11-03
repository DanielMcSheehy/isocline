// Seasonality visualization: ACF (lollipop + confidence band) and periodogram
// (log period axis), best period annotated. One chart, two side-by-side grids.
import type { EChartsOption } from "echarts";
import type { SeasonalityResult } from "isocline";
import { C, isoclineTheme, grid, tooltip, xAxis, yAxis, fmt, fmtTick } from "./theme.js";
import { tipList, tipValue, type IsoclineSeriesOption, type TipParams } from "./util.js";
import { renderChart } from "./render.js";

export interface SeasonalityVizOptions {
  height?: number;
  width?: number; // total (both panels)
}

/** Power of the periodogram point closest to `period` on the log axis. */
function nearestPower(pg: [number, number][], period: number): number {
  let bestD = Infinity;
  let power = 0;
  for (const [p, v] of pg) {
    const d = Math.abs(Math.log(p / period));
    if (d < bestD) {
      bestD = d;
      power = v;
    }
  }
  return power;
}

export function seasonalityOption(res: SeasonalityResult): EChartsOption {
  const n = res.acf.length; // ≈ effective sample size at lag 0
  const ci = 1.96 / Math.sqrt(Math.max(8, n));
  const acfData = Array.from(res.acf, (v, k): [number, number] => [Number(res.lags[k] ?? k), v]);
  const pgData: [number, number][] = [];
  for (let k = 1; k < res.periodogram.length; k++) {
    const f = res.frequencies[k];
    const p = res.periodogram[k];
    if (f !== undefined && p !== undefined && f > 0 && Number.isFinite(p) && p >= 0) pgData.push([1 / f, p]);
  }
  pgData.sort((a, b) => a[0] - b[0]);
  const pMin = pgData.length ? Math.max(1.5, pgData[0]![0]) : 1;
  const pMax = pgData.length ? pgData[pgData.length - 1]![0] : 10;
  const best = res.bestPeriod;

  const series: IsoclineSeriesOption[] = [
    {
      type: "bar",
      name: "acf",
      data: acfData,
      barWidth: 1.4,
      itemStyle: { color: C.cyan, opacity: 0.55 },
      silent: true,
      tooltip: { show: false },
      markArea: {
        silent: true,
        itemStyle: { color: "rgba(255,255,255,0.035)" },
        data: [[{ yAxis: -ci }, { yAxis: ci }]],
      },
      markLine: {
        silent: true,
        symbol: "none",
        label: { show: false },
        data: [
          { yAxis: -ci, lineStyle: { color: "rgba(255,255,255,0.18)", type: [4, 3], width: 1 } },
          { yAxis: ci, lineStyle: { color: "rgba(255,255,255,0.18)", type: [4, 3], width: 1 } },
          { yAxis: 0, lineStyle: { color: C.muted, opacity: 0.4, type: "solid", width: 1 } },
        ],
      },
    },
    { type: "scatter", name: "lag", data: acfData, symbolSize: 3.2, itemStyle: { color: C.cyan } },
  ];
  if (best != null) {
    series.push({
      type: "scatter",
      name: "best lag",
      data: [[best, res.acf[best] ?? 0]],
      symbolSize: 8,
      itemStyle: { color: C.amber, borderColor: C.bg, borderWidth: 1 },
      z: 5,
    });
  }
  series.push({
    type: "line",
    name: "power",
    xAxisIndex: 1,
    yAxisIndex: 1,
    data: pgData,
    step: "middle",
    symbol: "none",
    lineStyle: { color: C.violet, width: 1.2 },
    itemStyle: { color: C.violet },
    areaStyle: { color: C.violet, opacity: 0.18 },
    markLine:
      best == null
        ? undefined
        : {
            silent: true,
            symbol: "none",
            lineStyle: { color: C.amber, type: [5, 4], width: 1.2 },
            label: { show: false },
            data: [{ xAxis: best }],
          },
    // `p ≈ N` beside the spectral peak nearest the best period
    markPoint:
      best == null
        ? undefined
        : {
            silent: true,
            symbol: "circle",
            symbolSize: 0,
            label: { show: true, formatter: `p ≈ ${best}`, color: C.amber, fontSize: 11, position: "right", distance: 6 },
            data: [{ name: "best period", coord: [best, nearestPower(pgData, best)] }],
          },
  });

  return {
    ...isoclineTheme,
    grid: [grid({ left: 10, right: "53%" }), grid({ left: "53%", right: 20 })],
    tooltip: tooltip({
      trigger: "item",
      formatter: (p: TipParams | TipParams[]) =>
        tipList(p)
          .map((it) =>
            it.seriesName === "power"
              ? `period ${fmt(tipValue(it, 0))}<br/>power ${fmt(tipValue(it, 1))}`
              : `lag ${tipValue(it, 0)}<br/>acf ${fmt(tipValue(it, 1))}`,
          )
          .join("<br/>"),
    }),
    xAxis: [
      xAxis({ type: "value", gridIndex: 0, name: "lag", min: 0, max: "dataMax" }),
      xAxis({ type: "log", gridIndex: 1, name: "period (samples, log)", min: pMin, max: pMax, axisLabel: { formatter: (v: number) => fmtTick(Number(v.toPrecision(3))) } }),
    ],
    yAxis: [
      yAxis({ type: "value", gridIndex: 0, name: "autocorrelation" }),
      yAxis({ type: "value", gridIndex: 1, name: "spectral power", scale: false }),
    ],
    series,
  };
}

export function seasonalityPlot(res: SeasonalityResult, opts: SeasonalityVizOptions = {}): HTMLElement {
  const el = renderChart(seasonalityOption(res), { width: opts.width, height: opts.height ?? 260 });
  el.classList.add("isocline-seasonality");
  return el;
}

/** Candidate chips data for callers (CONTRACT §6 helper). */
export function seasonalityCandidates(res: SeasonalityResult): { period: number; strength: number; source: string }[] {
  return res.candidates.map((c) => ({ ...c }));
}
