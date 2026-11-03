// Changepoint visualization: series + segment-mean steps + split rules.
import type { EChartsOption } from "echarts";
import type { SeriesInput, ChangepointResult } from "isocline";
import { C, isoclineTheme, grid, tooltip, yAxis, fmt } from "./theme.js";
import { toPoints, seriesXAxis, xOf, tipList, type IsoclineSeriesOption, type TipParams } from "./util.js";
import { renderChart } from "./render.js";

export interface ChangepointVizOptions {
  height?: number;
  width?: number;
  xLabel?: string;
  yLabel?: string;
}

export function changepointOption(series: SeriesInput, res: ChangepointResult, opts: ChangepointVizOptions = {}): EChartsOption {
  const means = Array.from(res.means, (v, i): [number, number] => [xOf(series, i), v]).filter((d) => Number.isFinite(d[1]));
  const cps = res.changepoints;
  const out: IsoclineSeriesOption[] = [
    {
      type: "line",
      name: "segment mean",
      data: means,
      step: "end",
      symbol: "none",
      silent: true,
      lineStyle: { color: C.amber, width: 1.4, opacity: 0.9 },
      markLine: {
        silent: true,
        symbol: "none",
        label: { show: false },
        lineStyle: { color: C.amber, type: [5, 4], width: 1.1 },
        data: cps.map((cp) => ({ xAxis: xOf(series, cp.index) })),
      },
    },
    {
      type: "line",
      name: "series",
      data: toPoints(series).map((p) => [p.x, p.y]),
      symbol: "none",
      silent: true,
      lineStyle: { color: C.cyan, width: 1.1 },
    },
    {
      type: "scatter",
      name: "changepoint",
      data: cps.map((cp) => [xOf(series, cp.index), cp.meanAfter]),
      symbolSize: 7,
      itemStyle: { color: C.amber, borderColor: C.bg, borderWidth: 0.8 },
      z: 5,
      tooltip: {
        formatter: (p: TipParams | TipParams[]) =>
          tipList(p)
            .map((it) => cps[it.dataIndex])
            .map((cp) => (cp ? `<b>#${cp.index}</b><br/>μ ${fmt(cp.meanBefore)} → ${fmt(cp.meanAfter)}` : ""))
            .join(""),
      },
    },
  ];
  return {
    ...isoclineTheme,
    grid: grid(),
    tooltip: tooltip({ trigger: "item" }),
    xAxis: seriesXAxis(series, opts.xLabel),
    yAxis: yAxis({ type: "value", name: opts.yLabel ?? "value" }),
    series: out,
  };
}

export function changepointPlot(series: SeriesInput, res: ChangepointResult, opts: ChangepointVizOptions = {}): HTMLElement {
  return renderChart(changepointOption(series, res, opts), { width: opts.width, height: opts.height ?? 320 });
}
