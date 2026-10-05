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
} from "../src/index.js";
import {
  mockSeries,
  mockForecast,
  mockAnomalies,
  mockDecompose,
  mockSeasonality,
  mockChangepoints,
  mockBacktest,
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
  marks: [...marks, Plot.text([{ x: (marks.length, 0), y: 0, label: "composed" }], { x: "x", y: "y", text: "label", fontSize: 12, anchor: "start", dx: 8, fill: "#fbbf24" })],
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
