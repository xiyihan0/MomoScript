use mmt_rs::diag::Severity;
use mmt_rs::inline::MacroValueSyntax;
use mmt_rs::source::{LineColumn, SourceFile};
use mmt_rs::syntax::{BodyPartSyntax, SpeakerMarkerSyntax, StatementKind, SyntaxNode};
use mmt_rs::{parse_document, parse_text};

#[test]
fn public_parse_text_api_returns_statement_ast() {
    let doc = parse_text("> _2: 继续[:#1:](width: 2em)");

    assert!(doc.diagnostics.is_empty());
    let SyntaxNode::Statement(statement) = &doc.nodes[0] else {
        panic!("expected statement node");
    };

    assert_eq!(statement.kind, StatementKind::Right);
    assert!(matches!(
        statement.marker,
        Some(SpeakerMarkerSyntax::BackRef { n: 2, .. })
    ));
    assert!(statement.body.parts.iter().any(|part| matches!(
        part,
        BodyPartSyntax::InlineMacro(marker)
            if matches!(marker.args[0].value, MacroValueSyntax::Ordinal { n: 1 })
                && marker.render_patch.is_some()
    )));
}

#[test]
fn public_parse_document_api_preserves_source_positions_for_diagnostics() {
    let source = SourceFile::new(
        Some("case.mmt.txt".to_string()),
        "@actor hifumi\npreset: ba::日富美",
    );
    let doc = parse_document(&source);

    assert_eq!(source.path(), Some("case.mmt.txt"));
    assert_eq!(doc.diagnostics.len(), 1);
    assert_eq!(doc.diagnostics[0].severity, Severity::Error);
    assert_eq!(
        doc.diagnostics[0].primary_position(&source),
        Some(LineColumn { line: 1, column: 1 })
    );
}
