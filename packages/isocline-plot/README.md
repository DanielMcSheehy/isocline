# isocline-plot

[Apache ECharts](https://echarts.apache.org/) visualization layer for
isocline results. Every chart family comes in two forms:

- `*Option(...)` → an `EChartsOption` (dark isocline theme, axes, series,
  tooltips) for composition: `setOption` it on your own instance, merge
  more pieces into it, or render it server-side with `renderSVG`.
- `*Plot(...)` → a mounted `HTMLElement` (`div.isocline-plot`) holding a live
  ECharts instance, ready to append to the DOM.

Peer dependencies: `echarts ^5.6.0` and `isocline`. The package uses the
tree-shaken `echarts/core` build and registers only what it emits (line, bar,
scatter, heatmap series; grid, tooltip, title, markLine/markArea/markPoint,
visualMap components; canvas + SVG renderers). It has **no runtime
dependency on `isocline`** - it imports only the result types, so it renders
any object matching the contract shape (mocked data included).

When `series.t` (epoch-millis) is present the x axis is a `time` axis;
otherwise it is a value axis over the sample index, labeled `"index"`. All
tooltip numbers go through `fmt` (3 significant digits).

## Install

```sh
npm install isocline-plot echarts
```

## Quick start

```ts
import * as PP from "isocline-plot";
import { loadIsocline, genSeries } from "isocline";

const iso = await loadIsocline();
const { y, t } = genSeries({ n: 720, period: 24 });
const fc = iso.forecast({ y, t }, { horizon: 48 });

document.body.appendChild(PP.forecastPlot({ y, t }, fc, {
  showBand: true,        // PI band (default true)
  showComponents: false, // projected trend/seasonal lines when present
  paths: false,          // spaghetti of bootstrap sample paths
  height: 320,
  yLabel: "value",
}));
```

## Mounting, resizing, disposal

`*Plot(...)` calls `renderChart(option, { width, height })`:

- the element gets `height: <height>px` and `width: <width>px` (or `100%`
  when `width` is omitted);
- the ECharts instance is created at an explicit size (`width ?? 640`) so
  charts render even while the element is still detached;
- a `ResizeObserver` resizes the instance once the element is attached and
  whenever its box changes (zero-size, e.g. hidden tabs, is ignored).

ECharts instances hold canvases, listeners and observers - release them
before dropping the DOM:

```ts
PP.disposePlots(container); // disposes every instance inside container (container included)
container.replaceChildren();
```

| Helper | Description |
|---|---|
| `renderChart(option, { width?, height?, renderer? })` | Mount any option into a new `div.isocline-plot`; `renderer` is `"canvas"` (default) or `"svg"`; height defaults to 320 |
| `disposePlots(root)` | Dispose all ECharts instances mounted in `root` (and on `root` itself) and stop their resize tracking |
| `renderSVG(option, { width?, height? })` | Server-side / test render to an SVG string (ECharts SSR, animation off, no DOM needed); defaults 640×320 |
| `registerECharts()` | Idempotent `echarts/core` registration of the modules above; call it before `init` if you create instances from `echarts/core` yourself |

## Chart families

| Family | Option form | Plot form | Default height |
|---|---|---|---|
| Forecast | `forecastOption(series, fc, opts?)` | `forecastPlot` | 320 |
| Anomalies | `anomalyOption(series, res, opts?)` | `anomalyPlot` | 320 |
| Decomposition | `decomposeOption(series, dec, opts?)` | `decomposePlot` | `decomposeHeight(row)` = 3 × 150 + 42 |
| Seasonality | `seasonalityOption(res)` | `seasonalityPlot(res, opts?)` | 260 |
| Changepoints | `changepointOption(series, res, opts?)` | `changepointPlot` | 320 |
| Backtest | `backtestOption(res)` | `backtestPlot(res, opts?)` | 40 × models + 60 |
| Correlation | `correlationOption(a, b, res, opts?)` | `correlationPlot` | 320 |
| Majority | `majorityOption(res, opts?)` | `majorityPlot` | 44 + 26 × rows |
| Category outlier | `categoryOutlierOption(res, opts?)` | `categoryOutlierPlot` | 320 |
| Low variance | `lowVarianceOption(values, res, opts?)` | `lowVariancePlot` | 320 |
| Auto chart | `autoChartOption(input, auto, opts?)` | `autoChartPlot` | per dispatched family |

Every `*Plot` accepts `height` and `width` (px; fluid width when omitted).

### Forecast - `forecastOption` / `forecastPlot`

History (cyan), point forecast (violet dashed), PI band (violet, 15%
opacity), a rule at the split point, an end-point dot; optional projected
trend (amber dashed) / seasonal (green) lines and up to 60 bootstrap sample
paths. Axis tooltip lists history/forecast/PI/components at the hovered x.

```ts
PP.forecastPlot(series, forecast, {
  paths: true,          // default false
  showComponents: true, // default false
  showBand: true,       // default true
  height: 320,          // default 320
  width: 800,           // optional (fluid when omitted)
  xLabel: "time",       // default "time"/"index" by input kind
  yLabel: "value",      // default "value"
  title: "48h forecast",
});
```

| Option | Type | Default | Description |
|---|---|---|---|
| `paths` | `boolean` | `false` | Draw bootstrap sample paths (≤ 60, evenly strided) |
| `showComponents` | `boolean` | `false` | Draw projected trend and seasonal when the result has them |
| `showBand` | `boolean` | `true` | Draw the prediction-interval band |
| `height` / `width` | `number` | `320` / fluid | Chart size in px (`*Plot` only) |
| `xLabel` | `string` | `"time"` / `"index"` | X axis name |
| `yLabel` | `string` | `"value"` | Y axis name |
| `title` | `string` | - | Chart title (top-left) |
| `historyWindow` | `number \| "all"` | `max(3 × horizon, 2 × period)` | History points visible at first, so the forecast isn't a sliver at the edge. Drag to pan back; ctrl+wheel or trackpad pinch to zoom. The y axis fits what is visible. |

### Anomalies - `anomalyOption` / `anomalyPlot`

Series line (cyan) plus flagged points: spikes as red ▲, dips as blue ▼, an
amber dashed expected line. Hovering a flagged point shows index, direction,
observed, expected and score - plus the matching **explanation**, if any.

```ts
PP.anomalyPlot(series, anomalyResult, {
  showExpected: true, // default true
  height: 320,
  yLabel: "value",
  explanations: [
    { index: 412, text: "Deploy at 14:02 doubled request volume for six minutes." },
  ],
});
PP.anomalySplit(anomalyResult); // { spikes: number, dips: number } for legends
```

| Option | Type | Default | Description |
|---|---|---|---|
| `showExpected` | `boolean` | `true` | Draw the expected-value line |
| `explanations` | `ReadonlyArray<{ index: number; text: string }>` | - | Prose shown in the tooltip of the flagged point with the same `index` (HTML-escaped, wrapped at ~320px); entries for unflagged indices are ignored |
| `height` / `width` / `xLabel` / `yLabel` | `number` / `string` | as forecast | Layout and axis names |

### Decomposition - `decomposeOption` / `decomposePlot`

One chart with three stacked grids (trend amber, seasonal cyan, residual
muted) sharing the x domain - the axis pointer is linked across rows - with
independent y axes, so the near-zero residual is never crushed against the
trend range. The seasonal row name includes `seasonalStrength`.

```ts
PP.decomposePlot(series, decomposeResult, {
  height: 150,    // per row, default 150 (total = PP.decomposeHeight(150))
  width: 800,
  xLabel: "time", // shown on the bottom row only
});
```

### Seasonality - `seasonalityOption` / `seasonalityPlot`

One chart, two side-by-side grids: ACF lollipops with the ±1.96/√n band
(best lag marked amber) and the periodogram (power vs period, log x, step
area) with a dashed amber rule labelled `p ≈ <bestPeriod>`.

```ts
PP.seasonalityPlot(seasonalityResult, { height: 260, width: 900 }); // width covers both panels
PP.seasonalityCandidates(seasonalityResult); // candidate chips data
```

### Changepoints - `changepointOption` / `changepointPlot`

Series line, amber step line of segment means, dashed amber rules at each
changepoint, and dots with tooltips `#index · μ before → after`.

```ts
PP.changepointPlot(series, changepointResult, { height: 320, yLabel: "value" });
```

### Backtest - `backtestOption` / `backtestPlot` + `backtestWinner`

A models × metrics heatmap over rmse / mae / smape / coverage, colored by
per-metric rank through a hidden `visualMap` (violet → cyan, best model on
the top row), with formatted values in each cell.

```ts
document.body.appendChild(PP.backtestPlot(backtestResult, { height: 220 }));
PP.backtestWinner(backtestResult); // model name with lowest RMSE, e.g. "stl_ets"
```

### Tabular detectors

All take `TabularVizOptions` (`height`, `width`, `xLabel`, `yLabel`).

- **Correlation** - `correlationOption(a, b, res)`: muted scatter, cyan OLS
  line across the a-domain, headline `r = 0.83 · n = 500 · significant`
  (`correlationHeadline(res)`) top-right.
- **Majority** - `majorityOption(res)`: horizontal proportion bars (dominant
  cyan, rest muted) with `NN.N%` labels and a dashed amber threshold rule
  (`majorityBars(res)` gives the rows).
- **Category outlier** - `categoryOutlierOption(res)`: one dot per category
  (cyan within fences, red high, blue low), shaded Q1..Q3 band, dashed
  fences; tooltips give the distance in IQR units (`categoryRows(res)`).
- **Low variance** - `lowVarianceOption(values, res)`: muted line, amber
  mean ± σ band and dashed mean rule, y padded to ±3σ so flatness is
  visible, headline `cv = … · flat` (`lowVarianceHeadline`, `variancePoints`).

### Auto chart - `autoChartOption` / `autoChartPlot`

Dispatches on `auto.kind` to the matching family above (`forecast`,
`anomalies`, `correlation`, `majority`, `category_outlier`, `low_variance`).
`distribution` - or any kind whose result pieces are missing - renders cyan
bars of the per-category aggregates when categories exist, else a 24-bin
histogram of `y`. It never throws. `autoChartReason(auto)` returns the chip
text.

## Composition

Every option is a plain `EChartsOption`, so it composes with the normal
ECharts APIs. Use it on your own instance and merge extra pieces with
`setOption` (series with a new `id` are appended):

```ts
import * as echarts from "echarts/core";
import * as PP from "isocline-plot";

PP.registerECharts();
const chart = echarts.init(document.getElementById("chart")!);
chart.setOption(PP.forecastOption(series, fc, { yLabel: "kW" }));
chart.setOption({
  yAxis: { min: 0, max: 100 },                      // override the themed axis
  series: [{ id: "sla", type: "line", data: [], markLine: {
    symbol: "none", data: [{ yAxis: 90 }], lineStyle: { color: PP.C.red },
  } }],
});
```

or merge before mounting and keep the isocline element lifecycle:

```ts
const option = PP.anomalyOption(series, res);
const el = PP.renderChart({ ...option, title: { text: "checkout p99" } }, { height: 280 });
```

The full `echarts` package works too (`import * as echarts from "echarts"`);
the options only reference modules it already contains.

## Theme and formatting

- `isoclineTheme` - the `EChartsOption` base every family spreads first:
  transparent background (the page provides the panel), mono 10.5px muted
  text, themed tooltip, short animations.
- `xAxis(o)`, `yAxis(o)`, `grid(o)`, `tooltip(o)`, `title(text, o)`,
  `baseOption(title?)` - the themed builders the families share (grid lines
  `C.grid`, muted ticks, ink axis names, `fmtTick` on numeric axes); each
  takes overrides. `seriesXAxis(series, label?)` picks the time / index axis.
- `C` - the color tokens: `cyan #22d3ee`, `violet #a78bfa`,
  `amber #fbbf24`, `red #f87171`, `blue #60a5fa`, `green #34d399`,
  `ink #e6edf3`, `muted #8b98a9`, `grid rgba(255,255,255,.07)`, plus `bg` /
  panel colors.
- `fmt(x)` - 3-significant-digit number formatter used in tooltips and
  labels (`"1.23"`, `"12.3"`, `"1,234"`, exponential outside `[1e-3, 1e6)`);
  `fmtTick(x)` is its axis variant (exponential at the same bounds, otherwise
  the round tick value unchanged so near-flat ranges keep distinct ticks).
- `MONO` - the mono font stack.

## Examples

`npm run preview -w isocline-plot` serves `examples/`, a page rendering
every family against pure-TS mocks (no wasm needed).
