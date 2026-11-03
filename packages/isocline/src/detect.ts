// Auto detector (CONTRACT §12): hand it arbitrary data — a numeric array,
// GenericSeries columns, or an array of records — and get typed findings with
// one-line summaries and plain-language explanations. Detection runs on the
// full history; the TimeWindow is applied to the findings afterwards.
import {
  IsoclineError,
  type AnomalyFinding,
  type AnomalyOptions,
  type AnomalyResult,
  type CategoryOutlierFinding,
  type ChangepointResult,
  type DetectInput,
  type DetectOptions,
  type DetectReport,
  type Duration,
  type Finding,
  type FindingKind,
  type FrequencyOutlierFinding,
  type GenericSeries,
  type Isocline,
  type SeriesInput,
  type Severity,
} from "./types.js";
import { explainAnomaly, formatNumber, formatTimestamp, pct, severityOf } from "./explain.js";
import { appliedWindow, durationMs, inWindow, latestTime, resolveWindow, toEpochMs, type ResolvedWindow } from "./window.js";

const ALL_KINDS: readonly FindingKind[] = ["anomaly", "frequency_outlier", "category_outlier"];
const MIN_POINTS = 8;
const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2 };
const TIME_NAME = /^(t|ts|time|timestamp|date|datetime|created_?at|updated_?at|occurred_?at|event_?time|when)$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;
const BUCKETS: readonly number[] = [1e3, 60e3, 300e3, 900e3, 3600e3, 6 * 3600e3, 86400e3, 7 * 86400e3];

interface Measure {
  name: string;
  values: Float64Array;
}

interface Dataset {
  t: Float64Array | null; // per row, epoch ms
  measures: Measure[];
  category: string[] | null;
  categoryName: string | null;
}

interface Ctx {
  engine: Isocline;
  opts: DetectOptions<FindingKind>;
  kinds: Set<FindingKind>;
  window: ResolvedWindow | null;
  formatTime: (ms: number) => string;
  findings: Finding[];
  total: number; // findings before the window filter
  report: Pick<DetectReport, "analyzed" | "skipped">;
}

// ---------------------------------------------------------------- input ---

function isNumericArray(x: DetectInput): x is ArrayLike<number> {
  if (ArrayBuffer.isView(x)) return true;
  return Array.isArray(x) && (x.length === 0 || typeof x[0] === "number" || x[0] === null);
}

function isRecords(x: DetectInput): x is ReadonlyArray<Record<string, unknown>> {
  return Array.isArray(x) && x.length > 0 && typeof x[0] === "object" && x[0] !== null;
}

function timeValue(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "string") return ISO_DATE.test(v) ? Date.parse(v) : NaN;
  if (typeof v === "number" && Number.isFinite(v)) return v > 1e8 && v < 1e11 ? v * 1000 : v; // epoch seconds → ms
  return NaN;
}

function fromRecords(rows: ReadonlyArray<Record<string, unknown>>, opts: DetectOptions<FindingKind>): Dataset {
  const f = opts.fields ?? {};
  const sample = rows.slice(0, 200);
  const keys = [...new Set(sample.flatMap((r) => Object.keys(r)))];
  const values = (k: string) => sample.map((r) => r[k]).filter((v) => v !== null && v !== undefined);
  const looksTime = (k: string) => {
    const vs = values(k);
    if (!vs.length) return false;
    if (vs.every((v) => v instanceof Date || (typeof v === "string" && ISO_DATE.test(v)))) return true;
    return TIME_NAME.test(k) && vs.every((v) => Number.isFinite(timeValue(v)));
  };
  for (const k of [f.time, f.category, ...(typeof f.value === "string" ? [f.value] : f.value ?? [])]) {
    if (k !== undefined && !keys.includes(k)) throw new IsoclineError(`detect: field "${k}" not found (have ${keys.join(", ")})`, "badParams");
  }
  const timeKey = f.time ?? keys.find((k) => TIME_NAME.test(k) && looksTime(k)) ?? keys.find(looksTime);
  const rest = keys.filter((k) => k !== timeKey);
  const valueKeys =
    f.value === undefined
      ? rest.filter((k) => k !== f.category && values(k).some((v) => typeof v === "number") && values(k).every((v) => typeof v === "number"))
      : typeof f.value === "string" ? [f.value] : [...f.value];
  const maxCard = Math.max(1, Math.floor(rows.length / 2));
  const categoryKey =
    f.category ??
    rest.find((k) => {
      if (valueKeys.includes(k)) return false;
      const vs = values(k);
      return vs.length > 0 && vs.every((v) => typeof v === "string") && new Set(vs).size <= maxCard;
    });
  const n = rows.length;
  return {
    t: timeKey === undefined ? null : Float64Array.from(rows, (r) => timeValue(r[timeKey])),
    measures: valueKeys.map((k) => ({ name: k, values: Float64Array.from(rows, (r) => (typeof r[k] === "number" ? (r[k] as number) : NaN)) })),
    category: categoryKey === undefined ? null : Array.from({ length: n }, (_, i) => String(rows[i]?.[categoryKey] ?? "(none)")),
    categoryName: categoryKey ?? null,
  };
}

function toDataset(input: DetectInput, opts: DetectOptions<FindingKind>): Dataset {
  const name = opts.name ?? "series";
  if (isNumericArray(input)) {
    return { t: null, measures: [{ name, values: Float64Array.from(input, Number) }], category: null, categoryName: null };
  }
  if (isRecords(input)) return fromRecords(input, opts);
  if (Array.isArray(input)) return { t: null, measures: [], category: null, categoryName: null }; // empty records
  const g = input as GenericSeries;
  const measures: Measure[] = [];
  if (g.y) measures.push({ name, values: Float64Array.from(g.y, Number) });
  if (g.y2) measures.push({ name: `${name} 2`, values: Float64Array.from(g.y2, Number) });
  return {
    t: g.t ? Float64Array.from(g.t, timeValue) : null,
    measures,
    category: g.categories ? [...g.categories] : null,
    categoryName: null,
  };
}

// ------------------------------------------------------------- analyses ---

function trySafe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

/** Run anomaly detection on one series; returns the full (unwindowed) result plus context. */
function analyzeSeries(
  ctx: Ctx,
  subject: string,
  series: SeriesInput,
): { res: AnomalyResult; series: SeriesInput; period: number | null; cps: ChangepointResult | undefined } | null {
  const y = series.y;
  let finite = 0;
  for (let i = 0; i < y.length; i++) if (Number.isFinite(y[i])) finite++;
  if (finite < MIN_POINTS) {
    ctx.report.skipped.push({ subject, reason: `too short (${finite} finite points, need ${MIN_POINTS})` });
    return null;
  }
  const missing = finite < y.length;
  const s: SeriesInput = missing ? { ...series, y: ctx.engine.interpolate(series) } : series;
  const anomalyOpts: AnomalyOptions = { ...ctx.opts.anomaly };
  let res: AnomalyResult;
  try {
    res = ctx.engine.detectAnomalies(s, anomalyOpts);
  } catch (err) {
    ctx.report.skipped.push({ subject, reason: err instanceof Error ? err.message : String(err) });
    return null;
  }
  if (missing) res = { ...res, anomalies: res.anomalies.filter((a) => Number.isFinite(y[a.index])) };
  const context = ctx.opts.context !== false;
  const fixed = typeof anomalyOpts.period === "number" ? anomalyOpts.period : null;
  const period = fixed ?? (context ? (trySafe(() => ctx.engine.seasonality(s).bestPeriod) ?? null) : null);
  const cps = context ? (trySafe(() => ctx.engine.changepoints(s)) ?? undefined) : undefined;
  ctx.report.analyzed.push({ subject, kind: "series", points: y.length });
  return { res, series: s, period, cps };
}

function keep(ctx: Ctx, index: number, n: number, t: number | null): boolean {
  ctx.total++;
  return ctx.window === null || inWindow(ctx.window, index, n, t);
}

function seriesAnomalies(ctx: Ctx, measure: string, category: string | null, series: SeriesInput): void {
  const subject = category === null ? measure : `${measure} · ${category}`;
  const a = analyzeSeries(ctx, subject, series);
  if (!a) return;
  const n = series.y.length;
  for (const an of a.res.anomalies) {
    const t = series.t ? Number(series.t[an.index]) : null;
    if (!keep(ctx, an.index, n, t)) continue;
    const d = explainAnomaly(a.series, a.res, an, { name: subject, period: a.period, changepoints: a.cps, formatTime: ctx.formatTime });
    const change = d.deltaPct !== null && Math.abs(d.deltaPct) < 100 ? ` (${pct(d.deltaPct)})` : "";
    const f: AnomalyFinding = {
      kind: "anomaly",
      subject,
      measure,
      category,
      at: { index: an.index, t, label: d.when },
      severity: d.severity,
      score: an.score,
      threshold: a.res.threshold,
      direction: an.direction,
      observed: an.observed,
      expected: an.expected,
      method: a.res.method,
      summary: `Anomaly detected for ${subject} at ${d.when}: ${an.direction}, ${formatNumber(an.observed)} vs ~${formatNumber(an.expected)} expected${change}.`,
      explanation: d.reasons.join(" "),
      details: d,
    };
    ctx.findings.push(f);
  }
}

/** Row indices sorted by time (NaN times dropped), or input order when untimed. */
function orderOf(ds: Dataset, rows: number[]): number[] {
  const t = ds.t;
  if (!t) return rows;
  return rows.filter((i) => Number.isFinite(t[i])).sort((a, b) => (t[a] as number) - (t[b] as number));
}

function seriesOf(ds: Dataset, m: Measure, rows: number[]): SeriesInput {
  const idx = orderOf(ds, rows);
  const t = ds.t;
  return {
    y: Float64Array.from(idx, (i) => m.values[i] as number),
    ...(t ? { t: Float64Array.from(idx, (i) => t[i] as number) } : {}),
  };
}

/** Rows inside the window (category-level analyses aggregate only these). */
function windowRows(ctx: Ctx, ds: Dataset): number[] {
  const all = orderOf(ds, Array.from({ length: ds.category?.length ?? ds.t?.length ?? 0 }, (_, i) => i));
  const w = ctx.window;
  if (!w) return all;
  return all.filter((row, k) => inWindow(w, k, all.length, ds.t ? (ds.t[row] as number) : null));
}

function categoryOutliers(ctx: Ctx, ds: Dataset, m: Measure): void {
  const cats = ds.category;
  if (!cats) return;
  const rows = windowRows(ctx, ds).filter((i) => Number.isFinite(m.values[i]));
  if (new Set(rows.map((i) => cats[i])).size < 3) {
    ctx.report.skipped.push({ subject: `${m.name} by ${ds.categoryName ?? "category"}`, reason: "fewer than 3 categories" });
    return;
  }
  const co = ctx.engine.categoryOutlier(rows.map((i) => cats[i] as string), Float64Array.from(rows, (i) => m.values[i] as number), {
    agg: ctx.opts.categories?.agg,
    factor: ctx.opts.categories?.factor,
  });
  ctx.report.analyzed.push({ subject: `${m.name} by ${ds.categoryName ?? "category"}`, kind: "categories", points: rows.length });
  const iqr = Math.max(co.iqr, 1e-9);
  const median = (co.q1 + co.q3) / 2;
  for (const c of co.categories) {
    if (!c.isOutlier) continue;
    ctx.total++;
    const high = c.direction === "high";
    const fence = high ? co.upperFence : co.lowerFence;
    const score = high ? (c.value - co.q3) / iqr : (co.q1 - c.value) / iqr;
    const f: CategoryOutlierFinding = {
      kind: "category_outlier",
      subject: c.label,
      measure: m.name,
      category: c.label,
      at: null,
      severity: severityOf(score, co.factor),
      score,
      threshold: co.factor,
      direction: c.direction,
      value: c.value,
      agg: co.agg,
      fence,
      median,
      summary: `Category outlier detected for ${c.label}: ${m.name} ${co.agg} ${formatNumber(c.value)} is ${high ? "above the upper" : "below the lower"} fence ${formatNumber(fence)} (typical ${formatNumber(co.q1)}–${formatNumber(co.q3)}).`,
      explanation: `Compared with its ${co.categories.length - 1} peers, ${c.label}'s ${co.agg} of ${m.name} (${formatNumber(c.value)}, ${Math.abs(median) > 1e-9 ? `${pct((c.value - median) / Math.abs(median))} vs the typical ~${formatNumber(median)}` : `typical ~${formatNumber(median)}`}) is ${formatNumber(score)} IQRs ${high ? "above the 75th" : "below the 25th"} percentile (cut-off ${formatNumber(co.factor)}), so it behaves unlike the rest of the group.`,
    };
    ctx.findings.push(f);
  }
}

function humanMs(ms: number): string {
  const units: [number, string][] = [[7 * 86400e3, "w"], [86400e3, "d"], [3600e3, "h"], [60e3, "m"], [1e3, "s"]];
  for (const [u, s] of units) if (ms >= u && ms % u === 0) return `${ms / u}${s}`;
  return `${ms}ms`;
}

function frequencyOverTime(ctx: Ctx, ds: Dataset): void {
  const t = ds.t as Float64Array;
  const rows = orderOf(ds, Array.from({ length: t.length }, (_, i) => i));
  if (rows.length < 2) return;
  const lo = t[rows[0] as number] as number;
  const hi = t[rows[rows.length - 1] as number] as number;
  const span = hi - lo;
  const bucket = ctx.opts.frequency?.bucket !== undefined
    ? durationMs(ctx.opts.frequency.bucket as Duration, hi)
    : ([...BUCKETS].reverse().find((b) => span / b >= 100) ?? (BUCKETS[0] as number));
  const start = Math.floor(lo / bucket) * bucket;
  const nb = Math.floor((hi - start) / bucket) + 1;
  const bt = Float64Array.from({ length: nb }, (_, k) => start + k * bucket);
  const cats = ds.category;
  const groups = new Map<string, Float64Array>();
  for (const i of rows) {
    const key = cats ? (cats[i] as string) : "events";
    let g = groups.get(key);
    if (!g) groups.set(key, (g = new Float64Array(nb)));
    g[Math.floor(((t[i] as number) - start) / bucket)]! += 1;
  }
  const maxCats = ctx.opts.frequency?.maxCategories ?? 50;
  const ranked = [...groups.entries()].sort((a, b) => b[1].reduce((s, v) => s + v, 0) - a[1].reduce((s, v) => s + v, 0));
  for (const [key] of ranked.slice(maxCats)) ctx.report.skipped.push({ subject: key, reason: `beyond maxCategories (${maxCats})` });
  const minZ = ctx.opts.frequency?.minPoissonZ ?? 3;
  const label = humanMs(bucket);
  for (const [key, counts] of ranked.slice(0, maxCats)) {
    const a = analyzeSeries(ctx, key, { y: counts, t: bt });
    if (!a) continue;
    ctx.report.analyzed[ctx.report.analyzed.length - 1]!.kind = "frequency";
    for (const an of a.res.anomalies) {
      const expected = Math.max(0, an.expected);
      if (Math.abs(an.observed - expected) / Math.sqrt(Math.max(expected, 1)) < minZ) continue; // Poisson guard for sparse counts
      const at = bt[an.index] as number;
      if (!keep(ctx, an.index, nb, at)) continue;
      const d = explainAnomaly(a.series, a.res, an, { name: `${key} events`, period: a.period, changepoints: a.cps, formatTime: ctx.formatTime });
      const ratio = expected > 0 ? ` — ${formatNumber(an.observed / expected)}× the usual rate` : "";
      const f: FrequencyOutlierFinding = {
        kind: "frequency_outlier",
        subject: key,
        measure: null,
        category: key,
        at: { index: an.index, t: at, label: d.when },
        severity: d.severity,
        score: an.score,
        threshold: a.res.threshold,
        direction: an.direction === "spike" ? "high" : "low",
        count: an.observed,
        expected,
        bucketMs: bucket,
        summary: `Frequency outlier detected for ${key} at ${d.when}: ${formatNumber(an.observed)} events in ${label} vs ~${formatNumber(expected)} expected.`,
        explanation: [`${key} occurred ${formatNumber(an.observed)} times in the ${label} starting ${d.when}, vs ~${formatNumber(expected)} expected for that slot${ratio}.`, ...d.reasons.slice(1)].join(" "),
        details: d,
      };
      ctx.findings.push(f);
    }
  }
}

function frequencyByCategory(ctx: Ctx, ds: Dataset): void {
  const cats = ds.category as string[];
  const rows = windowRows(ctx, ds);
  const labels = rows.map((i) => cats[i] as string);
  if (new Set(labels).size < 3) {
    ctx.report.skipped.push({ subject: ds.categoryName ?? "categories", reason: "fewer than 3 categories" });
    return;
  }
  const co = ctx.engine.categoryOutlier(labels, new Float64Array(labels.length).fill(1), { agg: "count", factor: ctx.opts.categories?.factor });
  ctx.report.analyzed.push({ subject: ds.categoryName ?? "categories", kind: "categories", points: labels.length });
  const iqr = Math.max(co.iqr, 1e-9);
  const median = (co.q1 + co.q3) / 2;
  for (const c of co.categories) {
    if (!c.isOutlier) continue;
    ctx.total++;
    const high = c.direction === "high";
    const fence = high ? co.upperFence : co.lowerFence;
    const score = high ? (c.value - co.q3) / iqr : (co.q1 - c.value) / iqr;
    const f: FrequencyOutlierFinding = {
      kind: "frequency_outlier",
      subject: c.label,
      measure: null,
      category: c.label,
      at: null,
      severity: severityOf(score, co.factor),
      score,
      threshold: co.factor,
      direction: c.direction,
      count: c.value,
      expected: median,
      bucketMs: null,
      details: null,
      summary: `Frequency outlier detected for ${c.label}: ${formatNumber(c.value)} occurrences, unusually ${high ? "frequent" : "rare"} vs a typical ${formatNumber(co.q1)}–${formatNumber(co.q3)} (fence ${formatNumber(fence)}).`,
      explanation: `${c.label} appears ${formatNumber(c.value)} times while most of its ${co.categories.length - 1} peers appear ${formatNumber(co.q1)}–${formatNumber(co.q3)} times; that is ${formatNumber(score)} IQRs ${high ? "above" : "below"} the typical range (cut-off ${formatNumber(co.factor)}).`,
    };
    ctx.findings.push(f);
  }
}

// --------------------------------------------------------------- report ---

const NOUN: Record<FindingKind, [string, string]> = {
  anomaly: ["anomaly", "anomalies"],
  frequency_outlier: ["frequency outlier", "frequency outliers"],
  category_outlier: ["category outlier", "category outliers"],
};

const UNIT_WORD: Record<string, string> = { ms: "millisecond", s: "second", m: "minute", h: "hour", d: "day", w: "week", mo: "month", y: "year" };

function scopeText(opts: DetectOptions<FindingKind>, formatTime: (ms: number) => string): string {
  const parts: string[] = [];
  if (opts.lookback !== undefined) {
    const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w|mo|y)\s*$/.exec(typeof opts.lookback === "number" ? humanMs(opts.lookback) : opts.lookback);
    const n = Number(m?.[1]);
    const word = UNIT_WORD[m?.[2] ?? ""];
    parts.push(!m || !word ? `in the last ${String(opts.lookback)}` : n === 1 ? `in the last ${word}` : `in the last ${n} ${word}s`);
  }
  if (opts.since !== undefined) parts.push(`since ${formatTime(toEpochMs(opts.since))}`);
  if (opts.lastPoints !== undefined) parts.push(`in the last ${opts.lastPoints} points`);
  return parts.length ? ` ${parts.join(", ")}` : "";
}

function joinList(xs: string[]): string {
  return xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

const ratioOf = (f: Finding) => (f.threshold > 0 ? f.score / f.threshold : f.score);

/** Detect anomalies, frequency outliers and category outliers in arbitrary data.
 *
 *  ```ts
 *  const report = detect(engine, rows, { kinds: ["anomaly"], lookback: "1mo" });
 *  report.findings[0]?.summary // "Anomaly detected for cpu at 2026-10-14 13:00 UTC: spike, …"
 *  ```
 */
export function detect<K extends FindingKind = FindingKind>(
  engine: Isocline,
  input: DetectInput,
  opts: DetectOptions<K> = {},
): DetectReport<K> {
  const o = opts as DetectOptions<FindingKind>;
  const formatTime = o.formatTime ?? formatTimestamp;
  const ds = toDataset(input, o);
  const timed = ds.t !== null && ds.t.some(Number.isFinite);
  const report: DetectReport<FindingKind> = {
    headline: "",
    summary: "",
    findings: [],
    counts: { anomaly: 0, frequency_outlier: 0, category_outlier: 0 },
    window: null,
    analyzed: [],
    skipped: [],
  };
  const ctx: Ctx = {
    engine,
    opts: o,
    kinds: new Set(o.kinds ?? ALL_KINDS),
    window: resolveWindow(o, timed, latestTime(ds.t ?? undefined)),
    formatTime,
    findings: [],
    total: 0,
    report,
  };

  const all = Array.from({ length: ds.category?.length ?? ds.measures[0]?.values.length ?? ds.t?.length ?? 0 }, (_, i) => i);
  if (ds.measures.length > 0) {
    for (const m of ds.measures) {
      if (ctx.kinds.has("category_outlier")) categoryOutliers(ctx, ds, m);
      if (!ctx.kinds.has("anomaly")) continue;
      if (ds.category && timed) {
        const groups = new Map<string, number[]>();
        for (const i of all) {
          const key = ds.category[i] as string;
          let g = groups.get(key);
          if (!g) groups.set(key, (g = []));
          g.push(i);
        }
        for (const [key, rows] of groups) seriesAnomalies(ctx, m.name, key, seriesOf(ds, m, rows));
      } else if (!ds.category) {
        seriesAnomalies(ctx, m.name, null, seriesOf(ds, m, all));
      }
    }
  } else if (ctx.kinds.has("frequency_outlier")) {
    if (timed) frequencyOverTime(ctx, ds);
    else if (ds.category) frequencyByCategory(ctx, ds);
  }
  if (!report.analyzed.length && !report.skipped.length) {
    throw new IsoclineError("detect: no analyzable data (need numbers, timestamps, or a category column)", "badParams");
  }

  const minRank = SEVERITY_RANK[o.minSeverity ?? "low"];
  let findings = ctx.findings.filter((f) => ctx.kinds.has(f.kind) && SEVERITY_RANK[f.severity] >= minRank);
  const tOf = (f: Finding) => f.at?.t ?? -Infinity;
  findings.sort((a, b) =>
    o.sort === "recent"
      ? tOf(b) - tOf(a) || ratioOf(b) - ratioOf(a)
      : SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || ratioOf(b) - ratioOf(a) || tOf(b) - tOf(a),
  );
  for (const f of findings) report.counts[f.kind]++;
  const kept = findings.length;
  if (o.limit !== undefined) findings = findings.slice(0, Math.max(0, o.limit));

  const scope = scopeText(o, formatTime);
  const parts = ALL_KINDS.filter((k) => report.counts[k] > 0).map((k) => `${report.counts[k]} ${NOUN[k][report.counts[k] === 1 ? 0 : 1]}`);
  const nSeries = report.analyzed.filter((a) => a.kind !== "categories").length;
  const nGroups = report.analyzed.length - nSeries;
  const checked = [nSeries ? `${nSeries} series` : "", nGroups ? `${nGroups} category comparison${nGroups === 1 ? "" : "s"}` : ""].filter(Boolean).join(" + ");
  const across = ` (checked ${checked || "nothing"})`;
  report.headline = parts.length
    ? `${joinList(parts)} detected${scope}${across}.`
    : `No ${joinList([...ctx.kinds].map((k) => NOUN[k][1])).replace(" and ", " or ")} detected${scope}${across}.`;
  const lines = findings.map((f) => `- ${f.summary}`);
  if (kept > findings.length) lines.push(`- …and ${kept - findings.length} more`);
  report.summary = [report.headline, ...lines].join("\n");
  report.findings = findings;
  if (ctx.window) report.window = appliedWindow(ctx.window, ctx.total, kept);
  return report as unknown as DetectReport<K>;
}
