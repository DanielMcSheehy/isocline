// Anomalies tab: method picker, adaptive threshold slider, ewma lambda,
// direction filter, lookback window, flagged-point plot with plain-language
// explanations, precision/recall vs ground truth.
import { anomalyPlot, anomalySplit, fmt } from "isocline-plot";
import { explainAnomalies, type AnomalyMethod, type DurationString } from "isocline";
import { state } from "../state.js";
import { clearNode, controlRow, debounce, el, fmtPct, outputFor, rangeInput, runCompute, setChipValues } from "../util.js";

const METHODS: AnomalyMethod[] = ["stl", "madz", "iqr", "ewma"];

/** threshold slider ranges adapt per method: iqr is a k (1–4), others a z (2–6) */
function thresholdRange(method: AnomalyMethod): { min: number; max: number; label: string } {
  return method === "iqr"
    ? { min: 1, max: 4, label: "threshold (k·IQR)" }
    : { min: 2, max: 6, label: "threshold (|z|)" };
}

export function mountAnomalies(root: HTMLElement): () => Promise<void> {
  root.replaceChildren();

  const methodSel = el("select", { id: "an-method" });
  for (const m of METHODS) methodSel.append(el("option", { value: m, selected: m === "stl", text: m }));

  const threshold = rangeInput("an-threshold", 2, 6, 0.1, 3.5);
  const thresholdOut = outputFor("3.5");
  const thresholdLabel = el("label", {}) as HTMLLabelElement;
  thresholdLabel.append(document.createTextNode(thresholdRange("stl").label + " "), thresholdOut);

  const lambda = rangeInput("an-lambda", 0.05, 0.9, 0.05, 0.3);
  const lambdaOut = outputFor("0.30");
  const lambdaRow = controlRow("lambda", lambda, lambdaOut);
  lambdaRow.style.display = "none";

  const dirSel = el("select", { id: "an-direction" });
  for (const [v, t] of [["both", "both"], ["high", "spikes only"], ["low", "dips only"]] as const) {
    dirSel.append(el("option", { value: v, text: t }));
  }

  const lookbackSel = el("select", { id: "an-lookback" });
  for (const [v, t] of [["", "all history"], ["7d", "last 7 days"], ["3d", "last 3 days"], ["24h", "last 24 hours"]] as const) {
    lookbackSel.append(el("option", { value: v, text: t }));
  }

  const controls = el("div", { class: "tab-controls" });
  controls.append(controlRow("method", methodSel));

  const thresholdCtl = el("div", { class: "ctl" });
  thresholdCtl.append(thresholdLabel, threshold);
  controls.append(thresholdCtl, lambdaRow, controlRow("direction", dirSel), controlRow("lookback", lookbackSel));

  const chips = el("div", { class: "chips" });
  const notes = el("div", { class: "note" });
  const plotArea = el("div", { class: "plot-area" });
  const why = el("div", { class: "explanations" });
  root.append(controls, chips, notes, plotArea, why);

  function syncThresholdUI(method: AnomalyMethod): void {
    const r = thresholdRange(method);
    threshold.min = String(r.min);
    threshold.max = String(r.max);
    const cur = Number(threshold.value);
    const def = method === "iqr" ? 1.5 : 3.5;
    threshold.value = String(Math.min(Math.max(cur, r.min), r.max));
    thresholdOut.value = Number(threshold.value).toFixed(1);
    thresholdLabel.childNodes[0]!.textContent = `${r.label} `;
    void def;
  }

  async function refresh(): Promise<void> {
    await runCompute(plotArea, (engine) => {
      const series = state.series();
      const method = methodSel.value as AnomalyMethod;
      const lookback = (lookbackSel.value || undefined) as DurationString | undefined;
      // lookback is a post-result filter: detection still sees the full history.
      // now: "latest" anchors it to the synthetic data instead of the wall clock.
      const res = engine.detectAnomalies(series, {
        method,
        threshold: Number(threshold.value),
        lambda: Number(lambda.value),
        direction: dirSel.value as "both" | "high" | "low",
        ...(lookback ? { lookback, now: "latest" as const } : {}),
      });
      const explanations = explainAnomalies(series, res, {
        name: "the series",
        period: engine.seasonality(series).bestPeriod,
        changepoints: engine.changepoints(series),
      });

      clearNode(plotArea);
      plotArea.append(
        anomalyPlot(series, res, {
          width: Math.max(320, plotArea.clientWidth - 20),
          height: 340,
          explanations,
        }),
      );

      clearNode(why);
      for (const x of [...explanations].sort((a, b) => b.score / b.threshold - a.score / a.threshold).slice(0, 6)) {
        const item = el("div", { class: `explanation sev-${x.severity}` });
        item.append(el("div", { class: "explanation-head", text: x.headline }), el("div", { class: "explanation-why", text: x.reasons.join(" ") }));
        why.append(item);
      }

      // precision/recall vs generator ground truth inside the window (works with
      // mock — the ground truth comes from genSeries itself)
      const from = res.window?.from ?? null;
      const gt = state.data.anomalies.filter((i) => from === null || Number(series.t?.[i]) >= from);
      const gtSet = new Set(gt);
      const detectedIdx = res.anomalies.map((a) => a.index);
      const matched = detectedIdx.filter((i) => gtSet.has(i)).length;
      const detected = res.anomalies.length;
      const precision = detected > 0 ? matched / detected : 0;
      const recall = gt.length > 0 ? matched / gt.length : 0;
      const { spikes, dips } = anomalySplit(res);

      setChipValues(chips, [
        ["method", res.method, "accent"],
        ["detected", res.window ? `${detected} of ${res.window.total}` : String(detected)],
        ["ground truth", String(gt.length)],
        ["precision", fmtPct(precision), precision >= 0.8 ? "good" : precision < 0.5 ? "bad" : ""],
        ["recall", fmtPct(recall), recall >= 0.8 ? "good" : recall < 0.5 ? "bad" : ""],
        ["spikes", String(spikes)],
        ["dips", String(dips)],
        ["threshold", fmt(res.threshold)],
      ]);
      notes.textContent = explanations.length
        ? "Why: the most severe flagged points, explained (hover a marker for its explanation)."
        : "";
    });
  }

  methodSel.addEventListener("change", () => {
    syncThresholdUI(methodSel.value as AnomalyMethod);
    lambdaRow.style.display = methodSel.value === "ewma" ? "" : "none";
    refresh();
  });
  threshold.addEventListener("input", () => {
    thresholdOut.value = Number(threshold.value).toFixed(1);
    refreshSoon();
  });
  lambda.addEventListener("input", () => {
    lambdaOut.value = Number(lambda.value).toFixed(2);
    refreshSoon();
  });
  dirSel.addEventListener("change", refresh);
  lookbackSel.addEventListener("change", refresh);

  const refreshSoon = debounce(refresh, 150);
  void refresh();
  return refresh;
}
