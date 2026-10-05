// Renders every isocline-plot visualization against mock results.
import * as Plot from "@observablehq/plot";
import {
  forecastPlot,
  forecastMarks,
  anomalyPlot,
  decomposePlot,
  seasonalityPlot,
  changepointPlot,
  backtestPlot,
  backtestWinner,
  anomalySplit,
  applyIsoclineCss,
  correlationPlot,
  correlationHeadline,
  majorityPlot,
  categoryOutlierPlot,
  lowVariancePlot,
  autoChartPlot,
  autoChartReason,
} from "../src/index.js";
import {
  mockSeries,
  mockForecast,
  mockAnomalies,
  mockDecompose,
  mockSeasonality,
  mockChangepoints,
  mockBacktest,
  mockCorrelation,
  mockMajority,
  mockCategoryOutlier,
  mockLowVariance,
  mockAuto,
} from "./mocks.js";

applyIsoclineCss();
const app = document.getElementById("app")!;
const section = (title: string, el: HTMLElement, note = "") => {
  const h = document.createElement("h2");
  h.textContent = title + (note ? ` — ${note}` : "");
  const s = document.createElement("section");
  s.appendChild(el);
  app.append(h, s);
};

const series = mockSeries();
const forecast = mockForecast(series);

section(
  "forecast",
  forecastPlot(series, forecast, { paths: true, showComponents: true }),
  "PI band + sample paths + trend/seasonal projection",
);

// composition example: reuse forecastMarks inside a fully custom Plot
const { marks, plotOptions } = forecastMarks(series, forecast);
const custom = Plot.plot({
  ...plotOptions,
  height: 240,
  y: { ...plotOptions.y, label: "custom axis" },
  marks: [...marks, Plot.text([{ x: (marks.length, 0), y: 0, label: "composed" }], { x: "x", y: "y", text: "label", fontSize: 12, textAnchor: "start", dx: 8, fill: "#fbbf24" })],
} as Plot.PlotOptions);
custom.classList.add("isocline-plot");
section("forecast · composed", custom as HTMLElement, "forecastMarks inside a custom Plot.plot");

const anomalies = mockAnomalies(series);
section(
  "anomalies",
  anomalyPlot(series, anomalies),
  `split ${JSON.stringify(anomalySplit(anomalies))}`,
);
section("decompose", decomposePlot(series, mockDecompose(series)));
section("seasonality", seasonalityPlot(mockSeasonality(series)));
section("changepoints", changepointPlot(series, mockChangepoints(series)));
const bt = mockBacktest();
section("backtest", backtestPlot(bt), `winner: ${backtestWinner(bt)}`);

// ---- tabular detectors (CONTRACT §11) --------------------------------------

const corr = mockCorrelation();
section(
  "correlation",
  correlationPlot(corr.a, corr.b, corr.res, { xLabel: "latency (ms)", yLabel: "errors" }),
  correlationHeadline(corr.res),
);

const maj = mockMajority();
section("majority", majorityPlot(maj), `isMajority: ${maj.isMajority} (threshold ${maj.threshold})`);

const co = mockCategoryOutlier();
section("category outlier", categoryOutlierPlot(co, { yLabel: "sum of errors" }), `outliers: ${co.outlierCount}`);

const lv = mockLowVariance();
section("low variance", lowVariancePlot(lv.values, lv.res, { yLabel: "p99 latency" }), `cv = ${lv.res.cv.toFixed(5)} · flat: ${lv.res.isFlat}`);

// ---- auto-chart: one section per kind --------------------------------------

const forecast2 = mockForecast(series);
const anomalies2 = mockAnomalies(series);
const kinds = [
  "forecast",
  "anomalies",
  "correlation",
  "majority",
  "category_outlier",
  "low_variance",
  "distribution",
] as const;
const inputs = {
  correlation: (() => {
    const c = mockCorrelation();
    return { y: c.a, y2: c.b };
  })(),
  low_variance: (() => ({ y: mockLowVariance().values }))(),
} as Record<string, { y?: ArrayLike<number>; y2?: ArrayLike<number>; categories?: string[] }>;

for (const kind of kinds) {
  const auto = mockAuto(kind, series, { forecast: forecast2, anomalies: anomalies2 });
  const input = inputs[kind] ?? series;
  section(`auto · ${kind}`, autoChartPlot(input, auto), autoChartReason(auto));
}
