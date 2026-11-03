// Backtest leaderboard: models × metrics heatmap with rank-normalized color.
import type { EChartsOption } from "echarts";
import type { BacktestResult } from "isocline";
import { C, isoclineTheme, grid, tooltip, xAxis, yAxis, fmt } from "./theme.js";
import { tipList, tipValue, type TipParams } from "./util.js";
import { renderChart } from "./render.js";

export interface BacktestVizOptions {
  height?: number;
  width?: number;
}

const METRICS = ["rmse", "mae", "smape", "coverage"] as const;

const cellText = (metric: string, v: number): string => (metric === "coverage" ? `${fmt(v * 100)}%` : fmt(v));

export function backtestOption(res: BacktestResult): EChartsOption {
  // sort models by rmse ascending (best on top row)
  const byModel = new Map(res.rows.map((r) => [r.model, r]));
  const order = [...res.rows].sort((a, b) => a.rmse - b.rmse).map((r) => r.model);
  // cell = [metricIdx, modelIdx, value, rank∈[0,1]] (rank 0 = best for that metric)
  const cells: [number, number, number, number][] = [];
  METRICS.forEach((metric, mi) => {
    const vals = order.map((m) => byModel.get(m)?.[metric] ?? NaN).map((v) => (Number.isFinite(v) ? v : 0));
    const sorted = [...vals].sort((a, b) => (metric === "coverage" ? b - a : a - b)); // high coverage is good
    order.forEach((m, yi) => {
      const v = byModel.get(m)?.[metric] ?? NaN;
      const rank = sorted.indexOf(Number.isFinite(v) ? v : 0) / Math.max(1, order.length - 1);
      cells.push([mi, yi, v, Number.isFinite(rank) ? rank : 0.5]);
    });
  });
  return {
    ...isoclineTheme,
    grid: grid({ top: 10, bottom: 10, left: 10 }),
    tooltip: tooltip({
      trigger: "item",
      formatter: (p: TipParams | TipParams[]) =>
        tipList(p)
          .map((it) => {
            const metric = METRICS[tipValue(it, 0)] ?? "";
            return `${order[tipValue(it, 1)] ?? ""} · ${metric}<br/>${cellText(metric, tipValue(it, 2))}`;
          })
          .join(""),
    }),
    xAxis: xAxis({ type: "category", data: [...METRICS], name: "", axisTick: { show: false }, axisLine: { show: false } }),
    yAxis: yAxis({ type: "category", data: order, name: "", inverse: true, axisTick: { show: false }, axisLine: { show: false } }),
    visualMap: {
      show: false,
      type: "continuous",
      dimension: 3,
      min: 0,
      max: 1,
      inRange: { color: [C.violet, C.cyan], colorAlpha: 0.75 },
    },
    series: [
      {
        type: "heatmap",
        name: "backtest",
        data: cells,
        itemStyle: { borderColor: C.bg, borderWidth: 2, borderRadius: 3 },
        label: {
          show: true,
          color: C.ink,
          fontSize: 10.5,
          formatter: (p: TipParams) => cellText(METRICS[tipValue(p, 0)] ?? "", tipValue(p, 2)),
        },
        emphasis: { itemStyle: { borderColor: C.ink, borderWidth: 1 } },
      },
    ],
  };
}

export function backtestPlot(res: BacktestResult, opts: BacktestVizOptions = {}): HTMLElement {
  const height = opts.height ?? Math.max(120, 40 * res.rows.length + 60);
  return renderChart(backtestOption(res), { width: opts.width, height });
}

/** Winning (lowest-RMSE) model name. */
export function backtestWinner(res: BacktestResult): string {
  return [...res.rows].sort((a, b) => a.rmse - b.rmse)[0]?.model ?? "—";
}
