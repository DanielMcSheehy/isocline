// Plain-language anomaly explanations (CONTRACT §12). Pure functions over a
// series + AnomalyResult; no engine calls. Context (period, changepoints) is
// optional and only enriches the wording.
import type {
  Anomaly,
  AnomalyExplanation,
  AnomalyMethod,
  AnomalyResult,
  ExplainOptions,
  SeriesInput,
  Severity,
} from "./types.js";

/** "2026-10-14 13:00 UTC" (seconds shown only when non-zero). */
export function formatTimestamp(ms: number): string {
  const iso = new Date(ms).toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ
  const sec = iso.slice(17, 19);
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}${sec === "00" ? "" : `:${sec}`} UTC`;
}

/** 3-significant-digit number formatting for sentences (integers stay whole). */
export function formatNumber(x: number): string {
  if (!Number.isFinite(x)) return "—";
  const a = Math.abs(x);
  if (Number.isInteger(x) && a < 1e6) return x.toLocaleString("en-US");
  if (a !== 0 && (a >= 1e6 || a < 1e-3)) return x.toExponential(2);
  if (a >= 100) return x.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (a >= 10) return x.toFixed(1);
  if (a >= 1) return x.toFixed(2);
  return x.toFixed(3);
}

/** score / threshold → severity: < 1.5× low, < 2.5× medium, else high. */
export function severityOf(score: number, threshold: number): Severity {
  const r = threshold > 0 ? score / threshold : Infinity;
  return r < 1.5 ? "low" : r < 2.5 ? "medium" : "high";
}

export function pct(p: number): string {
  const v = p * 100;
  const s = Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1);
  return `${v >= 0 ? "+" : ""}${s}%`;
}

function timeAt(series: SeriesInput, i: number): number | null {
  const v = series.t ? Number(series.t[i]) : NaN;
  return Number.isFinite(v) ? v : null;
}

function labelAt(series: SeriesInput, i: number, formatTime: (ms: number) => string): string {
  const t = timeAt(series, i);
  return t === null ? `index ${i}` : formatTime(t);
}

function methodReason(method: AnomalyMethod, a: Anomaly, threshold: number, period: number | null | undefined): string {
  const above = a.direction === "spike" ? "above" : "below";
  const times = `${formatNumber(a.score / threshold)}× the ${formatNumber(threshold)} cut-off`;
  switch (method) {
    case "stl":
      return `The expected value already includes the trend${period ? ` and the usual ${period}-step cycle` : " and seasonal pattern"}, so neither explains it: the leftover deviation is ${formatNumber(a.score)} robust standard deviations ${above} normal (${times}).`;
    case "madz":
      return `It sits ${formatNumber(a.score)} robust standard deviations ${above} the local rolling median (${times}).`;
    case "iqr":
      return `It falls ${above} the normal range of values (outside the IQR fences, ${formatNumber(a.score)} vs k = ${formatNumber(threshold)}).`;
    case "ewma":
      return `The smoothed (EWMA) level drifted ${formatNumber(a.score)}σ ${above} its long-run mean (${times}) — a gradual shift rather than a one-off reading.`;
  }
}

/** Explain one flagged anomaly. `result` should be the full (unwindowed)
 *  result so runs spanning a window edge are measured correctly. */
export function explainAnomaly(
  series: SeriesInput,
  result: AnomalyResult,
  anomaly: Anomaly,
  opts: ExplainOptions = {},
): AnomalyExplanation {
  const formatTime = opts.formatTime ?? formatTimestamp;
  const name = opts.name ?? "series";
  const i = anomaly.index;
  const dir = anomaly.direction;

  // consecutive flagged points with the same direction
  const flagged = new Map(result.anomalies.map((a) => [a.index, a.direction]));
  let start = i;
  let end = i;
  while (flagged.get(start - 1) === dir) start--;
  while (flagged.get(end + 1) === dir) end++;
  const run = { start, end, length: end - start + 1 };

  const delta = anomaly.observed - anomaly.expected;
  const deltaPct = Math.abs(anomaly.expected) > 1e-9 ? delta / Math.abs(anomaly.expected) : null;

  let max = -Infinity;
  let min = Infinity;
  for (let k = 0; k < series.y.length; k++) {
    const v = Number(series.y[k]);
    if (!Number.isFinite(v)) continue;
    if (v > max) max = v;
    if (v < min) min = v;
  }
  const extreme = anomaly.observed >= max ? "max" : anomaly.observed <= min ? "min" : null;

  // A level shift in the anomaly's direction starting within 5 samples of a
  // sustained run. Isolated points are skipped: binary segmentation splits
  // around a lone outlier, which would "explain" the spike with itself.
  let levelShift: AnomalyExplanation["levelShift"] = null;
  if (run.length > 1) {
    for (const cp of opts.changepoints?.changepoints ?? []) {
      const up = cp.meanAfter > cp.meanBefore;
      if (up === (dir === "spike") && cp.index >= run.start - 5 && cp.index <= run.start + 5) {
        levelShift = { index: cp.index, when: labelAt(series, cp.index, formatTime), meanBefore: cp.meanBefore, meanAfter: cp.meanAfter };
        break;
      }
    }
  }

  const when = labelAt(series, i, formatTime);
  const kind = dir === "spike" ? "Spike" : "Dip";
  const change = deltaPct !== null && Math.abs(deltaPct) < 100 ? ` (${pct(deltaPct)})` : "";
  const headline = `${kind} in ${name} at ${when}: ${formatNumber(anomaly.observed)} vs ~${formatNumber(anomaly.expected)} expected${change}.`;

  const reasons: string[] = [methodReason(result.method, anomaly, result.threshold, opts.period)];
  if (run.length === 1) {
    reasons.push("It is an isolated point — the neighbouring values look normal — which usually means a one-off glitch, burst or bad reading.");
  } else {
    const from = labelAt(series, run.start, formatTime);
    const to = labelAt(series, run.end, formatTime);
    reasons.push(`It is part of a ${run.length}-point ${dir === "spike" ? "surge" : "drop"} from ${from} to ${to}, so this looks like a sustained event rather than a single bad reading.`);
  }
  if (levelShift) {
    const up = levelShift.meanAfter > levelShift.meanBefore ? "up" : "down";
    reasons.push(`It coincides with a level shift at ${levelShift.when}: the average moved ${up} from ${formatNumber(levelShift.meanBefore)} to ${formatNumber(levelShift.meanAfter)}.`);
  }
  if (extreme) reasons.push(`It is the ${extreme === "max" ? "highest" : "lowest"} value in the data for ${name}.`);

  return {
    index: i,
    t: timeAt(series, i),
    when,
    direction: dir,
    severity: severityOf(anomaly.score, result.threshold),
    observed: anomaly.observed,
    expected: anomaly.expected,
    delta,
    deltaPct,
    score: anomaly.score,
    threshold: result.threshold,
    run,
    levelShift,
    extreme,
    headline,
    reasons,
    text: `${headline} ${reasons.join(" ")}`,
  };
}

/** Explain every anomaly in `result` (aligned with result.anomalies). */
export function explainAnomalies(series: SeriesInput, result: AnomalyResult, opts: ExplainOptions = {}): AnomalyExplanation[] {
  return result.anomalies.map((a) => explainAnomaly(series, result, a, opts));
}
