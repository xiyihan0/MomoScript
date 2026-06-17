//! Typst-facing syntax checks will live here.
//!
//! The first Rust parser milestone keeps this module as a boundary only. Later
//! revisions should use `typst-syntax` 0.15 on `T` bodies and patch arguments.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TypstCheckConfig {
    pub allow_overlay_macros: bool,
}

impl Default for TypstCheckConfig {
    fn default() -> Self {
        Self {
            allow_overlay_macros: true,
        }
    }
}
