// Renders every isocline-plot visualization against mock results.
import { getInstanceByDom } from "echarts/core";
import {
  forecastPlot,
  forecastOption,
  renderChart,
  anomalyPlot,
  decomposePlot,
  seasonalityPlot,
  changepointPlot,
  backtestPlot,
  backtestWinner,
  anomalySplit,
  correlationPlot,
  correlationHeadline,
  majorityPlot,
  categoryOutlierPlot,
  lowVariancePlot,
  autoChartPlot,
  autoChartReason,
  C,
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

// composition example: render forecastOption, then merge extra option
// pieces into the live instance with echarts' setOption.
const custom = renderChart(forecastOption(series, forecast, { yLabel: "custom axis" }), { height: 240 });
const lastX = Number(series.t![series.y.length - 1]);
getInstanceByDom(custom)!.setOption({
  series: [
    {
      id: "annotation",
      type: "scatter",
      data: [[lastX, Number(series.y[series.y.length - 1])]],
      symbolSize: 9,
      itemStyle: { color: C.amber },
      label: { show: true, position: "left", formatter: "composed", color: C.amber, fontSize: 12 },
    },
  ],
});
section("forecast · composed", custom, "forecastOption + setOption merge");

const anomalies = mockAnomalies(series);
section(
  "anomalies",
  anomalyPlot(series, anomalies, {
    explanations: anomalies.anomalies.slice(0, 3).map((a) => ({
      index: a.index,
      text: `Sample #${a.index} deviates from the rolling-median baseline by ${a.score.toFixed(1)} robust σ; long explanation text wraps inside the tooltip at about 320px.`,
    })),
  }),
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
