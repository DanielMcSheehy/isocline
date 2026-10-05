//! Error types for the isocline core.

use std::error::Error;
use std::fmt;

/// All errors produced by isocline-core.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IsoclineError {
    /// Invalid configuration (bad option values, unknown settings).
    BadConfig(String),
    /// Input series too short: got `n`, need at least `need`.
    TooShort { n: usize, need: usize },
    /// Invalid parameters inside the data (e.g. all-NaN input).
    BadParams(String),
    /// Unexpected internal failure (numerical breakdown, invariant violation).
    Internal(String),
}

impl IsoclineError {
    /// Stable machine-readable code, mirroring the TS `IsoclineErrorCode`.
    pub fn code(&self) -> &'static str {
        match self {
            IsoclineError::BadConfig(_) => "badConfig",
            IsoclineError::TooShort { .. } => "tooShort",
            IsoclineError::BadParams(_) => "badParams",
            IsoclineError::Internal(_) => "internal",
        }
    }
}

impl fmt::Display for IsoclineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            IsoclineError::BadConfig(msg) => write!(f, "bad config: {msg}"),
            IsoclineError::TooShort { n, need } => {
                write!(f, "series too short: got {n} points, need at least {need}")
            }
            IsoclineError::BadParams(msg) => write!(f, "bad params: {msg}"),
            IsoclineError::Internal(msg) => write!(f, "internal error: {msg}"),
        }
    }
}

impl Error for IsoclineError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_and_codes() {
        let e = IsoclineError::TooShort { n: 2, need: 3 };
        assert_eq!(e.code(), "tooShort");
        assert!(e.to_string().contains("need at least 3"));
        assert_eq!(IsoclineError::BadConfig("x".into()).code(), "badConfig");
        assert_eq!(IsoclineError::BadParams("y".into()).code(), "badParams");
        assert_eq!(IsoclineError::Internal("z".into()).code(), "internal");
    }
}
