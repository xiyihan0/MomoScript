use mmt_rs::{
    CharacterPreset, ComposerDocumentNode, ComposerMessageSide, ComposerNewStatement,
    ComposerNewStatementSpeaker, ComposerSpeakerChoice, ComposerStatementBodyInput,
    ComposerStructureCommand, ComposerStructureFailure, ComposerStructureTarget, ContinuedValue,
    StatementTextMode, StaticPresetCatalog, analyze_text, compose_structure_edit,
    project_analyzed_composer_document,
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
        speaker: ComposerNewStatementSpeaker::Actor {
            reference: "A".to_string(),
        },
        avatar: None,
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
                    speaker: ComposerNewStatementSpeaker::Actor {
                        reference: reference.to_string(),
                    },
                    avatar: None,
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

    let separated = "- first\n \t\n- second\n";
    let (_, separated_projection) = project(separated);
    let deleted = structure(
        separated,
        ComposerStructureTarget::Node(separated_projection.nodes[0].node_ref()),
        ComposerStructureCommand::DeleteNode,
    )
    .unwrap();
    assert_eq!(deleted, " \t\n- second\n");

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
    for source in [
        "- A\n@mode: text\n- B\n",
        "- A\n\n- B\n",
        "- A\n- B\r\n- C\n",
    ] {
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
                statement: message(&"x".repeat(64 * 1024 + 1), StatementTextMode::Inherit),
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

fn cross_text(
    source: &str,
    anchor: (usize, usize),
    focus: (usize, usize),
    replacement: &str,
) -> Result<String, mmt_rs::ComposerTextFailure> {
    let (analysis, projection) = project(source);
    let selection = mmt_rs::ComposerTextSelection {
        anchor: mmt_rs::ComposerTextEndpoint {
            node: projection.nodes[anchor.0].node_ref(),
            offset_utf16: anchor.1,
        },
        focus: mmt_rs::ComposerTextEndpoint {
            node: projection.nodes[focus.0].node_ref(),
            offset_utf16: focus.1,
        },
    };
    let edit = mmt_rs::compose_text_edit(
        source,
        &analysis,
        &catalog(),
        &projection.source_digest,
        &selection,
        replacement,
    )?;
    let mut result = source.to_owned();
    for edit in edit.edits.iter().rev() {
        result.replace_range(edit.range.start..edit.range.end, &edit.new_text);
    }
    assert_eq!(
        mmt_rs::composer_document_source_digest(&result),
        edit.source_digest_after
    );
    Ok(result)
}

#[test]
fn cross_body_replace_merges_source_order_and_retains_blank_bytes_and_final_eol() {
    for (source, anchor, focus, expected) in [
        ("- abc\n- def\n", (0, 1), (1, 2), "- aXf\n"),
        ("- abc\n- def\n", (1, 2), (0, 1), "- aXf\n"),
        ("- abc\n- def", (0, 1), (1, 2), "- aXf"),
        (
            "- abc\r\n \t\r\n\r\n- def\r\n- tail",
            (0, 1),
            (3, 2),
            "- aXf\r\n \t\r\n\r\n- tail",
        ),
    ] {
        assert_eq!(
            cross_text(source, anchor, focus, "X").unwrap().as_bytes(),
            expected.as_bytes()
        );
    }
}

#[test]
fn cross_body_replace_preserves_first_speaker_patch_kind_and_later_semantics() {
    let source = ">(fill: green, continued: true) A: abc\n< B: def\n> A: tail\n";
    let result = cross_text(source, (1, 2), (0, 1), "X").unwrap();
    assert_eq!(
        result,
        ">(fill: green, continued: true) A: aXf\n> A: tail\n"
    );
    let (_, before) = project(source);
    let (_, after) = project(&result);
    let (ComposerDocumentNode::Message(first_before), ComposerDocumentNode::Message(first_after)) =
        (&before.nodes[0], &after.nodes[0])
    else {
        panic!("expected message");
    };
    assert_eq!(first_before.side, first_after.side);
    assert_eq!(
        first_before.description.speaker,
        first_after.description.speaker
    );
    assert_eq!(
        first_before.description.continued,
        first_after.description.continued
    );
    let (ComposerDocumentNode::Message(last_before), ComposerDocumentNode::Message(last_after)) =
        (&before.nodes[2], &after.nodes[1])
    else {
        panic!("expected message");
    };
    assert_eq!(last_before.description, last_after.description);
}

#[test]
fn cross_body_replace_rejects_inherited_speaker_drift_and_opaque_barriers() {
    let drift = "> A: abc\n> B: def\n> _0: tail\n";
    assert_eq!(
        cross_text(drift, (0, 1), (1, 2), "X"),
        Err(mmt_rs::ComposerTextFailure::CandidateInvalid)
    );
    for (source, last) in [
        ("- abc\n@mode: t\n- def\n", 2),
        ("- abc\n- rt\"\"\"def\"\"\"\n", 1),
        ("- abc\n- T\"\"\"#strong[def]\"\"\"\n", 1),
    ] {
        assert_eq!(
            cross_text(source, (0, 1), (last, 2), "X"),
            Err(mmt_rs::ComposerTextFailure::UnsupportedStructure)
        );
    }
    assert_eq!(
        cross_text("not syntax\n- abc\n- def\n", (1, 1), (2, 2), "X"),
        Err(mmt_rs::ComposerTextFailure::DocumentHasErrors),
    );
}

#[test]
fn cross_body_copy_and_delete_skip_blank_source_but_keep_its_bytes() {
    let source = "- abc\n \t\n- def\n";
    let (analysis, projection) = project(source);
    let selection = mmt_rs::ComposerTextSelection {
        anchor: mmt_rs::ComposerTextEndpoint {
            node: projection.nodes[2].node_ref(),
            offset_utf16: 2,
        },
        focus: mmt_rs::ComposerTextEndpoint {
            node: projection.nodes[0].node_ref(),
            offset_utf16: 1,
        },
    };
    let read = mmt_rs::read_composer_text_selection(
        source,
        &analysis,
        &projection.source_digest,
        &selection,
    )
    .unwrap();
    assert_eq!(read.text, "bc\nde");
    assert_eq!(read.selection, selection);
    assert_eq!(
        cross_text(source, (2, 2), (0, 1), "").unwrap(),
        "- af\n \t\n"
    );
}

#[test]
fn insert_multiline_and_empty_bodies_preserves_neighbors_and_eol() {
    for eol in ["\n", "\r\n"] {
        let source = format!("- before{eol}{eol}@reply: A | B{eol}- after{eol}");
        let (_, projection) = project(&source);
        for value in [
            "",
            "first\nsecond",
            "\n> A: literal\n@mode: T\n\"\"\" C:\\path\"",
        ] {
            let inserted = structure(
                &source,
                ComposerStructureTarget::Boundary(projection.boundaries[1].target.clone()),
                ComposerStructureCommand::InsertStatement {
                    statement: message(value, StatementTextMode::TextRaw),
                },
            )
            .unwrap();
            let (_, after) = project(&inserted);
            let ComposerDocumentNode::Message(node) = &after.nodes[1] else {
                panic!("inserted body must remain one statement");
            };
            assert_eq!(node.description.body.current, value.replace('\n', eol));
            assert!(inserted.starts_with(&format!("- before{eol}")));
            assert!(inserted.ends_with(&format!("{eol}@reply: A | B{eol}- after{eol}")));
            assert_eq!(after.nodes.len(), projection.nodes.len() + 1);
        }
    }
}

#[test]
fn insert_builtin_is_explicit_right_only_and_boundary_authorized() {
    let builtin = |side| ComposerNewStatement::Message {
        side,
        speaker: ComposerNewStatementSpeaker::Builtin,
        avatar: None,
        body: ComposerStatementBodyInput {
            value: "Teacher\nreply".to_owned(),
            mode: StatementTextMode::Inherit,
        },
        continued: ContinuedValue::Auto,
    };
    for source in ["", "> A: actor\n", "< _0: teacher\n"] {
        let (_, projection) = project(source);
        let boundary = projection.boundaries.last().unwrap();
        assert_eq!(
            boundary.insert.as_ref().unwrap().builtin_message_sides,
            vec![ComposerMessageSide::Right]
        );
        let inserted = structure(
            source,
            ComposerStructureTarget::Boundary(boundary.target.clone()),
            ComposerStructureCommand::InsertStatement {
                statement: builtin(ComposerMessageSide::Right),
            },
        )
        .unwrap();
        let (_, after) = project(&inserted);
        let ComposerDocumentNode::Message(node) = after.nodes.last().unwrap() else {
            panic!("Teacher must be a message");
        };
        assert!(matches!(
            &node.description.speaker,
            Some(mmt_rs::ComposerSpeakerDescription::Builtin { id }) if id == "__Sensei"
        ));
        assert!(!node.capabilities.set_speaker);
        assert_eq!(
            structure(
                source,
                ComposerStructureTarget::Boundary(boundary.target.clone()),
                ComposerStructureCommand::InsertStatement {
                    statement: builtin(ComposerMessageSide::Left),
                },
            ),
            Err(ComposerStructureFailure::UnsupportedStructure)
        );
    }
    let source = "< A: named right actor\n";
    let (_, projection) = project(source);
    assert_eq!(
        projection.boundaries[0]
            .insert
            .as_ref()
            .unwrap()
            .builtin_message_sides,
        vec![ComposerMessageSide::Right]
    );
    assert!(
        projection.boundaries[1]
            .insert
            .as_ref()
            .unwrap()
            .builtin_message_sides
            .is_empty()
    );
    assert_eq!(
        structure(
            source,
            ComposerStructureTarget::Boundary(projection.boundaries[1].target.clone()),
            ComposerStructureCommand::InsertStatement {
                statement: builtin(ComposerMessageSide::Right),
            },
        ),
        Err(ComposerStructureFailure::UnsupportedStructure)
    );
}

#[test]
fn replace_node_source_preserves_exact_partition_and_rejects_swallowed_neighbors() {
    for eol in ["\n", "\r\n"] {
        let source = format!(
            "- before{eol}{eol}@typ{eol}#strong[old]{eol}@end{eol}@reply: A | B{eol}- after{eol}"
        );
        let (_, projection) = project(&source);
        let target = projection.nodes[2].node_ref();
        let replacement = format!("@typ{eol}#strong[new \"quoted\" C:\\\\path]{eol}@end{eol}");
        let edited = structure(
            &source,
            ComposerStructureTarget::Node(target.clone()),
            ComposerStructureCommand::ReplaceNodeSource {
                source: replacement.clone(),
            },
        )
        .unwrap();
        assert_eq!(
            edited,
            format!("- before{eol}{eol}{replacement}@reply: A | B{eol}- after{eol}")
        );
        for replacement in [
            format!("@typ{eol}#strong[unclosed]"),
            format!("@typ{eol}#strong[broken{eol}@end{eol}"),
            format!("@typ{eol}#strong[ok]{eol}@end{eol}- injected{eol}"),
            format!("@actor forged{eol}preset: A{eol}@end{eol}"),
            String::new(),
        ] {
            assert!(
                structure(
                    &source,
                    ComposerStructureTarget::Node(target.clone()),
                    ComposerStructureCommand::ReplaceNodeSource {
                        source: replacement
                    },
                )
                .is_err()
            );
        }
        let mut forged = target.clone();
        forged.range = projection.nodes[3].range();
        assert_eq!(
            structure(
                &source,
                ComposerStructureTarget::Node(forged),
                ComposerStructureCommand::ReplaceNodeSource {
                    source: replacement.clone()
                },
            ),
            Err(ComposerStructureFailure::TargetChanged)
        );
        let (analysis, _) = project(&source);
        assert_eq!(
            compose_structure_edit(
                &source,
                &analysis,
                &catalog(),
                &"0".repeat(64),
                ComposerStructureTarget::Node(target),
                ComposerStructureCommand::ReplaceNodeSource {
                    source: replacement
                },
            ),
            Err(ComposerStructureFailure::StaleDocument)
        );
    }
}

#[test]
fn replace_node_source_supports_local_content_but_not_metadata_or_blanks() {
    for (source, target_index, replacement) in [
        ("- before\n@reply: A | B\n- after\n", 1, "@reply: C | D\n"),
        ("- before\n@bond: old\n- after\n", 1, "@bond: new\n"),
        (
            "- before\n@typ: #strong[old]\n- after\n",
            1,
            "@typ: #strong[new]\n",
        ),
        (
            "- before\n- T\"\"\"#strong[old]\"\"\"\n- after\n",
            1,
            "- T\"\"\"\n#strong[new]\n\"\"\"\n",
        ),
    ] {
        let (_, projection) = project(source);
        assert_eq!(
            structure(
                source,
                ComposerStructureTarget::Node(projection.nodes[target_index].node_ref()),
                ComposerStructureCommand::ReplaceNodeSource {
                    source: replacement.to_owned()
                },
            )
            .unwrap(),
            format!("- before\n{replacement}- after\n")
        );
    }
    let source = "@mode: text\n\n- body\n";
    let (_, projection) = project(source);
    for node in &projection.nodes[..2] {
        assert_eq!(
            structure(
                source,
                ComposerStructureTarget::Node(node.node_ref()),
                ComposerStructureCommand::ReplaceNodeSource {
                    source: "- forged\n".to_owned()
                },
            ),
            Err(ComposerStructureFailure::UnsupportedStructure)
        );
    }
}

#[test]
fn local_typst_line_replacement_rejects_invalid_typst_candidate() {
    let source = "- before\n@typ: #strong[old]\n- after\n";
    let (_, projection) = project(source);
    assert_eq!(
        structure(
            source,
            ComposerStructureTarget::Node(projection.nodes[1].node_ref()),
            ComposerStructureCommand::ReplaceNodeSource {
                source: "@typ: #strong[unclosed\n".to_owned(),
            },
        ),
        Err(ComposerStructureFailure::CandidateInvalid)
    );
}

#[test]
fn inserted_literal_colon_preserves_generated_actor_and_builtin_markers() {
    let (_, projection) = project("");
    for (statement, expected) in [
        (
            message("hello:", StatementTextMode::Inherit),
            "> A: hello:\n",
        ),
        (
            ComposerNewStatement::Message {
                side: ComposerMessageSide::Right,
                speaker: ComposerNewStatementSpeaker::Builtin,
                avatar: None,
                body: ComposerStatementBodyInput {
                    value: "hello:".to_owned(),
                    mode: StatementTextMode::Inherit,
                },
                continued: ContinuedValue::True,
            },
            "<(continued: true) _0: hello:\n",
        ),
    ] {
        let inserted = structure(
            "",
            ComposerStructureTarget::Boundary(projection.boundaries[0].target.clone()),
            ComposerStructureCommand::InsertStatement { statement },
        )
        .unwrap();
        assert_eq!(inserted, expected);
        let (_, after) = project(&inserted);
        let ComposerDocumentNode::Message(node) = &after.nodes[0] else {
            panic!("inserted node must remain a message");
        };
        assert_eq!(node.description.body.current, "hello:");
    }
}

#[test]
fn append_without_final_eol_is_one_authorized_edit_preserving_existing_bytes() {
    for (source, eol) in [
        ("- old", "\n"),
        ("- before\r\n- old", "\r\n"),
        ("- before\r\n- middle\n- old", "\n"),
        (
            "- before\n< Teacher\n- next\n> A: rt\"\"\"\nold\"\"\"",
            "\n",
        ),
        ("- before\r\n> A: rt\"\"\"\r\nold\"\"\"", "\r\n"),
        ("- \"\"\"\n\"\"\"", "\n"),
        ("@typ\n#strong[old]\n@end", "\n"),
        ("@mode: rt", "\n"),
        (" \t", "\n"),
    ] {
        let (analysis, projection) = project(source);
        let target =
            ComposerStructureTarget::Boundary(projection.boundaries.last().unwrap().target.clone());
        let command = ComposerStructureCommand::InsertStatement {
            statement: message("next", StatementTextMode::Inherit),
        };
        let edit = compose_structure_edit(
            source,
            &analysis,
            &catalog(),
            &projection.source_digest,
            target.clone(),
            command.clone(),
        )
        .unwrap();
        assert_eq!(
            (edit.range.start, edit.range.end),
            (source.len(), source.len())
        );
        assert_eq!(edit.new_text, format!("{eol}> A: next{eol}"));
        let appended = apply(source, &edit);
        assert_eq!(appended, format!("{source}{eol}> A: next{eol}"));
        let (_, after) = project(&appended);
        assert_eq!(after.nodes.len(), projection.nodes.len() + 1);
        let ComposerDocumentNode::Message(node) = after.nodes.last().unwrap() else {
            panic!("appended statement must remain a message");
        };
        assert_eq!(node.description.body.current, "next");
        assert_eq!(
            compose_structure_edit(
                source,
                &analysis,
                &catalog(),
                &"0".repeat(64),
                target,
                command,
            ),
            Err(ComposerStructureFailure::StaleDocument)
        );
    }
}

#[test]
fn append_multiline_builtin_after_unterminated_message_preserves_both_bodies() {
    let source = "< Teacher";
    let (_, projection) = project(source);
    let appended = structure(
        source,
        ComposerStructureTarget::Boundary(projection.boundaries.last().unwrap().target.clone()),
        ComposerStructureCommand::InsertStatement {
            statement: ComposerNewStatement::Message {
                side: ComposerMessageSide::Right,
                speaker: ComposerNewStatementSpeaker::Builtin,
                avatar: None,
                body: ComposerStatementBodyInput {
                    value: "first\nsecond".to_owned(),
                    mode: StatementTextMode::Inherit,
                },
                continued: ContinuedValue::Auto,
            },
        },
    )
    .unwrap();
    assert!(appended.starts_with("< Teacher\n"));
    let (_, after) = project(&appended);
    for (node, body) in after.nodes.iter().zip(["Teacher", "first\nsecond"]) {
        let ComposerDocumentNode::Message(node) = node else {
            panic!("Teacher append must preserve message ownership");
        };
        assert_eq!(node.description.body.current, body);
        assert!(matches!(
            &node.description.speaker,
            Some(mmt_rs::ComposerSpeakerDescription::Builtin { id }) if id == "__Sensei"
        ));
    }
}

fn pack_registry() -> mmt_rs::pack::PackRegistry {
    mmt_rs::pack::PackRegistry::new(vec![
        mmt_rs::pack::PackManifest::from_json(include_str!("fixtures/pack-v3/base-manifest.json"))
            .unwrap(),
        mmt_rs::pack::PackManifest::from_json(include_str!(
            "fixtures/pack-v3/extension-manifest.json"
        ))
        .unwrap(),
    ])
    .unwrap()
}

fn pack_insert(
    source: &str,
    boundary: usize,
    statement: ComposerNewStatement,
) -> Result<mmt_rs::ComposerSourceEdit, ComposerStructureFailure> {
    let packs = pack_registry();
    let analysis = mmt_rs::analyze_text_with_pack(source, &packs);
    let projection = project_analyzed_composer_document(source, &analysis).unwrap();
    mmt_rs::compose_structure_edit_with_pack(
        source,
        &analysis,
        &packs,
        &projection.source_digest,
        ComposerStructureTarget::Boundary(projection.boundaries[boundary].target.clone()),
        ComposerStructureCommand::InsertStatement { statement },
    )
}

fn pack_message(avatar: Option<mmt_rs::PackAvatarChoice>) -> ComposerNewStatement {
    ComposerNewStatement::Message {
        side: ComposerMessageSide::Left,
        speaker: ComposerNewStatementSpeaker::Actor {
            reference: "佳代子".to_owned(),
        },
        avatar,
        body: ComposerStatementBodyInput {
            value: "new 😀\nsecond".to_owned(),
            mode: StatementTextMode::TextRaw,
        },
        continued: ContinuedValue::True,
    }
}

fn smile_choice() -> mmt_rs::PackAvatarChoice {
    mmt_rs::PackAvatarChoice {
        entity_id: "ba_fixture::佳代子".to_owned(),
        contribution_namespace: "ba_fixture".to_owned(),
        variant_id: "smile".to_owned(),
    }
}

fn media_statement(media: mmt_rs::ComposerMediaChoice) -> ComposerNewStatement {
    ComposerNewStatement::Media {
        side: ComposerMessageSide::Right,
        speaker: ComposerNewStatementSpeaker::Builtin,
        avatar: None,
        continued: ContinuedValue::False,
        media,
    }
}

#[test]
fn insertion_avatar_is_one_scoped_edit_and_preserves_other_actor_and_neighbor_bytes() {
    for eol in ["\n", "\r\n"] {
        let source = format!("> 佳代子: before{eol}> 小雪: other{eol}> 佳代子: later{eol}");
        let edit = pack_insert(&source, 1, pack_message(Some(smile_choice()))).unwrap();
        assert!(edit.range.is_empty());
        assert_eq!(edit.range.start, format!("> 佳代子: before{eol}").len());
        let changed = apply(&source, &edit);
        assert!(changed.starts_with(&format!("> 佳代子: before{eol}")));
        assert!(changed.ends_with(&format!("> 小雪: other{eol}> 佳代子: later{eol}")));
        let packs = pack_registry();
        let before = mmt_rs::project_composer_document_with_pack(&source, &packs).unwrap();
        let after = mmt_rs::project_composer_document_with_pack(&changed, &packs).unwrap();
        let messages = after
            .nodes
            .iter()
            .filter_map(|node| {
                if let ComposerDocumentNode::Message(node) = node {
                    Some(node)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();
        let ComposerDocumentNode::Message(original_first) = &before.nodes[0] else {
            panic!()
        };
        let ComposerDocumentNode::Message(original_other) = &before.nodes[1] else {
            panic!()
        };
        assert_eq!(messages[0].description, original_first.description);
        assert_eq!(messages[2].description, original_other.description);
        for index in [1, 3] {
            assert_eq!(
                messages[index]
                    .description
                    .actor_avatar
                    .as_ref()
                    .unwrap()
                    .current,
                Some(mmt_rs::ComposerAvatarCurrent::Pack(smile_choice()))
            );
        }
        assert_eq!(
            messages[1].description.body.current,
            format!("new 😀{eol}second")
        );
        assert_eq!(
            messages[1].description.continued,
            Some(ContinuedValue::True)
        );
        assert_eq!(after.nodes.len(), before.nodes.len() + 2);
    }
}

#[test]
fn insertion_avatar_creates_implicit_actor_once_and_reuses_current_choice() {
    let first = pack_insert("", 0, pack_message(Some(smile_choice()))).unwrap();
    let source = apply("", &first);
    let projection =
        mmt_rs::project_composer_document_with_pack(&source, &pack_registry()).unwrap();
    let second = pack_insert(
        &source,
        projection.nodes.len(),
        pack_message(Some(smile_choice())),
    )
    .unwrap();
    let appended = apply(&source, &second);
    let analysis = mmt_rs::analyze_text_with_pack(&appended, &pack_registry());
    assert_eq!(analysis.document.nodes.iter().filter(|node| {
        matches!(node, mmt_rs::syntax::SyntaxNode::DirectiveBlock(block) if block.name == "actor")
    }).count(), 1);
    let mut invalid = smile_choice();
    invalid.variant_id = "not-in-current-pack".to_owned();
    assert_eq!(
        pack_insert("", 0, pack_message(Some(invalid))),
        Err(ComposerStructureFailure::InvalidValue)
    );
    let mut teacher = media_statement(mmt_rs::ComposerMediaChoice::Sticker {
        entity_id: "ba_fixture::佳代子".to_owned(),
        set_id: "default".to_owned(),
        ordinal: 1,
    });
    if let ComposerNewStatement::Media { avatar, .. } = &mut teacher {
        *avatar = Some(smile_choice());
    }
    assert_eq!(
        pack_insert("", 0, teacher),
        Err(ComposerStructureFailure::InvalidValue)
    );
}

#[test]
fn canonical_pack_first_send_with_changed_avatar_preserves_the_default_actor_for_repeated_sends() {
    for source in ["", "- before\r\n"] {
        let packs = pack_registry();
        let before = mmt_rs::project_composer_document_with_pack(source, &packs).unwrap();
        let mut statement = pack_message(Some(smile_choice()));
        if let ComposerNewStatement::Message {
            speaker,
            body,
            continued,
            ..
        } = &mut statement
        {
            *speaker = ComposerNewStatementSpeaker::Actor {
                reference: "ba_fixture::佳代子".to_owned(),
            };
            body.value = "First meeting".to_owned();
            *continued = ContinuedValue::Auto;
        }
        let first = pack_insert(source, before.nodes.len(), statement.clone()).unwrap();
        assert!(first.range.is_empty());
        assert_eq!(first.range.start, source.len());
        let first_source = apply(source, &first);
        assert!(first_source.starts_with(source));
        let first_analysis = mmt_rs::analyze_text_with_pack(&first_source, &packs);
        let first_projection =
            project_analyzed_composer_document(&first_source, &first_analysis).unwrap();
        assert!(!first_projection.has_errors);
        assert_eq!(first_analysis.actors.actors.len(), 1);
        assert_eq!(
            first_analysis.actors.actors[0].names,
            vec!["佳代子".to_owned()]
        );
        let second = pack_insert(&first_source, first_projection.nodes.len(), statement).unwrap();
        assert!(second.range.is_empty());
        let second_source = apply(&first_source, &second);
        let second_analysis = mmt_rs::analyze_text_with_pack(&second_source, &packs);
        let second_projection =
            project_analyzed_composer_document(&second_source, &second_analysis).unwrap();
        assert!(!second_projection.has_errors);
        assert_eq!(second_analysis.actors.actors.len(), 1);
        let messages = second_projection
            .nodes
            .iter()
            .filter_map(|node| match node {
                ComposerDocumentNode::Message(node) => Some(node),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(messages.len(), 2);
        for node in messages {
            assert_eq!(node.description.body.current, "First meeting");
            assert_eq!(
                node.description.actor_avatar.as_ref().unwrap().current,
                Some(mmt_rs::ComposerAvatarCurrent::Pack(smile_choice()))
            );
            assert!(matches!(&node.description.speaker,
                Some(mmt_rs::ComposerSpeakerDescription::Actor { preset_id, .. })
                if preset_id == "ba_fixture::佳代子"));
        }
    }
}

#[test]
fn media_assets_and_workspace_images_are_semantic_atomic_and_collision_free() {
    for eol in ["\n", "\r\n"] {
        let source = format!(
            "@asset image_1{eol}src: old.png{eol}@end{eol}- before{eol}{eol}@typ: #strong[keep]{eol}"
        );
        let edit = pack_insert(
            &source,
            2,
            media_statement(mmt_rs::ComposerMediaChoice::WorkspaceImage {
                relative_path: "assets/34806688-1100-4400-8800-889911223344.png".to_owned(),
            }),
        )
        .unwrap();
        assert!(edit.range.is_empty());
        let changed = apply(&source, &edit);
        let packs = pack_registry();
        let analysis = mmt_rs::analyze_text_with_pack(&changed, &packs);
        assert!(analysis.assets.resolve("image_1").is_some());
        let imported = analysis.assets.resolve("image_2").unwrap();
        assert_eq!(
            imported.source,
            mmt_rs::semantic::AssetSource::LocalFile(
                "assets/34806688-1100-4400-8800-889911223344.png".to_owned()
            )
        );
        assert!(changed.starts_with(&format!(
            "@asset image_1{eol}src: old.png{eol}@end{eol}- before{eol}"
        )));
        assert!(changed.ends_with(&format!("{eol}@typ: #strong[keep]{eol}")));
        let projection = project_analyzed_composer_document(&changed, &analysis).unwrap();
        assert!(
            projection
                .asset_choices
                .iter()
                .any(|choice| choice.asset_name == "image_2")
        );
        let media = projection
            .nodes
            .iter()
            .find_map(|node| match node {
                ComposerDocumentNode::Message(node) => Some(node),
                _ => None,
            })
            .unwrap();
        assert!(media.text_editing.is_none());
        assert_eq!(media.side, ComposerMessageSide::Right);
        assert_eq!(media.description.continued, Some(ContinuedValue::False));
        let existing = pack_insert(
            &source,
            2,
            media_statement(mmt_rs::ComposerMediaChoice::Asset {
                asset_name: "image_1".to_owned(),
            }),
        )
        .unwrap();
        let existing_source = apply(&source, &existing);
        let existing_analysis = mmt_rs::analyze_text_with_pack(&existing_source, &packs);
        assert_eq!(existing_analysis.assets.assets, analysis.assets.assets[..1]);
    }
}

#[test]
fn declared_media_assets_preserve_inline_argument_names() {
    for eol in ["\n", "\r\n"] {
        for asset_name in ["#1", "a,b"] {
            let source =
                format!("@asset \"{asset_name}\"{eol}src: image.png{eol}@end{eol}- keep{eol}");
            let edit = pack_insert(
                &source,
                2,
                media_statement(mmt_rs::ComposerMediaChoice::Asset {
                    asset_name: asset_name.to_owned(),
                }),
            )
            .unwrap();
            assert!(edit.range.is_empty());
            let changed = apply(&source, &edit);
            assert!(changed.starts_with(&source));
            let analysis = mmt_rs::analyze_text_with_pack(&changed, &pack_registry());
            let projection = project_analyzed_composer_document(&changed, &analysis).unwrap();
            assert!(!projection.has_errors);
            let resources = &analysis.resolution.as_ref().unwrap().resources;
            assert_eq!(resources.len(), 1);
            assert!(matches!(&resources[0].kind,
                mmt_rs::ResolvedResourceKind::ScriptAsset { name, .. } if name == asset_name));
            assert_eq!(analysis.assets.assets.len(), 1);
            assert_eq!(analysis.assets.assets[0].id.name, asset_name);
        }
    }
}

#[test]
fn media_stickers_validate_catalog_set_ordinal_and_keep_physical_frame() {
    for (set_id, expected_set, ordinal, namespace, frame) in [
        ("default", "default", 2, "ba_fixture", 1),
        ("festival", "festival", 1, "ba_fixture_ext", 0),
        ("ba_fixture::default", "default", 2, "ba_fixture", 1),
        (
            "ba_fixture_ext::festival",
            "festival",
            1,
            "ba_fixture_ext",
            0,
        ),
    ] {
        let edit = pack_insert(
            "",
            0,
            media_statement(mmt_rs::ComposerMediaChoice::Sticker {
                entity_id: "ba_fixture::佳代子".to_owned(),
                set_id: set_id.to_owned(),
                ordinal,
            }),
        )
        .unwrap();
        let source = apply("", &edit);
        let analysis = mmt_rs::analyze_text_with_pack(&source, &pack_registry());
        let resources = analysis.resolution.as_ref().unwrap();
        assert!(
            matches!(&resources.resources[0].kind, mmt_rs::ResolvedResourceKind::Sticker {
            contribution_namespace, set_id: actual_set, source, ..
        } if contribution_namespace == namespace && actual_set == expected_set && source.frame == Some(frame))
        );
    }
    for media in [
        mmt_rs::ComposerMediaChoice::Asset {
            asset_name: "pack_portrait".to_owned(),
        },
        mmt_rs::ComposerMediaChoice::Sticker {
            entity_id: "ba_fixture::missing".to_owned(),
            set_id: "default".to_owned(),
            ordinal: 1,
        },
        mmt_rs::ComposerMediaChoice::Sticker {
            entity_id: "ba_fixture::佳代子".to_owned(),
            set_id: "missing".to_owned(),
            ordinal: 1,
        },
        mmt_rs::ComposerMediaChoice::Sticker {
            entity_id: "ba_fixture::佳代子".to_owned(),
            set_id: "default".to_owned(),
            ordinal: 0,
        },
        mmt_rs::ComposerMediaChoice::Sticker {
            entity_id: "ba_fixture::佳代子".to_owned(),
            set_id: "default".to_owned(),
            ordinal: 3,
        },
        mmt_rs::ComposerMediaChoice::Sticker {
            entity_id: "ba_fixture::佳代子".to_owned(),
            set_id: "ba_fixture::festival".to_owned(),
            ordinal: 1,
        },
        mmt_rs::ComposerMediaChoice::Sticker {
            entity_id: "ba_fixture::佳代子".to_owned(),
            set_id: "missing::default".to_owned(),
            ordinal: 1,
        },
        mmt_rs::ComposerMediaChoice::Sticker {
            entity_id: "ba_fixture::佳代子".to_owned(),
            set_id: "ba_fixture::::default".to_owned(),
            ordinal: 1,
        },
    ] {
        assert_eq!(
            pack_insert("", 0, media_statement(media)),
            Err(ComposerStructureFailure::InvalidValue)
        );
    }
}

#[test]
fn workspace_media_rejects_unsafe_paths_and_stale_boundary_without_partial_declarations() {
    for path in [
        "../x.png",
        "/assets/x.png",
        "assets/../x.png",
        "assets//x.png",
        "assets\\x.png",
        "https://x.png",
        "assets/x.svg",
        "assets/x.png\n@mode: T",
        "assets/C:x.png",
        "x.png",
        "assets/nested/x.png",
    ] {
        assert_eq!(
            pack_insert(
                "",
                0,
                media_statement(mmt_rs::ComposerMediaChoice::WorkspaceImage {
                    relative_path: path.to_owned(),
                })
            ),
            Err(ComposerStructureFailure::InvalidValue),
            "{path}"
        );
    }
    let source = "- keep\n";
    let packs = pack_registry();
    let analysis = mmt_rs::analyze_text_with_pack(source, &packs);
    let projection = project_analyzed_composer_document(source, &analysis).unwrap();
    let statement = media_statement(mmt_rs::ComposerMediaChoice::WorkspaceImage {
        relative_path: "assets/new.jpg".to_owned(),
    });
    let mut stale = projection.boundaries[0].target.clone();
    stale.after.as_mut().unwrap().node_key = "0".repeat(64);
    assert!(
        mmt_rs::compose_structure_edit_with_pack(
            source,
            &analysis,
            &packs,
            &projection.source_digest,
            ComposerStructureTarget::Boundary(stale),
            ComposerStructureCommand::InsertStatement {
                statement: statement.clone()
            }
        )
        .is_err()
    );
    assert_eq!(
        mmt_rs::compose_structure_edit_with_pack(
            source,
            &analysis,
            &packs,
            &"0".repeat(64),
            ComposerStructureTarget::Boundary(projection.boundaries[0].target.clone()),
            ComposerStructureCommand::InsertStatement { statement }
        ),
        Err(ComposerStructureFailure::StaleDocument)
    );
    assert_eq!(analysis.assets.assets.len(), 0);
}

#[test]
fn side_edits_preserve_fences_patches_blanks_and_neighbor_semantics() {
    for eol in ["\n", "\r\n"] {
        let source = format!(
            "- before{eol}>(continued: true, fill: green) A: rt\"\"\"{eol}body 😀{eol}line\"\"\"{eol}{eol}@typ: #strong[keep]{eol}"
        );
        let (analysis, projection) = project(&source);
        let edit = compose_structure_edit(
            &source,
            &analysis,
            &catalog(),
            &projection.source_digest,
            ComposerStructureTarget::Node(projection.nodes[1].node_ref()),
            ComposerStructureCommand::SetStatementSide {
                side: ComposerMessageSide::Right,
            },
        )
        .unwrap();
        let changed = apply(&source, &edit);
        let expected = source.replacen(">(continued:", "<(continued:", 1);
        assert_eq!(changed, expected);
        let (_, after) = project(&changed);
        let ComposerDocumentNode::Message(message) = &after.nodes[1] else {
            panic!()
        };
        let ComposerDocumentNode::Message(original) = &projection.nodes[1] else {
            panic!()
        };
        assert_eq!(message.description, original.description);
        let stale = "0".repeat(64);
        let mut target = projection.nodes[1].node_ref();
        target.node_key = stale;
        assert_eq!(
            compose_structure_edit(
                &source,
                &analysis,
                &catalog(),
                &projection.source_digest,
                ComposerStructureTarget::Node(target),
                ComposerStructureCommand::SetStatementSide {
                    side: ComposerMessageSide::Right
                }
            ),
            Err(ComposerStructureFailure::TargetChanged)
        );
    }
    let source = "< _0: teacher\n";
    let (_, projection) = project(source);
    assert_eq!(
        structure(
            source,
            ComposerStructureTarget::Node(projection.nodes[0].node_ref()),
            ComposerStructureCommand::SetStatementSide {
                side: ComposerMessageSide::Left
            }
        ),
        Err(ComposerStructureFailure::UnsupportedStructure)
    );
}

#[test]
fn moving_to_any_boundary_stays_inside_the_authorized_opaque_free_run() {
    for eol in ["\n", "\r\n"] {
        let source = format!(
            "- first{eol}- second{eol}- third{eol}- fourth{eol}{eol}@typ: #strong[barrier]{eol}- last{eol}"
        );
        let (_, projection) = project(&source);
        let moved = structure(
            &source,
            ComposerStructureTarget::Node(projection.nodes[0].node_ref()),
            ComposerStructureCommand::MoveNode {
                anchor: projection.boundaries[4].target.clone(),
            },
        )
        .unwrap();
        assert_eq!(
            moved,
            format!(
                "- second{eol}- third{eol}- fourth{eol}- first{eol}{eol}@typ: #strong[barrier]{eol}- last{eol}"
            )
        );
        assert_eq!(
            structure(
                &source,
                ComposerStructureTarget::Node(projection.nodes[0].node_ref()),
                ComposerStructureCommand::MoveNode {
                    anchor: projection.boundaries.last().unwrap().target.clone()
                }
            ),
            Err(ComposerStructureFailure::UnsupportedStructure)
        );
    }
}

#[test]
fn side_change_pins_side_local_history_only_inside_target_and_rejects_neighbor_drift() {
    for (source, target_index, expected) in [
        ("> A: first\n> _0: second\n", 1, "> A: first\n< A: second\n"),
        (
            "> A: first\n> rt\"\"\"\nsecond\"\"\"\n",
            1,
            "> A: first\n< A: rt\"\"\"\nsecond\"\"\"\n",
        ),
    ] {
        let (_, projection) = project(source);
        let changed = structure(
            source,
            ComposerStructureTarget::Node(projection.nodes[target_index].node_ref()),
            ComposerStructureCommand::SetStatementSide {
                side: ComposerMessageSide::Right,
            },
        )
        .unwrap();
        assert_eq!(changed, expected);
    }
    for source in ["> A: first\n< _0: teacher\n", "> A: first\n> _0: second\n"] {
        let (analysis, projection) = project(source);
        assert_eq!(
            structure(
                source,
                ComposerStructureTarget::Node(projection.nodes[0].node_ref()),
                ComposerStructureCommand::SetStatementSide {
                    side: ComposerMessageSide::Right
                }
            ),
            Err(ComposerStructureFailure::CandidateInvalid)
        );
        assert_eq!(
            compose_structure_edit(
                source,
                &analysis,
                &catalog(),
                &"0".repeat(64),
                ComposerStructureTarget::Node(projection.nodes[0].node_ref()),
                ComposerStructureCommand::SetStatementSide {
                    side: ComposerMessageSide::Right
                }
            ),
            Err(ComposerStructureFailure::StaleDocument)
        );
        assert_eq!(
            structure(
                source,
                ComposerStructureTarget::Node(projection.nodes[0].node_ref()),
                ComposerStructureCommand::SetStatementSide {
                    side: ComposerMessageSide::Left
                }
            ),
            Err(ComposerStructureFailure::InvalidValue)
        );
    }
}
