// Engine access for the demo (CONTRACT §8). `getEngine()` resolves the real
// wasm engine (bytes fetched from /isocline.wasm, served from public/); the
// pure-TS mock remains available via ?mock=1 and as a load-failure fallback.
import { loadIsocline, type Isocline } from "isocline";
import { createMockEngine } from "./engine-mock.js";

/** Spec-wording alias: the demo spec calls the engine handle `Pythia`;
 *  the contract type is `Isocline` (CONTRACT §2). Same interface. */
export type Pythia = Isocline;

let cached: Promise<Pythia> | null = null;
let isReal = false;

/** True once the real wasm engine has loaded (false for ?mock=1 / fallback). */
export function isRealEngine(): boolean {
  return isReal;
}

export function getEngine(): Promise<Pythia> {
  if (cached) return cached;
  cached = (async (): Promise<Pythia> => {
    // ?mock=1 forces the mock even though the real engine is available.
    const forceMock = new URLSearchParams(window.location.search).has("mock");
    if (forceMock) {
      console.warn("[isocline] running with MOCK engine (?mock=1)");
      return createMockEngine();
    }
    try {
      // The wasm binary is copied to public/ by the demo's predev/prebuild
      // step, so /isocline.wasm resolves identically under `vite dev` and
      // `vite build` — no bundler URL rewriting involved.
      const res = await fetch("/isocline.wasm");
      if (!res.ok) throw new Error(`fetch /isocline.wasm failed: HTTP ${res.status}`);
      const bytes = await res.arrayBuffer();
      const engine = await loadIsocline(bytes);
      isReal = true;
      return engine;
    } catch (err) {
      console.warn("[isocline] wasm engine unavailable, using mock", err);
      return createMockEngine();
    }
  })();
  return cached;
}

/** Convenience alias used by tab computations (CONTRACT §8 wording). */
export const useEngine = getEngine;
