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
    assert!(message.capabilities.set_body);
    let ComposerDocumentNode::Opaque(blank) = &projection.nodes[1] else {
        panic!("blank line must remain opaque");
    };
    assert_eq!(blank.category, ComposerOpaqueCategory::Blank);
    assert_eq!(&source[blank.range.start..blank.range.end], "\r\n");
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
fn multiline_statement_keeps_read_only_body_when_edit_capability_is_absent() {
    let source = "> 角色: first\ncontinued body";
    let projection = project_composer_document(source, &catalog()).unwrap();
    let ComposerDocumentNode::Message(message) = &projection.nodes[0] else {
        panic!("multiline statement must remain a Message");
    };
    assert_eq!(message.description.body.current, "first\ncontinued body");
    assert!(message.description.statement_text.is_none());
    assert!(!message.capabilities.set_body);
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
    assert!(projection.boundaries[2].insert.is_none());
}
