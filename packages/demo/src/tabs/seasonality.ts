// Seasonality tab: maxPeriod slider, ACF + periodogram plot, detected-period
// headline and candidate chips.
import { seasonalityCandidates, seasonalityPlot } from "isocline-plot";
import type { SeasonalityResult } from "isocline";
import { state } from "../state.js";
import { clearNode, controlRow, debounce, el, outputFor, rangeInput, runCompute } from "../util.js";

export function mountSeasonality(root: HTMLElement): () => Promise<void> {
  root.replaceChildren();

  const maxPeriod = rangeInput("ss-maxperiod", 8, 512, 8, 168);
  const maxPeriodOut = outputFor("168");

  const controls = el("div", { class: "tab-controls" });
  controls.append(controlRow("max period", maxPeriod, maxPeriodOut));

  const headline = el("div", {
    class: "chips",
    role: "status",
  });
  const chips = el("div", { class: "chips" });
  const plotArea = el("div", { class: "plot-area" });
  root.append(controls, headline, chips, plotArea);

  function renderHeadline(res: SeasonalityResult): void {
    headline.replaceChildren();
    const strong = res.bestPeriod != null;
    const text = strong
      ? `best period: ${res.bestPeriod} · strength ${res.strength.toFixed(2)}`
      : `no strong period (best candidate ${res.candidates[0]?.period ?? "—"} · strength ${res.strength.toFixed(2)})`;
    headline.append(
      el("span", {
        class: `chip stat ${strong ? "good" : ""}`,
      }, el("span", { class: "v", text })),
    );
  }

  async function refresh(): Promise<void> {
    await runCompute(plotArea, (engine) => {
      const series = state.series();
      const res = engine.seasonality(series, { maxPeriod: Number(maxPeriod.value) });
      clearNode(plotArea);
      plotArea.append(
        seasonalityPlot(res, {
          width: Math.max(320, Math.floor((plotArea.clientWidth - 30) / 2)),
          height: 300,
        }),
      );
      renderHeadline(res);
      const cands = seasonalityCandidates(res);
      clearNode(chips);
      for (const c of cands.slice(0, 5)) {
        chips.append(
          el("span", { class: "chip" }, document.createTextNode(`p=${c.period} · ${c.strength.toFixed(2)} (${c.source})`)),
        );
      }
      if (cands.length === 0) chips.append(el("span", { class: "chip", text: "no candidates" }));
    });
  }

  maxPeriod.addEventListener("input", () => {
    maxPeriodOut.value = maxPeriod.value;
    refreshSoon();
  });

  const refreshSoon = debounce(refresh, 150);
  void refresh();
  return refresh;
}
