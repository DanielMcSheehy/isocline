// Time windows (CONTRACT §12): duration parsing and the post-result filter
// shared by `detectAnomalies({ lookback })` and `detect()`.
import {
  IsoclineError,
  type AnomalyResult,
  type AppliedWindow,
  type Duration,
  type SeriesInput,
  type TimeLike,
  type TimeWindow,
} from "./types.js";

const UNIT_MS = { ms: 1, s: 1e3, m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 } as const;
const DURATION_RE = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w|mo|y)\s*$/;

/** Parse a TimeLike into epoch ms. */
export function toEpochMs(x: TimeLike): number {
  const v = x instanceof Date ? x.getTime() : typeof x === "string" ? Date.parse(x) : x;
  if (!Number.isFinite(v)) throw new IsoclineError(`invalid time: ${String(x)}`, "badParams");
  return v;
}

/** `now − duration` in epoch ms. "mo"/"y" step calendar months/years in UTC, clamping
 *  the day to the target month's length (Mar 31 − 1mo = Feb 28); fractional amounts
 *  fall back to 30.436875 d / 365.2425 d. */
export function subtractDuration(now: number, d: Duration): number {
  if (typeof d === "number") {
    if (!Number.isFinite(d) || d < 0) throw new IsoclineError(`invalid duration: ${d}`, "badParams");
    return now - d;
  }
  const m = DURATION_RE.exec(d);
  if (!m) throw new IsoclineError(`invalid duration "${d}" (use e.g. "15m", "24h", "7d", "1mo", "1y")`, "badParams");
  const amount = Number(m[1]);
  const unit = m[2] as keyof typeof UNIT_MS | "mo" | "y";
  if (unit === "mo" || unit === "y") {
    const months = unit === "y" ? amount * 12 : amount;
    if (Number.isInteger(months)) {
      const date = new Date(now);
      const day = date.getUTCDate();
      date.setUTCDate(1);
      date.setUTCMonth(date.getUTCMonth() - months);
      const monthDays = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
      date.setUTCDate(Math.min(day, monthDays));
      return date.getTime();
    }
    return now - months * 30.436875 * 86400e3;
  }
  return now - amount * UNIT_MS[unit];
}

/** Duration in ms (calendar units measured back from `now`). */
export function durationMs(d: Duration, now = Date.now()): number {
  return now - subtractDuration(now, d);
}

export function hasWindow(w: TimeWindow): boolean {
  return w.lookback !== undefined || w.since !== undefined || w.lastPoints !== undefined;
}

/** A window resolved against one dataset: absolute bounds + sample cutoff. */
export interface ResolvedWindow {
  from: number | null;
  to: number | null;
  lastPoints: number | null;
}

/** Resolve a TimeWindow. `latest` is the newest timestamp in the data (for now: "latest");
 *  `timed` says whether the data has timestamps. Returns null when no window is set. */
export function resolveWindow(w: TimeWindow, timed: boolean, latest: number | null): ResolvedWindow | null {
  if (!hasWindow(w)) return null;
  if ((w.lookback !== undefined || w.since !== undefined) && !timed) {
    throw new IsoclineError("lookback/since need timestamps (series.t); use lastPoints for index-only data", "badParams");
  }
  if (w.lastPoints !== undefined && !(Number.isInteger(w.lastPoints) && w.lastPoints >= 0)) {
    throw new IsoclineError(`lastPoints must be a non-negative integer, got ${w.lastPoints}`, "badParams");
  }
  let from: number | null = null;
  let to: number | null = null;
  if (w.lookback !== undefined) {
    const now =
      w.now === "latest" ? (latest ?? Date.now()) : w.now === undefined ? Date.now() : toEpochMs(w.now);
    from = subtractDuration(now, w.lookback);
    to = now;
  }
  if (w.since !== undefined) {
    const s = toEpochMs(w.since);
    from = from === null ? s : Math.max(from, s);
  }
  return { from, to, lastPoints: w.lastPoints ?? null };
}

/** True when sample `index` (timestamp `t`) of an n-point series lies in the window. */
export function inWindow(w: ResolvedWindow, index: number, n: number, t: number | null): boolean {
  if (w.lastPoints !== null && index < n - w.lastPoints) return false;
  if (t === null) return w.from === null && w.to === null;
  if (w.from !== null && t < w.from) return false;
  if (w.to !== null && t > w.to) return false;
  return true;
}

export function appliedWindow(w: ResolvedWindow, total: number, kept: number): AppliedWindow {
  return { from: w.from, to: w.to, lastPoints: w.lastPoints, total, kept };
}

/** Newest finite timestamp, or null. */
export function latestTime(t: ArrayLike<number> | undefined): number | null {
  if (!t) return null;
  let best = -Infinity;
  for (let i = 0; i < t.length; i++) {
    const v = Number(t[i]);
    if (v > best) best = v;
  }
  return Number.isFinite(best) ? best : null;
}

/** Post-result filter: keep only anomalies inside the window. Scores/expected
 *  channels stay full-length. Returns the input unchanged when no window is set. */
export function filterAnomalies(series: SeriesInput, result: AnomalyResult, window: TimeWindow): AnomalyResult {
  const w = resolveWindow(window, series.t !== undefined, latestTime(series.t));
  if (!w) return result;
  const n = series.y.length;
  const t = series.t;
  const kept = result.anomalies.filter((a) => inWindow(w, a.index, n, t ? Number(t[a.index]) : null));
  return { ...result, anomalies: kept, window: appliedWindow(w, result.anomalies.length, kept.length) };
}
