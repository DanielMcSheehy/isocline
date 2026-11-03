// ECharts mounting / SSR. Uses the tree-shaken `echarts/core` build and
// registers only what isocline-plot emits: line, bar, scatter and heatmap
// series; grid, tooltip, title, markLine/markArea/markPoint, visualMap,
// inside dataZoom (forecast history window); canvas + SVG renderers.
import * as echarts from "echarts/core";
import { BarChart, HeatmapChart, LineChart, ScatterChart } from "echarts/charts";
import {
  DataZoomInsideComponent,
  GridComponent,
  MarkAreaComponent,
  MarkLineComponent,
  MarkPointComponent,
  TitleComponent,
  TooltipComponent,
  VisualMapComponent,
} from "echarts/components";
import { CanvasRenderer, SVGRenderer } from "echarts/renderers";
import type { EChartsOption } from "echarts";

let registered = false;

/** Register the ECharts modules isocline-plot needs (idempotent). Call it before `echarts/core` init of your own. */
export function registerECharts(): void {
  if (registered) return;
  registered = true;
  echarts.use([
    LineChart,
    BarChart,
    ScatterChart,
    HeatmapChart,
    GridComponent,
    DataZoomInsideComponent,
    TooltipComponent,
    TitleComponent,
    MarkLineComponent,
    MarkAreaComponent,
    MarkPointComponent,
    VisualMapComponent,
    CanvasRenderer,
    SVGRenderer,
  ]);
}

export interface RenderChartOptions {
  /** Fixed width in px; omitted → the element is `width: 100%` and tracks its container. */
  width?: number;
  /** Height in px (default 320). */
  height?: number;
  /** Renderer (default "canvas"). */
  renderer?: "canvas" | "svg";
}

const observers = new WeakMap<Element, ResizeObserver>();

/**
 * Mount `option` into a fresh `div.isocline-plot`. The instance is created at
 * an explicit size (width ?? 640) so detached elements render immediately; a
 * ResizeObserver then resizes it once attached / whenever the element changes.
 * Release with {@link disposePlots}.
 */
export function renderChart(option: EChartsOption, opts: RenderChartOptions = {}): HTMLElement {
  registerECharts();
  const height = opts.height ?? 320;
  const el = document.createElement("div");
  el.className = "isocline-plot";
  el.style.height = `${height}px`;
  el.style.width = opts.width ? `${opts.width}px` : "100%";
  const chart = echarts.init(el, undefined, {
    renderer: opts.renderer ?? "canvas",
    width: opts.width ?? 640,
    height,
  });
  chart.setOption(option);
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 0 && h > 0 && (w !== chart.getWidth() || h !== chart.getHeight())) chart.resize({ width: w, height: h });
    });
    ro.observe(el);
    observers.set(el, ro);
  }
  return el;
}

/** Dispose every ECharts instance mounted inside `root` (root included) and stop its resize tracking. */
export function disposePlots(root: Element): void {
  const els = [root, ...Array.from(root.querySelectorAll("[_echarts_instance_]"))];
  for (const el of els) {
    observers.get(el)?.disconnect();
    observers.delete(el);
    echarts.getInstanceByDom(el as HTMLElement)?.dispose();
  }
}

/** Server-side / test rendering to an SVG string (no DOM needed, animation off). */
export function renderSVG(option: EChartsOption, opts: { width?: number; height?: number } = {}): string {
  registerECharts();
  const chart = echarts.init(null as unknown as HTMLElement, undefined, {
    renderer: "svg",
    ssr: true,
    width: opts.width ?? 640,
    height: opts.height ?? 320,
  });
  try {
    chart.setOption({ ...option, animation: false });
    return chart.renderToSVGString();
  } finally {
    chart.dispose();
  }
}
