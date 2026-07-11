use crate::source::{LineColumn, SourceFile, TextRange};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiagnosticPhase {
    Syntax,
    Semantic,
    Resolve,
    Materialize,
    Typst,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiagnosticLabel {
    pub range: TextRange,
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diagnostic {
    pub severity: Severity,
    pub phase: DiagnosticPhase,
    pub message: String,
    pub range: Option<TextRange>,
    pub labels: Vec<DiagnosticLabel>,
}

impl Diagnostic {
    pub fn new(
        severity: Severity,
        phase: DiagnosticPhase,
        message: impl Into<String>,
        range: Option<TextRange>,
    ) -> Self {
        Self {
            severity,
            phase,
            message: message.into(),
            range,
            labels: Vec::new(),
        }
    }

    pub fn syntax_error(message: impl Into<String>, range: TextRange) -> Self {
        Self::new(
            Severity::Error,
            DiagnosticPhase::Syntax,
            message,
            Some(range),
        )
    }

    pub fn with_label(mut self, range: TextRange, message: impl Into<String>) -> Self {
        self.labels.push(DiagnosticLabel {
            range,
            message: Some(message.into()),
        });
        self
    }

    pub fn primary_position(&self, source: &SourceFile) -> Option<LineColumn> {
        source.line_column(self.range?.start)
    }
}
