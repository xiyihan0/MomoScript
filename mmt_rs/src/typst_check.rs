//! Typst 0.15 syntax prechecks with MMT source-range projection.

use std::ops::Range;

use typst_syntax::{DiagSpanKind, LinkedNode, Side, Source, SyntaxDiagnostic, SyntaxMode};

use crate::diag::{Diagnostic, DiagnosticPhase, Severity};
use crate::inline::{InlineMacroParseError, InlineMacroSyntax, parse_inline_macro_at_checked};
use crate::source::TextRange;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TypstCheckConfig {
    pub allow_overlay_macros: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TypstOverlayScan {
    pub macros: Vec<InlineMacroSyntax>,
    pub diagnostics: Vec<Diagnostic>,
}

impl Default for TypstCheckConfig {
    fn default() -> Self {
        Self {
            allow_overlay_macros: true,
        }
    }
}

pub fn check_typst_source(text: &str, origin: TextRange) -> Vec<Diagnostic> {
    debug_assert_eq!(text.len(), origin.len());
    let source = Source::detached(text);
    syntax_errors(&source)
        .into_iter()
        .map(|(diagnostic, range)| {
            typst_diagnostic(diagnostic, project_range(range, 0, text.len(), origin))
        })
        .collect()
}

/// Checks a raw Typst argument list by placing it in a synthetic function call.
pub fn check_typst_args(args: &str, origin: TextRange) -> Vec<Diagnostic> {
    debug_assert_eq!(args.len(), origin.len());
    const PREFIX: &str = "#mmt-probe(";
    const SUFFIX: &str = ")[probe]";
    let wrapped = format!("{PREFIX}{args}{SUFFIX}");
    let source = Source::detached(wrapped);
    syntax_errors(&source)
        .into_iter()
        .filter_map(|(diagnostic, range)| {
            let projected = project_wrapped_range(range, PREFIX.len(), args.len(), origin)?;
            Some(typst_diagnostic(diagnostic, projected))
        })
        .collect()
}

/// Finds MMT inline macros that occur in Typst markup regions.
///
/// Candidates are replaced with same-byte-length identifier text before Typst
/// parsing, so MMT-only tokens such as `#1` cannot corrupt the surrounding CST.
pub fn scan_typst_overlay_macros(text: &str, origin: TextRange) -> TypstOverlayScan {
    debug_assert_eq!(text.len(), origin.len());
    let mut masked = text.as_bytes().to_vec();
    let mut candidates = Vec::new();
    let mut cursor = 0;

    while let Some(relative) = text[cursor..].find("[:") {
        let start = cursor + relative;
        match parse_inline_macro_at_checked(&text[start..], origin.start + start) {
            Ok(parsed) => {
                let end = parsed.syntax.range.end - origin.start;
                mask_overlay_candidate(&mut masked, start, end);
                candidates.push((start, Some(parsed.syntax), parsed.diagnostics));
                cursor = end;
            }
            Err(InlineMacroParseError::MissingClose { range }) => {
                let end = start + 2;
                mask_overlay_candidate(&mut masked, start, end);
                candidates.push((
                    start,
                    None,
                    vec![crate::inline::InlineMacroDiagnostic {
                        message: "unclosed inline macro".to_string(),
                        range,
                    }],
                ));
                cursor = end;
            }
        }
    }

    let masked = String::from_utf8(masked).expect("overlay mask always produces valid UTF-8");
    let source = Source::detached(masked);
    let mut diagnostics = syntax_errors(&source)
        .into_iter()
        .map(|(diagnostic, range)| {
            typst_diagnostic(diagnostic, project_range(range, 0, text.len(), origin))
        })
        .collect::<Vec<_>>();
    let root = LinkedNode::new(source.root());
    let mut macros = Vec::new();

    for (start, syntax, candidate_diagnostics) in candidates {
        let is_markup = root
            .leaf_at(start, Side::After)
            .and_then(|leaf| leaf.mode_after())
            == Some(SyntaxMode::Markup);
        if !is_markup {
            continue;
        }
        diagnostics.extend(
            candidate_diagnostics
                .into_iter()
                .map(|diagnostic| Diagnostic::syntax_error(diagnostic.message, diagnostic.range)),
        );
        if let Some(syntax) = syntax {
            macros.push(syntax);
        }
    }

    TypstOverlayScan {
        macros,
        diagnostics,
    }
}

fn mask_overlay_candidate(masked: &mut [u8], start: usize, end: usize) {
    for byte in &mut masked[start..end] {
        if !matches!(*byte, b'\n' | b'\r') {
            *byte = b'x';
        }
    }
}

fn syntax_errors(source: &Source) -> Vec<(SyntaxDiagnostic, Range<usize>)> {
    let (errors, _) = source.root().errors_and_warnings();
    errors
        .into_iter()
        .map(|diagnostic| {
            let range = diagnostic_range(source, &diagnostic)
                .unwrap_or_else(|| source.text().len()..source.text().len());
            (diagnostic, range)
        })
        .collect()
}

fn diagnostic_range(source: &Source, diagnostic: &SyntaxDiagnostic) -> Option<Range<usize>> {
    match diagnostic.span.get() {
        DiagSpanKind::Detached => None,
        DiagSpanKind::Number { id, num, sub_range } if id == source.id() => {
            source.range(num, sub_range)
        }
        DiagSpanKind::Range { id, range } if id == source.id() => Some(range),
        _ => None,
    }
}

fn project_wrapped_range(
    range: Range<usize>,
    prefix_len: usize,
    body_len: usize,
    origin: TextRange,
) -> Option<TextRange> {
    let body_end = prefix_len + body_len;
    if range.end < prefix_len {
        return None;
    }
    let start = range.start.clamp(prefix_len, body_end) - prefix_len;
    let end = range.end.clamp(prefix_len, body_end) - prefix_len;
    Some(project_range(start..end, 0, body_len, origin))
}

fn project_range(
    range: Range<usize>,
    source_start: usize,
    source_len: usize,
    origin: TextRange,
) -> TextRange {
    let source_end = source_start + source_len;
    let start = range.start.clamp(source_start, source_end) - source_start;
    let end = range.end.clamp(source_start, source_end) - source_start;
    TextRange::new(origin.start + start, origin.start + end)
}

fn typst_diagnostic(diagnostic: SyntaxDiagnostic, range: TextRange) -> Diagnostic {
    Diagnostic::new(
        Severity::Error,
        DiagnosticPhase::Typst,
        diagnostic.message.to_string(),
        Some(range),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_typst_markup_and_args_pass_syntax_checks() {
        let body = "#strong[你好]";
        let args = "fill: green, inset: 5pt";
        assert!(check_typst_source(body, TextRange::new(20, 20 + body.len())).is_empty());
        assert!(check_typst_args(args, TextRange::new(100, 100 + args.len())).is_empty());
    }

    #[test]
    fn body_errors_map_to_original_utf8_byte_ranges() {
        let text = "中文 #let x =";
        let origin = TextRange::new(50, 50 + text.len());
        let diagnostics = check_typst_source(text, origin);

        assert!(!diagnostics.is_empty());
        assert!(diagnostics.iter().all(|diagnostic| {
            diagnostic.phase == DiagnosticPhase::Typst
                && diagnostic
                    .range
                    .is_some_and(|range| range.start >= origin.start && range.end <= origin.end)
        }));
    }

    #[test]
    fn argument_errors_project_out_of_the_synthetic_wrapper() {
        for args in ["fill: , inset: 5pt", "fill: ("] {
            let origin = TextRange::new(200, 200 + args.len());
            let diagnostics = check_typst_args(args, origin);

            assert!(!diagnostics.is_empty(), "args: {args}");
            assert!(diagnostics.iter().all(|diagnostic| {
                diagnostic
                    .range
                    .is_some_and(|range| range.start >= origin.start && range.end <= origin.end)
            }));
        }
    }

    #[test]
    fn trailing_incomplete_argument_can_map_to_zero_length_origin_end() {
        let args = "fill:";
        let origin = TextRange::new(8, 13);
        let diagnostics = check_typst_args(args, origin);

        assert!(!diagnostics.is_empty());
        assert!(diagnostics.iter().any(|diagnostic| {
            diagnostic
                .range
                .is_some_and(|range| range.start == origin.end && range.end == origin.end)
        }));
    }

    #[test]
    fn typst_overlay_only_selects_markup_and_nested_content_regions() {
        let text = r#"before [:#1:]
#let string = "[:#2:]"
#let raw = `[:#3:]`
// [:#4:]
#let content = [nested [:#5:]]
#text([:#6:])"#;
        let scan = scan_typst_overlay_macros(text, TextRange::new(20, 20 + text.len()));

        assert!(scan.diagnostics.is_empty());
        assert_eq!(
            scan.macros
                .iter()
                .map(|marker| marker.args[0].range)
                .map(|range| &text[range.start - 20..range.end - 20])
                .collect::<Vec<_>>(),
            vec!["#1", "#5"]
        );
    }

    #[test]
    fn malformed_overlay_marker_only_errors_in_markup() {
        let markup = "before [:";
        let string = "#let value = \"[:\"";

        let markup_scan = scan_typst_overlay_macros(markup, TextRange::new(0, markup.len()));
        let string_scan = scan_typst_overlay_macros(string, TextRange::new(0, string.len()));

        assert!(
            markup_scan
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.message.contains("unclosed inline macro"))
        );
        assert!(string_scan.diagnostics.is_empty());
    }
}
