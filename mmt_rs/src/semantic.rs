//! Semantic lowering passes.
//!
//! Syntax parsing intentionally does not resolve actor names, speaker history,
//! resource selectors, or file-local directives. Each concern is lowered in a
//! separate pass so diagnostics can retain precise syntax ranges.

use crate::diag::{Diagnostic, DiagnosticPhase, Severity};
use crate::source::TextRange;
use crate::syntax::{BodyMode, BodySyntax, SyntaxDocument, SyntaxNode};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SemanticOptions {
    pub strict: bool,
}

impl Default for SemanticOptions {
    fn default() -> Self {
        Self { strict: true }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolvedBodyMode {
    TextMacro,
    TypstMacro,
    TextRaw,
    TypstRaw,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResolvedBodyModeEntry {
    pub range: TextRange,
    pub mode: ResolvedBodyMode,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BodyModeResolution {
    pub bodies: Vec<ResolvedBodyModeEntry>,
    pub diagnostics: Vec<Diagnostic>,
}

/// Resolves file-local `@mode` directives for statement, reply, and bond bodies.
///
/// Directive payloads and configuration blocks are intentionally excluded.
/// Explicit fenced-body prefixes override the current file default.
pub fn resolve_body_modes(document: &SyntaxDocument) -> BodyModeResolution {
    let mut current = ResolvedBodyMode::TextMacro;
    let mut bodies = Vec::new();
    let mut diagnostics = Vec::new();

    for node in &document.nodes {
        match node {
            SyntaxNode::DirectiveLine(directive) if directive.name == "mode" => {
                let Some(payload) = &directive.payload else {
                    diagnostics.push(semantic_error(
                        "@mode requires a body mode",
                        directive.range,
                    ));
                    continue;
                };
                match parse_mode_name(payload.source.trim()) {
                    Some(mode) => current = mode,
                    None => diagnostics.push(semantic_error(
                        format!("unknown body mode '{}'", payload.source.trim()),
                        payload.range,
                    )),
                }
            }
            SyntaxNode::Statement(statement) => {
                push_resolved_body(&mut bodies, &statement.body, current);
            }
            SyntaxNode::Reply(reply) => {
                for body in &reply.items {
                    push_resolved_body(&mut bodies, body, current);
                }
            }
            SyntaxNode::Bond(bond) => {
                push_resolved_body(&mut bodies, &bond.body, current);
            }
            _ => {}
        }
    }

    BodyModeResolution {
        bodies,
        diagnostics,
    }
}

fn push_resolved_body(
    bodies: &mut Vec<ResolvedBodyModeEntry>,
    body: &BodySyntax,
    inherited: ResolvedBodyMode,
) {
    let mode = match body.mode {
        BodyMode::Inherit => inherited,
        BodyMode::TextMacro => ResolvedBodyMode::TextMacro,
        BodyMode::TypstMacro => ResolvedBodyMode::TypstMacro,
        BodyMode::TextRaw => ResolvedBodyMode::TextRaw,
        BodyMode::TypstRaw => ResolvedBodyMode::TypstRaw,
    };
    bodies.push(ResolvedBodyModeEntry {
        range: body.range,
        mode,
    });
}

fn parse_mode_name(name: &str) -> Option<ResolvedBodyMode> {
    match name {
        "t" | "text" => Some(ResolvedBodyMode::TextMacro),
        "T" | "typst" => Some(ResolvedBodyMode::TypstMacro),
        "rt" | "raw-text" => Some(ResolvedBodyMode::TextRaw),
        "rT" | "raw-typst" => Some(ResolvedBodyMode::TypstRaw),
        _ => None,
    }
}

fn semantic_error(message: impl Into<String>, range: TextRange) -> Diagnostic {
    Diagnostic::new(
        Severity::Error,
        DiagnosticPhase::Semantic,
        message,
        Some(range),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diag::DiagnosticPhase;
    use crate::parse_text;

    #[test]
    fn mode_directives_apply_forward_and_explicit_fences_override_locally() {
        let document = parse_text(
            "> 柚子: text\n\
             @mode: T\n\
             > 柚子: typst\n\
             @reply\n\
             - rt\"\"\"raw reply\"\"\"\n\
             - inherited reply\n\
             @end\n\
             @mode: raw-typst\n\
             @bond: inherited bond",
        );
        assert!(document.diagnostics.is_empty());

        let resolution = resolve_body_modes(&document);
        assert!(resolution.diagnostics.is_empty());
        assert_eq!(
            resolution
                .bodies
                .iter()
                .map(|entry| entry.mode)
                .collect::<Vec<_>>(),
            vec![
                ResolvedBodyMode::TextMacro,
                ResolvedBodyMode::TypstMacro,
                ResolvedBodyMode::TextRaw,
                ResolvedBodyMode::TypstMacro,
                ResolvedBodyMode::TypstRaw,
            ]
        );
    }

    #[test]
    fn accepts_all_documented_mode_names() {
        for (name, expected) in [
            ("t", ResolvedBodyMode::TextMacro),
            ("text", ResolvedBodyMode::TextMacro),
            ("T", ResolvedBodyMode::TypstMacro),
            ("typst", ResolvedBodyMode::TypstMacro),
            ("rt", ResolvedBodyMode::TextRaw),
            ("raw-text", ResolvedBodyMode::TextRaw),
            ("rT", ResolvedBodyMode::TypstRaw),
            ("raw-typst", ResolvedBodyMode::TypstRaw),
        ] {
            let document = parse_text(&format!("@mode: {name}\n- body"));
            let resolution = resolve_body_modes(&document);
            assert!(resolution.diagnostics.is_empty(), "mode name: {name}");
            assert_eq!(resolution.bodies[0].mode, expected, "mode name: {name}");
        }
    }

    #[test]
    fn invalid_mode_reports_semantic_error_and_keeps_previous_default() {
        let document = parse_text("@mode: T\n- first\n@mode: css\n- second\n@mode:\n- third");
        let resolution = resolve_body_modes(&document);

        assert_eq!(resolution.diagnostics.len(), 2);
        assert!(
            resolution
                .diagnostics
                .iter()
                .all(|diagnostic| diagnostic.phase == DiagnosticPhase::Semantic)
        );
        assert!(
            resolution
                .bodies
                .iter()
                .all(|body| body.mode == ResolvedBodyMode::TypstMacro)
        );
    }

    #[test]
    fn mode_does_not_create_entries_for_directive_content() {
        let document = parse_text(
            "@mode: T\n\
             @typ: #let x = 1\n\
             @asset\n\
             body without field syntax\n\
             @end\n\
             - narration",
        );
        let resolution = resolve_body_modes(&document);

        assert!(resolution.diagnostics.is_empty());
        assert_eq!(resolution.bodies.len(), 1);
        assert_eq!(resolution.bodies[0].mode, ResolvedBodyMode::TypstMacro);
    }
}
