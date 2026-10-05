# isocline-wasm

Flat-ABI WASM bindings for `isocline-core`. Crate type is `cdylib` with a
plain C ABI — **no wasm-bindgen, no wasm-pack, no JS glue generated**. The
TypeScript side (`packages/isocline/src/abi.ts`) is the only consumer and
talks to the module through raw pointers.

## Why no wasm-bindgen?

- Zero JS runtime: the module instantiates with an empty import object
  (`new WebAssembly.Instance(mod, {})`), so it loads in any JS environment
  with no pulled-in runtime JS.
- Tiny binary: the release profile (`opt-level = "z"`, `lto = "fat"`,
  `codegen-units = 1`, `panic = "abort"`, `strip = true`) plus a hand-rolled
  ABI yields a 240 KB raw / 88 KB gzip binary (see below).
- Plain toolchain: `cargo build` is the whole build — no wasm-pack, no
  generated TS to keep in sync.

## Exports

All exports are `#[no_mangle] extern "C"`:

| Export | Signature | Notes |
|---|---|---|
| `alloc` | `(len: i32) -> i32` | Byte pointer from an internal bump arena, 8-aligned. Call twice (config + data) before writing. |
| `call` | `(op, cfg_ptr, cfg_len, y_ptr, y_len) -> i32` | Run one op. `cfg` is UTF-8 JSON, `y` is an f64 little-endian array (`y_len` = element count). Returns a status code. |
| `json_ptr` / `json_len` | `() -> i32` | UTF-8 result header (JSON) for the last `call`. |
| `version` | `() -> i32` | ABI version, currently `1`. |

Op codes for `call`: `0` forecast, `1` anomalies, `2` decompose,
`3` seasonality, `4` changepoints, `5` backtest, `6` interpolate.

## Arena lifetime rule

The result header and all channel buffers live in an internal bump arena and
are **valid only until the next `call`** (which resets the arena). The caller
must construct `Float64Array(memory.buffer, offset, len)` views *after* `call`
returns and `.slice()` them immediately — wasm memory may grow and detach its
buffer, and a subsequent call reuses the arena. The TS wrapper enforces this
in `Abi.channel()`.

## Status codes

| Code | Name | Meaning |
|---|---|---|
| 0 | — | Success |
| 1 | `badConfig` | Config JSON failed to parse (or unknown keys — configs use `deny_unknown_fields`) |
| 2 | `badOp` | Unknown op code |
| 3 | `tooShort` | Series has fewer than 3 usable points |
| 4 | `badParams` | Config parsed but a value is out of range (e.g. `horizon > 10000`) |
| 5 | `internal` | Unexpected internal error |

On failure the header is `{"ok": false, "code": "...", "error": "..."}`.

## Config JSON conventions

- Keys are **snake_case**: `{"model": "stl_ets", "horizon": 48, "period": null}`.
- TS camelCase is translated by the engine wrapper; e.g. `period: "auto"`
  becomes `period: null` in JSON, `maxPeriod` becomes `max_period`.
- Values are scalars only — numbers, strings, booleans, null. Never arrays,
  never NaN/Infinity.
- Unknown keys are errors (`serde(deny_unknown_fields)`).
- Omitted fields fall back to the core defaults.

## Channels per op

The success header contains `"channels": {"<name>": [byteOffset, elemCount]}`
pointing at f64 arrays in linear memory:

| Op | Channels |
|---|---|
| forecast (0) | `point`, `lower`, `upper`, `fitted`, `residuals`, plus `paths` (flat pathsN x horizon), `trend`, `seasonal` when present |
| anomalies (1) | `scores`, `expected` |
| decompose (2) | `trend`, `seasonal`, `resid`, plus `weights` when robust |
| seasonality (3) | `acf`, `lags`, `periodogram`, `frequencies` |
| changepoints (4) | `means` |
| backtest (5) | none — rows are plain JSON in the header |
| interpolate (6) | `y` |

## Rebuild

```sh
cargo build -p isocline-wasm --target wasm32-unknown-unknown --release
cp target/wasm32-unknown-unknown/release/isocline_wasm.wasm packages/isocline/dist/isocline.wasm
```

or simply `npm run build:wasm` at the repository root (builds and copies).
Current binary size: **240 KB raw / 88 KB gzip** (240,767 / 88,831 bytes).
