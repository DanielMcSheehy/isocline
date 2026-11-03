// Decomposition visualization: trend / seasonal / residual rows.
// One chart, three stacked grids sharing the x domain, each row with its own
// y axis (a shared y would crush resid against trend).
import type { EChartsOption, GridComponentOption, XAXisComponentOption, YAXisComponentOption } from "echarts";
import type { SeriesInput, DecomposeResult } from "isocline";
import { C, isoclineTheme, grid, tooltip, yAxis, fmt } from "./theme.js";
import { seriesXAxis, xOf, tipList, tipMarker, tipValue, type IsoclineSeriesOption, type TipParams } from "./util.js";
import { renderChart } from "./render.js";

export interface DecomposeVizOptions {
  height?: number; // per row (default 150)
  width?: number;
  xLabel?: string;
}

const TOP = 26; // room above the first row for its y-axis name
const BOTTOM = 46; // room below the last row for x labels + x-axis name
const GAP = 30; // between rows: next row's y-axis name

function rows(series: SeriesInput, a: Float64Array | null): [number, number][] {
  if (!a) return [];
  const out: [number, number][] = [];
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    if (v !== undefined && Number.isFinite(v) && Number.isFinite(Number(series.y[i]))) out.push([xOf(series, i), v]);
  }
  return out;
}

/** Total chart height for a per-row height `h`. */
export function decomposeHeight(h = 150): number {
  return 3 * h + TOP + BOTTOM - GAP;
}

export function decomposeOption(series: SeriesInput, dec: DecomposeResult, opts: DecomposeVizOptions = {}): EChartsOption {
  const h = opts.height ?? 150;
  const defs = [
    { label: "trend", data: rows(series, dec.trend), color: C.amber },
    { label: `seasonal · strength ${fmt(dec.seasonalStrength)}`, data: rows(series, dec.seasonal), color: C.cyan },
    { label: "residual", data: rows(series, dec.resid), color: C.muted },
  ];
  const grids: GridComponentOption[] = [];
  const xAxes: XAXisComponentOption[] = [];
  const yAxes: YAXisComponentOption[] = [];
  const out: IsoclineSeriesOption[] = [];
  defs.forEach((d, i) => {
    const last = i === defs.length - 1;
    // containLabel off so the three plot areas line up exactly; fixed left margin fits the y ticks.
    grids.push(grid({ containLabel: false, left: 56, right: 20, top: TOP + i * h, height: h - GAP }));
    xAxes.push(
      seriesXAxis(series, opts.xLabel, {
        gridIndex: i,
        ...(last ? {} : { name: "", axisLabel: { show: false }, axisTick: { show: false } }),
      } as XAXisComponentOption),
    );
    yAxes.push(yAxis({ type: "value", gridIndex: i, name: d.label, splitNumber: 3 }));
    out.push({
      type: "line",
      name: d.label.split(" ")[0],
      xAxisIndex: i,
      yAxisIndex: i,
      data: d.data,
      symbol: "none",
      lineStyle: { color: d.color, width: 1.1 },
      itemStyle: { color: d.color },
    });
  });
  return {
    ...isoclineTheme,
    grid: grids,
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    tooltip: tooltip({
      trigger: "axis",
      axisPointer: { type: "line", lineStyle: { color: "rgba(255,255,255,0.25)" } },
      formatter: (p: TipParams | TipParams[]) =>
        tipList(p)
          .map((it) => `${tipMarker(it)}${it.seriesName ?? ""} ${fmt(tipValue(it, 1))}`)
          .join("<br/>"),
    }),
    xAxis: xAxes,
    yAxis: yAxes,
    series: out,
  };
}

export function decomposePlot(series: SeriesInput, dec: DecomposeResult, opts: DecomposeVizOptions = {}): HTMLElement {
  const el = renderChart(decomposeOption(series, dec, opts), { width: opts.width, height: decomposeHeight(opts.height) });
  el.classList.add("isocline-decompose");
  return el;
}
