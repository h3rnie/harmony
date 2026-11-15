//! Harmony analysis kernel (pure Rust, no I/O).
//!
//! AOI rasterisation, zonal sums of the harmonized MODIS + VIIRS tile columns, the contract
//! uncertainty interval, and the statistics shown in the web app. Output shapes mirror
//! `web/src/lib/kernel/types.ts`; the tile schema and interval formula follow
//! `schema/data-contract.md`.

pub mod cells;
pub mod engine;
pub mod geom;
pub mod meta;
pub mod outlook;
pub mod robust;
pub mod season;
pub mod series;
pub mod stats;
pub mod store;
pub mod trend;

pub use engine::{Analysis, AnalyzeOptions, Engine};

use std::fmt;

/// Kernel version string, surfaced in the UI footer.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// A readable error, surfaced to JavaScript as an exception message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error(pub String);

impl Error {
    pub fn new(msg: impl Into<String>) -> Self {
        Error(msg.into())
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

/// Calendar helpers for the contract month index `m = (year - 2000) * 12 + (month - 1)`.
pub mod months {
    pub fn year_of(m: i32) -> i32 {
        2000 + m.div_euclid(12)
    }

    /// Month of year, 0-based.
    pub fn moy(m: i32) -> usize {
        m.rem_euclid(12) as usize
    }

    pub fn month_index(year: i32, moy: usize) -> i32 {
        (year - 2000) * 12 + moy as i32
    }
}
