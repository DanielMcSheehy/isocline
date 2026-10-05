// Changepoints tab: threshold-σ and min-segment sliders, step-mean plot,
// detected vs ground-truth lists.
import { changepointPlot, fmt } from "isocline-plot";
import { state } from "../state.js";
import { clearNode, controlRow, debounce, el, outputFor, rangeInput, runCompute, setChipValues } from "../util.js";

export function mountChangepoints(root: HTMLElement): () => Promise<void> {
  root.replaceChildren();

  const threshold = rangeInput("cp-threshold", 2, 5, 0.1, 3);
  const thresholdOut = outputFor("3.0");
  const minSegment = rangeInput("cp-minseg", 5, 50, 1, 10);
  const minSegOut = outputFor("10");

  const controls = el("div", { class: "tab-controls" });
  controls.append(
    controlRow("threshold (σ)", threshold, thresholdOut),
    controlRow("min segment", minSegment, minSegOut),
  );

  const chips = el("div", { class: "chips" });

  const detectedTitle = el("div", { class: "sparkline-label", text: "detected" });
  const detectedList = el("div", { class: "item-list" });
  const truthTitle = el("div", { class: "sparkline-label", text: "ground truth (generator)" });
  const truthList = el("div", { class: "item-list" });

  const plotArea = el("div", { class: "plot-area" });
  root.append(controls, chips, plotArea, detectedTitle, detectedList, truthTitle, truthList);

  async function refresh(): Promise<void> {
    await runCompute(plotArea, (engine) => {
      const series = state.series();
      const res = engine.changepoints(series, {
        threshold: Number(threshold.value),
        minSegment: Number(minSegment.value),
      });
      clearNode(plotArea);
      plotArea.append(
        changepointPlot(series, res, {
          width: Math.max(320, plotArea.clientWidth - 20),
          height: 320,
        }),
      );
      setChipValues(chips, [["detected", String(res.changepoints.length), "accent"]]);

      // detected list: index + mean shift
      clearNode(detectedList);
      if (res.changepoints.length === 0) {
        detectedList.append(el("span", { class: "chip", text: "none" }));
      }
      for (const cp of res.changepoints) {
        detectedList.append(
          el("span", { class: "chip" }, document.createTextNode(`i=${cp.index} · ${fmt(cp.meanBefore)} → ${fmt(cp.meanAfter)}`)),
        );
      }

      // ground truth from the generator
      clearNode(truthList);
      const truth = state.data.changepoints;
      if (truth.length === 0) truthList.append(el("span", { class: "chip", text: "none" }));
      for (const idx of truth) {
        truthList.append(el("span", { class: "chip chip-quiet", text: `i=${idx}` }));
      }
    });
  }

  threshold.addEventListener("input", () => {
    thresholdOut.value = Number(threshold.value).toFixed(1);
    refreshSoon();
  });
  minSegment.addEventListener("input", () => {
    minSegOut.value = minSegment.value;
    refreshSoon();
  });

  const refreshSoon = debounce(refresh, 150);
  void refresh();
  return refresh;
}
