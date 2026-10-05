// Internal helpers shared by all mark builders.
import type { SeriesInput } from "isocline";

export interface Pt {
  x: number | Date;
  y: number;
  i: number;
}

/** Series → finite points, mapping index → x (Date when t present). */
export function toPoints(series: SeriesInput): Pt[] {
  const y = series.y;
  const t = series.t;
  const n = y.length;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const v = Number(y[i]);
    if (!Number.isFinite(v)) continue;
    const tv = t ? Number(t[i]) : NaN;
    out.push({ x: Number.isFinite(tv) ? new Date(tv) : i, y: v, i });
  }
  return out;
}

/** X-axis options for index- or time-keyed series. */
export function xScale(series: SeriesInput, label = "") {
  return series.t
    ? { type: "time" as const, nice: true, label: label || "time" }
    : { nice: true, label: label || "index" };
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
export function futureX(series: SeriesInput, k: number): number | Date {
  const n = series.y.length;
  if (series.t) {
    const last = Number(series.t[n - 1] ?? 0);
    return new Date(last + (k + 1) * stepOf(series));
  }
  return n + k;
}

export const isArray = (a: unknown): a is ArrayLike<number> =>
  a != null && typeof (a as ArrayLike<number>).length === "number";
