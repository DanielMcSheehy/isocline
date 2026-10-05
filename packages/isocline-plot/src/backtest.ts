// Backtest leaderboard: models × metrics heatmap with rank-normalized color.
import * as Plot from "@observablehq/plot";
import type { BacktestResult } from "isocline";
import { C, isoclineTheme, applyIsoclineCss, fmt } from "./theme.js";

export interface BacktestVizOptions {
  height?: number;
  width?: number;
}

const METRICS = ["rmse", "mae", "smape", "coverage"] as const;
type MetricName = (typeof METRICS)[number];

export function backtestPlot(res: BacktestResult, opts: BacktestVizOptions = {}): HTMLElement {
  applyIsoclineCss();
  // sort models by rmse ascending (best on top row)
  const byModel = new Map(res.rows.map((r) => [r.model, r]));
  const order = [...res.rows].sort((a, b) => a.rmse - b.rmse).map((r) => r.model);
  const cells: { model: string; metric: MetricName; value: number; rank: number }[] = [];
  for (const metric of METRICS) {
    const vals = order
      .map((m) => byModel.get(m)?.[metric] ?? NaN)
      .map((v) => (Number.isFinite(v) ? v : 0));
    const sorted = [...vals].sort((a, b) => (metric === "coverage" ? b - a : a - b)); // high coverage is good
    for (let i = 0; i < order.length; i++) {
      const m = order[i];
      if (!m) continue;
      const v = byModel.get(m)?.[metric] ?? NaN;
      const rank = sorted.indexOf(Number.isFinite(v) ? v : 0) / Math.max(1, order.length - 1);
      cells.push({ model: m, metric, value: v, rank: Number.isFinite(rank) ? rank : 0.5 });
    }
  }
  const fig = Plot.plot({
    ...isoclineTheme,
    marginTop: 10,
    marginLeft: 90,
    marginBottom: 30,
    x: { ...isoclineTheme.x, label: null, tickPadding: 6, domain: [...METRICS] },
    y: { ...isoclineTheme.y, label: null, grid: false, domain: order.reverse() },
    color: { range: [C.violet, C.cyan], scheme: undefined, legend: false },
    height: opts.height ?? Math.max(120, 40 * order.length + 60),
    ...(opts.width ? { width: opts.width } : {}),
    marks: [
      Plot.cell(cells, { x: "metric", y: "model", fill: "rank", fillOpacity: 0.75 }),
      Plot.text(cells, {
        x: "metric",
        y: "model",
        text: (d: (typeof cells)[number]) => (d.metric === "coverage" ? `${fmt(d.value * 100)}%` : fmt(d.value)),
        fill: C.ink,
        fontSize: 10.5,
      }),
    ],
  } as Plot.PlotOptions);
  fig.classList.add("isocline-plot");
  return fig as HTMLElement;
}

/** Winning (lowest-RMSE) model name. */
export function backtestWinner(res: BacktestResult): string {
  return [...res.rows].sort((a, b) => a.rmse - b.rmse)[0]?.model ?? "—";
}
