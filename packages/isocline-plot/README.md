# isocline-plot

Observable Plot visualization layer for isocline results. Every chart family
comes in two forms:

- `*Marks(series, result, opts?)` → `{ marks: Plot.Markish[], plotOptions }`
  — composable marks plus partial plot options, for building your own
  `Plot.plot({...plotOptions, marks})`.
- `*Plot(...)` → a rendered `HTMLElement` (a `Plot.plot` figure with the
  isocline theme applied), ready to append to the DOM.

The package has a single peer dependency, `@observablehq/plot ^0.6`, and
**no runtime dependency on `isocline`** — it imports only the result types,
so it renders any object matching the contract shape (mocked data included).
When `series.t` (epoch-millis) is present the x axis is temporal; otherwise
the index is used and labeled `"index"`.

## Install

```sh
npm install isocline-plot @observablehq/plot
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

## Chart families

### Forecast — `forecastPlot` / `forecastMarks`

History (cyan), point forecast (violet dashed), PI band (violet, 15%
opacity), a rule at the split point, an end-point dot; optional projected
trend/seasonal component lines and up to 60 drawn bootstrap sample paths.

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
| `paths` | `boolean` | `false` | Draw bootstrap sample paths (spaghetti) |
| `showComponents` | `boolean` | `false` | Draw projected trend (amber dashed) and seasonal (green) when the result has them |
| `showBand` | `boolean` | `true` | Draw the prediction-interval band |
| `height` | `number` | `320` | Plot height in px |
| `width` | `number` | — | Plot width (fluid when omitted) |
| `xLabel` | `string` | `"time"` / `"index"` | X axis label |
| `yLabel` | `string` | `"value"` | Y axis label |
| `title` | `string` | — | Figure caption (`<title>` on the SVG) |

### Anomalies — `anomalyPlot` / `anomalyMarks`

Series line plus flagged points: spikes as red up-triangles, dips as blue
down-triangles, an amber dashed expected line, and tooltips with index,
observed, expected, and score.

```ts
PP.anomalyPlot(series, anomalyResult, {
  showExpected: true, // default true
  height: 320,
  yLabel: "value",
});
PP.anomalySplit(anomalyResult); // { spikes: number, dips: number } for legends
```

| Option | Type | Default | Description |
|---|---|---|---|
| `showExpected` | `boolean` | `true` | Draw the expected-value line |
| `height` / `width` / `xLabel` / `yLabel` | `number` / `string` | as forecast | Layout and axis labels |

### Decomposition — `decomposePlot`

Three vertically stacked rows (trend, seasonal, residual) with per-row
independent y scales; the seasonal row caption includes `seasonalStrength`.

```ts
PP.decomposePlot(series, decomposeResult, {
  height: 150, // per row, default 150
  width: 800,
  xLabel: "time", // label on the bottom row only
});
```

### Seasonality — `seasonalityPlot`

ACF (lollipop with 95% confidence band) and periodogram (power vs period,
log x) side by side, best period highlighted on both panels.

```ts
PP.seasonalityPlot(seasonalityResult, { height: 260, width: 400 }); // width is per panel
PP.seasonalityCandidates(seasonalityResult); // candidate chips data
```

### Changepoints — `changepointPlot` / `changepointMarks`

Series line, amber step line of segment means, vertical dashed rules at each
changepoint, and tooltips showing `#index, μ before → after`.

```ts
PP.changepointPlot(series, changepointResult, { height: 320, yLabel: "value" });
```

### Backtest — `backtestPlot` + `backtestWinner`

A models × metrics heatmap (`Plot.cell`) over rmse / mae / smape / coverage,
rank-colored (violet→cyan, best model on top row), with formatted values in
each cell.

```ts
const el = PP.backtestPlot(backtestResult, { height: 220 });
document.body.appendChild(el);
PP.backtestWinner(backtestResult); // model name with lowest RMSE, e.g. "stl_ets"
```

## Composition

The `*Marks` forms return `{ marks, plotOptions }`. `plotOptions` starts
from `isoclineTheme` (margins, mono font, muted tick color, grid defaults)
and includes the axis scales; spread it first and override anything:

```ts
import * as Plot from "@observablehq/plot";
import * as PP from "isocline-plot";

const { marks, plotOptions } = PP.forecastMarks(series, fc, { yLabel: "kW" });
const fig = Plot.plot({
  ...plotOptions,       // theme + axes
  y: { ...plotOptions.y, domain: [0, 100] }, // your overrides
  marks,
});
document.body.appendChild(fig);
```

## Theme and formatting

- `isoclineTheme` — shared `Partial<Plot.PlotOptions>`: dark-transparent
  background (the page provides the panel), muted ticks, grid on the y axis,
  mono font at 10.5px.
- `C` — the color tokens: `cyan #22d3ee`, `violet #a78bfa`,
  `amber #fbbf24`, `red #f87171`, `blue #60a5fa`, `green #34d399`,
  `ink #e6edf3`, `muted #8b98a9`, `grid rgba(255,255,255,.07)`, plus panel
  colors.
- `fmt(x)` — 3-significant-digit number formatter used across all plots
  (`"1.23"`, `"12.3"`, `"1,234"`, exponential outside `[1e-3, 1e6)`).
- `MONO` — the mono font stack; `applyIsoclineCss()` idempotently injects
  the small stylesheet (grid/axis colors) that the `*Plot` forms call for you.
- `plot(spec)` — thin wrapper that renders `Plot.plot(spec)` with the
  `isocline-plot` class attached.

## Design notes

`decomposePlot` and `seasonalityPlot` render **multiple separate plots in
one container** rather than a single faceted plot. This is deliberate:
Plot facets share scales across rows, which would crush the near-zero
residual row against a large trend range. Independent per-row y scales (and
independent x scales for the ACF/periodogram panels) keep every component
readable. The tradeoff is that rows are separate SVGs with slightly
different pixel widths on fluid layouts.

Both functions are `*Plot`-only (no `*Marks` form) because their multi-plot
structure cannot be expressed as a single mark list.
