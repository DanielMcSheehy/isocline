// Backtest tab: model multi-select, horizon/folds sliders, sortable
// leaderboard table + metric heatmap via isocline-plot.
import { backtestPlot, fmt } from "isocline-plot";
import type { BacktestResult, ModelKind } from "isocline";
import { state } from "../state.js";
import { clearNode, controlRow, debounce, el, fmtPct, outputFor, rangeInput, runCompute, toast } from "../util.js";

const MODEL_KEYS = ["stl_ets", "ets", "ar", "snaive", "naive"] as const;
const SORT_KEYS = ["rmse", "mae", "smape", "coverage"] as const;
type SortKey = (typeof SORT_KEYS)[number];

export function mountBacktest(root: HTMLElement): () => Promise<void> {
  root.replaceChildren();

  const modelBoxes = new Map<ModelKind, HTMLInputElement>();
  const modelWrap = el("div", { class: "ctl" });
  const modelLabel = el("label", { text: "models" });
  modelWrap.append(modelLabel);
  const modelRow = el("div", { class: "ctl-row", style: "flex-wrap: wrap; gap: 4px 12px;" });
  for (const m of MODEL_KEYS) {
    const cb = el("input", { type: "checkbox", checked: m !== "naive", id: `bt-${m}` });
    modelBoxes.set(m, cb);
    const lab = el("label", { class: "check-ctl", style: "display:inline-flex; gap:4px; align-items:center; font: 500 12px var(--mono); color: var(--muted);" }, cb, document.createTextNode(m));
    modelRow.append(lab);
  }
  modelWrap.append(modelRow);

  const horizon = rangeInput("bt-horizon", 1, 96, 1, 24);
  const horizonOut = outputFor("24");
  const folds = rangeInput("bt-folds", 1, 10, 1, 3);
  const foldsOut = outputFor("3");

  const controls = el("div", { class: "tab-controls" });
  controls.append(modelWrap, controlRow("horizon", horizon, horizonOut), controlRow("folds", folds, foldsOut));

  let last: BacktestResult | null = null;
  let sortKey: SortKey = "rmse";
  let sortAsc = true;

  const table = el("table", { class: "data" });
  const tableWrap = el("div", { class: "table-wrap" });
  tableWrap.append(table);
  const plotArea = el("div", { class: "plot-area" });
  root.append(controls, tableWrap, plotArea);

  function renderTable(): void {
    if (!last) return;
    table.replaceChildren();
    const head = el("tr");
    const mkTh = (key: string, label: string, sortable: boolean): void => {
      const th = el("th", { scope: "col", text: label });
      if (sortable) {
        if (key === sortKey) th.classList.add("sorted");
        th.addEventListener("click", () => {
          if (sortKey === key) sortAsc = !sortAsc;
          else {
            sortKey = key as SortKey;
            sortAsc = true;
          }
          renderTable();
        });
      }
      head.append(th);
    };
    mkTh("model", "model", false);
    mkTh("folds", "folds", false);
    for (const k of SORT_KEYS) mkTh(k, k, true);

    const body = el("tbody");
    const rows = [...last.rows].sort((a, b) => (sortAsc ? 1 : -1) * (a[sortKey] - b[sortKey]));
    for (const r of rows) {
      body.append(
        el(
          "tr",
          {},
          el("td", { text: r.model }),
          el("td", { class: "dim", text: String(r.folds) }),
          el("td", { text: fmt(r.rmse) }),
          el("td", { text: fmt(r.mae) }),
          el("td", { text: fmt(r.smape) }),
          el("td", { text: fmtPct(r.coverage) }),
        ),
      );
    }
    table.append(el("thead", {}, head), body);
  }

  async function refresh(): Promise<void> {
    const models = [...modelBoxes.entries()].filter(([, cb]) => cb.checked).map(([m]) => m);
    if (models.length === 0) {
      toast("backtest: select at least one model");
      return;
    }
    await runCompute(plotArea, (engine) => {
      const series = state.series();
      last = engine.backtest(series, {
        models,
        horizon: Number(horizon.value),
        folds: Number(folds.value),
        seed: state.params.seed,
      });
      renderTable();
      clearNode(plotArea);
      plotArea.append(
        backtestPlot(last, {
          width: Math.max(320, plotArea.clientWidth - 20),
          height: 46 * Math.max(2, last.rows.length) + 40,
        }),
      );
    });
  }

  horizon.addEventListener("input", () => {
    horizonOut.value = horizon.value;
    refreshSoon();
  });
  folds.addEventListener("input", () => {
    foldsOut.value = folds.value;
    refreshSoon();
  });
  for (const cb of modelBoxes.values()) cb.addEventListener("change", refresh);

  const refreshSoon = debounce(refresh, 150);
  void refresh();
  return refresh;
}
