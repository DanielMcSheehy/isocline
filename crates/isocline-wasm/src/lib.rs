//! isocline-wasm — flat-ABI WASM bindings for isocline-core (CONTRACT §3).
//!
//! Exports (C ABI):
//!   alloc(len) -> ptr                  8-aligned bump allocation
//!   call(op, cfg_ptr, cfg_len, y_ptr, y_len) -> status
//!   json_ptr() / json_len()            UTF-8 result header
//!   version() -> 1                     ABI version
//!
//! Lifetime rule: the result header + channels stay valid until the NEXT
//! `call` (which resets the arena after copying inputs out).
#![allow(clippy::missing_safety_doc)]

use isocline_core as core;
use serde::Deserialize;
use std::cell::RefCell;
use std::slice;

// ---------------------------------------------------------------------------
// bump arena
// ---------------------------------------------------------------------------

struct Bump {
    ptr: *mut u8,
    cap: usize,
    off: usize,
    /// Retired chunks, kept mapped: pointers handed out before a growth
    /// (e.g. the cfg pointer the JS side writes into after the second alloc)
    /// must stay valid for the whole call. Reuse of retired chunks is what
    /// caused heap corruption at large n; they are small and short-lived.
    dead: Vec<(*mut u8, usize)>,
}

const ALIGN: usize = 8;

impl Drop for Bump {
    fn drop(&mut self) {
        // SAFETY: chunks were allocated with Layout(cap, align 16)
        unsafe {
            std::alloc::dealloc(self.ptr, std::alloc::Layout::from_size_align(self.cap, 16).unwrap());
            for (p, c) in self.dead.drain(..) {
                std::alloc::dealloc(p, std::alloc::Layout::from_size_align(c, 16).unwrap());
            }
        }
    }
}

impl Bump {
    fn new() -> Self {
        // start at 64 KiB; grows (with copy) on demand
        let cap = 1 << 16;
        // SAFETY: layout with align 16 guarantees our ALIGN=8 requirement
        let ptr = unsafe { std::alloc::alloc(std::alloc::Layout::from_size_align(cap, 16).unwrap()) };
        Bump { ptr, cap, off: 0, dead: Vec::new() }
    }

    fn alloc(&mut self, len: usize) -> usize {
        let start = (self.off + ALIGN - 1) & !(ALIGN - 1);
        let end = start + len.max(1);
        if end > self.cap {
            let need = end.max(self.cap * 2);
            let new_cap = (need + 0xffff) & !0xffff; // round to 64 KiB
            // SAFETY: same allocator, valid layout for both chunks
            let new_ptr =
                unsafe { std::alloc::alloc(std::alloc::Layout::from_size_align(new_cap, 16).unwrap()) };
            if new_ptr.is_null() {
                std::alloc::handle_alloc_error(std::alloc::Layout::from_size_align(new_cap, 16).unwrap());
            }
            unsafe {
                std::ptr::copy_nonoverlapping(self.ptr, new_ptr, self.off);
            }
            // retire (do NOT free) the old chunk: outstanding pointers into it
            // remain valid because its bytes are never overwritten before the
            // next `call` resets everything anyway
            self.dead.push((self.ptr, self.cap));
            self.ptr = new_ptr;
            self.cap = new_cap;
        }
        self.off = end;
        start + self.ptr as usize
    }

    fn reset(&mut self) {
        self.off = 0;
    }
}

thread_local! {
    static ARENA: RefCell<Bump> = RefCell::new(Bump::new());
    static RESULT: RefCell<ResultState> = RefCell::new(ResultState { json: Vec::new(), channels: Vec::new() });
}

struct ResultState {
    json: Vec<u8>,
    channels: Vec<(String, Vec<f64>)>, // inner Vec heap data is stable once pushed
}

// ---------------------------------------------------------------------------
// wasm exports
// ---------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn alloc(len: i32) -> i32 {
    ARENA.with(|a| a.borrow_mut().alloc(len.max(0) as usize)) as i32
}

#[no_mangle]
pub extern "C" fn version() -> i32 {
    1
}

#[no_mangle]
pub extern "C" fn json_ptr() -> i32 {
    RESULT.with(|r| r.borrow().json.as_ptr() as i32)
}

#[no_mangle]
pub extern "C" fn json_len() -> i32 {
    RESULT.with(|r| r.borrow().json.len() as i32)
}

const ERR_BAD_CONFIG: i32 = 1;
const ERR_BAD_OP: i32 = 2;
const ERR_TOO_SHORT: i32 = 3;
const ERR_BAD_PARAMS: i32 = 4;
const ERR_INTERNAL: i32 = 5;

fn err_json(code: &str, msg: &str) -> String {
    format!(r#"{{"ok":false,"code":"{code}","error":{}}}"#, escape(msg))
}

fn escape(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"?\"".into())
}

#[no_mangle]
pub extern "C" fn call(op: i32, cfg_ptr: i32, cfg_len: i32, y_ptr: i32, y_len: i32) -> i32 {
    // SAFETY: JS allocated cfg bytes at cfg_ptr..+cfg_len and an f64 array at
    // y_ptr (8-aligned, y_len elements) before invoking us; we copy them out
    // before resetting the arena they may live in.
    let cfg: Vec<u8> = unsafe { slice::from_raw_parts(cfg_ptr as *const u8, cfg_len.max(0) as usize).to_vec() };
    let y: Vec<f64> = unsafe { slice::from_raw_parts(y_ptr as *const f64, y_len.max(0) as usize).to_vec() };

    ARENA.with(|a| a.borrow_mut().reset());
    RESULT.with(|r| r.borrow_mut().channels.clear());

    let (status, json) = dispatch(op, &cfg, &y);
    RESULT.with(|r| r.borrow_mut().json = json.into_bytes());
    status
}

fn dispatch(op: i32, cfg: &[u8], y: &[f64]) -> (i32, String) {
    match op {
        0 => api::forecast(cfg, y),
        1 => api::anomalies(cfg, y),
        2 => api::decompose(cfg, y),
        3 => api::seasonality(cfg, y),
        4 => api::changepoints(cfg, y),
        5 => api::backtest(cfg, y),
        6 => api::interpolate(y),
        _ => (ERR_BAD_OP, err_json("badOp", "unknown op code")),
    }
}

// ---------------------------------------------------------------------------
// op mapping (single reconciliation point against isocline-core's API)
// ---------------------------------------------------------------------------

mod api {
    use super::*;
    use serde_json::json;

    fn parse<T: for<'de> Deserialize<'de>>(cfg: &[u8]) -> Result<T, String> {
        serde_json::from_slice(cfg).map_err(|e| format!("bad config: {e}"))
    }

    fn status_of(e: &core::IsoclineError) -> i32 {
        match e {
            core::IsoclineError::TooShort { .. } => ERR_TOO_SHORT,
            core::IsoclineError::BadParams(_) => ERR_BAD_PARAMS,
            core::IsoclineError::BadConfig(_) => ERR_BAD_CONFIG,
            core::IsoclineError::Internal(_) => ERR_INTERNAL,
        }
    }

    fn err(e: &core::IsoclineError) -> (i32, String) {
        let code = match status_of(e) {
            ERR_TOO_SHORT => "tooShort",
            ERR_BAD_PARAMS => "badParams",
            ERR_BAD_CONFIG => "badConfig",
            _ => "internal",
        };
        (status_of(e), err_json(code, &e.to_string()))
    }

    /// Push channel data into RESULT (stable pointers) → (name, byteOffset, elemCount).
    fn chans(pairs: Vec<(&'static str, Vec<f64>)>) -> Vec<(String, usize, usize)> {
        let mut out = Vec::with_capacity(pairs.len());
        for (name, data) in pairs {
            let off = data.as_ptr() as usize;
            let len = data.len();
            RESULT.with(|r| r.borrow_mut().channels.push((name.to_string(), data)));
            out.push((name.to_string(), off, len));
        }
        out
    }

    fn chans_json(ch: &[(String, usize, usize)]) -> serde_json::Value {
        let mut m = serde_json::Map::new();
        for (name, off, len) in ch {
            if *len > 0 {
                m.insert(name.clone(), json!([off, len]));
            }
        }
        serde_json::Value::Object(m)
    }

    // -- op 0: forecast ----------------------------------------------------

    #[derive(Deserialize, Default)]
    #[serde(deny_unknown_fields)]
    struct ForecastCfg {
        model: Option<String>,
        horizon: Option<u32>,
        period: Option<u32>,
        level: Option<f64>,
        paths: Option<u32>,
        seed: Option<u64>,
    }

    pub fn forecast(cfg: &[u8], y: &[f64]) -> (i32, String) {
        let c: ForecastCfg = match parse(cfg) {
            Ok(c) => c,
            Err(e) => return (ERR_BAD_CONFIG, err_json("badConfig", &e)),
        };
        let mut opts = core::ForecastOptions::default();
        if let Some(m) = &c.model {
            opts.model = match m.as_str() {
                "auto" => core::Model::Auto,
                "stl_ets" => core::Model::StlEts,
                "ets" => core::Model::Ets,
                "ar" => core::Model::Ar,
                "snaive" => core::Model::Snaive,
                "naive" => core::Model::Naive,
                other => return (ERR_BAD_PARAMS, err_json("badParams", &format!("unknown model {other}"))),
            };
        }
        if let Some(h) = c.horizon {
            if h == 0 || h > 10_000 {
                return (ERR_BAD_PARAMS, err_json("badParams", "horizon must be 1..=10000"));
            }
            opts.horizon = h as usize;
        }
        opts.period = c.period;
        if let Some(l) = c.level {
            if !(0.0..1.0).contains(&l) {
                return (ERR_BAD_PARAMS, err_json("badParams", "level must be in (0,1)"));
            }
            opts.level = l;
        }
        if let Some(p) = c.paths {
            opts.paths = p as usize;
        }
        if let Some(s) = c.seed {
            opts.seed = s;
        }
        match core::forecast(y, &opts) {
            Ok(r) => {
                let mut pairs: Vec<(&'static str, Vec<f64>)> = vec![
                    ("point", r.point.clone()),
                    ("lower", r.lower.clone()),
                    ("upper", r.upper.clone()),
                    ("fitted", r.fitted.clone()),
                    ("residuals", r.residuals.clone()),
                ];
                let has_paths = r.paths.as_ref().is_some_and(|p| !p.is_empty());
                let has_trend = r.trend.as_ref().is_some_and(|p| !p.is_empty());
                let has_seasonal = r.seasonal.as_ref().is_some_and(|p| !p.is_empty());
                if has_paths {
                    pairs.push(("paths", r.paths.clone().unwrap_or_default()));
                }
                if has_trend {
                    pairs.push(("trend", r.trend.clone().unwrap_or_default()));
                }
                if has_seasonal {
                    pairs.push(("seasonal", r.seasonal.clone().unwrap_or_default()));
                }
                let ch = chans(pairs);
                let header = json!({
                    "ok": true,
                    "model": model_str(&r.model),
                    "period": r.period,
                    "horizon": r.horizon,
                    "level": r.level,
                    "paths_n": r.paths_n,
                    "metrics": {"rmse": finite(r.metrics.rmse), "mae": finite(r.metrics.mae), "smape": finite(r.metrics.smape)},
                    "params": r.params,
                    "warnings": r.warnings,
                    "channels": chans_json(&ch),
                });
                (0, header.to_string())
            }
            Err(e) => err(&e),
        }
    }

    fn model_str(m: &core::Model) -> &'static str {
        m.as_str()
    }

    fn finite(v: f64) -> f64 {
        v
    }

    // -- op 1: anomalies ----------------------------------------------------

    #[derive(Deserialize, Default)]
    #[serde(deny_unknown_fields)]
    struct AnomalyCfg {
        method: Option<String>,
        period: Option<u32>,
        threshold: Option<f64>,
        lambda: Option<f64>,
        direction: Option<String>,
    }

    pub fn anomalies(cfg: &[u8], y: &[f64]) -> (i32, String) {
        let c: AnomalyCfg = match parse(cfg) {
            Ok(c) => c,
            Err(e) => return (ERR_BAD_CONFIG, err_json("badConfig", &e)),
        };
        let mut opts = core::AnomalyOptions::default();
        if let Some(m) = &c.method {
            opts.method = match m.as_str() {
                "stl" => core::AnomalyMethod::Stl,
                "madz" => core::AnomalyMethod::MadZ,
                "iqr" => core::AnomalyMethod::Iqr,
                "ewma" => core::AnomalyMethod::Ewma,
                other => return (ERR_BAD_PARAMS, err_json("badParams", &format!("unknown method {other}"))),
            };
        }
        opts.period = c.period;
        if let Some(t) = c.threshold {
            opts.threshold = Some(t);
        }
        if let Some(l) = c.lambda {
            opts.lambda = Some(l);
        }
        if let Some(d) = &c.direction {
            opts.direction = match d.as_str() {
                "both" => core::Direction::Both,
                "high" => core::Direction::High,
                "low" => core::Direction::Low,
                other => return (ERR_BAD_PARAMS, err_json("badParams", &format!("unknown direction {other}"))),
            };
        }
        match core::detect_anomalies(y, &opts) {
            Ok(r) => {
                let anomalies: Vec<serde_json::Value> = r
                    .anomalies
                    .iter()
                    .map(|a| {
                        json!({
                            "index": a.index,
                            "score": a.score,
                            "expected": a.expected,
                            "observed": a.observed,
                            "direction": if a.direction == core::AnomalyDirection::Spike { "spike" } else { "dip" },
                        })
                    })
                    .collect();
                let ch = chans(vec![("scores", r.scores.clone()), ("expected", r.expected.clone())]);
                let header = json!({
                    "ok": true,
                    "method": method_str(&r.method),
                    "threshold": r.threshold,
                    "anomalies": anomalies,
                    "channels": chans_json(&ch),
                });
                (0, header.to_string())
            }
            Err(e) => err(&e),
        }
    }

    fn method_str(m: &core::AnomalyMethod) -> &'static str {
        match m {
            core::AnomalyMethod::Stl => "stl",
            core::AnomalyMethod::MadZ => "madz",
            core::AnomalyMethod::Iqr => "iqr",
            core::AnomalyMethod::Ewma => "ewma",
        }
    }

    // -- op 2: decompose ----------------------------------------------------

    #[derive(Deserialize, Default)]
    #[serde(deny_unknown_fields)]
    struct DecomposeCfg {
        period: Option<u32>,
        robust: Option<bool>,
        seasons: Option<u32>,
    }

    pub fn decompose(cfg: &[u8], y: &[f64]) -> (i32, String) {
        let c: DecomposeCfg = match parse(cfg) {
            Ok(c) => c,
            Err(e) => return (ERR_BAD_CONFIG, err_json("badConfig", &e)),
        };
        let mut opts = core::DecomposeOptions::default();
        opts.period = c.period;
        if let Some(r) = c.robust {
            opts.robust = r;
        }
        if let Some(s) = c.seasons {
            opts.seasons = s as usize;
        }
        match core::decompose(y, &opts) {
            Ok(r) => {
                let mut pairs: Vec<(&'static str, Vec<f64>)> = vec![
                    ("trend", r.trend.clone()),
                    ("seasonal", r.seasonal.clone()),
                    ("resid", r.resid.clone()),
                ];
                if let Some(w) = &r.robust_weights {
                    if !w.is_empty() {
                        pairs.push(("weights", w.clone()));
                    }
                }
                let ch = chans(pairs);
                let header = json!({
                    "ok": true,
                    "period": r.period,
                    "seasonal_strength": r.seasonal_strength,
                    "channels": chans_json(&ch),
                });
                (0, header.to_string())
            }
            Err(e) => err(&e),
        }
    }

    // -- op 3: seasonality ---------------------------------------------------

    #[derive(Deserialize, Default)]
    #[serde(deny_unknown_fields)]
    struct SeasonalityCfg {
        max_period: Option<u32>,
    }

    pub fn seasonality(cfg: &[u8], y: &[f64]) -> (i32, String) {
        let c: SeasonalityCfg = match parse(cfg) {
            Ok(c) => c,
            Err(e) => return (ERR_BAD_CONFIG, err_json("badConfig", &e)),
        };
        let mut opts = core::SeasonalityOptions::default();
        if let Some(m) = c.max_period {
            if m < 2 {
                return (ERR_BAD_PARAMS, err_json("badParams", "maxPeriod must be >= 2"));
            }
            opts.max_period = Some(m);
        }
        match core::seasonality(y, &opts) {
            Ok(r) => {
                let candidates: Vec<serde_json::Value> = r
                    .candidates
                    .iter()
                    .map(|c| {
                        json!({
                            "period": c.period,
                            "strength": c.strength,
                            "source": if c.source == core::SeasonSource::Acf { "acf" } else { "spectral" },
                        })
                    })
                    .collect();
                let ch = chans(vec![
                    ("acf", r.acf.clone()),
                    ("lags", r.lags.clone()),
                    ("periodogram", r.periodogram.clone()),
                    ("frequencies", r.frequencies.clone()),
                ]);
                let header = json!({
                    "ok": true,
                    "best_period": r.best_period,
                    "strength": r.strength,
                    "candidates": candidates,
                    "channels": chans_json(&ch),
                });
                (0, header.to_string())
            }
            Err(e) => err(&e),
        }
    }

    // -- op 4: changepoints ---------------------------------------------------

    #[derive(Deserialize, Default)]
    #[serde(deny_unknown_fields)]
    struct ChangepointCfg {
        min_segment: Option<u32>,
        max_changepoints: Option<u32>,
        threshold: Option<f64>,
    }

    pub fn changepoints(cfg: &[u8], y: &[f64]) -> (i32, String) {
        let c: ChangepointCfg = match parse(cfg) {
            Ok(c) => c,
            Err(e) => return (ERR_BAD_CONFIG, err_json("badConfig", &e)),
        };
        let mut opts = core::ChangepointOptions::default();
        if let Some(m) = c.min_segment {
            opts.min_segment = m as usize;
        }
        if let Some(m) = c.max_changepoints {
            opts.max_changepoints = m as usize;
        }
        if let Some(t) = c.threshold {
            opts.threshold = t;
        }
        match core::changepoints(y, &opts) {
            Ok(r) => {
                let cps: Vec<serde_json::Value> = r
                    .changepoints
                    .iter()
                    .map(|c| {
                        json!({
                            "index": c.index,
                            "mean_before": c.mean_before,
                            "mean_after": c.mean_after,
                        })
                    })
                    .collect();
                let ch = chans(vec![("means", r.means.clone())]);
                let header = json!({
                    "ok": true,
                    "changepoints": cps,
                    "channels": chans_json(&ch),
                });
                (0, header.to_string())
            }
            Err(e) => err(&e),
        }
    }

    // -- op 5: backtest -------------------------------------------------------

    #[derive(Deserialize, Default)]
    #[serde(deny_unknown_fields)]
    struct BacktestCfg {
        models: Option<Vec<String>>,
        horizon: Option<u32>,
        folds: Option<u32>,
        period: Option<u32>,
        seed: Option<u64>,
    }

    pub fn backtest(cfg: &[u8], y: &[f64]) -> (i32, String) {
        let c: BacktestCfg = match parse(cfg) {
            Ok(c) => c,
            Err(e) => return (ERR_BAD_CONFIG, err_json("badConfig", &e)),
        };
        let mut opts = core::BacktestOptions::default();
        if let Some(models) = &c.models {
            let mut ms = Vec::new();
            for m in models {
                ms.push(match m.as_str() {
                    "auto" => core::Model::Auto,
                    "stl_ets" => core::Model::StlEts,
                    "ets" => core::Model::Ets,
                    "ar" => core::Model::Ar,
                    "snaive" => core::Model::Snaive,
                    "naive" => core::Model::Naive,
                    other => return (ERR_BAD_PARAMS, err_json("badParams", &format!("unknown model {other}"))),
                });
            }
            opts.models = ms;
        }
        if let Some(h) = c.horizon {
            opts.horizon = h as usize;
        }
        if let Some(f) = c.folds {
            opts.folds = f as usize;
        }
        opts.period = c.period;
        if let Some(s) = c.seed {
            opts.seed = s;
        }
        match core::backtest(y, &opts) {
            Ok(r) => {
                let rows: Vec<serde_json::Value> = r
                    .rows
                    .iter()
                    .map(|row| {
                        json!({
                            "model": model_str(&row.model),
                            "folds": row.folds,
                            "rmse": row.rmse,
                            "mae": row.mae,
                            "smape": row.smape,
                            "coverage": row.coverage,
                        })
                    })
                    .collect();
                let header = json!({
                    "ok": true,
                    "horizon": r.horizon,
                    "folds": r.folds,
                    "rows": rows,
                });
                (0, header.to_string())
            }
            Err(e) => err(&e),
        }
    }

    // -- op 6: interpolate -----------------------------------------------------

    pub fn interpolate(y: &[f64]) -> (i32, String) {
        let filled = core::interpolate(y);
        let ch = chans(vec![("y", filled)]);
        let header = json!({ "ok": true, "channels": chans_json(&ch) });
        (0, header.to_string())
    }
}
