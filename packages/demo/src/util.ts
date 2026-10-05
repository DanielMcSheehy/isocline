// Shared DOM/format helpers for the demo tabs.
import type { Isocline } from "isocline";
import { useEngine } from "./engine.js";

export function fmtNum(x: number | null | undefined, digits = 3): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  const a = Math.abs(x);
  if (a !== 0 && (a >= 1e6 || a < 1e-3)) return x.toExponential(Math.max(0, digits - 3));
  return String(parseFloat(x.toPrecision(digits)));
}

export function fmtPct(x: number, digits = 0): string {
  if (!Number.isFinite(x)) return "—";
  return `${(100 * x).toFixed(digits)}%`;
}

export function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms >= 10) return `${ms.toFixed(0)} ms`;
  return `${ms.toFixed(2)} ms`;
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let t: ReturnType<typeof setTimeout> | null = null;
  return (...args: A) => {
    if (t !== null) clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      fn(...args);
    }, ms);
  };
}

/** Yield so the shimmer paints before (synchronous) mock computation runs. */
export function nextFrame(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 16));
}

export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Red toast, fixed bottom-right, auto-dismisses after 5 s. */
export function toast(message: string): void {
  const root = document.getElementById("toast-root");
  if (!root) return;
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

/**
 * Run a tab computation: shimmer the plot area, yield a frame, then execute
 * `body` with the awaited engine. Sync mock work stays off the paint path;
 * errors surface as a red toast.
 */
export async function runCompute(area: HTMLElement, body: (engine: Isocline) => void): Promise<void> {
  area.classList.add("computing");
  try {
    await nextFrame();
    const engine = await useEngine();
    body(engine);
  } catch (err) {
    toast(errMessage(err));
  } finally {
    area.classList.remove("computing");
  }
}

// ---------- tiny DOM builders ----------

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | number> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = String(v);
    else if (k === "text") node.textContent = String(v);
    else if (v === false || v === null || v === undefined) continue;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v as EventListener);
    else node.setAttribute(k, String(v));
  }
  for (const c of children) node.append(c);
  return node;
}

export function clearNode(node: Element): void {
  node.replaceChildren();
}

/** Metric chip: `<span class="chip stat"><span class="k">rmse</span><span class="v">0.42</span></span>` */
export function statChip(key: string, value: string, extraClass = ""): HTMLSpanElement {
  const chip = el("span", { class: `chip stat ${extraClass}`.trim() });
  chip.append(el("span", { class: "k", text: key }), el("span", { class: "v", text: value }));
  return chip;
}

export function setChipValues(container: HTMLElement, entries: [key: string, value: string, cls?: string][]): void {
  clearNode(container);
  for (const [k, v, cls] of entries) container.append(statChip(k, v, cls ?? ""));
}

/** Labelled control row used inside `.tab-controls` blocks. */
export function controlRow(label: string, input: HTMLElement, output?: HTMLOutputElement): HTMLDivElement {
  const row = el("div", { class: "ctl" });
  const lab = el("label", {}) as HTMLLabelElement;
  lab.append(document.createTextNode(`${label} `));
  if (output) lab.append(output);
  row.append(lab, input);
  return row;
}

export function rangeInput(id: string, min: number, max: number, step: number, value: number): HTMLInputElement {
  return el("input", { type: "range", id, min, max, step, value }) as HTMLInputElement;
}

export function outputFor(initial: string): HTMLOutputElement {
  return el("output", { text: initial });
}
