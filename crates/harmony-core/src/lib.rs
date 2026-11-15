//! Harmony analysis kernel (pure Rust, no I/O).

/// Kernel version string, surfaced in the UI footer.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
