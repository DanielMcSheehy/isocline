// Forecast tab: model picker, horizon/level/paths, PI band + spaghetti +
// component toggles, metrics chips, warnings, big plot via isocline-plot.
import { forecastPlot, fmt } from "isocline-plot";
import type { ModelKind } from "isocline";
import { state } from "../state.js";
import { clearNode, controlRow, debounce, el, outputFor, rangeInput, runCompute, setChipValues } from "../util.js";

const MODELS: ModelKind[] = ["auto", "stl_ets", "ets", "ar", "snaive", "naive"];
const LEVELS = [0.8, 0.9, 0.95, 0.99];

export function mountForecast(root: HTMLElement): () => Promise<void> {
  root.replaceChildren();

  const modelSel = el("select", { id: "fc-model" });
  for (const m of MODELS) modelSel.append(el("option", { value: m, selected: m === "auto", text: m }));

  const horizon = rangeInput("fc-horizon", 1, 168, 1, 24);
  const horizonOut = outputFor("24");

  const levelSel = el("select", { id: "fc-level" });
  for (const lv of LEVELS) levelSel.append(el("option", { value: String(lv), selected: lv === 0.95, text: `${lv}` }));

  const paths = rangeInput("fc-paths", 0, 1000, 10, 200);
  const pathsOut = outputFor("200");

  const cbBand = el("input", { type: "checkbox", checked: true, id: "fc-band" });
  const cbPaths = el("input", { type: "checkbox", id: "fc-paths-show" });
  const cbComp = el("input", { type: "checkbox", id: "fc-components" });

  const controls = el("div", { class: "tab-controls" });
  controls.append(
    controlRow("model", modelSel),
    controlRow("horizon", horizon, horizonOut),
    controlRow("level", levelSel),
    controlRow("paths", paths, pathsOut),
    el("label", { class: "ctl check-ctl" }, cbBand, document.createTextNode("PI band")),
    el("label", { class: "ctl check-ctl" }, cbPaths, document.createTextNode("sample paths")),
    el("label", { class: "ctl check-ctl" }, cbComp, document.createTextNode("trend/seasonal")),
  );

  const chips = el("div", { class: "chips" });
  const notes = el("div", { class: "note" });
  const plotArea = el("div", { class: "plot-area" });
  root.append(controls, chips, notes, plotArea);

  async function refresh(): Promise<void> {
    await runCompute(plotArea, (engine) => {
      const series = state.series();
      const res = engine.forecast(series, {
        model: modelSel.value as ModelKind,
        horizon: Number(horizon.value),
        level: Number(levelSel.value),
        paths: Number(paths.value),
        seed: state.params.seed,
      });
      clearNode(plotArea);
      plotArea.append(
        forecastPlot(series, res, {
          width: Math.max(320, plotArea.clientWidth - 20),
          height: 340,
          showBand: cbBand.checked,
          paths: cbPaths.checked,
          showComponents: cbComp.checked,
          yLabel: "y",
        }),
      );
      setChipValues(chips, [
        ["model", res.model, "accent"],
        ["period", res.period != null ? String(res.period) : "—"],
        ["rmse", fmt(res.metrics.rmse)],
        ["mae", fmt(res.metrics.mae)],
        ["smape", fmt(res.metrics.smape)],
      ]);
      notes.textContent = res.warnings.join(" · ");
    });
  }

  horizon.addEventListener("input", () => {
    horizonOut.value = horizon.value;
    refreshSoon();
  });
  paths.addEventListener("input", () => {
    pathsOut.value = paths.value;
    refreshSoon();
  });
  for (const node of [modelSel, levelSel]) node.addEventListener("change", refresh);
  for (const node of [cbBand, cbPaths, cbComp]) node.addEventListener("change", refresh);

  const refreshSoon = debounce(refresh, 150);
  void refresh();
  return refresh;
}
