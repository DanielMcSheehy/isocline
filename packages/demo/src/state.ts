// Tiny observable store: synthetic-data parameters + the generated series.
// Plain pub/sub — no framework. Sidebar controls write params; tabs subscribe.
import { genSeries, type GenResult, type SeriesInput } from "isocline";

export interface SynthParams {
  n: number;
  period: number; // 0 → none
  trend: number; // slope per sample
  sigma: number; // noise std
  amplitude: number;
  spikes: number;
  dips: number;
  eventMag: number; // event magnitude in σ units
  shift: boolean;
  shiftMag: number; // shift magnitude in σ units
  drift: boolean;
  missing: number;
  seed: number;
}

export const defaultParams: SynthParams = {
  n: 720,
  period: 24,
  trend: 0.02,
  sigma: 1.5,
  amplitude: 8,
  spikes: 3,
  dips: 2,
  eventMag: 6,
  shift: true,
  shiftMag: 5,
  drift: true,
  missing: 8,
  seed: 42,
};

type Listener = () => void;

class AppState {
  params: SynthParams = { ...defaultParams };
  data: GenResult;

  private listeners = new Set<Listener>();

  constructor() {
    this.data = this.generate();
  }

  private generate(): GenResult {
    const p = this.params;
    return genSeries({
      n: p.n,
      period: p.period,
      trend: p.trend,
      sigma: p.sigma,
      amplitude: p.amplitude,
      spikes: p.spikes,
      dips: p.dips,
      eventMag: p.eventMag,
      shift: p.shift,
      shiftMag: p.shiftMag,
      drift: p.drift,
      missing: p.missing,
      seed: p.seed,
    });
  }

  /** Patch params and regenerate the series (deterministic per seed). */
  update(patch: Partial<SynthParams>): void {
    Object.assign(this.params, patch);
    this.regenerate();
  }

  regenerate(): void {
    this.data = this.generate();
    for (const fn of this.listeners) fn();
  }

  randomizeSeed(): void {
    this.update({ seed: 1 + Math.floor(Math.random() * 999_998) });
  }

  resetSeed(seed: number): void {
    const s = Number.isFinite(seed) ? Math.max(0, Math.floor(seed)) : defaultParams.seed;
    this.update({ seed: s });
  }

  /** Series view for engine calls. */
  series(): SeriesInput {
    return { y: this.data.y, t: this.data.t };
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const state = new AppState();
