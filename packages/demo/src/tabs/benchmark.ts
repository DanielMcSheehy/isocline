// Benchmark tab: times the CURRENT engine (mock now, wasm at integration)
// on a fixed op×n grid, plus a pure-JS snaive baseline row for comparison.
// Cell ids: bench-<op>-<n> — integration reuses them for the real engine.
import { fmt } from "isocline-plot";
import { genSeries } from "isocline";
import { useEngine } from "../engine.js";
import { state } from "../state.js";
import { clearNode, el, fmtMs, toast } from "../util.js";

interface BenchOp {
  op: "forecast" | "anomalies" | "decompose" | "seasonality" | "snaive-js";
  n: number;
  label: string;
  baseline?: boolean;
}

const OPS: BenchOp[] = [
  { op: "forecast", n: 1_000, label: "forecast · n=1k · h=48" },
  { op: "forecast", n: 10_000, label: "forecast · n=10k · h=48" },
  { op: "forecast", n: 50_000, label: "forecast · n=50k · h=48" },
  { op: "anomalies", n: 10_000, label: "anomalies · n=10k" },
  { op: "decompose", n: 10_000, label: "decompose · n=10k" },
  { op: "seasonality", n: 10_000, label: "seasonality · n=10k" },
  { op: "snaive-js", n: 1_000, label: "snaive·js baseline · n=1k", baseline: true },
  { op: "snaive-js", n: 10_000, label: "snaive·js baseline · n=10k", baseline: true },
  { op: "snaive-js", n: 50_000, label: "snaive·js baseline · n=50k", baseline: true },
];

const cellId = (op: string, n: number): string => `bench-${op}-${n}`;

/** Pure-JS seasonal-naive forecast, horizon 48 — the baseline to beat. */
function snaiveJs(y: Float64Array, period: number, h: number): Float64Array {
  const n = y.length;
  const out = new Float64Array(h);
  const p = Math.max(1, period);
  for (let k = 0; k < h; k++) out[k] = y[n - p + (k % p)] as number;
  return out;
}

export function mountBenchmark(root: HTMLElement): () => Promise<void> {
  root.replaceChildren();

  const runBtn = el("button", { class: "btn primary", id: "bench-run", text: "run benchmarks", style: "width:auto; align-self: flex-start;" });

  const table = el("table", { class: "data" });
  const head = el("thead");
  const headRow = el("tr");
  for (const [label, sortable] of [["op", false], ["n", false], ["time", false]] as const) {
    headRow.append(el("th", { text: label }));
    void sortable;
  }
  head.append(headRow);
  const body = el("tbody");
  for (const bench of OPS) {
    const tr = el("tr", { class: bench.baseline ? "baseline" : "" });
    tr.append(
      el("td", { text: bench.label }),
      el("td", { class: "dim", text: String(bench.n) }),
      el("td", { id: cellId(bench.op, bench.n), text: "—" }),
    );
    body.append(tr);
  }
  table.append(head, body);
  const tableWrap = el("div", { class: "table-wrap" });
  tableWrap.append(table);

  const bars = el("div", { class: "bars", id: "bench-bars" });
  for (const bench of OPS) {
    const row = el("div", { class: "bar-row", "data-op": cellId(bench.op, bench.n) });
    row.append(
      el("span", { class: "bar-label", text: bench.label }),
      el("span", { class: "bar-track" }, el("span", { class: `bar-fill${bench.baseline ? " baseline" : ""}` })),
      el("span", { class: "bar-val", text: "—" }),
    );
    bars.append(row);
  }

  const note = el(
    "div",
    { class: "note" },
    document.createTextNode(
      "timings measure the currently loaded engine (real wasm, or the pure-TS mock via ?mock=1). the snaive·js row is a pure-JS baseline on the same grid for comparison.",
    ),
  );

  const col = el("div", { style: "display: flex; flex-direction: column; gap: 12px;" });
  col.append(runBtn, tableWrap, bars, note);
  root.append(col);

  let running = false;

  function updateBars(): void {
    const entries: { id: string; ms: number; baseline: boolean }[] = [];
    for (const bench of OPS) {
      const cell = document.getElementById(cellId(bench.op, bench.n));
      const ms = cell ? Number(cell.dataset.ms ?? NaN) : NaN;
      if (Number.isFinite(ms)) entries.push({ id: cellId(bench.op, bench.n), ms, baseline: !!bench.baseline });
    }
    const max = Math.max(...entries.map((e) => e.ms), 1e-9);
    for (const row of Array.from(bars.children) as HTMLElement[]) {
      const id = row.dataset.op ?? "";
      const val = row.querySelector(".bar-val") as HTMLElement;
      const fill = row.querySelector(".bar-fill") as HTMLElement;
      const e = entries.find((x) => x.id === id);
      if (e) {
        fill.style.width = `${Math.max(1.5, (Math.log10(e.ms + 1) / Math.log10(max + 1)) * 100)}%`;
        val.textContent = fmtMs(e.ms);
      }
    }
  }

  async function run(): Promise<void> {
    if (running) return;
    running = true;
    runBtn.disabled = true;
    runBtn.textContent = "running…";
    try {
      const engine = await useEngine();
      const h = 48;
      for (const bench of OPS) {
        const cell = document.getElementById(cellId(bench.op, bench.n));
        if (!cell) continue;
        cell.textContent = "…";
        await new Promise((r) => setTimeout(r, 16)); // let the UI breathe between ops
        const series = state.series();
        let ms = NaN;
        try {
          const t0 = performance.now();
          if (bench.op === "snaive-js") {
            // baseline on the same n: build a length-n series
            const big = genSeries({ n: bench.n, seed: 42 });
            snaiveJs(big.y, 24, h);
          } else if (bench.n !== series.y.length) {
            const big = genSeries({ n: bench.n, seed: state.params.seed });
            const sub = { y: big.y, t: big.t };
            if (bench.op === "forecast") engine.forecast(sub, { horizon: h, seed: 42 });
            else if (bench.op === "anomalies") engine.detectAnomalies(sub);
            else if (bench.op === "decompose") engine.decompose(sub);
            else engine.seasonality(sub, { maxPeriod: 256 });
          } else if (bench.op === "forecast") {
            engine.forecast(series, { horizon: h, seed: 42 });
          } else if (bench.op === "anomalies") {
            engine.detectAnomalies(series);
          } else if (bench.op === "decompose") {
            engine.decompose(series);
          } else {
            engine.seasonality(series, { maxPeriod: 256 });
          }
          ms = performance.now() - t0;
        } catch (err) {
          toast(`benchmark ${bench.op} n=${bench.n} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        cell.textContent = Number.isFinite(ms) ? fmtMs(ms) : "err";
        cell.dataset.ms = Number.isFinite(ms) ? String(ms) : "";
      }
      updateBars();
    } finally {
      running = false;
      runBtn.disabled = false;
      runBtn.textContent = "run benchmarks";
    }
  }

  runBtn.addEventListener("click", run);
  void run(); // first fill on mount — mock is fast enough at these sizes
  return async () => {
    /* benchmarks run on demand, not on sidebar refresh */
  };
}
