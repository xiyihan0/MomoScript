//! Stable JSON analysis surface for editors and WASM hosts.

use serde::Serialize;

use crate::diag::{Diagnostic, DiagnosticPhase, Severity};
use crate::source::{LineColumn, SourceFile, TextRange};
use crate::syntax::SyntaxNode;

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

pub const ANALYSIS_SCHEMA: &str = "mmt.syntax.v2";

#[derive(Debug, Serialize)]
pub struct AnalysisReport<'a> {
    pub schema: &'static str,
    pub ast: AstReport<'a>,
    pub diagnostics: Vec<AnalysisDiagnostic>,
}

#[derive(Debug, Serialize)]
pub struct AstReport<'a> {
    pub range: TextRange,
    pub nodes: &'a [SyntaxNode],
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AnalysisDiagnostic {
    pub severity: Severity,
    pub phase: DiagnosticPhase,
    pub message: String,
    pub span: Option<SourceSpan>,
    pub labels: Vec<AnalysisLabel>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub struct SourceSpan {
    pub range: TextRange,
    pub start: LineColumn,
    pub end: LineColumn,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AnalysisLabel {
    pub message: Option<String>,
    pub span: Option<SourceSpan>,
}

pub fn analyze_text_json(text: &str) -> Result<String, serde_json::Error> {
    let source = SourceFile::anonymous(text);
    let document = crate::parse_document(&source);
    let diagnostics = document
        .diagnostics
        .iter()
        .map(|diagnostic| analysis_diagnostic(diagnostic, &source))
        .collect();
    serde_json::to_string(&AnalysisReport {
        schema: ANALYSIS_SCHEMA,
        ast: AstReport {
            range: document.range,
            nodes: &document.nodes,
        },
        diagnostics,
    })
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn analyze_text_wasm(text: &str) -> String {
    match analyze_text_json(text) {
        Ok(json) => json,
        Err(error) => format!(
            "{{\"schema\":\"{ANALYSIS_SCHEMA}\",\"ast\":null,\"diagnostics\":[{{\"severity\":\"error\",\"phase\":\"syntax\",\"message\":{}}}]}}",
            serde_json::to_string(&error.to_string())
                .unwrap_or_else(|_| "\"serialization error\"".to_string())
        ),
    }
}

fn analysis_diagnostic(diagnostic: &Diagnostic, source: &SourceFile) -> AnalysisDiagnostic {
    AnalysisDiagnostic {
        severity: diagnostic.severity,
        phase: diagnostic.phase,
        message: diagnostic.message.clone(),
        span: diagnostic
            .range
            .and_then(|range| source_span(source, range)),
        labels: diagnostic
            .labels
            .iter()
            .map(|label| AnalysisLabel {
                message: label.message.clone(),
                span: source_span(source, label.range),
            })
            .collect(),
    }
}

fn source_span(source: &SourceFile, range: TextRange) -> Option<SourceSpan> {
    Some(SourceSpan {
        range,
        start: source.line_column(range.start)?,
        end: source.line_column(range.end)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn analysis_json_contains_versioned_full_ast_and_positions() {
        let source = "> 柚子: 你好 [:happy:](width: 2em)\n@end";
        let json = analyze_text_json(source).unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();

        assert_eq!(value["schema"], ANALYSIS_SCHEMA);
        assert_eq!(value["ast"]["nodes"][0]["kind"], "statement");
        assert_eq!(
            value["ast"]["nodes"][0]["data"]["body"]["parts"][1]["kind"],
            "inline_macro"
        );
        assert_eq!(value["diagnostics"][0]["span"]["start"]["line"], 2);
        assert_eq!(value["diagnostics"][0]["span"]["start"]["column"], 1);
    }

    #[test]
    fn wasm_string_entry_matches_native_json_entry() {
        let source = "- 你好";
        assert_eq!(
            analyze_text_wasm(source),
            analyze_text_json(source).unwrap()
        );
    }
}
