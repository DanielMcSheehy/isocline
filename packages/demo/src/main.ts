// Demo entrypoint: wires the sidebar store, header badges, tab nav, and the
// per-tab refresh loop (debounced 150 ms on sidebar changes).
import "./style.css";
import { state } from "./state.js";
import { getEngine, isRealEngine } from "./engine.js";
import type { Isocline } from "isocline";
import { debounce } from "./util.js";
import { mountForecast } from "./tabs/forecast.js";
import { mountAnomalies } from "./tabs/anomalies.js";
import { mountDecompose } from "./tabs/decompose.js";
import { mountSeasonality } from "./tabs/seasonality.js";
import { mountChangepoints } from "./tabs/changepoints.js";
import { mountBacktest } from "./tabs/backtest.js";
import { mountBenchmark } from "./tabs/benchmark.js";

// ---------- sparkline ----------

function drawSparkline(): void {
  const canvas = document.getElementById("sparkline") as HTMLCanvasElement | null;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { width: w, height: h } = canvas;
  ctx.clearRect(0, 0, w, h);

  const y = state.data.y;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of y) {
    if (Number.isFinite(v)) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
  const pad = 4;
  const span = Math.max(1e-9, hi - lo);
  const px = (i: number): number => (i / Math.max(1, y.length - 1)) * (w - 2 * pad) + pad;
  const py = (v: number): number => h - pad - ((v - lo) / span) * (h - 2 * pad);

  ctx.strokeStyle = "rgba(255,255,255,0.07)";
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
  ctx.strokeStyle = "#22d3ee";
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  let pen = false;
  for (let i = 0; i < y.length; i++) {
    const v = y[i] as number;
    if (!Number.isFinite(v)) {
      pen = false;
      continue;
    }
    if (!pen) {
      ctx.moveTo(px(i), py(v));
      pen = true;
    } else {
      ctx.lineTo(px(i), py(v));
    }
  }
  ctx.stroke();
}

// ---------- sidebar wiring ----------

function bindRange(id: string, outputId: string, apply: (v: number) => void, format: (v: number) => string = String): void {
  const input = document.getElementById(id) as HTMLInputElement | null;
  const out = document.getElementById(outputId) as HTMLOutputElement | null;
  if (!input || !out) return;
  out.value = format(Number(input.value));
  input.addEventListener("input", () => {
    const v = Number(input.value);
    out.value = format(v);
    apply(v);
  });
}

function bindCheck(id: string, apply: (v: boolean) => void): void {
  const input = document.getElementById(id) as HTMLInputElement | null;
  if (!input) return;
  input.addEventListener("change", () => apply(input.checked));
}

function wireSidebar(): void {
  bindRange("syn-n", "syn-n-v", (v) => state.update({ n: v }));
  const periodSel = document.getElementById("syn-period") as HTMLSelectElement | null;
  periodSel?.addEventListener("change", () => state.update({ period: Number(periodSel.value) }));
  bindRange("syn-trend", "syn-trend-v", (v) => state.update({ trend: v }), (v) => v.toFixed(3));
  bindRange("syn-sigma", "syn-sigma-v", (v) => state.update({ sigma: v }), (v) => v.toFixed(1));
  bindRange("syn-amplitude", "syn-amplitude-v", (v) => state.update({ amplitude: v }), (v) => v.toFixed(1));
  bindRange("syn-spikes", "syn-spikes-v", (v) => state.update({ spikes: Math.round(v) }));
  bindRange("syn-dips", "syn-dips-v", (v) => state.update({ dips: Math.round(v) }));
  bindRange("syn-eventmag", "syn-eventmag-v", (v) => state.update({ eventMag: v }), (v) => v.toFixed(1));
  bindCheck("syn-shift", (v) => state.update({ shift: v }));
  bindRange("syn-shiftmag", "syn-shiftmag-v", (v) => state.update({ shiftMag: v }), (v) => v.toFixed(1));
  bindCheck("syn-drift", (v) => state.update({ drift: v }));
  bindRange("syn-missing", "syn-missing-v", (v) => state.update({ missing: Math.round(v) }));

  const seedInput = document.getElementById("syn-seed") as HTMLInputElement | null;
  seedInput?.addEventListener("change", () => state.resetSeed(Number(seedInput.value)));
  document.getElementById("syn-dice")?.addEventListener("click", () => {
    state.randomizeSeed();
    if (seedInput) seedInput.value = String(state.params.seed);
  });
  document.getElementById("btn-regenerate")?.addEventListener("click", () => state.regenerate());

  // reflect external seed changes (dice) back into the output display
  state.subscribe(() => {
    if (seedInput && document.activeElement !== seedInput) seedInput.value = String(state.params.seed);
  });
}

// ---------- tabs ----------

type RefreshFn = () => Promise<void> | void;

function wireTabs(): void {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(".tab"));
  const panels = new Map<string, HTMLElement>();
  for (const b of buttons) {
    const panel = document.getElementById(`tab-${b.dataset.tab}`);
    if (panel) panels.set(b.dataset.tab as string, panel);
  }

  const refreshers = new Map<string, RefreshFn>([
    ["forecast", mountForecast(panels.get("forecast") as HTMLElement)],
    ["anomalies", mountAnomalies(panels.get("anomalies") as HTMLElement)],
    ["decompose", mountDecompose(panels.get("decompose") as HTMLElement)],
    ["seasonality", mountSeasonality(panels.get("seasonality") as HTMLElement)],
    ["changepoints", mountChangepoints(panels.get("changepoints") as HTMLElement)],
    ["backtest", mountBacktest(panels.get("backtest") as HTMLElement)],
    ["benchmark", mountBenchmark(panels.get("benchmark") as HTMLElement)],
  ]);

  let active = "forecast";

  const activate = (id: string): void => {
    active = id;
    for (const b of buttons) {
      const on = b.dataset.tab === id;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-selected", String(on));
    }
    for (const [tabId, panel] of panels) panel.classList.toggle("is-active", tabId === id);
    void refreshers.get(id)?.();
  };

  for (const b of buttons) {
    b.addEventListener("click", () => activate(b.dataset.tab as string));
    b.addEventListener("keydown", (ev) => {
      if (ev.key !== "ArrowRight" && ev.key !== "ArrowLeft") return;
      const idx = buttons.indexOf(b);
      const next = buttons[(idx + (ev.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length]!;
      next.focus();
      activate(next.dataset.tab as string);
      ev.preventDefault();
    });
  }

  // sidebar changes → re-run only the ACTIVE tab (debounced 150 ms)
  const refreshActive = debounce(() => {
    void refreshers.get(active)?.();
  }, 150);
  state.subscribe(() => {
    drawSparkline();
    refreshActive();
  });
}

// ---------- header badges + engine pill ----------

const GZIP_KB = 88; // hardcode from the build briefing — no gzip in-browser

/** Report raw KB of the served wasm binary (labelled; gzip KB is static). */
async function fetchWasmKB(): Promise<number | null> {
  try {
    const res = await fetch("/isocline.wasm");
    if (!res.ok) return null;
    const bytes = await res.arrayBuffer();
    return Math.round(bytes.byteLength / 1024);
  } catch {
    return null;
  }
}

/** Forecasts of the default n=720 / h=24 series per second, measured ~2s.
 *  Chunked with yields so the page stays responsive while measuring. */
async function measureThroughput(engine: Isocline): Promise<number> {
  const { genSeries } = await import("isocline");
  const series = genSeries({ n: 720, seed: 42 });
  const deadline = performance.now() + 2000;
  let ops = 0;
  let t = performance.now();
  while (t < deadline) {
    for (let i = 0; i < 256; i++) {
      engine.forecast(series, { horizon: 24, seed: 42 });
      ops++;
    }
    await new Promise((r) => setTimeout(r, 0));
    t = performance.now();
  }
  return ops / ((t - (deadline - 2000)) / 1000);
}

function wireEngineMeta(): void {
  void getEngine().then(async (engine) => {
    // version chip: real value (mock reports "0.1.0-mock")
    const v = document.getElementById("badge-version");
    if (v) v.textContent = `v${engine.version}`;
    if (!isRealEngine()) return; // mock: pill/badges stay as-is

    const pill = document.getElementById("engine-pill");
    if (pill) {
      pill.classList.remove("pill-amber");
      pill.classList.add("pill-green");
      pill.textContent = "engine: wasm";
      pill.title = "real wasm engine loaded";
    }

    const size = document.getElementById("badge-wasm-size");
    if (size) {
      const kb = await fetchWasmKB();
      if (kb !== null) {
        size.title = `${kb} KB raw · ~${GZIP_KB} KB gzipped`;
        size.textContent = `wasm · ${kb} KB (${GZIP_KB} KB gz)`;
      }
    }

    const tput = document.getElementById("badge-throughput");
    if (tput) {
      try {
        const ops = await measureThroughput(engine);
        tput.textContent = `${Math.round(ops).toLocaleString("en-US")} forecast/s`;
        tput.title = `n=720, h=24, measured over ~2s against the wasm engine`;
      } catch (err) {
        console.warn("[isocline] throughput measurement failed", err);
      }
    }
  });
}

// ---------- responsive drawer ----------

function wireDrawer(): void {
  document.getElementById("sidebar-toggle")?.addEventListener("click", () => {
    document.getElementById("sidebar")?.classList.toggle("open");
  });
}

drawSparkline();
wireSidebar();
wireTabs();
wireEngineMeta();
wireDrawer();
