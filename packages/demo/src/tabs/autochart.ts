// Auto-chart tab (CONTRACT §11): sample datasets + paste-your-own JSON input,
// autoChart dispatch with an explanation strip (kind / reason / headline
// numbers), and an anomaly-overlay toggle when the result carries both a
// forecast and anomalies. Plotting is delegated to isocline-plot entirely.
import { anomalyPlot, autoChartPlot, autoChartReason } from "isocline-plot";
import { genSeries, mulberry32, randn, type AutoChartResult, type GenericSeries, type SeriesInput } from "isocline";
import { state } from "../state.js";
import { clearNode, debounce, el, fmtNum, fmtPct, runCompute, setChipValues } from "../util.js";

// ---------- sample datasets (deterministic — seeded mulberry32) ----------

/** 12 devices × 50 events of ~100±5 error counts, except device-7 at ~400. */
function fleetErrors(): GenericSeries {
  const rng = mulberry32(1337);
  const y: number[] = [];
  const categories: string[] = [];
  for (let d = 0; d < 12; d++) {
    const hot = d === 7;
    const base = hot ? 400 : 100;
    const sigma = hot ? 8 : 5;
    for (let e = 0; e < 50; e++) {
      y.push(Math.max(0, Math.round(base + sigma * randn(rng))));
      categories.push(`device-${d}`);
    }
  }
  return { y, categories };
}

/** 100 categorical events, one dominant mode (72%) + four minority modes. */
function failureModes(): GenericSeries {
  const rng = mulberry32(9001);
  const labels: string[] = [
    ...Array<string>(72).fill("navigation-failure"),
    ...Array<string>(18).fill("wheel-stall"),
    ...Array<string>(4).fill("sensor-drift"),
    ...Array<string>(3).fill("lidar-dropout"),
    ...Array<string>(3).fill("battery-fault"),
  ];
  // deterministic Fisher–Yates so the event order looks natural, not sorted
  for (let i = labels.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [labels[i], labels[j]] = [labels[j] as string, labels[i] as string];
  }
  return { categories: labels };
}

/** Ohm's-law-ish pair: voltage ~ 220 + 20·sin, current ≈ 0.5·voltage + noise. */
function voltageCurrent(): GenericSeries {
  const rng = mulberry32(2026);
  const y: number[] = [];
  const y2: number[] = [];
  for (let i = 0; i < 300; i++) {
    const volts = 220 + 20 * Math.sin((2 * Math.PI * i) / 60) + 3 * randn(rng);
    y.push(volts);
    y2.push(0.5 * volts + randn(rng));
  }
  return { y, y2 };
}

/** y = 42 + microscopic deterministic wiggle (cv far below 1e-3). */
function flatMetric(): GenericSeries {
  const y: number[] = [];
  for (let i = 0; i < 240; i++) {
    y.push(42 + 0.003 * Math.sin(i * 0.13) + 0.002 * Math.cos(i * 0.031));
  }
  return { y };
}

/** Reuse the sidebar's generated hourly series (n=720, period 24) if present. */
function hourlyTraffic(): GenericSeries {
  if (state.data.y.length > 0) return { y: state.data.y, t: state.data.t };
  const gen = genSeries({ n: 720, period: 24, seed: state.params.seed });
  return { y: gen.y, t: gen.t };
}

// ---------- paste-your-own validation (JSON.parse only — never eval) ----------

const PASTE_HINT = 'paste JSON like { "y": [...], "y2": [...], "categories": [...], "t": [...] }';

function parsePaste(text: string): { input?: GenericSeries; error?: string } {
  if (!text.trim()) return { error: `paste some JSON first — e.g. ${PASTE_HINT}` };
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return { error: "invalid JSON — numbers must be plain JSON literals" };
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return { error: "expected a JSON object with keys y, y2, categories, t (any subset)" };
  }
  const rec = obj as Record<string, unknown>;
  for (const k of Object.keys(rec)) {
    if (k !== "y" && k !== "y2" && k !== "categories" && k !== "t") {
      return { error: `unknown key "${k}" — allowed: y, y2, categories, t` };
    }
  }

  const numArray = (key: string): number[] | string => {
    const v = rec[key];
    if (!Array.isArray(v)) return `"${key}" must be an array of numbers`;
    const out: number[] = [];
    for (const x of v) {
      if (typeof x !== "number" || !Number.isFinite(x)) return `"${key}" must contain only finite numbers`;
      out.push(x);
    }
    return out;
  };

  const y = "y" in rec ? numArray("y") : undefined;
  if (typeof y === "string") return { error: y };
  const y2 = "y2" in rec ? numArray("y2") : undefined;
  if (typeof y2 === "string") return { error: y2 };
  const t = "t" in rec ? numArray("t") : undefined;
  if (typeof t === "string") return { error: t };

  let categories: string[] | undefined;
  if ("categories" in rec) {
    const v = rec.categories;
    if (!Array.isArray(v) || v.some((s) => typeof s !== "string")) {
      return { error: '"categories" must be an array of strings' };
    }
    categories = v as string[];
  }

  if (y === undefined && categories === undefined) {
    return { error: "provide at least one of: y (numbers) or categories (strings)" };
  }
  if (y2 !== undefined && y === undefined) return { error: '"y2" requires "y"' };
  if (t !== undefined && y === undefined) return { error: '"t" requires "y"' };
  if (y !== undefined) {
    if (y2 !== undefined && y2.length !== y.length) {
      return { error: `"y2" length (${y2.length}) must match "y" length (${y.length})` };
    }
    if (t !== undefined && t.length !== y.length) {
      return { error: `"t" length (${t.length}) must match "y" length (${y.length})` };
    }
    if (categories !== undefined && categories.length !== y.length) {
      return { error: `"categories" length (${categories.length}) must match "y" length (${y.length})` };
    }
  }

  const input: GenericSeries = {};
  if (y !== undefined) input.y = y;
  if (y2 !== undefined) input.y2 = y2;
  if (t !== undefined) input.t = t;
  if (categories !== undefined) input.categories = categories;
  return { input };
}

// ---------- tab ----------

type SampleKey = "fleet" | "modes" | "volts" | "flat" | "traffic" | "paste";

const SAMPLES: { key: SampleKey; label: string }[] = [
  { key: "fleet", label: "fleet errors" },
  { key: "modes", label: "failure modes" },
  { key: "volts", label: "voltage vs current" },
  { key: "flat", label: "flat metric" },
  { key: "traffic", label: "hourly traffic" },
  { key: "paste", label: "paste your own" },
];

export function mountAutoChart(root: HTMLElement): () => Promise<void> {
  root.replaceChildren();

  let active: SampleKey = "fleet";
  let pasteInput: GenericSeries | null = null;

  // --- input selector: sample buttons + paste panel ---
  const sampleRow = el("div", { class: "auto-samples" });
  const buttons = new Map<SampleKey, HTMLButtonElement>();
  for (const s of SAMPLES) {
    const b = el("button", { class: "btn ghost", type: "button", text: s.label });
    if (s.key === active) b.classList.add("is-active");
    buttons.set(s.key, b);
    sampleRow.append(b);
  }

  const pasteArea = el("textarea", {
    id: "ac-paste",
    spellcheck: "false",
    placeholder: PASTE_HINT,
  }) as HTMLTextAreaElement;
  const pasteBtn = el("button", { class: "btn", type: "button", text: "chart it" });
  const pasteError = el("div", { class: "auto-paste-error" });
  const pastePanel = el("div", { class: "auto-paste" });
  pastePanel.append(pasteArea, el("div", { class: "ctl-row" }, pasteBtn), pasteError);
  pastePanel.style.display = "none";

  const controls = el("div", { class: "tab-controls" });
  controls.append(sampleRow, pastePanel);

  // --- explanation strip + chart area ---
  const chips = el("div", { class: "chips" });
  const overlayCb = el("input", { type: "checkbox", id: "ac-overlay" });
  const overlayRow = el("label", { class: "ctl check-ctl" }, overlayCb, document.createTextNode("anomaly overlay"));
  overlayRow.style.display = "none";
  controls.append(overlayRow);

  const plotArea = el("div", { class: "plot-area" });
  root.append(controls, chips, plotArea);

  // --- helpers ---

  function buildInput(): GenericSeries {
    switch (active) {
      case "fleet":
        return fleetErrors();
      case "modes":
        return failureModes();
      case "volts":
        return voltageCurrent();
      case "flat":
        return flatMetric();
      case "traffic":
        return hourlyTraffic();
      case "paste":
        return pasteInput ?? {};
    }
  }

  function setActive(key: SampleKey): void {
    active = key;
    for (const [k, b] of buttons) b.classList.toggle("is-active", k === key);
    pastePanel.style.display = key === "paste" ? "" : "none";
  }

  function headline(auto: AutoChartResult): [key: string, value: string, cls?: string][] {
    const out: [string, string, string?][] = [["kind", auto.kind, "cyan"]];
    switch (auto.kind) {
      case "correlation": {
        const c = auto.correlation;
        if (c) {
          out.push(["r", fmtNum(c.r)], ["significant", c.significant ? "yes" : "no", c.significant ? "good" : "bad"], ["n", String(c.n)]);
        }
        break;
      }
      case "majority": {
        const m = auto.majority;
        if (m) {
          out.push(
            ["dominant", m.dominant ?? "—"],
            ["proportion", fmtPct(m.dominantProportion), m.isMajority ? "good" : ""],
            ["threshold", fmtNum(m.threshold)],
          );
        }
        break;
      }
      case "category_outlier": {
        const co = auto.categoryOutlier;
        if (co) {
          out.push(
            ["outliers", String(co.outlierCount), co.outlierCount > 0 ? "bad" : "good"],
            ["agg", co.agg],
            ["fences", `${fmtNum(co.lowerFence)} … ${fmtNum(co.upperFence)}`],
          );
        }
        break;
      }
      case "low_variance": {
        const lv = auto.lowVariance;
        if (lv) {
          out.push(["cv", fmtNum(lv.cv)], ["mean", fmtNum(lv.mean)], ["flat", lv.isFlat ? "yes" : "no", lv.isFlat ? "good" : ""]);
        }
        break;
      }
      case "forecast": {
        const f = auto.forecast;
        if (f) out.push(["model", f.model, "accent"], ["period", f.period != null ? String(f.period) : "—"]);
        if (auto.anomalies) out.push(["anomalies", String(auto.anomalies.anomalies.length)]);
        break;
      }
      case "anomalies": {
        const a = auto.anomalies;
        if (a) out.push(["anomalies", String(a.anomalies.length), a.anomalies.length > 0 ? "bad" : "good"], ["method", a.method]);
        break;
      }
      default:
        break; // distribution: no extra headline numbers
    }
    return out;
  }

  function render(input: GenericSeries, auto: AutoChartResult): void {
    clearNode(plotArea);
    const opts = { width: Math.max(320, plotArea.clientWidth - 20), height: 340 };

    const both = auto.forecast != null && auto.anomalies != null;
    overlayRow.style.display = both ? "" : "none";

    if (both && overlayCb.checked) {
      // swap to the dedicated anomaly renderer over the same series
      const series = (auto.series ?? { y: input.y, t: input.t }) as SeriesInput;
      plotArea.append(anomalyPlot(series, auto.anomalies!, opts));
    } else {
      plotArea.append(autoChartPlot(input, auto, opts));
    }

    setChipValues(chips, headline(auto));
    // explanation chip: prose reason (autoChartReason is a thin pass-through)
    const reason = el("span", { class: "chip stat reason" });
    reason.append(el("span", { class: "k", text: "why" }), el("span", { class: "v", text: autoChartReason(auto) }));
    chips.append(reason);
  }

  async function refresh(): Promise<void> {
    if (active === "paste" && pasteInput === null) {
      pasteError.textContent = pasteArea.value.trim() ? parsePaste(pasteArea.value).error ?? PASTE_HINT : PASTE_HINT;
      return;
    }
    await runCompute(plotArea, (engine) => {
      const input = buildInput();
      render(input, engine.autoChart(input));
    });
  }

  // --- wiring ---

  for (const [key, b] of buttons) {
    b.addEventListener("click", () => {
      setActive(key);
      refreshSoon();
    });
  }

  pasteArea.addEventListener("input", () => {
    if (active !== "paste") setActive("paste");
    const parsed = parsePaste(pasteArea.value);
    if (parsed.error !== undefined) {
      pasteError.textContent = parsed.error;
      return; // keep the last good chart up; no recompute on bad input
    }
    pasteError.textContent = "";
    pasteInput = parsed.input ?? null;
    refreshSoon();
  });

  pasteBtn.addEventListener("click", () => {
    const parsed = parsePaste(pasteArea.value);
    if (parsed.error !== undefined) {
      pasteError.textContent = parsed.error;
      return;
    }
    pasteError.textContent = "";
    pasteInput = parsed.input ?? null;
    setActive("paste");
    void refresh();
  });

  overlayCb.addEventListener("change", refresh);

  const refreshSoon = debounce(refresh, 150);
  void refresh();
  return refresh;
}
