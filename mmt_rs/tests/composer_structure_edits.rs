use mmt_rs::{
    CharacterPreset, ComposerDocumentNode, ComposerMessageSide, ComposerNewStatement,
    ComposerSpeakerChoice, ComposerStatementBodyInput, ComposerStructureCommand,
    ComposerStructureFailure, ComposerStructureTarget, ContinuedValue, StatementTextMode,
    StaticPresetCatalog, analyze_text, compose_structure_edit, project_analyzed_composer_document,
};

fn catalog() -> StaticPresetCatalog {
    StaticPresetCatalog::new(vec![
        CharacterPreset {
            id: "fixture::A".to_string(),
            names: vec!["A".to_string()],
            display_name: Some("Actor A".to_string()),
            avatar: None,
        },
        CharacterPreset {
            id: "fixture::B".to_string(),
            names: vec!["B".to_string()],
            display_name: Some("Actor B".to_string()),
            avatar: None,
        },
    ])
}

fn project(source: &str) -> (mmt_rs::AnalyzedDocument, mmt_rs::ComposerDocumentProjection) {
    let analysis = analyze_text(source, &catalog());
    let projection = project_analyzed_composer_document(source, &analysis).unwrap();
    (analysis, projection)
}

fn apply(source: &str, edit: &mmt_rs::ComposerSourceEdit) -> String {
    format!(
        "{}{}{}",
        &source[..edit.range.start],
        edit.new_text,
        &source[edit.range.end..]
    )
}

fn structure(
    source: &str,
    target: ComposerStructureTarget,
    command: ComposerStructureCommand,
) -> Result<String, ComposerStructureFailure> {
    let (analysis, projection) = project(source);
    let edit = compose_structure_edit(
        source,
        &analysis,
        &catalog(),
        &projection.source_digest,
        target,
        command,
    )?;
    Ok(apply(source, &edit))
}

fn message(body: &str, mode: StatementTextMode) -> ComposerNewStatement {
    ComposerNewStatement::Message {
        side: ComposerMessageSide::Left,
        speaker: ComposerSpeakerChoice::Actor {
            reference: "A".to_string(),
        },
        body: ComposerStatementBodyInput {
            value: body.to_string(),
            mode,
        },
        continued: ContinuedValue::Auto,
    }
}

#[test]
fn insert_supports_empty_start_interior_end_and_all_body_modes() {
    let (_, empty) = project("");
    assert_eq!(
        structure(
            "",
            ComposerStructureTarget::Boundary(empty.boundaries[0].target.clone()),
            ComposerStructureCommand::InsertStatement {
                statement: message("hello", StatementTextMode::Inherit),
            },
        )
        .unwrap(),
        "> A: hello\n"
    );

    for mode in [
        StatementTextMode::Inherit,
        StatementTextMode::TextMacro,
        StatementTextMode::TextRaw,
        StatementTextMode::TypstMacro,
        StatementTextMode::TypstRaw,
    ] {
        let source = "- before\n- after\n";
        let (_, projection) = project(source);
        let inserted = structure(
            source,
            ComposerStructureTarget::Boundary(projection.boundaries[1].target.clone()),
            ComposerStructureCommand::InsertStatement {
                statement: message("quoted \"\"\" body 😀", mode),
            },
        )
        .unwrap();
        let (_, after) = project(&inserted);
        let ComposerDocumentNode::Message(node) = &after.nodes[1] else {
            panic!("inserted node must be a Message");
        };
        assert_eq!(node.description.body.current, "quoted \"\"\" body 😀");
        assert_eq!(node.description.body.mode, mode);
        assert_eq!(&inserted[.."- before\n".len()], "- before\n");
        assert!(inserted.ends_with("- after\n"));
    }

    let source = "- existing\r\n";
    let (_, projection) = project(source);
    let inserted = structure(
        source,
        ComposerStructureTarget::Boundary(projection.boundaries[1].target.clone()),
        ComposerStructureCommand::InsertStatement {
            statement: ComposerNewStatement::Narration {
                body: ComposerStatementBodyInput {
                    value: "new".to_string(),
                    mode: StatementTextMode::Inherit,
                },
            },
        },
    )
    .unwrap();
    assert_eq!(inserted, "- existing\r\n- new\r\n");
}

#[test]
fn insert_resolves_canonical_pack_and_declared_script_actor_references() {
    let source = "@actor Script\npreset: A\n@end\n";
    let (_, projection) = project(source);
    for reference in ["fixture::A", "Script"] {
        let inserted = structure(
            source,
            ComposerStructureTarget::Boundary(projection.boundaries.last().unwrap().target.clone()),
            ComposerStructureCommand::InsertStatement {
                statement: ComposerNewStatement::Message {
                    side: ComposerMessageSide::Right,
                    speaker: ComposerSpeakerChoice::Actor {
                        reference: reference.to_string(),
                    },
                    body: ComposerStatementBodyInput {
                        value: "hello".to_string(),
                        mode: StatementTextMode::Inherit,
                    },
                    continued: ContinuedValue::False,
                },
            },
        )
        .unwrap();
        assert!(
            inserted.ends_with("<(continued: false) fixture::A: hello\n")
                || inserted.ends_with("<(continued: false) Script: hello\n")
        );
        let (_, after) = project(&inserted);
        let ComposerDocumentNode::Message(message) = after.nodes.last().unwrap() else {
            panic!("inserted actor statement must be a Message");
        };
        assert_eq!(message.description.continued, Some(ContinuedValue::False));
    }
}

#[test]
fn delete_removes_only_owned_statement_bytes() {
    let source = "\n- first\n@mode: text\n- second\n";
    let (_, projection) = project(source);
    let target = projection.nodes[1].node_ref();
    let deleted = structure(
        source,
        ComposerStructureTarget::Node(target),
        ComposerStructureCommand::DeleteNode,
    )
    .unwrap();
    assert_eq!(deleted, "\n@mode: text\n- second\n");

    let opaque = projection.nodes[0].node_ref();
    assert_eq!(
        structure(
            source,
            ComposerStructureTarget::Node(opaque),
            ComposerStructureCommand::DeleteNode,
        ),
        Err(ComposerStructureFailure::UnsupportedStructure)
    );
}

#[test]
fn move_reconciles_lf_crlf_and_final_eol_exactly() {
    for (source, expected) in [
        ("- A\n- B", "- B\n- A"),
        ("- A\r\n- B", "- B\r\n- A"),
        ("- A\n- B\n", "- B\n- A\n"),
    ] {
        let (_, projection) = project(source);
        let target = projection.nodes[0].node_ref();
        let anchor = match &projection.nodes[0] {
            ComposerDocumentNode::Narration(node) => node.capabilities.move_down.clone().unwrap(),
            _ => unreachable!(),
        };
        let moved = structure(
            source,
            ComposerStructureTarget::Node(target),
            ComposerStructureCommand::MoveNode { anchor },
        )
        .unwrap();
        assert_eq!(moved, expected);

        let (_, reverse_projection) = project(source);
        let reverse_target = reverse_projection.nodes[1].node_ref();
        let reverse_anchor = match &reverse_projection.nodes[1] {
            ComposerDocumentNode::Narration(node) => node.capabilities.move_up.clone().unwrap(),
            _ => unreachable!(),
        };
        assert_eq!(
            structure(
                source,
                ComposerStructureTarget::Node(reverse_target),
                ComposerStructureCommand::MoveNode {
                    anchor: reverse_anchor,
                },
            )
            .unwrap(),
            expected
        );
    }
}

#[test]
fn move_handles_duplicate_and_unicode_statement_payloads() {
    for source in ["- same\n- same", "- 😀\n- 𠮷"] {
        let (_, projection) = project(source);
        let target = projection.nodes[0].node_ref();
        let anchor = match &projection.nodes[0] {
            ComposerDocumentNode::Narration(node) => node.capabilities.move_down.clone().unwrap(),
            _ => unreachable!(),
        };
        let moved = structure(
            source,
            ComposerStructureTarget::Node(target),
            ComposerStructureCommand::MoveNode { anchor },
        )
        .unwrap();
        let expected = if source.contains("😀") {
            "- 𠮷\n- 😀"
        } else {
            source
        };
        assert_eq!(moved, expected);
    }
}

#[test]
fn move_fails_closed_for_opaque_barriers_mixed_eol_and_stale_anchor() {
    for source in ["- A\n@mode: text\n- B\n", "- A\n- B\r\n- C\n"] {
        let (_, projection) = project(source);
        for node in projection.nodes {
            if let ComposerDocumentNode::Narration(node) = node {
                assert!(node.capabilities.move_up.is_none());
                assert!(node.capabilities.move_down.is_none());
            }
        }
    }

    let source = "- A\n- B";
    let (_, projection) = project(source);
    let target = projection.nodes[0].node_ref();
    assert_eq!(
        structure(
            source,
            ComposerStructureTarget::Node(target),
            ComposerStructureCommand::MoveNode {
                anchor: projection.boundaries[0].target.clone(),
            },
        ),
        Err(ComposerStructureFailure::UnsupportedStructure)
    );
}

#[test]
fn set_speaker_is_minimal_and_rejects_builtin_unknown_and_inheritance_drift() {
    let source = "> A: hello";
    let (_, projection) = project(source);
    let target = projection.nodes[0].node_ref();
    assert_eq!(
        structure(
            source,
            ComposerStructureTarget::Node(target),
            ComposerStructureCommand::SetStatementSpeaker {
                speaker: ComposerSpeakerChoice::Actor {
                    reference: "B".to_string(),
                },
            },
        )
        .unwrap(),
        "> B: hello"
    );

    assert_eq!(
        structure(
            source,
            ComposerStructureTarget::Node(projection.nodes[0].node_ref()),
            ComposerStructureCommand::SetStatementSpeaker {
                speaker: ComposerSpeakerChoice::Actor {
                    reference: "missing".to_string(),
                },
            },
        ),
        Err(ComposerStructureFailure::SpeakerUnavailable)
    );

    let builtin = "< _0: builtin";
    let (_, builtin_projection) = project(builtin);
    assert_eq!(
        structure(
            builtin,
            ComposerStructureTarget::Node(builtin_projection.nodes[0].node_ref()),
            ComposerStructureCommand::SetStatementSpeaker {
                speaker: ComposerSpeakerChoice::Actor {
                    reference: "A".to_string(),
                },
            },
        ),
        Err(ComposerStructureFailure::UnsupportedStructure)
    );

    let inherited = "> A: first\n> _0: downstream";
    let (_, inherited_projection) = project(inherited);
    assert_eq!(
        structure(
            inherited,
            ComposerStructureTarget::Node(inherited_projection.nodes[0].node_ref()),
            ComposerStructureCommand::SetStatementSpeaker {
                speaker: ComposerSpeakerChoice::Actor {
                    reference: "B".to_string(),
                },
            },
        ),
        Err(ComposerStructureFailure::CandidateInvalid)
    );
}

#[test]
fn stale_digest_node_identity_invalid_values_and_error_documents_are_rejected() {
    let source = "- narration\n";
    let (analysis, projection) = project(source);
    assert_eq!(
        compose_structure_edit(
            source,
            &analysis,
            &catalog(),
            &"0".repeat(64),
            ComposerStructureTarget::Boundary(projection.boundaries[0].target.clone()),
            ComposerStructureCommand::InsertStatement {
                statement: message("hello", StatementTextMode::Inherit),
            },
        ),
        Err(ComposerStructureFailure::StaleDocument)
    );

    let mut changed = projection.nodes[0].node_ref();
    changed.node_key = "f".repeat(64);
    assert_eq!(
        structure(
            source,
            ComposerStructureTarget::Node(changed),
            ComposerStructureCommand::DeleteNode,
        ),
        Err(ComposerStructureFailure::TargetChanged)
    );

    assert_eq!(
        structure(
            source,
            ComposerStructureTarget::Boundary(projection.boundaries[0].target.clone()),
            ComposerStructureCommand::InsertStatement {
                statement: message("", StatementTextMode::Inherit),
            },
        ),
        Err(ComposerStructureFailure::InvalidValue)
    );

    let broken = "// error-looking\n- narration\n";

    let mut wrong_range = projection.nodes[0].node_ref();
    wrong_range.range.end -= 1;
    assert_eq!(
        structure(
            source,
            ComposerStructureTarget::Node(wrong_range),
            ComposerStructureCommand::DeleteNode,
        ),
        Err(ComposerStructureFailure::TargetChanged)
    );

    let mut wrong_kind = projection.nodes[0].node_ref();
    wrong_kind.node_kind = mmt_rs::ComposerDocumentNodeKind::Message;
    assert_eq!(
        structure(
            source,
            ComposerStructureTarget::Node(wrong_kind),
            ComposerStructureCommand::DeleteNode,
        ),
        Err(ComposerStructureFailure::TargetChanged)
    );
    let (broken_analysis, broken_projection) = project(broken);
    assert_eq!(
        compose_structure_edit(
            broken,
            &broken_analysis,
            &catalog(),
            &broken_projection.source_digest,
            ComposerStructureTarget::Node(broken_projection.nodes[1].node_ref()),
            ComposerStructureCommand::DeleteNode,
        ),
        Err(ComposerStructureFailure::DocumentHasErrors)
    );
}
