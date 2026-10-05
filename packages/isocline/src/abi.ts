// Low-level flat-ABI wasm marshalling (CONTRACT §3).
// Exports: alloc(len) -> ptr, call(op, cfg_ptr, cfg_len, y_ptr, y_len) -> status,
// json_ptr() -> ptr, json_len() -> len, version() -> i32.

export const OP = {
  forecast: 0,
  anomalies: 1,
  decompose: 2,
  seasonality: 3,
  changepoints: 4,
  backtest: 5,
  interpolate: 6,
  correlation: 7,
  majority: 8,
  categoryOutlier: 9,
  lowVariance: 10,
} as const;

export interface IsoclineWasm {
  alloc(len: number): number;
  call(op: number, cfgPtr: number, cfgLen: number, yPtr: number, yLen: number): number;
  call2(op: number, cfgPtr: number, cfgLen: number, yPtr: number, yLen: number, y2Ptr: number, y2Len: number): number;
  json_ptr(): number;
  json_len(): number;
  version(): number;
  memory: WebAssembly.Memory;
}

export interface ResultHeader {
  ok: boolean;
  error?: string;
  code?: string;
  channels?: Record<string, [number, number]>;
  [k: string]: unknown;
}

const STATUS_TO_CODE: Record<number, string> = {
  1: "badConfig",
  2: "badOp",
  3: "tooShort",
  4: "badParams",
  5: "internal",
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class Abi {
  readonly exports: IsoclineWasm;
  readonly memory: WebAssembly.Memory;

  constructor(exports: IsoclineWasm) {
    this.exports = exports;
    this.memory = exports.memory;
  }

  /** Run one op. Returns the parsed result header (throws on failure). */
  call(op: number, cfg: string, y: ArrayLike<number>): ResultHeader {
    const cfgBytes = encoder.encode(cfg);
    // alloc BOTH buffers before writing either — a growth during the second
    // alloc can relocate the arena, invalidating the first pointer
    const cfgPtr = this.exports.alloc(cfgBytes.length);
    const yPtr = this.exports.alloc(y.length * 8);
    new Uint8Array(this.memory.buffer).set(cfgBytes, cfgPtr);
    new Float64Array(this.memory.buffer, yPtr, y.length).set(y);
    const status = this.exports.call(op, cfgPtr, cfgBytes.length, yPtr, y.length);
    const header = this.readJson();
    if (status !== 0 || header.ok === false) {
      const code = (header.code as string) ?? STATUS_TO_CODE[status] ?? "internal";
      throw Object.assign(new Error(`isocline: ${header.error ?? `call failed with status ${status}`}`), { code });
    }
    return header;
  }

  /** Two-array variant for tabular ops (CONTRACT §11). */
  call2(op: number, cfg: string, y: ArrayLike<number>, y2: ArrayLike<number> = new Float64Array(0)): ResultHeader {
    const cfgBytes = encoder.encode(cfg);
    // alloc ALL buffers before writing any — arena growth can relocate
    const cfgPtr = this.exports.alloc(cfgBytes.length);
    const yPtr = this.exports.alloc(y.length * 8);
    const y2Ptr = this.exports.alloc(y2.length * 8);
    new Uint8Array(this.memory.buffer).set(cfgBytes, cfgPtr);
    new Float64Array(this.memory.buffer, yPtr, y.length).set(y);
    new Float64Array(this.memory.buffer, y2Ptr, y2.length).set(y2);
    const status = this.exports.call2(op, cfgPtr, cfgBytes.length, yPtr, y.length, y2Ptr, y2.length);
    const header = this.readJson();
    if (status !== 0 || header.ok === false) {
      const code = (header.code as string) ?? STATUS_TO_CODE[status] ?? "internal";
      throw Object.assign(new Error(`isocline: ${header.error ?? `call failed with status ${status}`}`), { code });
    }
    return header;
  }

  readJson(): ResultHeader {
    const ptr = this.exports.json_ptr();
    const len = this.exports.json_len();
    const bytes = new Uint8Array(this.memory.buffer, ptr, len);
    return JSON.parse(decoder.decode(bytes)) as ResultHeader;
  }

  /** Copy a channel out of linear memory. Must be called before the next `call`. */
  channel(header: ResultHeader, name: string): Float64Array {
    const spec = header.channels?.[name];
    if (!spec) return new Float64Array(0);
    const [off, len] = spec;
    return new Float64Array(this.memory.buffer, off, len).slice();
  }
}

/** Instantiate the raw wasm module from bytes. */
export function instantiateSync(bytes: ArrayBuffer | Uint8Array): Abi {
  const mod = new WebAssembly.Module(bytes as BufferSource);
  const inst = new WebAssembly.Instance(mod, {});
  return new Abi(inst.exports as unknown as IsoclineWasm);
}

export async function instantiate(bytes: ArrayBuffer | Uint8Array): Promise<Abi> {
  return instantiateSync(bytes);
}

/** Default binary loader: browser fetch of the sibling .wasm asset, node fs fallback. */
export async function defaultWasmBytes(): Promise<Uint8Array> {
  const url = new URL("./isocline.wasm", import.meta.url);
  if (typeof fetch === "function" && (url.protocol === "http:" || url.protocol === "https:")) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`isocline: failed to fetch ${url} (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  }
  // node / file:
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  return new Uint8Array(await readFile(fileURLToPath(url)));
}
