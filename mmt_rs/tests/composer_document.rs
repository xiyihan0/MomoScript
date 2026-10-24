use mmt_rs::{
    CharacterPreset, ComposerDocumentNode, ComposerOpaqueCategory, StaticPresetCatalog,
    composer_document_source_digest, project_composer_document,
};

fn catalog() -> StaticPresetCatalog {
    StaticPresetCatalog::new(vec![CharacterPreset {
        id: "fixture::角色".to_string(),
        names: vec!["角色".to_string()],
        display_name: Some("角色显示名".to_string()),
        avatar: None,
    }])
}

fn assert_partition(source: &str) {
    let projection = project_composer_document(source, &catalog()).unwrap();
    assert_eq!(
        projection.source_digest,
        composer_document_source_digest(source)
    );
    assert_eq!(projection.boundaries.len(), projection.nodes.len() + 1);
    if source.is_empty() {
        assert!(projection.nodes.is_empty());
        assert!(projection.boundaries[0].target.before.is_none());
        assert!(projection.boundaries[0].target.after.is_none());
        return;
    }

    assert_eq!(projection.nodes.first().unwrap().range().start, 0);
    assert_eq!(projection.nodes.last().unwrap().range().end, source.len());
    let mut reconstructed = String::new();
    for (index, node) in projection.nodes.iter().enumerate() {
        let range = node.range();
        assert!(source.is_char_boundary(range.start));
        assert!(source.is_char_boundary(range.end));
        assert!(range.start < range.end);
        if index > 0 {
            assert_eq!(projection.nodes[index - 1].range().end, range.start);
        }
        assert!(
            !(range.end > 0
                && range.end < source.len()
                && source.as_bytes()[range.end - 1] == b'\r'
                && source.as_bytes()[range.end] == b'\n')
        );
        reconstructed.push_str(&source[range.start..range.end]);
    }
    assert_eq!(reconstructed.as_bytes(), source.as_bytes());
}

#[test]
fn projection_partitions_required_source_fixtures_losslessly() {
    for source in [
        "",
        "- no final eol",
        "- final eol\n",
        "- first\n- second",
        "- first\r\n- second\r\n",
        "- Unicode 😀𠮷\n",
        "\u{feff}- BOM statement\n",
        "> 角色: first\ncontinued body",
        "\n\n- after blanks\n",
        "@mode: text\n- after directive\n",
        "@reply: option A | option B\n@bond: bond\n",
        "@end\n- recovered\n",
        "unknown top-level\n- recovered\n",
        "// comment-looking remains an error\n- recovered\n",
    ] {
        assert_partition(source);
    }
}

#[test]
fn physical_blank_lines_keep_independent_node_identity() {
    let projection = project_composer_document("\r\n\r\n- narration", &catalog()).unwrap();
    assert_eq!(projection.nodes.len(), 3);
    for (index, expected) in [(0, "\r\n"), (1, "\r\n")] {
        let ComposerDocumentNode::Opaque(node) = &projection.nodes[index] else {
            panic!("blank line must remain opaque");
        };
        assert_eq!(node.category, ComposerOpaqueCategory::Blank);
        assert_eq!(
            &"\r\n\r\n- narration"[node.range.start..node.range.end],
            expected
        );
    }
    assert_ne!(
        projection.nodes[0].node_ref().node_key,
        projection.nodes[1].node_ref().node_key
    );
}

#[test]
fn blank_after_statement_remains_independent_and_statement_editable() {
    let source = "> 角色: original\r\n\r\n@reply: A | B\r\n@bond: bond";
    let projection = project_composer_document(source, &catalog()).unwrap();
    let ComposerDocumentNode::Message(message) = &projection.nodes[0] else {
        panic!("first node must remain a message");
    };
    assert_eq!(message.description.body.current, "original");
    assert_eq!(
        message.description.statement_text.as_ref().unwrap().current,
        "original"
    );
    assert!(message.capabilities.set_body);
    let ComposerDocumentNode::Opaque(blank) = &projection.nodes[1] else {
        panic!("blank line must remain opaque");
    };
    assert_eq!(blank.category, ComposerOpaqueCategory::Blank);
    assert_eq!(&source[blank.range.start..blank.range.end], "\r\n");
    assert_partition(source);
}

#[test]
fn statement_bodies_and_separator_blanks_follow_parser_boundaries() {
    for (source, expected_body, set_body, expected_blanks) in [
        (
            "> 角色: first\ncontinued body\n\n\n@reply: A | B",
            "first\ncontinued body",
            true,
            vec!["\n", "\n"],
        ),
        ("> 角色:\r\n\r\n@reply: A | B", "", true, vec!["\r\n"]),
        (
            "> 角色: first\ncontinued body\n  \n\t\r\n@reply: A | B",
            "first\ncontinued body",
            true,
            vec!["  \n", "\t\r\n"],
        ),
        (
            "> 角色: kept  \n \n@reply: A | B",
            "kept  ",
            true,
            vec![" \n"],
        ),
    ] {
        let projection = project_composer_document(source, &catalog()).unwrap();
        let ComposerDocumentNode::Message(message) = &projection.nodes[0] else {
            panic!("first node must remain a message");
        };
        assert_eq!(message.description.body.current, expected_body);
        assert_eq!(message.text_editing.as_ref().unwrap().text, expected_body);
        assert_eq!(message.capabilities.set_body, set_body);
        for (offset, expected) in expected_blanks.iter().enumerate() {
            let ComposerDocumentNode::Opaque(blank) = &projection.nodes[offset + 1] else {
                panic!("separator blank must remain an independent opaque node");
            };
            assert_eq!(blank.category, ComposerOpaqueCategory::Blank);
            assert_eq!(&source[blank.range.start..blank.range.end], *expected);
        }
        assert_partition(source);
    }
}

#[test]
fn final_bare_cr_blank_projects_as_a_physical_separator() {
    for (source, expected_blank) in [
        ("- first\n \r", " \r"),
        ("- first\n \n", " \n"),
        ("- first\r\n \r\n", " \r\n"),
    ] {
        let projection = project_composer_document(source, &catalog()).unwrap();
        assert_eq!(projection.nodes.len(), 2);
        let ComposerDocumentNode::Narration(narration) = &projection.nodes[0] else {
            panic!("first physical line must be narration");
        };
        assert_eq!(narration.description.body.current, "first");
        let ComposerDocumentNode::Opaque(blank) = &projection.nodes[1] else {
            panic!("separator must remain opaque");
        };
        assert_eq!(blank.category, ComposerOpaqueCategory::Blank);
        assert_eq!(&source[blank.range.start..blank.range.end], expected_blank);
        assert_eq!(blank.range.end, source.len());
        assert_partition(source);
    }

    let source = "- first\n \r\ncontinued";
    let projection = project_composer_document(source, &catalog()).unwrap();
    assert_eq!(projection.nodes.len(), 1);
    let ComposerDocumentNode::Narration(narration) = &projection.nodes[0] else {
        panic!("internal blank belongs to the continuing narration");
    };
    assert_eq!(narration.description.body.current, "first\n \r\ncontinued");
    assert_partition(source);
}

#[test]
fn whitespace_and_zero_width_blank_syntax_own_full_physical_lines() {
    let source = "\r\n  \r\n\t\n- narration";
    let projection = project_composer_document(source, &catalog()).unwrap();
    for (index, expected) in ["\r\n", "  \r\n", "\t\n"].iter().enumerate() {
        let ComposerDocumentNode::Opaque(blank) = &projection.nodes[index] else {
            panic!("physical blank line must remain opaque");
        };
        assert_eq!(blank.category, ComposerOpaqueCategory::Blank);
        assert_eq!(&source[blank.range.start..blank.range.end], *expected);
    }
    assert_partition(source);
}

#[test]
fn comment_looking_line_is_recoverable_error_and_keeps_diagnostic_gate() {
    let source = "// not parser syntax\n- narration\n";
    let analysis = mmt_rs::analyze_text(source, &catalog());
    assert!(matches!(
        analysis.document.nodes[0],
        mmt_rs::syntax::SyntaxNode::Error(_)
    ));
    let projection = project_composer_document(source, &catalog()).unwrap();
    assert!(projection.has_errors);
    let ComposerDocumentNode::Opaque(comment) = &projection.nodes[0] else {
        panic!("comment-looking line must remain opaque");
    };
    assert_eq!(comment.category, ComposerOpaqueCategory::RecoverableError);
    assert!(
        projection
            .boundaries
            .iter()
            .all(|boundary| boundary.insert.is_none())
    );
    let ComposerDocumentNode::Narration(narration) = &projection.nodes[1] else {
        panic!("narration remains visible after recoverable error");
    };
    assert!(!narration.capabilities.set_body);
    assert!(!narration.capabilities.delete);
}

#[test]
fn bom_is_an_explicit_unsupported_partition_node() {
    let source = "\u{feff}- narration\n";
    let projection = project_composer_document(source, &catalog()).unwrap();
    let ComposerDocumentNode::Opaque(bom) = &projection.nodes[0] else {
        panic!("BOM must be opaque");
    };
    assert_eq!(bom.category, ComposerOpaqueCategory::Unsupported);
    assert_eq!(&source[bom.range.start..bom.range.end], "\u{feff}");
    assert_partition(source);
}

#[test]
fn bom_prefix_before_blank_physical_line_partitions_losslessly() {
    let source = "\u{feff}\n\n- narration";
    let projection = project_composer_document(source, &catalog()).unwrap();
    let blank = projection
        .nodes
        .iter()
        .find_map(|node| match node {
            ComposerDocumentNode::Opaque(node)
                if node.category == ComposerOpaqueCategory::Blank =>
            {
                Some(node)
            }
            _ => None,
        })
        .expect("blank physical line after BOM must remain explicit");
    assert_eq!(&source[blank.range.start..blank.range.end], "\n");
    assert_partition(source);
}

#[test]
fn digest_and_node_keys_are_deterministic_and_snapshot_local() {
    let source = "- one\n- two";
    let first = project_composer_document(source, &catalog()).unwrap();
    let second = project_composer_document(source, &catalog()).unwrap();
    assert_eq!(first.source_digest, second.source_digest);
    assert_eq!(
        first
            .nodes
            .iter()
            .map(|node| node.node_ref().node_key)
            .collect::<Vec<_>>(),
        second
            .nodes
            .iter()
            .map(|node| node.node_ref().node_key)
            .collect::<Vec<_>>()
    );

    let changed = project_composer_document("- one\n- too", &catalog()).unwrap();
    assert_ne!(first.source_digest, changed.source_digest);
    assert_ne!(
        first.nodes[0].node_ref().node_key,
        changed.nodes[0].node_ref().node_key
    );
}

#[test]
fn canonical_source_digest_has_a_fixed_cross_language_fixture() {
    assert_eq!(
        composer_document_source_digest("- Unicode 😀\r\n"),
        "b764fdd6f4a8bb209bebee01873de5b29986a4ef2263ab6deae0c853ee1249f0"
    );
    assert_eq!(
        composer_document_source_digest(""),
        "5229a1859903f18b147ff1dc5ac552d83d0f4550fb28f0de4fd413c8e5ee1b0a"
    );
}

#[test]
fn multiline_statement_exposes_whole_body_and_source_lens_capabilities() {
    let source = "> 角色: first\ncontinued body";
    let projection = project_composer_document(source, &catalog()).unwrap();
    let ComposerDocumentNode::Message(message) = &projection.nodes[0] else {
        panic!("multiline statement must remain a Message");
    };
    assert_eq!(message.description.body.current, "first\ncontinued body");
    assert_eq!(
        message.description.statement_text.as_ref().unwrap().current,
        "first\ncontinued body"
    );
    assert!(message.capabilities.set_body);
    assert!(message.capabilities.replace_source);
    assert_eq!(
        message.text_editing.as_ref().unwrap().text,
        "first\ncontinued body"
    );
}

#[test]
fn declared_script_actor_choice_does_not_require_a_spoken_statement() {
    let source = "@actor 讲述者\npreset: 角色\n@end\n- narration";
    let projection = project_composer_document(source, &catalog()).unwrap();
    assert!(!projection.has_errors);
    assert_eq!(projection.script_actor_choices.len(), 1);
    let choice = &projection.script_actor_choices[0];
    assert_eq!(choice.reference, "讲述者");
    assert_eq!(choice.primary_name, "讲述者");
    assert_eq!(choice.preset_id, "fixture::角色");
}

#[test]
fn valid_projection_exposes_product_descriptions_and_direct_boundaries() {
    let source = "> 角色: hello\n- narration";
    let projection = project_composer_document(source, &catalog()).unwrap();
    assert!(!projection.has_errors);
    let ComposerDocumentNode::Message(message) = &projection.nodes[0] else {
        panic!("first node must be message");
    };
    assert_eq!(
        message.description.statement_text.as_ref().unwrap().current,
        "hello"
    );
    assert!(message.capabilities.set_body);
    assert!(message.capabilities.set_speaker);
    assert!(message.capabilities.move_down.is_some());
    assert!(projection.boundaries[0].insert.is_some());
    assert!(projection.boundaries[1].insert.is_some());
    assert_eq!(projection.boundaries[2].insert.as_ref().unwrap().eol, "\n");
}

#[test]
fn text_editing_preserves_semantic_lf_for_empty_and_multiline_bodies() {
    for (source, expected) in [
        ("- \"\"\"\n\"\"\"", ""),
        (
            "- rt\"\"\"\r\n\r\nA😀e\u{301}中\r\n\"\"\"",
            "\nA😀e\u{301}中\n",
        ),
        ("- first\r\ncontinued\r\n\r\n- next", "first\ncontinued"),
        ("- \"\"\"\na\r\nb\nc\"\"\"", "a\nb\nc"),
    ] {
        let projection = project_composer_document(source, &catalog()).unwrap();
        let first = &projection.nodes[0];
        assert_eq!(first.text_editing().unwrap().text, expected);
        assert!(matches!(first, ComposerDocumentNode::Narration(_)));
    }
}

#[test]
fn nonreversible_macro_and_typst_bodies_never_advertise_text_editing() {
    for source in [
        "- T\"\"\"#strong[body]\"\"\"",
        "- rT\"\"\"#strong[body]\"\"\"",
    ] {
        let projection = project_composer_document(source, &catalog()).unwrap();
        assert!(projection.nodes[0].text_editing().is_none());
    }
    let packs = mmt_rs::pack::PackRegistry::new(Vec::new()).unwrap();
    let macro_source = "- [:missing:]";
    let projection = mmt_rs::project_composer_document_with_pack(macro_source, &packs).unwrap();
    assert!(projection.nodes[0].text_editing().is_none());
    let raw = project_composer_document("- rt\"\"\"[:literal:]\"\"\"", &catalog()).unwrap();
    assert_eq!(raw.nodes[0].text_editing().unwrap().text, "[:literal:]");
}

#[test]
fn source_lens_capability_distinguishes_content_from_metadata_and_blank_partitions() {
    let source = concat!(
        "@mode: text\n",
        "\n",
        "@typ\n#strong[advanced]\n@end\n",
        "@reply: A | B\n",
        "@bond: bond\n",
        "- body\n",
    );
    let projection = project_composer_document(source, &catalog()).unwrap();
    assert!(!projection.has_errors);
    for (index, expected) in [false, false, true, true, true, true]
        .into_iter()
        .enumerate()
    {
        let allowed = match &projection.nodes[index] {
            ComposerDocumentNode::Message(node) => node.capabilities.replace_source,
            ComposerDocumentNode::Narration(node) => node.capabilities.replace_source,
            ComposerDocumentNode::Opaque(node) => node.capabilities.replace_source,
        };
        assert_eq!(allowed, expected, "node {index}");
    }
    let broken = project_composer_document("@typ\n#strong[unclosed\n@end\n", &catalog()).unwrap();
    assert!(broken.has_errors);
    assert!(
        matches!(&broken.nodes[0], ComposerDocumentNode::Opaque(node) if !node.capabilities.replace_source)
    );
}

#[test]
fn complete_unterminated_eof_advertises_parser_owned_local_eol_insertion() {
    for (source, eol) in [
        ("- old", "\n"),
        ("- before\r\n- old", "\r\n"),
        ("- before\r\n- middle\n- old", "\n"),
        ("- rt\"\"\"\r\nold\"\"\"", "\r\n"),
        ("@typ\n#strong[old]\n@end", "\n"),
        (" \t", "\n"),
    ] {
        let projection = project_composer_document(source, &catalog()).unwrap();
        let boundary = projection.boundaries.last().unwrap();
        let insert = boundary
            .insert
            .as_ref()
            .expect("complete EOF must allow append");
        assert_eq!(insert.eol, eol);
        assert_eq!(insert.boundary, boundary.target);
        assert_eq!(
            boundary.target.before,
            projection.nodes.last().map(ComposerDocumentNode::node_ref)
        );
        assert!(boundary.target.after.is_none());
    }
    for source in [
        "\u{feff}",
        "- old\r",
        "- \"\"\"\nunclosed",
        "@typ\n#strong[old]",
    ] {
        let projection = project_composer_document(source, &catalog()).unwrap();
        assert!(projection.boundaries.last().unwrap().insert.is_none());
    }
}

#[test]
fn projection_exposes_declared_assets_and_actual_side_and_move_choices() {
    let source = "@asset photo\nsrc: assets/photo.png\n@end\n> 角色: first\n> 角色: second\n< _0: teacher\n- last\n\n@typ: #strong[barrier]\n- isolated\n";
    let projection = project_composer_document(source, &catalog()).unwrap();
    assert!(!projection.has_errors);
    assert_eq!(
        projection.asset_choices,
        vec![mmt_rs::ComposerAssetChoice {
            asset_name: "photo".to_owned(),
        }]
    );
    let ComposerDocumentNode::Message(actor) = &projection.nodes[1] else {
        panic!()
    };
    assert_eq!(
        actor.capabilities.set_side,
        vec![
            mmt_rs::ComposerMessageSide::Left,
            mmt_rs::ComposerMessageSide::Right
        ]
    );
    assert_eq!(
        actor.capabilities.move_targets,
        vec![
            projection.boundaries[3].target.clone(),
            projection.boundaries[4].target.clone(),
            projection.boundaries[5].target.clone(),
        ]
    );
    let ComposerDocumentNode::Message(teacher) = &projection.nodes[3] else {
        panic!()
    };
    assert_eq!(
        teacher.capabilities.set_side,
        vec![mmt_rs::ComposerMessageSide::Right]
    );
    let ComposerDocumentNode::Narration(isolated) = projection.nodes.last().unwrap() else {
        panic!()
    };
    assert!(isolated.capabilities.move_targets.is_empty());

    let broken = project_composer_document(
        "@asset photo\nsrc: x.png\n@end\n@end\n> 角色: text\n",
        &catalog(),
    )
    .unwrap();
    assert!(broken.has_errors);
    assert!(broken.asset_choices.is_empty());
    let ComposerDocumentNode::Message(message) = broken.nodes.last().unwrap() else {
        panic!()
    };
    assert!(message.capabilities.set_side.is_empty());
    assert!(message.capabilities.move_targets.is_empty());
}
