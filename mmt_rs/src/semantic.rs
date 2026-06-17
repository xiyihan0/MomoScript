//! Semantic lowering boundary.
//!
//! Syntax parsing intentionally does not resolve character handles, speaker
//! history, resource selectors, or pack manifests. Those passes will be added
//! here after the syntax AST stabilizes.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SemanticOptions {
    pub strict: bool,
}

impl Default for SemanticOptions {
    fn default() -> Self {
        Self { strict: true }
    }
}
