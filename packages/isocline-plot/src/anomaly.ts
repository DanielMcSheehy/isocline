// Anomaly visualization: series + expected line + flagged spike/dip points.
import type { EChartsOption } from "echarts";
import type { SeriesInput, AnomalyResult } from "isocline";
import { C, isoclineTheme, grid, tooltip, yAxis, fmt } from "./theme.js";
import { toPoints, seriesXAxis, xOf, escapeHtml, tipList, type IsoclineSeriesOption, type TipParams } from "./util.js";
import { renderChart } from "./render.js";

export interface AnomalyVizOptions {
  showExpected?: boolean; // default true
  height?: number;
  width?: number;
  xLabel?: string;
  yLabel?: string;
  /** Per-anomaly prose; an entry whose `index` matches a flagged point is shown in its tooltip. */
  explanations?: ReadonlyArray<{ index: number; text: string }>;
}

interface Flag {
  x: number;
  y: number;
  i: number;
  dir: "spike" | "dip";
  score: number;
  exp: number;
}

const INK_STROKE = C.bg; // dark halo around colored markers

export function anomalyOption(series: SeriesInput, res: AnomalyResult, opts: AnomalyVizOptions = {}): EChartsOption {
  const { showExpected = true } = opts;
  const pts = toPoints(series);
  const expected = pts
    .filter((p) => Number.isFinite(res.expected[p.i]))
    .map((p) => [p.x, Number(res.expected[p.i])]);
  const flagged: Flag[] = res.anomalies.map((a) => ({
    x: xOf(series, a.index),
    y: a.observed,
    i: a.index,
    dir: a.direction,
    score: a.score,
    exp: a.expected,
  }));
  const spikes = flagged.filter((d) => d.dir === "spike");
  const dips = flagged.filter((d) => d.dir === "dip");
  const notes = new Map<number, string>();
  for (const e of opts.explanations ?? []) notes.set(e.index, e.text);

  const tip = (d: Flag): string => {
    const head = `<b>#${d.i} · ${d.dir}</b><br/>observed ${fmt(d.y)}<br/>expected ${fmt(d.exp)}<br/>score ${fmt(d.score)}`;
    const note = notes.get(d.i);
    return note === undefined
      ? head
      : `${head}<div style="max-width:320px;white-space:normal;overflow-wrap:anywhere;margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.12);color:${C.ink};line-height:1.4">${escapeHtml(note)}</div>`;
  };
  const marker = (name: string, data: Flag[], color: string, rotate: number): IsoclineSeriesOption => ({
    type: "scatter",
    name,
    data: data.map((d) => [d.x, d.y]),
    symbol: "triangle",
    symbolRotate: rotate,
    symbolSize: 10,
    itemStyle: { color, borderColor: INK_STROKE, borderWidth: 0.8 },
    z: 5,
    tooltip: {
      formatter: (p: TipParams | TipParams[]) =>
        tipList(p)
          .map((it) => data[it.dataIndex])
          .filter((d): d is Flag => d !== undefined)
          .map(tip)
          .join(""),
    },
  });

  const out: IsoclineSeriesOption[] = [];
  if (showExpected && expected.length) {
    out.push({
      type: "line",
      name: "expected",
      data: expected,
      symbol: "none",
      silent: true,
      lineStyle: { color: C.amber, type: [3, 4], width: 1 },
    });
  }
  out.push(
    { type: "line", name: "series", data: pts.map((p) => [p.x, p.y]), symbol: "none", silent: true, lineStyle: { color: C.cyan, width: 1.2 } },
    marker("spike", spikes, C.red, 0),
    marker("dip", dips, C.blue, 180),
  );
  return {
    ...isoclineTheme,
    grid: grid(),
    tooltip: tooltip({ trigger: "item" }),
    xAxis: seriesXAxis(series, opts.xLabel),
    yAxis: yAxis({ type: "value", name: opts.yLabel ?? "value" }),
    series: out,
  };
}

export function anomalyPlot(series: SeriesInput, res: AnomalyResult, opts: AnomalyVizOptions = {}): HTMLElement {
  return renderChart(anomalyOption(series, res, opts), { width: opts.width, height: opts.height ?? 320 });
}

/** Small stat helper for legends: split of flagged points by direction. */
export function anomalySplit(res: AnomalyResult): { spikes: number; dips: number } {
  let spikes = 0;
  let dips = 0;
  for (const a of res.anomalies) a.direction === "spike" ? spikes++ : dips++;
  return { spikes, dips };
}
