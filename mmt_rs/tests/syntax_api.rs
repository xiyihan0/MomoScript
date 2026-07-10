use mmt_rs::diag::Severity;
use mmt_rs::inline::MacroValueSyntax;
use mmt_rs::source::{LineColumn, SourceFile};
use mmt_rs::syntax::{BodyPartSyntax, SpeakerMarkerSyntax, StatementKind, SyntaxNode};
use mmt_rs::{
    CharacterPreset, ResolvedBodyMode, StaticPresetCatalog, lower_actors, parse_document,
    parse_text, resolve_body_modes,
};

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

#[test]
fn public_mode_resolution_api_applies_file_local_directives() {
    let doc = parse_text("@mode: typst\n- #strong[你好]");
    let resolution = resolve_body_modes(&doc);

    assert!(resolution.diagnostics.is_empty());
    assert_eq!(resolution.bodies.len(), 1);
    assert_eq!(resolution.bodies[0].mode, ResolvedBodyMode::TypstMacro);
}

#[test]
fn public_actor_lowering_api_captures_statement_revisions() {
    let catalog = StaticPresetCatalog::new(vec![CharacterPreset {
        id: "ba::日富美".to_string(),
        names: vec!["日富美".to_string()],
        display_name: None,
        avatar: Some("ba::日富美/avatar/default".to_string()),
    }]);
    let doc = parse_text(
        "> 日富美: first\n\
         @actor 日富美\n\
         display-name: \"小鸟游日富美\"\n\
         @end\n\
         > _: second",
    );
    let lowered = lower_actors(&doc, &catalog);

    assert!(lowered.diagnostics.is_empty());
    assert_eq!(lowered.actors.len(), 1);
    assert_eq!(lowered.actors[0].revisions.len(), 2);
    assert_eq!(lowered.speakers[0].revision, 0);
    assert_eq!(lowered.speakers[1].revision, 1);
    assert_eq!(lowered.speakers[0].actor_id, lowered.speakers[1].actor_id);
}
