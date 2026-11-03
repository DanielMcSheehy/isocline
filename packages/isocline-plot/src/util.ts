// Internal helpers shared by all option builders.
import type { SeriesInput } from "isocline";
import type {
  BarSeriesOption,
  DefaultLabelFormatterCallbackParams as TipParams,
  HeatmapSeriesOption,
  LineSeriesOption,
  ScatterSeriesOption,
  XAXisComponentOption,
} from "echarts";
import { xAxis } from "./theme.js";

/** Union of the series types isocline-plot emits. */
export type IsoclineSeriesOption = LineSeriesOption | ScatterSeriesOption | BarSeriesOption | HeatmapSeriesOption;

export interface Pt {
  /** Epoch ms when `series.t` is present, otherwise the sample index. */
  x: number;
  y: number;
  i: number;
}

/** Series → finite points, mapping index → x (epoch ms when t present). */
export function toPoints(series: SeriesInput): Pt[] {
  const y = series.y;
  const t = series.t;
  const n = y.length;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const v = Number(y[i]);
    if (!Number.isFinite(v)) continue;
    const tv = t ? Number(t[i]) : NaN;
    out.push({ x: Number.isFinite(tv) ? tv : i, y: v, i });
  }
  return out;
}

/** x coordinate of sample `i` (epoch ms when t present, else the index). */
export function xOf(series: SeriesInput, i: number): number {
  return series.t ? Number(series.t[i]) : i;
}

/** X axis for index- or time-keyed series: `time` when t present, else a value axis labeled "index". */
export function seriesXAxis(series: SeriesInput, label = "", extra: XAXisComponentOption = {}): XAXisComponentOption {
  return xAxis({
    type: series.t ? "time" : "value",
    name: label || (series.t ? "time" : "index"),
    min: "dataMin",
    max: "dataMax",
    ...extra,
  } as XAXisComponentOption);
}

/** Median positive spacing of t (ms), for extending timestamps past the end. */
export function stepOf(series: SeriesInput): number {
  const t = series.t;
  if (!t) return 1;
  const diffs: number[] = [];
  for (let i = 1; i < Math.min(t.length, 200); i++) {
    const d = Number(t[i]) - Number(t[i - 1]);
    if (d > 0) diffs.push(d);
  }
  if (!diffs.length) return 1;
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)] ?? 1;
}

/** x coordinate for forecast step k (0-based, after the last history point). */
export function futureX(series: SeriesInput, k: number): number {
  const n = series.y.length;
  if (series.t) {
    const last = Number(series.t[n - 1] ?? 0);
    return last + (k + 1) * stepOf(series);
  }
  return n + k;
}

export const isArray = (a: unknown): a is ArrayLike<number> =>
  a != null && typeof (a as ArrayLike<number>).length === "number";

/** Escape text for HTML tooltip content. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export type { TipParams };

/** Tooltip formatter params as a list (axis trigger passes an array, item trigger a single entry). */
export function tipList(p: TipParams | TipParams[]): TipParams[] {
  return Array.isArray(p) ? p : [p];
}

/** Colored dot HTML echarts provides for each tooltip entry. */
export function tipMarker(p: TipParams): string {
  return typeof p.marker === "string" ? p.marker : "";
}

/** Component `k` of an `[x, y, …]` data value (NaN when absent). */
export function tipValue(p: TipParams, k: number): number {
  return Array.isArray(p.value) ? Number(p.value[k]) : NaN;
}
