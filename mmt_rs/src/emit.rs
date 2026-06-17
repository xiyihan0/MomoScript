//! Typst emitter and source-map boundary.

use crate::source::TextRange;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OriginKind {
    TextBody,
    TypstBody,
    StatementPatch,
    ResourceMarker,
    ResourcePatch,
    TypDirective,
    DirectiveField,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GeneratedKind {
    TemplateWrapper,
    EscapedText,
    MacroExpansion,
    ResourceCallWrapper,
    StatementCallWrapper,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Origin {
    MmtRange {
        range: TextRange,
        kind: OriginKind,
    },
    Generated {
        kind: GeneratedKind,
        parent: Option<usize>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmitChunk {
    pub text: String,
    pub origin: Origin,
}
