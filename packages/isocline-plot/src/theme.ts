// Shared theme tokens (CONTRACT §7) and plot defaults for isocline-plot.
import * as Plot from "@observablehq/plot";

export const C = {
  bg: "#0b0e14",
  panel: "#11151f",
  panel2: "#161b26",
  ink: "#e6edf3",
  muted: "#8b98a9",
  grid: "rgba(255,255,255,0.07)",
  cyan: "#22d3ee",
  violet: "#a78bfa",
  amber: "#fbbf24",
  red: "#f87171",
  blue: "#60a5fa",
  green: "#34d399",
} as const;

/** Mono stack per §7 — all labels/numbers render in it. */
export const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

/** Base plot options applied to every isocline plot. Spread FIRST, then user opts. */
export const isoclineTheme = {
  marginTop: 18,
  marginRight: 16,
  marginBottom: 30,
  marginLeft: 46,
  style: {
    background: "transparent",
    color: C.muted,
    fontFamily: MONO,
    fontSize: "10.5px",
    overflow: "visible",
  },
  x: { tickSize: 4, tickPadding: 6 },
  y: { tickSize: 4, tickPadding: 6, grid: true },
} satisfies Partial<Plot.PlotOptions>;

const CSS = `
.isocline-plot { color: ${C.muted}; }
.isocline-plot .grid line { stroke: ${C.grid}; }
.isocline-plot text { font-family: ${MONO}; }
.isocline-plot .axis text { fill: ${C.muted}; }
.isocline-plot .axis-label { fill: ${C.ink}; font-size: 11px; }
.isocline-plot figcaption, .isocline-plot .legend text { fill: ${C.muted}; }
`;

/** Idempotently inject the isocline plot stylesheet (grid/axis colors). */
export function applyIsoclineCss(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById("isocline-plot-css")) return;
  const el = document.createElement("style");
  el.id = "isocline-plot-css";
  el.textContent = CSS;
  document.head.appendChild(el);
}

/** 3-significant-digit formatter used everywhere (CONTRACT §6). */
export function fmt(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  const a = Math.abs(x);
  if (a !== 0 && (a >= 1e6 || a < 1e-3)) return x.toExponential(2);
  if (a >= 100) return x.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (a >= 10) return x.toFixed(1);
  if (a >= 1) return x.toFixed(2);
  return x.toFixed(3);
}
