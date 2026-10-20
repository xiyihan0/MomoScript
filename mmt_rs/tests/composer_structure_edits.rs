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
