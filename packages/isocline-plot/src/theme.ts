// Shared theme tokens (CONTRACT §7) and ECharts option defaults for isocline-plot.
import type {
  EChartsOption,
  GridComponentOption,
  TitleComponentOption,
  TooltipComponentOption,
  XAXisComponentOption,
  YAXisComponentOption,
} from "echarts";

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

/**
 * Axis-tick formatter: `fmt`'s exponent form for very large/small magnitudes,
 * otherwise the tick value as-is (ticks are already round; 3-sig-digit
 * rounding would collapse the ticks of a near-flat series into one label).
 */
export function fmtTick(x: number): string {
  const a = Math.abs(x);
  if (a !== 0 && (a >= 1e6 || a < 1e-3)) return fmt(x);
  return x.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

const AXIS_LINE = "rgba(255,255,255,0.16)";

const TOOLTIP: TooltipComponentOption = {
  confine: true,
  backgroundColor: C.panel2,
  borderColor: "rgba(255,255,255,0.12)",
  borderWidth: 1,
  padding: [6, 9],
  textStyle: { color: C.ink, fontFamily: MONO, fontSize: 11 },
  extraCssText: "box-shadow: 0 6px 18px rgba(0,0,0,0.45); border-radius: 6px;",
};

/** Base option every isocline chart starts from. Spread FIRST, then family/user keys. */
export const isoclineTheme: EChartsOption = {
  backgroundColor: "transparent",
  animationDuration: 300,
  animationDurationUpdate: 200,
  textStyle: { fontFamily: MONO, fontSize: 10.5, color: C.muted },
  tooltip: TOOLTIP,
};

/** Themed tooltip; `o` overrides the defaults (trigger, formatter, …). */
export function tooltip(o: TooltipComponentOption = {}): TooltipComponentOption {
  return { ...TOOLTIP, ...o };
}

/** Grid with label-aware margins (room above for the y-axis name, below for the x-axis name). */
export function grid(o: GridComponentOption = {}): GridComponentOption {
  return { left: 10, right: 20, top: 30, bottom: 24, containLabel: true, ...o };
}

/** Chart title (top-left, ink, mono). */
export function title(text: string, o: TitleComponentOption = {}): TitleComponentOption {
  return {
    text,
    left: 8,
    top: 2,
    textStyle: { color: C.ink, fontFamily: MONO, fontSize: 12, fontWeight: "normal" },
    ...o,
  };
}

const STYLE_KEYS = ["axisLine", "axisTick", "axisLabel", "splitLine", "nameTextStyle"] as const;

function axisStyle(type: unknown): Record<string, unknown> {
  const numeric = type === "value" || type === "log" || type === undefined;
  return {
    axisLine: { show: true, lineStyle: { color: AXIS_LINE } },
    axisTick: { show: true, length: 4, lineStyle: { color: AXIS_LINE } },
    axisLabel: {
      color: C.muted,
      fontFamily: MONO,
      fontSize: 10.5,
      hideOverlap: true,
      ...(numeric ? { formatter: (v: number) => fmtTick(v) } : {}),
    },
    splitLine: { show: type !== "category", lineStyle: { color: C.grid } },
    nameTextStyle: { color: C.ink, fontFamily: MONO, fontSize: 11 },
  };
}

function merge<T extends object>(defaults: Record<string, unknown>, o: T): T {
  const out: Record<string, unknown> = { ...defaults, ...o };
  for (const k of STYLE_KEYS) {
    const v = (o as Record<string, unknown>)[k];
    if (v && typeof v === "object") out[k] = { ...(defaults[k] as object), ...v };
  }
  return out as T;
}

/** Themed x axis: name centered below the axis, mono ticks, `fmt` on numeric labels. */
export function xAxis(o: XAXisComponentOption = {}): XAXisComponentOption {
  return merge({ nameLocation: "middle", nameGap: 28, ...axisStyle(o.type) }, o);
}

/** Themed y axis: name above the axis (left-aligned), grid lines, `fmt` on numeric labels. */
export function yAxis(o: YAXisComponentOption = {}): YAXisComponentOption {
  const base = axisStyle(o.type);
  return merge(
    {
      nameLocation: "end",
      nameGap: 10,
      ...(o.type === "category" ? {} : { scale: true }),
      ...base,
      nameTextStyle: { ...(base.nameTextStyle as object), align: "left" },
    },
    o,
  );
}

/** Base option with an optional title. */
export function baseOption(titleText?: string): EChartsOption {
  return titleText ? { ...isoclineTheme, title: title(titleText) } : { ...isoclineTheme };
}
