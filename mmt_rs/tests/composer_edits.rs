use mmt_rs::emit::{GeneratedKind, Origin, OriginKind};
use mmt_rs::pack::{PackManifest, PackRegistry};
use mmt_rs::source::TextRange;
use mmt_rs::syntax::{StatementSyntax, SyntaxNode};
use mmt_rs::{
    AuthoredOriginResolution, COMPOSER_STATEMENT_TEXT_MAX_BYTES, CharacterPreset,
    ComposerAvatarCurrent, ComposerBodyMode, ComposerCommand, ComposerFailure,
    ComposerTargetFailure, ContinuedValue, EmitOptions, EmittedTypst, MaterializedContent,
    PackAvatarChoice, SourceMapEntry, StatementTextMode, StaticPresetCatalog, analyze_text,
    analyze_text_with_pack, compose_edit, compose_edit_with_pack, emit_typst,
    resolve_preview_statement, statement_continued,
};

const BASE_MANIFEST: &str = include_str!("fixtures/pack-v3/base-manifest.json");
const EXTENSION_MANIFEST: &str = include_str!("fixtures/pack-v3/extension-manifest.json");

fn registry() -> PackRegistry {
    PackRegistry::new(vec![
        PackManifest::from_json(BASE_MANIFEST).unwrap(),
        PackManifest::from_json(EXTENSION_MANIFEST).unwrap(),
    ])
    .unwrap()
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

fn authored_statement_mode(statement: &StatementSyntax) -> StatementTextMode {
    match statement.body.mode {
        mmt_rs::syntax::BodyMode::Inherit => StatementTextMode::Inherit,
        mmt_rs::syntax::BodyMode::TextMacro => StatementTextMode::TextMacro,
        mmt_rs::syntax::BodyMode::TextRaw => StatementTextMode::TextRaw,
        mmt_rs::syntax::BodyMode::TypstMacro => StatementTextMode::TypstMacro,
        mmt_rs::syntax::BodyMode::TypstRaw => StatementTextMode::TypstRaw,
    }
}

fn statement_text(source: &str, ordinal: usize, value: &str) -> String {
    let packs = registry();
    let analysis = analyze_text_with_pack(source, &packs);
    let statement = statement(&analysis, ordinal);
    let target = statement.range;
    let edit = compose_edit_with_pack(
        source,
        &analysis,
        &packs,
        target,
        ComposerCommand::SetStatementBody {
            value: value.to_string(),
            mode: authored_statement_mode(statement),
        },
    )
    .unwrap();
    apply(source, &edit)
}

fn statement_text_mode(source: &str, ordinal: usize, mode: StatementTextMode) -> String {
    let packs = registry();
    let analysis = analyze_text_with_pack(source, &packs);
    let statement = statement(&analysis, ordinal);
    let target = statement.range;
    let edit = compose_edit_with_pack(
        source,
        &analysis,
        &packs,
        target,
        ComposerCommand::SetStatementBody {
            value: statement.body.source.clone(),
            mode,
        },
    )
    .unwrap();
    apply(source, &edit)
}

fn avatar(source: &str, ordinal: usize, choice: PackAvatarChoice) -> String {
    let packs = registry();
    let analysis = analyze_text_with_pack(source, &packs);
    let target = statement(&analysis, ordinal).range;
    let edit = compose_edit_with_pack(
        source,
        &analysis,
        &packs,
        target,
        ComposerCommand::SetActorAvatarFromStatement(choice),
    )
    .unwrap();
    apply(source, &edit)
}

fn avatar_choice(entity: &str, contribution: &str, variant: &str) -> PackAvatarChoice {
    PackAvatarChoice {
        entity_id: entity.to_string(),
        contribution_namespace: contribution.to_string(),
        variant_id: variant.to_string(),
    }
}

fn preview_target(source: &str, packs: &PackRegistry) -> mmt_rs::ComposerTarget {
    preview_target_at(source, packs, 0)
}

fn preview_target_at(
    source: &str,
    packs: &PackRegistry,
    statement_ordinal: usize,
) -> mmt_rs::ComposerTarget {
    let analysis = analyze_text_with_pack(source, packs);
    let range = statement(&analysis, statement_ordinal).range;
    let emitted = EmittedTypst {
        source: "x".to_string(),
        origins: vec![Origin::MmtRange {
            range,
            kind: OriginKind::TextBody,
        }],
        source_map: vec![SourceMapEntry {
            generated_range: TextRange::new(0, 1),
            origin_id: 0,
        }],
        diagnostics: Vec::new(),
    };
    resolve_preview_statement(&analysis, &emitted, TextRange::new(0, 1)).unwrap()
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
    assert_eq!(target.continued, Some(ContinuedValue::Auto));
    assert_eq!(target.actor_display_name, None);
    assert_eq!(
        target
            .statement_text
            .as_ref()
            .map(|text| text.current.as_str()),
        Some("你好😀")
    );
}

#[test]
fn preview_target_reports_pack_asset_and_null_avatar_without_leaks() {
    let packs = registry();
    let pack_target = preview_target("> 佳代子: target", &packs);
    let pack_avatar = pack_target.actor_avatar.clone().unwrap();
    assert_eq!(pack_avatar.actor_preset_id, "ba_fixture::佳代子");
    assert_eq!(
        pack_target
            .statement_text
            .as_ref()
            .map(|text| text.current.as_str()),
        Some("target")
    );
    assert_eq!(
        pack_avatar.current,
        Some(ComposerAvatarCurrent::Pack(avatar_choice(
            "ba_fixture::佳代子",
            "ba_fixture",
            "default",
        )))
    );
    let history_target = preview_target_at("> 佳代子: before\n> _0: target", &packs, 1);
    assert_eq!(history_target.actor_avatar, pack_target.actor_avatar);

    let script_target = preview_target(
        "@asset portrait\nsrc: portrait.png\n@end\n@actor 佳代子\npreset: 佳代子\navatar: asset::portrait\n@end\n> 佳代子: target",
        &packs,
    );
    assert_eq!(
        script_target.actor_avatar.unwrap().current,
        Some(ComposerAvatarCurrent::Asset("portrait".to_string()))
    );

    let pack_asset_target = preview_target(
        "@actor 佳代子\npreset: 佳代子\navatar: asset::pack_portrait\n@end\n> 佳代子: target",
        &packs,
    );
    assert_eq!(
        pack_asset_target.actor_avatar.unwrap().current,
        Some(ComposerAvatarCurrent::Asset("pack_portrait".to_string()))
    );

    let no_avatar_manifest = r#"{
      "schema":"mmt-pack.v3",
      "pack":{"namespace":"plain","name":"plain","version":"1","type":"base"},
      "entities":{"actor":{"names":["角色"],"slots":{}}},
      "storage":{}
    }"#;
    let no_avatar =
        PackRegistry::new(vec![PackManifest::from_json(no_avatar_manifest).unwrap()]).unwrap();
    assert_eq!(
        preview_target("> 角色: target", &no_avatar)
            .actor_avatar
            .unwrap()
            .current,
        None
    );

    let catalog = StaticPresetCatalog::new(vec![CharacterPreset {
        id: "fixture".to_string(),
        names: vec!["角色".to_string()],
        display_name: Some("角色".to_string()),
        avatar: None,
    }]);
    let source = "> 角色: target";
    let analysis = analyze_text(source, &catalog);
    let range = statement(&analysis, 0).range;
    let emitted = EmittedTypst {
        source: "x".to_string(),
        origins: vec![Origin::MmtRange {
            range,
            kind: OriginKind::TextBody,
        }],
        source_map: vec![SourceMapEntry {
            generated_range: TextRange::new(0, 1),
            origin_id: 0,
        }],
        diagnostics: Vec::new(),
    };
    assert_eq!(
        resolve_preview_statement(&analysis, &emitted, TextRange::new(0, 1))
            .unwrap()
            .actor_avatar,
        None
    );
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
fn preview_target_exposes_single_line_chat_and_narration_text() {
    let packs = registry();
    let left = preview_target("> 佳代子: 当前正文😀", &packs)
        .statement_text
        .unwrap();
    assert_eq!(left.current, "当前正文😀");
    assert_eq!(left.mode, StatementTextMode::Inherit);
    assert_eq!(left.resolved_mode, ComposerBodyMode::TextMacro);
    assert_eq!(left.inherited_mode, ComposerBodyMode::TextMacro);
    assert_eq!(
        preview_target("< 佳代子: 右侧正文", &packs)
            .statement_text
            .as_ref()
            .map(|text| text.current.as_str()),
        Some("右侧正文")
    );
    let narration = preview_target("- 旁白正文", &packs);
    assert_eq!(
        narration
            .statement_text
            .as_ref()
            .map(|text| text.current.as_str()),
        Some("旁白正文")
    );
    assert_eq!(narration.continued, None);
    assert_eq!(narration.actor_display_name, None);
    assert_eq!(narration.actor_avatar, None);
    assert_eq!(
        preview_target("> 佳代子: first\ncontinued body", &packs).statement_text,
        None
    );

    let builtin = empty_registry();
    let builtin_text = preview_target("< _0: builtin", &builtin)
        .statement_text
        .unwrap();
    assert_eq!(builtin_text.current, "builtin");
    assert_eq!(builtin_text.mode, StatementTextMode::Inherit);
    let raw_default = preview_target("@mode: rt\n- raw body", &packs)
        .statement_text
        .unwrap();
    assert_eq!(raw_default.mode, StatementTextMode::Inherit);
    assert_eq!(raw_default.resolved_mode, ComposerBodyMode::TextRaw);
    assert_eq!(raw_default.inherited_mode, ComposerBodyMode::TextRaw);

    let local_text = preview_target("@mode: T\n- t\"\"\"local text\"\"\"", &packs)
        .statement_text
        .unwrap();
    assert_eq!(local_text.mode, StatementTextMode::TextMacro);
    assert_eq!(local_text.resolved_mode, ComposerBodyMode::TextMacro);
    assert_eq!(local_text.inherited_mode, ComposerBodyMode::TypstMacro);

    let local_typst = preview_target("- T\"\"\"#strong[local typst]\"\"\"", &packs)
        .statement_text
        .unwrap();
    assert_eq!(local_typst.current, "#strong[local typst]");
    assert_eq!(local_typst.mode, StatementTextMode::TypstMacro);
    assert_eq!(local_typst.resolved_mode, ComposerBodyMode::TypstMacro);
    assert_eq!(local_typst.inherited_mode, ComposerBodyMode::TextMacro);
}

#[test]
fn statement_text_replaces_only_body_and_preserves_parameters_crlf_and_escapes() {
    let source = concat!(
        "> 佳代子: first\r\n",
        ">(fill: green,  inset: 5pt) _0: old text\r\n",
        "> _0: after"
    );
    let replacement = r#"新正文😀 "quoted" C:\path\{literal\}"#;
    let edited = statement_text(source, 1, replacement);
    assert_eq!(
        edited,
        concat!(
            "> 佳代子: first\r\n",
            ">(fill: green,  inset: 5pt) _0: 新正文😀 \"quoted\" C:\\path\\{literal\\}\r\n",
            "> _0: after"
        )
    );
}

#[test]
fn statement_text_preserves_crlf_separator_outside_body() {
    let source = "> 佳代子: original\r\n\r\n@reply: A | B\r\n@bond: bond";
    let packs = registry();
    let analysis = analyze_text_with_pack(source, &packs);
    let parsed = statement(&analysis, 0);
    assert_eq!(parsed.body.source, "original");
    assert_eq!(
        &source[parsed.body.range.start..parsed.body.range.end],
        "original"
    );
    assert_eq!(
        &source[parsed.body.range.end..],
        "\r\n\r\n@reply: A | B\r\n@bond: bond"
    );
    assert_eq!(
        statement_text(source, 0, "targeted"),
        "> 佳代子: targeted\r\n\r\n@reply: A | B\r\n@bond: bond"
    );
}

#[test]
fn statement_text_preserves_lf_and_multiple_blank_separators() {
    for (source, expected) in [
        (
            "> 佳代子: original\n\n@reply: A | B",
            "> 佳代子: targeted\n\n@reply: A | B",
        ),
        (
            "> 佳代子: original\n\n\n@reply: A | B",
            "> 佳代子: targeted\n\n\n@reply: A | B",
        ),
        (
            "> 佳代子: original\r\n\r\n\r\n@reply: A | B",
            "> 佳代子: targeted\r\n\r\n\r\n@reply: A | B",
        ),
    ] {
        assert_eq!(statement_text(source, 0, "targeted"), expected);
    }
}

#[test]
fn statement_text_edits_right_chat_and_narration_without_changing_their_markers() {
    assert_eq!(
        statement_text("< 佳代子: right before", 0, "right after"),
        "< 佳代子: right after"
    );
    assert_eq!(
        statement_text("- narration before", 0, "narration after"),
        "- narration after"
    );
}

#[test]
fn statement_text_mode_wraps_plain_body_and_minimally_rewrites_fence_prefix() {
    assert_eq!(
        statement_text_mode("> 佳代子: plain body", 0, StatementTextMode::TextMacro,),
        "> 佳代子: t\"\"\"plain body\"\"\""
    );
    assert_eq!(
        statement_text_mode(
            "- t\"\"\"narration body\"\"\"",
            0,
            StatementTextMode::TextRaw,
        ),
        "- rt\"\"\"narration body\"\"\""
    );
    assert_eq!(
        statement_text_mode(
            "< 佳代子: rt\"\"\"right body\"\"\"",
            0,
            StatementTextMode::Inherit,
        ),
        "< 佳代子: \"\"\"right body\"\"\""
    );
    assert_eq!(
        statement_text_mode(
            "< _0: \"\"\"right body\"\"\"",
            0,
            StatementTextMode::TypstMacro,
        ),
        "< _0: T\"\"\"right body\"\"\""
    );

    assert_eq!(
        statement_text_mode(
            "- T\"\"\"#strong[body]\"\"\"",
            0,
            StatementTextMode::TypstRaw,
        ),
        "- rT\"\"\"#strong[body]\"\"\""
    );
    assert_eq!(
        statement_text_mode(
            "@mode: T\n- t\"\"\"local text\"\"\"",
            0,
            StatementTextMode::Inherit,
        ),
        "@mode: T\n- \"\"\"local text\"\"\""
    );
}
#[test]
fn statement_body_changes_text_and_mode_in_one_source_edit() {
    let packs = registry();
    let source = ">(fill: green) 佳代子: old";
    let analysis = analyze_text_with_pack(source, &packs);
    let statement = statement(&analysis, 0);
    let edit = compose_edit_with_pack(
        source,
        &analysis,
        &packs,
        statement.range,
        ComposerCommand::SetStatementBody {
            value: "new #strong[Typst]".to_string(),
            mode: StatementTextMode::TypstRaw,
        },
    )
    .unwrap();
    assert_eq!(edit.range, statement.body.range);
    assert_eq!(edit.new_text, "rT\"\"\"new #strong[Typst]\"\"\"");
    assert_eq!(
        apply(source, &edit),
        ">(fill: green) 佳代子: rT\"\"\"new #strong[Typst]\"\"\""
    );
}

#[test]
fn statement_text_mode_rejects_noop_and_invalid_fence_candidate() {
    let packs = registry();
    for (source, value, expected) in [
        (
            "> 佳代子: plain",
            StatementTextMode::Inherit,
            ComposerFailure::InvalidValue,
        ),
        (
            "> 佳代子: contains \"\"\" fence",
            StatementTextMode::TextRaw,
            ComposerFailure::CandidateInvalid,
        ),
    ] {
        let analysis = analyze_text_with_pack(source, &packs);
        assert_eq!(
            compose_edit_with_pack(
                source,
                &analysis,
                &packs,
                statement(&analysis, 0).range,
                ComposerCommand::SetStatementBody {
                    value: statement(&analysis, 0).body.source.clone(),
                    mode: value,
                },
            ),
            Err(expected),
            "source: {source}",
        );
    }
}

#[test]
fn statement_text_rejects_empty_multiline_noop_and_invalid_candidate() {
    let packs = registry();
    let source = "> 佳代子: current";
    let analysis = analyze_text_with_pack(source, &packs);
    let target = statement(&analysis, 0).range;
    for value in [
        String::new(),
        "line one\nline two".to_string(),
        "line one\rline two".to_string(),
        "current".to_string(),
        "x".repeat(COMPOSER_STATEMENT_TEXT_MAX_BYTES + 1),
    ] {
        assert_eq!(
            compose_edit_with_pack(
                source,
                &analysis,
                &packs,
                target,
                ComposerCommand::SetStatementBody {
                    value,
                    mode: StatementTextMode::Inherit,
                },
            ),
            Err(ComposerFailure::InvalidValue)
        );
    }
    assert_eq!(
        compose_edit_with_pack(
            source,
            &analysis,
            &packs,
            target,
            ComposerCommand::SetStatementBody {
                value: "broken [:macro".to_string(),
                mode: StatementTextMode::Inherit,
            },
        ),
        Err(ComposerFailure::CandidateInvalid)
    );
    assert_eq!(
        compose_edit_with_pack(
            "> 佳代子: currenX",
            &analysis,
            &packs,
            target,
            ComposerCommand::SetStatementBody {
                value: "replacement".to_string(),
                mode: StatementTextMode::Inherit,
            },
        ),
        Err(ComposerFailure::CandidateInvalid)
    );

    let multiline = "> 佳代子: first\ncontinued body";
    let multiline_analysis = analyze_text_with_pack(multiline, &packs);
    assert_eq!(
        compose_edit_with_pack(
            multiline,
            &multiline_analysis,
            &packs,
            statement(&multiline_analysis, 0).range,
            ComposerCommand::SetStatementBody {
                value: "replacement".to_string(),
                mode: StatementTextMode::Inherit,
            },
        ),
        Err(ComposerFailure::TargetChanged)
    );

    let builtin = empty_registry();
    let builtin_source = "< _0: builtin";
    let builtin_analysis = analyze_text_with_pack(builtin_source, &builtin);
    let edit = compose_edit_with_pack(
        builtin_source,
        &builtin_analysis,
        &builtin,
        statement(&builtin_analysis, 0).range,
        ComposerCommand::SetStatementBody {
            value: "replacement".to_string(),
            mode: StatementTextMode::Inherit,
        },
    )
    .unwrap();
    assert_eq!(apply(builtin_source, &edit), "< _0: replacement");
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
    assert_eq!(
        continued(&forced, 1, ContinuedValue::Auto),
        "> 佳代子: 开场😀\r\n> _0: 第二句𠮷"
    );
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
        (
            ">(continued: false, fill: red) 佳代子: text",
            ContinuedValue::False,
        ),
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

    let quoted =
        "@actor 佳代子\r\npreset: 佳代子\r\ndisplay-name: 'Old'  \r\n@end\r\n> 佳代子: target";
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
fn adjacent_actor_block_inserts_or_replaces_avatar_only() {
    let without_field = "@actor 佳代子\npreset: 佳代子\n@end\n> 佳代子: target";
    assert_eq!(
        avatar(
            without_field,
            0,
            avatar_choice("ba_fixture::佳代子", "ba_fixture", "smile"),
        ),
        "@actor 佳代子\npreset: 佳代子\navatar: ba_fixture::佳代子/ba_fixture::avatar/smile\n@end\n> 佳代子: target"
    );

    let quoted = "@actor 佳代子\r\npreset: 佳代子\r\navatar: 'ba_fixture::佳代子/ba_fixture::avatar/default'  \r\n@end\r\n> 佳代子: target";
    assert_eq!(
        avatar(
            quoted,
            0,
            avatar_choice("ba_fixture::佳代子", "ba_fixture", "smile"),
        ),
        "@actor 佳代子\r\npreset: 佳代子\r\navatar: 'ba_fixture::佳代子/ba_fixture::avatar/smile'  \r\n@end\r\n> 佳代子: target"
    );
}

#[test]
fn avatar_inserts_cross_character_revision_from_target_forward() {
    let source = "> 小雪: before\r\n> _0: target😀\r\n> _0: after";
    assert_eq!(
        avatar(
            source,
            1,
            avatar_choice("ba_fixture::佳代子", "ba_fixture", "default"),
        ),
        "> 小雪: before\r\n@actor 小雪\r\navatar: ba_fixture::佳代子/ba_fixture::avatar/default\r\n@end\r\n> _0: target😀\r\n> _0: after"
    );

    let first = "> 小雪: target";
    assert_eq!(
        avatar(
            first,
            0,
            avatar_choice("ba_fixture::佳代子", "ba_fixture", "default"),
        ),
        "@actor 小雪\npreset: ba_fixture::小雪\navatar: ba_fixture::佳代子/ba_fixture::avatar/default\n@end\n> 小雪: target"
    );

    let first_with_later = "> 小雪: before\n> _0: target";
    assert_eq!(
        avatar(
            first_with_later,
            0,
            avatar_choice("ba_fixture::佳代子", "ba_fixture", "default"),
        ),
        "@actor 小雪\npreset: ba_fixture::小雪\navatar: ba_fixture::佳代子/ba_fixture::avatar/default\n@end\n> 小雪: before\n> _0: target"
    );
}

#[test]
fn avatar_inheritance_stops_at_later_explicit_revision() {
    let source = "> 小雪: before\n> _0: target\n@actor 小雪\navatar: smile\n@end\n> _0: restored";
    assert_eq!(
        avatar(
            source,
            1,
            avatar_choice("ba_fixture::佳代子", "ba_fixture", "default"),
        ),
        "> 小雪: before\n@actor 小雪\navatar: ba_fixture::佳代子/ba_fixture::avatar/default\n@end\n> _0: target\n@actor 小雪\navatar: smile\n@end\n> _0: restored"
    );
}

#[test]
fn avatar_serializes_contribution_identity_explicitly() {
    let source = "> 佳代子: before\n> _0: target";
    assert_eq!(
        avatar(
            source,
            1,
            avatar_choice("ba_fixture::佳代子", "ba_fixture_ext", "festival"),
        ),
        "> 佳代子: before\n@actor 佳代子\navatar: ba_fixture::佳代子/ba_fixture_ext::avatar/festival\n@end\n> _0: target"
    );
}

#[test]
fn avatar_rejects_current_missing_no_pack_and_invalid_target() {
    let packs = registry();
    let source = "> 佳代子: target";
    let analysis = analyze_text_with_pack(source, &packs);
    let target = statement(&analysis, 0).range;
    assert_eq!(
        compose_edit_with_pack(
            source,
            &analysis,
            &packs,
            target,
            ComposerCommand::SetActorAvatarFromStatement(avatar_choice(
                "ba_fixture::佳代子",
                "ba_fixture",
                "default",
            )),
        ),
        Err(ComposerFailure::AvatarUnavailable)
    );
    assert_eq!(
        compose_edit_with_pack(
            source,
            &analysis,
            &packs,
            target,
            ComposerCommand::SetActorAvatarFromStatement(avatar_choice(
                "ba_fixture::佳代子",
                "ba_fixture",
                "missing",
            )),
        ),
        Err(ComposerFailure::AvatarUnavailable)
    );
    assert_eq!(
        compose_edit_with_pack(
            source,
            &analysis,
            &packs,
            target,
            ComposerCommand::SetActorAvatarFromStatement(avatar_choice(
                "ba_fixture::佳代子",
                "ba_fixture",
                "笑颜",
            )),
        ),
        Err(ComposerFailure::AvatarUnavailable)
    );
    assert_eq!(
        compose_edit_with_pack(
            source,
            &analysis,
            &packs,
            TextRange::new(target.start, target.end - 1),
            ComposerCommand::SetActorAvatarFromStatement(avatar_choice(
                "ba_fixture::佳代子",
                "ba_fixture",
                "smile",
            )),
        ),
        Err(ComposerFailure::TargetChanged)
    );

    let catalog = StaticPresetCatalog::new(vec![CharacterPreset {
        id: "fixture".to_string(),
        names: vec!["角色".to_string()],
        display_name: Some("角色".to_string()),
        avatar: None,
    }]);
    let no_pack_source = "> 角色: target";
    let no_pack_analysis = analyze_text(no_pack_source, &catalog);
    assert_eq!(
        compose_edit(
            no_pack_source,
            &no_pack_analysis,
            &catalog,
            statement(&no_pack_analysis, 0).range,
            ComposerCommand::SetActorAvatarFromStatement(avatar_choice(
                "ba_fixture::佳代子",
                "ba_fixture",
                "smile",
            )),
        ),
        Err(ComposerFailure::AvatarUnavailable)
    );

    let empty = empty_registry();
    let builtin = "< _0: target";
    let builtin_analysis = analyze_text_with_pack(builtin, &empty);
    assert_eq!(
        compose_edit_with_pack(
            builtin,
            &builtin_analysis,
            &empty,
            statement(&builtin_analysis, 0).range,
            ComposerCommand::SetActorAvatarFromStatement(avatar_choice(
                "ba_fixture::佳代子",
                "ba_fixture",
                "smile",
            )),
        ),
        Err(ComposerFailure::ActorUnavailable)
    );

    let duplicate =
        "@actor 佳代子\npreset: 佳代子\navatar: default\navatar: smile\n@end\n> 佳代子: target";
    let duplicate_analysis = analyze_text_with_pack(duplicate, &packs);
    assert_eq!(
        compose_edit_with_pack(
            duplicate,
            &duplicate_analysis,
            &packs,
            statement(&duplicate_analysis, 0).range,
            ComposerCommand::SetActorAvatarFromStatement(avatar_choice(
                "ba_fixture::佳代子",
                "ba_fixture",
                "smile",
            )),
        ),
        Err(ComposerFailure::DocumentHasErrors)
    );

    let changed_same_length = "> 佳代子: targeX";
    assert_eq!(
        compose_edit_with_pack(
            changed_same_length,
            &analysis,
            &packs,
            target,
            ComposerCommand::SetActorAvatarFromStatement(avatar_choice(
                "ba_fixture::佳代子",
                "ba_fixture",
                "smile",
            )),
        ),
        Err(ComposerFailure::CandidateInvalid)
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
    let ambiguous =
        PackRegistry::new(vec![PackManifest::from_json(ambiguous_manifest).unwrap()]).unwrap();
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
    let text_edit = compose_edit(
        source,
        &analysis,
        &catalog,
        target,
        ComposerCommand::SetStatementBody {
            value: "新的正文😀".to_string(),
            mode: StatementTextMode::Inherit,
        },
    )
    .unwrap();
    assert_eq!(
        apply(source, &text_edit),
        "> 角色: before\n> _0: 新的正文😀"
    );
}

#[test]
fn narration_is_editable_and_error_preview_targets_remain_classified() {
    let packs = empty_registry();
    let narration = preview_target("- narration", &packs);
    assert_eq!(
        narration
            .statement_text
            .as_ref()
            .map(|text| text.current.as_str()),
        Some("narration")
    );
    assert_eq!(narration.continued, None);

    let broken = "not syntax";
    let broken_analysis = analyze_text_with_pack(broken, &packs);
    let empty_emitted = EmittedTypst {
        source: String::new(),
        origins: Vec::new(),
        source_map: Vec::new(),
        diagnostics: Vec::new(),
    };
    assert_eq!(
        resolve_preview_statement(&broken_analysis, &empty_emitted, TextRange::new(0, 0)),
        Err(ComposerTargetFailure::DocumentHasErrors)
    );
}

fn text_selection(
    source: &str,
    packs: &PackRegistry,
    anchor: (usize, usize),
    focus: (usize, usize),
) -> (
    mmt_rs::AnalyzedDocument,
    mmt_rs::ComposerDocumentProjection,
    mmt_rs::ComposerTextSelection,
) {
    let analysis = analyze_text_with_pack(source, packs);
    let projection = mmt_rs::project_analyzed_composer_document(source, &analysis).unwrap();
    let nodes = projection
        .nodes
        .iter()
        .filter(|node| node.kind() != mmt_rs::ComposerDocumentNodeKind::Opaque)
        .collect::<Vec<_>>();
    let selection = mmt_rs::ComposerTextSelection {
        anchor: mmt_rs::ComposerTextEndpoint {
            node: nodes[anchor.0].node_ref(),
            offset_utf16: anchor.1,
        },
        focus: mmt_rs::ComposerTextEndpoint {
            node: nodes[focus.0].node_ref(),
            offset_utf16: focus.1,
        },
    };
    (analysis, projection, selection)
}

fn apply_text_edits(source: &str, edit: &mmt_rs::ComposerTextEdit) -> String {
    let mut result = source.to_owned();
    for edit in edit.edits.iter().rev() {
        result.replace_range(edit.range.start..edit.range.end, &edit.new_text);
    }
    assert_eq!(
        mmt_rs::composer_document_source_digest(&result),
        edit.source_digest_after
    );
    result
}

fn replace_text(
    source: &str,
    packs: &PackRegistry,
    anchor: (usize, usize),
    focus: (usize, usize),
    replacement: &str,
) -> (String, mmt_rs::ComposerTextEdit) {
    let (analysis, projection, selection) = text_selection(source, packs, anchor, focus);
    let edit = mmt_rs::compose_text_edit_with_pack(
        source,
        &analysis,
        packs,
        &projection.source_digest,
        &selection,
        replacement,
    )
    .unwrap();
    (apply_text_edits(source, &edit), edit)
}

#[test]
fn character_edits_use_utf16_graphemes_and_candidate_statement_identity() {
    let packs = empty_registry();
    let source = "- A😀e\u{301}中\n- 第二条\n";
    let (inserted, edit) = replace_text(source, &packs, (0, 3), (0, 3), "X");
    assert_eq!(inserted, "- A😀Xe\u{301}中\n- 第二条\n");
    assert_eq!(edit.selection_after.0.offset_utf16, 4);
    assert_eq!(edit.selection_after.0, edit.selection_after.1);
    let after = analyze_text_with_pack(&inserted, &packs);
    assert_eq!(
        edit.selection_after.0.statement_range,
        statement(&after, 0).range
    );
    let (restored, _) = replace_text(&inserted, &packs, (0, 4), (0, 3), "");
    assert_eq!(restored, source);
    let (deleted, _) = replace_text(&restored, &packs, (0, 3), (0, 1), "");
    assert_eq!(deleted, "- Ae\u{301}中\n- 第二条\n");
    let (started, _) = replace_text(&deleted, &packs, (0, 0), (0, 0), "start");
    let (ended, _) = replace_text(&started, &packs, (0, 9), (0, 9), "end");
    assert_eq!(ended, "- startAe\u{301}中end\n- 第二条\n");

    for offset in [2, 4, 7] {
        let (analysis, projection, selection) =
            text_selection(source, &packs, (0, offset), (0, offset));
        assert_eq!(
            mmt_rs::compose_text_edit_with_pack(
                source,
                &analysis,
                &packs,
                &projection.source_digest,
                &selection,
                "X"
            ),
            Err(mmt_rs::ComposerTextFailure::InvalidValue),
        );
    }
}

#[test]
fn text_serialization_keeps_empty_multiline_quotes_and_final_eol_exact() {
    let packs = empty_registry();
    let (multiline, _) = replace_text("- first", &packs, (0, 5), (0, 5), "\r\n> @不是语法 \"\"\"");
    let analysis = analyze_text_with_pack(&multiline, &packs);
    assert_eq!(
        statement(&analysis, 0).body.source,
        "first\n> @不是语法 \"\"\""
    );
    assert_eq!(analysis.document.nodes.len(), 1);
    assert_eq!(multiline, "- \"\"\"\"\nfirst\n> @不是语法 \"\"\"\"\"\"\"");
    assert!(!multiline.ends_with('\n'));
    let length = statement(&analysis, 0).body.source.encode_utf16().count();
    let (empty, edit) = replace_text(&multiline, &packs, (0, 0), (0, length), "");
    assert_eq!(empty, "- \"\"\"\n\"\"\"");
    assert_eq!(edit.selection_after.0.offset_utf16, 0);
    let (again, _) = replace_text(&empty, &packs, (0, 0), (0, 0), "restored");
    assert_eq!(
        statement(&analyze_text_with_pack(&again, &packs), 0)
            .body
            .source,
        "restored"
    );

    let source = "- rt\"\"\"\r\n\r\nstart\r\n\"\"\"\r\n- untouched";
    let (edited, _) = replace_text(source, &packs, (0, 1), (0, 6), "中\r\nnew\rline");
    assert_eq!(
        edited,
        "- rt\"\"\"\r\n\r\n中\r\nnew\r\nline\r\n\"\"\"\r\n- untouched"
    );
    let projection = mmt_rs::project_composer_document_with_pack(&edited, &packs).unwrap();
    assert_eq!(
        projection.nodes[0].text_editing().unwrap().text,
        "\n中\nnew\nline\n"
    );
}

#[test]
fn text_serializer_fences_terminal_lf_and_preserves_empty_body_separators() {
    let packs = empty_registry();
    let source = "- first\r\n\r\n- next";
    let (trailing_lf, _) = replace_text(source, &packs, (0, 5), (0, 5), "\n");
    assert_eq!(trailing_lf, "- \"\"\"\r\nfirst\r\n\"\"\"\r\n\r\n- next");
    let analysis = analyze_text_with_pack(&trailing_lf, &packs);
    assert_eq!(statement(&analysis, 0).body.source, "first\r\n");
    let projection = mmt_rs::project_analyzed_composer_document(&trailing_lf, &analysis).unwrap();
    let mmt_rs::ComposerDocumentNode::Narration(first) = &projection.nodes[0] else {
        panic!("first node must remain narration");
    };
    assert_eq!(first.description.body.current, "first\r\n");
    assert!(first.description.statement_text.is_none());
    assert!(!first.capabilities.set_body);
    assert_eq!(first.text_editing.as_ref().unwrap().text, "first\n");
    let mmt_rs::ComposerDocumentNode::Opaque(separator) = &projection.nodes[1] else {
        panic!("separator must remain opaque");
    };
    assert_eq!(separator.category, mmt_rs::ComposerOpaqueCategory::Blank);
    assert_eq!(
        &trailing_lf[separator.range.start..separator.range.end],
        "\r\n"
    );

    let empty_source = "- \n\n- next";
    let (filled, _) = replace_text(empty_source, &packs, (0, 0), (0, 0), "filled");
    assert_eq!(filled, "- filled\n\n- next");
}

#[test]
fn text_selection_read_is_directional_and_rejects_stale_or_nonbody_endpoints() {
    let packs = empty_registry();
    let source = "- abc\n- def\n";
    let (analysis, projection, selection) = text_selection(source, &packs, (1, 2), (0, 1));
    let read = mmt_rs::read_composer_text_selection(
        source,
        &analysis,
        &projection.source_digest,
        &selection,
    )
    .unwrap();
    assert_eq!(read.selection, selection);
    assert_eq!(read.text, "bc\nde");
    let authored = mmt_rs::resolve_composer_text_selection(
        source,
        &analysis,
        &projection.source_digest,
        TextRange::empty(statement(&analysis, 1).body.range.start + 2),
        TextRange::empty(statement(&analysis, 0).body.range.start + 1),
    )
    .unwrap();
    assert_eq!(authored, read);
    assert_eq!(
        mmt_rs::read_composer_text_selection(source, &analysis, "stale", &selection),
        Err(mmt_rs::ComposerTextFailure::StaleDocument),
    );
    let mut stale = selection.clone();
    stale.anchor.node.node_key = "old".to_owned();
    assert_eq!(
        mmt_rs::read_composer_text_selection(source, &analysis, &projection.source_digest, &stale),
        Err(mmt_rs::ComposerTextFailure::TargetChanged),
    );
    assert_eq!(
        mmt_rs::resolve_composer_text_selection(
            source,
            &analysis,
            &projection.source_digest,
            TextRange::empty(0),
            TextRange::empty(0)
        ),
        Err(mmt_rs::ComposerTextFailure::UnsupportedStructure),
    );
}

#[test]
fn text_edit_rejects_mixed_eol_but_reads_normalized_copy_without_loss() {
    let packs = empty_registry();
    let source = "- \"\"\"\na\r\nb\nc\"\"\"\n";
    let (analysis, projection, selection) = text_selection(source, &packs, (0, 0), (0, 5));
    assert_eq!(
        mmt_rs::read_composer_text_selection(
            source,
            &analysis,
            &projection.source_digest,
            &selection
        )
        .unwrap()
        .text,
        "a\nb\nc",
    );
    assert_eq!(
        mmt_rs::compose_text_edit_with_pack(
            source,
            &analysis,
            &packs,
            &projection.source_digest,
            &selection,
            "new"
        ),
        Err(mmt_rs::ComposerTextFailure::UnsupportedStructure),
    );
    let ordinary = "- abc";
    let (analysis, projection, selection) = text_selection(ordinary, &packs, (0, 1), (0, 1));
    assert_eq!(
        mmt_rs::compose_text_edit_with_pack(
            ordinary,
            &analysis,
            &packs,
            &projection.source_digest,
            &selection,
            &"x".repeat(COMPOSER_STATEMENT_TEXT_MAX_BYTES)
        ),
        Err(mmt_rs::ComposerTextFailure::InvalidValue),
    );
    assert_eq!(
        mmt_rs::compose_text_edit_with_pack(
            ordinary,
            &analysis,
            &packs,
            &projection.source_digest,
            &selection,
            "[:broken"
        ),
        Err(mmt_rs::ComposerTextFailure::CandidateInvalid),
    );
}

#[test]
fn text_projection_maps_utf8_escapes_crlf_and_empty_bodies_without_wrappers() {
    let packs = empty_registry();
    let source = "- rt\"\"\"\r\nA😀e\u{301}中\\\"\r\nnext\"\"\"\r\n- same\r\n- same\r\n";
    let (analysis, _, selection) = text_selection(source, &packs, (0, 1), (0, 9));
    let emitted = emit_typst(
        &analysis.document,
        &analysis.document_config.config,
        &analysis.modes,
        &analysis.actors,
        &MaterializedContent::default(),
        &EmitOptions::default(),
    );
    let projected =
        mmt_rs::project_composer_text_selection(source, &analysis, &emitted, &selection).unwrap();
    let generated = projected
        .segments
        .iter()
        .map(|range| &emitted.source[range.start..range.end])
        .collect::<String>();
    assert_eq!(generated, "😀e\u{301}中\\\\\\\"");
    let newline = projected
        .segments
        .iter()
        .find(|range| range.is_empty())
        .unwrap();
    let authored =
        mmt_rs::resolve_composer_text_source_range(source, &analysis, &emitted, *newline).unwrap();
    let resolved = mmt_rs::resolve_composer_text_selection(
        source,
        &analysis,
        &mmt_rs::composer_document_source_digest(source),
        authored,
        authored,
    )
    .unwrap();
    assert_eq!(resolved.selection.anchor.offset_utf16, 8);
    for endpoint in [selection.anchor, selection.focus] {
        let collapsed = mmt_rs::ComposerTextSelection {
            anchor: endpoint.clone(),
            focus: endpoint.clone(),
        };
        let projected =
            mmt_rs::project_composer_text_selection(source, &analysis, &emitted, &collapsed)
                .unwrap();
        let authored = mmt_rs::resolve_composer_text_source_range(
            source,
            &analysis,
            &emitted,
            projected.anchor,
        )
        .unwrap();
        let resolved = mmt_rs::resolve_composer_text_selection(
            source,
            &analysis,
            &mmt_rs::composer_document_source_digest(source),
            authored,
            authored,
        )
        .unwrap();
        assert_eq!(resolved.selection.anchor, endpoint);
    }
    let escaped = projected
        .segments
        .iter()
        .find(|range| &emitted.source[range.start..range.end] == "\\\\")
        .unwrap();
    assert_eq!(
        emitted.map_text_caret_to_authored(source, escaped.start + 1),
        None
    );
    let (_, _, second) = text_selection(source, &packs, (1, 0), (1, 4));
    let (_, _, third) = text_selection(source, &packs, (2, 0), (2, 4));
    let second =
        mmt_rs::project_composer_text_selection(source, &analysis, &emitted, &second).unwrap();
    let third =
        mmt_rs::project_composer_text_selection(source, &analysis, &emitted, &third).unwrap();
    assert_ne!(second.anchor, third.anchor);

    let source = "- \"\"\"\n\"\"\"";
    let (analysis, _, selection) = text_selection(source, &packs, (0, 0), (0, 0));
    let emitted = emit_typst(
        &analysis.document,
        &analysis.document_config.config,
        &analysis.modes,
        &analysis.actors,
        &MaterializedContent::default(),
        &EmitOptions::default(),
    );
    let projected =
        mmt_rs::project_composer_text_selection(source, &analysis, &emitted, &selection).unwrap();
    assert_eq!(projected.anchor, projected.focus);
    assert!(projected.segments.is_empty());
    assert_eq!(
        mmt_rs::resolve_composer_text_source_range(source, &analysis, &emitted, projected.anchor)
            .unwrap(),
        statement(&analysis, 0).body.range,
    );
}

#[test]
fn text_projection_retains_exact_empty_line_carets_and_selection_anchors() {
    let packs = empty_registry();
    let source = "- rt\"\"\"\r\n\r\nfirst\r\n\r\nlast\r\n\"\"\"";
    let (analysis, projection, _) = text_selection(source, &packs, (0, 0), (0, 0));
    let emitted = emit_typst(
        &analysis.document,
        &analysis.document_config.config,
        &analysis.modes,
        &analysis.actors,
        &MaterializedContent::default(),
        &EmitOptions::default(),
    );
    for offset in [0, 1, 6, 7, 8, 12, 13] {
        let (_, _, selection) = text_selection(source, &packs, (0, offset), (0, offset));
        let projected =
            mmt_rs::project_composer_text_selection(source, &analysis, &emitted, &selection)
                .unwrap();
        let authored = mmt_rs::resolve_composer_text_source_range(
            source,
            &analysis,
            &emitted,
            projected.anchor,
        )
        .unwrap();
        let resolved = mmt_rs::resolve_composer_text_selection(
            source,
            &analysis,
            &projection.source_digest,
            authored,
            authored,
        )
        .unwrap();
        assert_eq!(resolved.selection, selection);
    }
    let (_, _, selection) = text_selection(source, &packs, (0, 7), (0, 8));
    let projected =
        mmt_rs::project_composer_text_selection(source, &analysis, &emitted, &selection).unwrap();
    let anchor = projected
        .segments
        .iter()
        .find(|range| range.is_empty())
        .unwrap();
    let authored =
        mmt_rs::resolve_composer_text_source_range(source, &analysis, &emitted, *anchor).unwrap();
    let resolved = mmt_rs::resolve_composer_text_selection(
        source,
        &analysis,
        &projection.source_digest,
        authored,
        authored,
    )
    .unwrap();
    assert_eq!(resolved.selection.anchor.offset_utf16, 7);
}
