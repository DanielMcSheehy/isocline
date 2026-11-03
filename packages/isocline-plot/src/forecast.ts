// Forecast visualization: history + point forecast + PI band + bootstrap paths.
import type { EChartsOption } from "echarts";
import type { SeriesInput, ForecastResult } from "isocline";
import { C, baseOption, grid, tooltip, yAxis, fmt } from "./theme.js";
import { toPoints, seriesXAxis, futureX, tipList, tipMarker, tipValue, type IsoclineSeriesOption, type TipParams } from "./util.js";
import { renderChart } from "./render.js";

export interface ForecastVizOptions {
  paths?: boolean; // draw bootstrap sample paths (default false)
  showComponents?: boolean; // draw projected trend/seasonal when present
  showBand?: boolean; // draw PI band (default true)
  height?: number;
  width?: number;
  xLabel?: string;
  yLabel?: string;
  title?: string;
  /** History points visible initially (drag to pan back, ctrl+wheel or trackpad pinch to zoom).
   *  Default: max(3 × horizon, 2 × period); "all" shows the whole history. */
  historyWindow?: number | "all";
}

const MAX_PATHS = 60;

interface ForecastData {
  hist: [number, number][];
  fpts: [number, number][];
  band: { x: number; lo: number; hi: number }[];
  paths: [number, number][][];
  trend: [number, number][];
  seasonal: [number, number][];
  splitX: number | null;
}

function forecastData(series: SeriesInput, fc: ForecastResult): ForecastData {
  const histPts = toPoints(series);
  const hist = histPts.map((p): [number, number] => [p.x, p.y]);
  const last = histPts[histPts.length - 1];
  const fpts: [number, number][] = last
    ? [[last.x, last.y], ...Array.from({ length: fc.horizon }, (_, k): [number, number] => [futureX(series, k), fc.point[k] ?? NaN])]
    : [];
  const band = Array.from({ length: fc.horizon }, (_, k) => ({
    x: futureX(series, k),
    lo: fc.lower[k] ?? NaN,
    hi: fc.upper[k] ?? NaN,
  }));
  const paths: [number, number][][] = [];
  if (fc.paths) {
    const nDraw = Math.min(MAX_PATHS, fc.pathsN || 0);
    const stride = Math.max(1, Math.ceil((fc.pathsN || 0) / nDraw));
    for (let p = 0; p < nDraw; p++) {
      const off = p * stride * fc.horizon;
      const line: [number, number][] = [];
      for (let k = 0; k < fc.horizon; k++) {
        const v = fc.paths[off + k];
        if (v !== undefined && Number.isFinite(v)) line.push([futureX(series, k), v]);
      }
      if (line.length) paths.push(line);
    }
  }
  const proj = (a: Float64Array | null): [number, number][] =>
    a ? Array.from({ length: fc.horizon }, (_, k): [number, number] => [futureX(series, k), a[k] ?? NaN]) : [];
  return { hist, fpts, band, paths, trend: proj(fc.trend), seasonal: proj(fc.seasonal), splitX: last ? last.x : null };
}

const NO_TIP = { show: false } as const;
const TIP_SERIES: Record<string, true> = { history: true, forecast: true, trend: true, seasonal: true };

export function forecastOption(series: SeriesInput, fc: ForecastResult, opts: ForecastVizOptions = {}): EChartsOption {
  const { showBand = true } = opts;
  const d = forecastData(series, fc);
  const out: IsoclineSeriesOption[] = [];
  if (showBand && d.band.length) {
    // PI band = invisible `lower` line + stacked (upper − lower) area on top of it.
    out.push(
      {
        type: "line",
        name: "lower",
        data: d.band.map((b) => [b.x, b.lo]),
        stack: "pi",
        stackStrategy: "all",
        symbol: "none",
        lineStyle: { opacity: 0 },
        itemStyle: { color: C.violet },
        silent: true,
      },
      {
        type: "line",
        name: "pi",
        data: d.band.map((b) => [b.x, b.hi - b.lo]),
        stack: "pi",
        stackStrategy: "all",
        symbol: "none",
        lineStyle: { opacity: 0 },
        areaStyle: { color: C.violet, opacity: 0.15 },
        silent: true,
        tooltip: NO_TIP,
      },
    );
  }
  if (opts.paths) {
    for (const line of d.paths) {
      out.push({
        type: "line",
        name: "path",
        data: line,
        symbol: "none",
        silent: true,
        tooltip: NO_TIP,
        lineStyle: { color: C.violet, opacity: 0.12, width: 0.7 },
        z: 1,
      });
    }
  }
  if (opts.showComponents && d.trend.length) {
    out.push({ type: "line", name: "trend", data: d.trend, symbol: "none", lineStyle: { color: C.amber, type: [4, 3], width: 1.2 } });
  }
  if (opts.showComponents && d.seasonal.length) {
    out.push({ type: "line", name: "seasonal", data: d.seasonal, symbol: "none", lineStyle: { color: C.green, width: 1.2 } });
  }
  out.push(
    {
      type: "line",
      name: "history",
      data: d.hist,
      symbol: "none",
      lineStyle: { color: C.cyan, width: 1.2 },
      itemStyle: { color: C.cyan },
      z: 3,
      markLine:
        d.splitX === null
          ? undefined
          : {
              silent: true,
              symbol: "none",
              label: { show: false },
              lineStyle: { color: C.grid, type: "solid", width: 1 },
              data: [{ xAxis: d.splitX }],
            },
    },
    {
      type: "line",
      name: "forecast",
      data: d.fpts,
      symbol: "none",
      lineStyle: { color: C.violet, type: [5, 4], width: 1.6 },
      itemStyle: { color: C.violet },
      z: 4,
    },
  );
  const end = d.fpts[d.fpts.length - 1];
  if (end) {
    out.push({ type: "scatter", name: "end", data: [end], symbolSize: 5, itemStyle: { color: C.violet }, silent: true, tooltip: NO_TIP, z: 5 });
  }
  const bandAt = new Map(d.band.map((b) => [b.x, b]));
  const win = opts.historyWindow ?? Math.max(3 * fc.horizon, 2 * (fc.period ?? 0));
  const start = win === "all" || win >= d.hist.length ? undefined : d.hist[d.hist.length - Math.max(1, Math.floor(win))];
  return {
    ...baseOption(opts.title),
    grid: grid(opts.title ? { top: 48 } : {}),
    tooltip: tooltip({
      trigger: "axis",
      axisPointer: { type: "line", lineStyle: { color: "rgba(255,255,255,0.25)" } },
      formatter: (p: TipParams | TipParams[]) => {
        const lines: string[] = [];
        for (const it of tipList(p)) {
          const name = it.seriesName ?? "";
          if (name === "lower") {
            const b = bandAt.get(tipValue(it, 0));
            if (b) lines.push(`${tipMarker(it)}PI ${fmt(b.lo)} – ${fmt(b.hi)}`);
          } else if (name in TIP_SERIES) {
            lines.push(`${tipMarker(it)}${name} ${fmt(tipValue(it, 1))}`);
          }
        }
        return lines.join("<br/>");
      },
    }),
    xAxis: seriesXAxis(series, opts.xLabel),
    // Zoom into recent history so the forecast isn't a sliver at the edge;
    // "filter" lets the y axis rescale to what is visible.
    ...(start
      ? { dataZoom: [{ type: "inside", xAxisIndex: 0, startValue: start[0], filterMode: "filter", zoomOnMouseWheel: "ctrl", moveOnMouseWheel: false, moveOnMouseMove: true }] }
      : {}),
    yAxis: yAxis({ type: "value", name: opts.yLabel ?? "value" }),
    series: out,
  };
}

export function forecastPlot(series: SeriesInput, fc: ForecastResult, opts: ForecastVizOptions = {}): HTMLElement {
  return renderChart(forecastOption(series, fc, opts), { width: opts.width, height: opts.height ?? 320 });
}
