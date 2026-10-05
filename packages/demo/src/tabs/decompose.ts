// Decompose tab: robust toggle, seasons slider, stacked component plot,
// seasonal-strength chips.
import { decomposePlot, fmt } from "isocline-plot";
import { state } from "../state.js";
import { clearNode, controlRow, debounce, el, outputFor, rangeInput, runCompute, setChipValues } from "../util.js";

export function mountDecompose(root: HTMLElement): () => Promise<void> {
  root.replaceChildren();

  const cbRobust = el("input", { type: "checkbox", checked: true, id: "dc-robust" });
  const seasons = rangeInput("dc-seasons", 1, 7, 1, 3);
  const seasonsOut = outputFor("3");

  const controls = el("div", { class: "tab-controls" });
  controls.append(
    el("label", { class: "ctl check-ctl" }, cbRobust, document.createTextNode("robust")),
    controlRow("seasons (inner iters)", seasons, seasonsOut),
  );

  const chips = el("div", { class: "chips" });
  const plotArea = el("div", { class: "plot-area" });
  root.append(controls, chips, plotArea);

  async function refresh(): Promise<void> {
    await runCompute(plotArea, (engine) => {
      const series = state.series();
      const res = engine.decompose(series, {
        robust: cbRobust.checked,
        seasons: Number(seasons.value),
      });
      clearNode(plotArea);
      plotArea.append(
        decomposePlot(series, res, {
          width: Math.max(320, plotArea.clientWidth - 20),
          height: 120,
        }),
      );
      setChipValues(chips, [
        ["period", String(res.period), "accent"],
        ["seasonal strength", fmt(res.seasonalStrength), res.seasonalStrength >= 0.5 ? "good" : ""],
        ["resid var", fmt(varianceOf(res.resid))],
      ]);
    });
  }

  seasons.addEventListener("input", () => {
    seasonsOut.value = seasons.value;
    refreshSoon();
  });
  cbRobust.addEventListener("change", refresh);

  const refreshSoon = debounce(refresh, 150);
  void refresh();
  return refresh;
}

function varianceOf(a: ArrayLike<number>): number {
  const n = a.length;
  if (n < 2) return 0;
  let s = 0;
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const v = a[i] as number;
    s += v;
    sq += v * v;
  }
  const m = s / n;
  return sq / (n - 1) - m * m;
}
