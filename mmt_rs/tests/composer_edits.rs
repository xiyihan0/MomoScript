use mmt_rs::emit::{GeneratedKind, Origin, OriginKind};
use mmt_rs::pack::{PackManifest, PackRegistry};
use mmt_rs::source::TextRange;
use mmt_rs::syntax::{StatementSyntax, SyntaxNode};
use mmt_rs::{
    AuthoredOriginResolution, CharacterPreset, ComposerCommand, ComposerFailure,
    ComposerTargetFailure, ContinuedValue, EmitOptions, EmittedTypst, MaterializedContent,
    SourceMapEntry, StaticPresetCatalog, analyze_text, analyze_text_with_pack, compose_edit,
    compose_edit_with_pack, emit_typst, resolve_preview_statement, statement_continued,
};

const BASE_MANIFEST: &str = include_str!("fixtures/pack-v3/base-manifest.json");

fn registry() -> PackRegistry {
    PackRegistry::new(vec![PackManifest::from_json(BASE_MANIFEST).unwrap()]).unwrap()
}

fn empty_registry() -> PackRegistry {
    PackRegistry::new(Vec::new()).unwrap()
}

fn statement(analysis: &mmt_rs::AnalyzedDocument, ordinal: usize) -> &StatementSyntax {
    analysis
        .document
        .nodes
        .iter()
        .filter_map(|node| match node {
            SyntaxNode::Statement(statement) => Some(statement),
            _ => None,
        })
        .nth(ordinal)
        .unwrap()
}

fn apply(source: &str, edit: &mmt_rs::ComposerSourceEdit) -> String {
    format!(
        "{}{}{}",
        &source[..edit.range.start],
        edit.new_text,
        &source[edit.range.end..]
    )
}

fn continued(source: &str, ordinal: usize, value: ContinuedValue) -> String {
    let packs = registry();
    let analysis = analyze_text_with_pack(source, &packs);
    let target = statement(&analysis, ordinal).range;
    let edit = compose_edit_with_pack(
        source,
        &analysis,
        &packs,
        target,
        ComposerCommand::SetStatementContinued(value),
    )
    .unwrap();
    apply(source, &edit)
}

fn display_name(source: &str, ordinal: usize, value: &str) -> String {
    let packs = registry();
    let analysis = analyze_text_with_pack(source, &packs);
    let target = statement(&analysis, ordinal).range;
    let edit = compose_edit_with_pack(
        source,
        &analysis,
        &packs,
        target,
        ComposerCommand::SetActorDisplayNameFromStatement(value.to_string()),
    )
    .unwrap();
    apply(source, &edit)
}

#[test]
fn glyph_wrapper_origin_resolves_to_containing_statement() {
    let packs = empty_registry();
    let source = "< _0: 你好😀";
    let analysis = analyze_text_with_pack(source, &packs);
    let emitted = emit_typst(
        &analysis.document,
        &analysis.document_config.config,
        &analysis.modes,
        &analysis.actors,
        &MaterializedContent::default(),
        &EmitOptions::default(),
    );
    let wrapper = emitted.source.find("#text(\"").unwrap();
    let target = resolve_preview_statement(
        &analysis,
        &emitted,
        TextRange::new(wrapper + 1, wrapper + 2),
    )
    .unwrap();

    assert_eq!(target.statement_range, statement(&analysis, 0).range);
    assert_eq!(target.continued, ContinuedValue::Auto);
    assert_eq!(target.actor_display_name, None);
}

#[test]
fn classified_origin_distinguishes_unmapped_and_mixed_ancestry() {
    let emitted = EmittedTypst {
        source: "abcd".to_string(),
        origins: vec![
            Origin::MmtRange {
                range: TextRange::new(10, 11),
                kind: OriginKind::TextBody,
            },
            Origin::Generated {
                kind: GeneratedKind::TemplateWrapper,
                parent: None,
            },
        ],
        source_map: vec![
            SourceMapEntry {
                generated_range: TextRange::new(0, 2),
                origin_id: 0,
            },
            SourceMapEntry {
                generated_range: TextRange::new(2, 4),
                origin_id: 1,
            },
        ],
        diagnostics: Vec::new(),
    };

    assert_eq!(
        emitted.classify_authored_parent(TextRange::new(2, 4)),
        AuthoredOriginResolution::Unmapped
    );
    assert_eq!(
        emitted.classify_authored_parent(TextRange::new(1, 3)),
        AuthoredOriginResolution::Ambiguous
    );
}

#[test]
fn continued_insert_update_and_auto_are_byte_minimal() {
    let base = "> 佳代子: first\n> _0: second";
    let forced = continued(base, 1, ContinuedValue::True);
    assert_eq!(forced, "> 佳代子: first\n>(continued: true) _0: second");
    let new_message = continued(&forced, 1, ContinuedValue::False);
    assert_eq!(
        new_message,
        "> 佳代子: first\n>(continued: false) _0: second"
    );
    assert_eq!(continued(&new_message, 1, ContinuedValue::Auto), base);
}

#[test]
fn continued_preserves_other_arguments_order_spelling_and_whitespace() {
    let source = "> 佳代子: first\n>(fill: green,  inset: 5pt) _0: second";
    let inserted = continued(source, 1, ContinuedValue::True);
    assert_eq!(
        inserted,
        "> 佳代子: first\n>(continued: true, fill: green,  inset: 5pt) _0: second"
    );
    let changed = continued(&inserted, 1, ContinuedValue::False);
    assert_eq!(
        changed,
        "> 佳代子: first\n>(continued: false, fill: green,  inset: 5pt) _0: second"
    );
    assert_eq!(continued(&changed, 1, ContinuedValue::Auto), source);

    let last = "> 佳代子: first\n>(fill: green, continued: true,  ) _0: second";
    assert_eq!(
        continued(last, 1, ContinuedValue::Auto),
        "> 佳代子: first\n>(fill: green,  ) _0: second"
    );
}

#[test]
fn continued_handles_empty_patch_crlf_and_utf8_boundaries() {
    let source = "> 佳代子: 开场😀\r\n>() _0: 第二句𠮷";
    let forced = continued(source, 1, ContinuedValue::True);
    assert_eq!(
        forced,
        "> 佳代子: 开场😀\r\n>(continued: true) _0: 第二句𠮷"
    );
    assert_eq!(continued(&forced, 1, ContinuedValue::Auto), "> 佳代子: 开场😀\r\n> _0: 第二句𠮷");
}

#[test]
fn continued_rejects_duplicate_malformed_and_non_boolean_values() {
    let packs = registry();
    for (source, expected) in [
        (
            "> 佳代子: first\n>(continued: true, continued: false) _0: second",
            ComposerFailure::CandidateInvalid,
        ),
        (
            "> 佳代子: first\n>(continued: \"true\") _0: second",
            ComposerFailure::CandidateInvalid,
        ),
        (
            "> 佳代子: first\n>(continued: true,, fill: green) _0: second",
            ComposerFailure::CandidateInvalid,
        ),
    ] {
        let analysis = analyze_text_with_pack(source, &packs);
        let target = statement(&analysis, 1).range;
        assert_eq!(
            compose_edit_with_pack(
                source,
                &analysis,
                &packs,
                target,
                ComposerCommand::SetStatementContinued(ContinuedValue::False),
            ),
            Err(expected),
            "source: {source}"
        );
    }
}

#[test]
fn current_continued_state_is_structurally_reported() {
    let packs = registry();
    for (source, expected) in [
        ("> 佳代子: text", ContinuedValue::Auto),
        (">(continued: true) 佳代子: text", ContinuedValue::True),
        (">(continued: false, fill: red) 佳代子: text", ContinuedValue::False),
    ] {
        let analysis = analyze_text_with_pack(source, &packs);
        assert_eq!(statement_continued(statement(&analysis, 0)), Ok(expected));
    }
}

#[test]
fn adjacent_actor_block_inserts_or_replaces_only_display_value() {
    let without_field = "@actor 佳代子\npreset: 佳代子\n@end\n> 佳代子: target";
    assert_eq!(
        display_name(without_field, 0, "老师"),
        "@actor 佳代子\npreset: 佳代子\ndisplay-name: 老师\n@end\n> 佳代子: target"
    );

    let quoted = "@actor 佳代子\r\npreset: 佳代子\r\ndisplay-name: 'Old'  \r\n@end\r\n> 佳代子: target";
    assert_eq!(
        display_name(quoted, 0, "O'Brien"),
        "@actor 佳代子\r\npreset: 佳代子\r\ndisplay-name: 'O\\'Brien'  \r\n@end\r\n> 佳代子: target"
    );
}

#[test]
fn display_name_inserts_canonical_revision_from_target_forward() {
    let source = "> 佳代子: before\n> _0: target😀\n> _0: after";
    assert_eq!(
        display_name(source, 1, "老师"),
        "> 佳代子: before\n@actor 佳代子\ndisplay-name: 老师\n@end\n> _0: target😀\n> _0: after"
    );

    let crlf = "> 佳代子: before\r\n> _0: target\r\n> _0: after";
    assert_eq!(
        display_name(crlf, 1, "[老师]"),
        "> 佳代子: before\r\n@actor 佳代子\r\ndisplay-name: \"[老师]\"\r\n@end\r\n> _0: target\r\n> _0: after"
    );
}

#[test]
fn blank_separator_disables_adjacent_block_optimization() {
    let source = "@actor 佳代子\npreset: 佳代子\n@end\n\n> 佳代子: target";
    assert_eq!(
        display_name(source, 0, "老师"),
        "@actor 佳代子\npreset: 佳代子\n@end\n\n@actor 佳代子\ndisplay-name: 老师\n@end\n> 佳代子: target"
    );
}

#[test]
fn display_name_rejects_empty_builtin_and_unrepresentable_values() {
    let packs = registry();
    let actor_source = "> 佳代子: target";
    let actor_analysis = analyze_text_with_pack(actor_source, &packs);
    let actor_target = statement(&actor_analysis, 0).range;
    assert_eq!(
        compose_edit_with_pack(
            actor_source,
            &actor_analysis,
            &packs,
            actor_target,
            ComposerCommand::SetActorDisplayNameFromStatement(String::new()),
        ),
        Err(ComposerFailure::InvalidValue)
    );
    assert_eq!(
        compose_edit_with_pack(
            actor_source,
            &actor_analysis,
            &packs,
            actor_target,
            ComposerCommand::SetActorDisplayNameFromStatement("line one\nline two".to_string()),
        ),
        Err(ComposerFailure::InvalidValue)
    );

    let empty = empty_registry();
    let builtin_source = "< _0: target";
    let builtin_analysis = analyze_text_with_pack(builtin_source, &empty);
    let builtin_target = statement(&builtin_analysis, 0).range;
    assert_eq!(
        compose_edit_with_pack(
            builtin_source,
            &builtin_analysis,
            &empty,
            builtin_target,
            ComposerCommand::SetActorDisplayNameFromStatement("老师".to_string()),
        ),
        Err(ComposerFailure::ActorUnavailable)
    );
}

#[test]
fn unresolved_ambiguous_and_syntax_error_documents_fail_closed() {
    let packs = registry();
    let unresolved = "> 不存在: target";
    let unresolved_analysis = analyze_text_with_pack(unresolved, &packs);
    assert_eq!(
        compose_edit_with_pack(
            unresolved,
            &unresolved_analysis,
            &packs,
            statement(&unresolved_analysis, 0).range,
            ComposerCommand::SetStatementContinued(ContinuedValue::True),
        ),
        Err(ComposerFailure::DocumentHasErrors)
    );

    let ambiguous_manifest = r#"{
      "schema":"mmt-pack.v3",
      "pack":{"namespace":"ambiguous","name":"ambiguous","version":"1","type":"base"},
      "entities":{
        "one":{"names":["same"],"slots":{}},
        "two":{"names":["same"],"slots":{}}
      },
      "storage":{}
    }"#;
    let ambiguous = PackRegistry::new(vec![PackManifest::from_json(ambiguous_manifest).unwrap()]).unwrap();
    let ambiguous_source = "> same: target";
    let ambiguous_analysis = analyze_text_with_pack(ambiguous_source, &ambiguous);
    assert_eq!(
        compose_edit_with_pack(
            ambiguous_source,
            &ambiguous_analysis,
            &ambiguous,
            statement(&ambiguous_analysis, 0).range,
            ComposerCommand::SetStatementContinued(ContinuedValue::True),
        ),
        Err(ComposerFailure::DocumentHasErrors)
    );

    let broken = "> 佳代子: ok\n@end";
    let broken_analysis = analyze_text_with_pack(broken, &packs);
    assert_eq!(
        compose_edit_with_pack(
            broken,
            &broken_analysis,
            &packs,
            statement(&broken_analysis, 0).range,
            ComposerCommand::SetStatementContinued(ContinuedValue::True),
        ),
        Err(ComposerFailure::DocumentHasErrors)
    );
}

#[test]
fn exact_target_and_candidate_invariants_fail_closed() {
    let packs = registry();
    let source = "> 佳代子: before\n> _0: target";
    let analysis = analyze_text_with_pack(source, &packs);
    let target = statement(&analysis, 1).range;
    assert_eq!(
        compose_edit_with_pack(
            source,
            &analysis,
            &packs,
            TextRange::new(target.start, target.end - 1),
            ComposerCommand::SetStatementContinued(ContinuedValue::True),
        ),
        Err(ComposerFailure::TargetChanged)
    );

    let changed_same_length = "> 佳代子: before\n> _0: targeX";
    assert_eq!(
        compose_edit_with_pack(
            changed_same_length,
            &analysis,
            &packs,
            target,
            ComposerCommand::SetStatementContinued(ContinuedValue::True),
        ),
        Err(ComposerFailure::CandidateInvalid)
    );
}

#[test]
fn no_pack_catalog_reanalysis_uses_the_supplied_catalog() {
    let catalog = StaticPresetCatalog::new(vec![CharacterPreset {
        id: "fixture".to_string(),
        names: vec!["角色".to_string()],
        display_name: Some("角色".to_string()),
        avatar: None,
    }]);
    let source = "> 角色: before\n> _0: after";
    let analysis = analyze_text(source, &catalog);
    let target = statement(&analysis, 1).range;
    let edit = compose_edit(
        source,
        &analysis,
        &catalog,
        target,
        ComposerCommand::SetStatementContinued(ContinuedValue::True),
    )
    .unwrap();
    assert_eq!(
        apply(source, &edit),
        "> 角色: before\n>(continued: true) _0: after"
    );
}

#[test]
fn unsupported_and_error_preview_targets_are_classified() {
    let packs = empty_registry();
    let narration = "- narration";
    let narration_analysis = analyze_text_with_pack(narration, &packs);
    let emitted = emit_typst(
        &narration_analysis.document,
        &narration_analysis.document_config.config,
        &narration_analysis.modes,
        &narration_analysis.actors,
        &MaterializedContent::default(),
        &EmitOptions::default(),
    );
    let mapped = emitted
        .source_map
        .iter()
        .find(|entry| matches!(&emitted.origins[entry.origin_id], Origin::MmtRange { .. }))
        .unwrap()
        .generated_range;
    assert_eq!(
        resolve_preview_statement(&narration_analysis, &emitted, mapped),
        Err(ComposerTargetFailure::UnsupportedNode)
    );

    let broken = "not syntax";
    let broken_analysis = analyze_text_with_pack(broken, &packs);
    let empty_emitted = EmittedTypst {
        source: String::new(),
        origins: Vec::new(),
        source_map: Vec::new(),
        diagnostics: Vec::new(),
    };
    assert_eq!(
        resolve_preview_statement(
            &broken_analysis,
            &empty_emitted,
            TextRange::new(0, 0)
        ),
        Err(ComposerTargetFailure::DocumentHasErrors)
    );
}
