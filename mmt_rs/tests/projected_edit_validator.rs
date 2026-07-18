use mmt_rs::{
    EmitOptions, PROJECTED_EDIT_PROTOCOL_VERSION, ProjectedEditDocumentIdentity,
    ProjectedEditEncoding, ProjectedEditFailure, ProjectedEditPosition, ProjectedEditRange,
    ProjectedEditTarget, ProjectedEditTransaction, ProjectedTargetClass, ProjectedTargetVersion,
    ProjectedTextEdit, ProjectionKey, RetainedProjectedDocument, SourceContentKey,
    StaticPresetCatalog, UnsafeEditReason, project_text, validate_projected_edit_transaction,
};

const SOURCE_URI: &str = "file:///workspace/story.mmt";
const VIRTUAL_URI: &str = "mmtfs://projection/story.typ";

fn position(source: &str, offset: usize, encoding: ProjectedEditEncoding) -> ProjectedEditPosition {
    let prefix = &source[..offset];
    let line = prefix.bytes().filter(|byte| *byte == b'\n').count() as u32;
    let start = prefix.rfind('\n').map_or(0, |newline| newline + 1);
    let character = match encoding {
        ProjectedEditEncoding::Utf8 => source[start..offset].len(),
        ProjectedEditEncoding::Utf16 => source[start..offset].encode_utf16().count(),
    } as u32;
    ProjectedEditPosition { line, character }
}

fn edit(source: &str, start: usize, end: usize, text: &str) -> ProjectedTextEdit {
    ProjectedTextEdit {
        virtual_uri: VIRTUAL_URI.into(),
        range: ProjectedEditRange {
            start: position(source, start, ProjectedEditEncoding::Utf16),
            end: position(source, end, ProjectedEditEncoding::Utf16),
        },
        new_text: text.into(),
    }
}

fn transaction(
    edits: Vec<ProjectedTextEdit>,
    expected_uri: &str,
    version: i32,
) -> ProjectedEditTransaction {
    ProjectedEditTransaction {
        protocol_version: PROJECTED_EDIT_PROTOCOL_VERSION,
        documents: vec![ProjectedEditDocumentIdentity {
            virtual_uri: VIRTUAL_URI.into(),
            source_content: SourceContentKey("source-v1".into()),
            projection_key: ProjectionKey("projection-v1".into()),
            encoding: ProjectedEditEncoding::Utf16,
        }],
        edits,
        expected_versions: vec![ProjectedTargetVersion {
            uri: expected_uri.into(),
            version,
        }],
    }
}

#[test]
fn maps_precise_authored_ranges_against_retained_utf16_document() {
    let source = "@typ: #let 名 = \"😀é\"\n";
    let projection = project_text(
        source,
        &StaticPresetCatalog::default(),
        &EmitOptions::default(),
    )
    .unwrap();
    let projected_start = projection.emitted.source.find("名").unwrap();
    let projected_end = projected_start + "名".len();
    let tx = transaction(
        vec![edit(
            &projection.emitted.source,
            projected_start,
            projected_end,
            "标题",
        )],
        SOURCE_URI,
        7,
    );
    let source_key = SourceContentKey("source-v1".into());
    let projection_key = ProjectionKey("projection-v1".into());
    let retained = [RetainedProjectedDocument {
        virtual_uri: VIRTUAL_URI,
        source_content: &source_key,
        projection_key: &projection_key,
        source: &projection.emitted.source,
        index: &projection.index,
        authored_target_uri: SOURCE_URI,
        current: true,
    }];
    let targets = [ProjectedEditTarget {
        uri: SOURCE_URI,
        version: 7,
        class: ProjectedTargetClass::Authored,
        writable: true,
    }];

    let validated = validate_projected_edit_transaction(&tx, &retained, &targets, true).unwrap();
    let authored = source.find("名").unwrap();
    assert_eq!(validated.documents[0].edits[0].range.start, authored);
    assert_eq!(
        validated.documents[0].edits[0].range.end,
        authored + "名".len()
    );
    assert_eq!(validated.documents[0].edits[0].new_text, "标题");
}

#[test]
fn rejects_surrogate_boundary_and_mixed_safe_unsafe_atomically() {
    let source = "@typ: #let x = \"😀\"\n";
    let projection = project_text(
        source,
        &StaticPresetCatalog::default(),
        &EmitOptions::default(),
    )
    .unwrap();
    let x = projection.emitted.source.find("x =").unwrap();
    let emoji = projection.emitted.source.find('😀').unwrap();
    let mut split = edit(
        &projection.emitted.source,
        emoji,
        emoji + '😀'.len_utf8(),
        "bad",
    );
    split.range.start.character += 1;
    let tx = transaction(
        vec![edit(&projection.emitted.source, x, x + 1, "y"), split],
        SOURCE_URI,
        1,
    );
    let source_key = SourceContentKey("source-v1".into());
    let projection_key = ProjectionKey("projection-v1".into());
    let retained = [RetainedProjectedDocument {
        virtual_uri: VIRTUAL_URI,
        source_content: &source_key,
        projection_key: &projection_key,
        source: &projection.emitted.source,
        index: &projection.index,
        authored_target_uri: SOURCE_URI,
        current: true,
    }];
    let targets = [ProjectedEditTarget {
        uri: SOURCE_URI,
        version: 1,
        class: ProjectedTargetClass::Authored,
        writable: true,
    }];

    assert!(matches!(
        validate_projected_edit_transaction(&tx, &retained, &targets, true),
        Err(ProjectedEditFailure::UnsafeEdit {
            reason: UnsafeEditReason::InvalidPosition
        })
    ));
}

#[test]
fn rejects_generated_cross_segment_overlap_and_concurrent_change() {
    let source = "@typ: #let alpha = 1\n";
    let projection = project_text(
        source,
        &StaticPresetCatalog::default(),
        &EmitOptions::default(),
    )
    .unwrap();
    let alpha = projection.emitted.source.find("alpha").unwrap();
    let source_key = SourceContentKey("source-v1".into());
    let projection_key = ProjectionKey("projection-v1".into());
    let retained = [RetainedProjectedDocument {
        virtual_uri: VIRTUAL_URI,
        source_content: &source_key,
        projection_key: &projection_key,
        source: &projection.emitted.source,
        index: &projection.index,
        authored_target_uri: SOURCE_URI,
        current: true,
    }];
    let current = [ProjectedEditTarget {
        uri: SOURCE_URI,
        version: 4,
        class: ProjectedTargetClass::Authored,
        writable: true,
    }];

    let overlapping = transaction(
        vec![
            edit(&projection.emitted.source, alpha, alpha + 3, "a"),
            edit(&projection.emitted.source, alpha + 2, alpha + 5, "b"),
        ],
        SOURCE_URI,
        4,
    );
    assert!(matches!(
        validate_projected_edit_transaction(&overlapping, &retained, &current, true),
        Err(ProjectedEditFailure::UnsafeEdit {
            reason: UnsafeEditReason::OverlappingEdits
        })
    ));

    let stale = transaction(
        vec![edit(&projection.emitted.source, alpha, alpha + 5, "beta")],
        SOURCE_URI,
        3,
    );
    assert!(matches!(
        validate_projected_edit_transaction(&stale, &retained, &current, true),
        Err(ProjectedEditFailure::StaleProjection { .. })
    ));

    let generated = projection
        .index
        .segments()
        .iter()
        .find(|segment| segment.mmt_range.is_none())
        .unwrap()
        .typst_range;
    let unsafe_generated = transaction(
        vec![edit(
            &projection.emitted.source,
            generated.start,
            generated.end.min(generated.start + 1),
            "x",
        )],
        SOURCE_URI,
        4,
    );
    assert!(matches!(
        validate_projected_edit_transaction(&unsafe_generated, &retained, &current, true),
        Err(ProjectedEditFailure::ReadOnlyTarget { .. })
    ));
}

#[test]
fn normalizes_aliases_before_duplicate_and_read_only_checks() {
    let source = "@typ: #let alpha = 1\n";
    let projection = project_text(
        source,
        &StaticPresetCatalog::default(),
        &EmitOptions::default(),
    )
    .unwrap();
    let alpha = projection.emitted.source.find("alpha").unwrap();
    let source_key = SourceContentKey("source-v1".into());
    let projection_key = ProjectionKey("projection-v1".into());
    let retained = [RetainedProjectedDocument {
        virtual_uri: VIRTUAL_URI,
        source_content: &source_key,
        projection_key: &projection_key,
        source: &projection.emitted.source,
        index: &projection.index,
        authored_target_uri: "FILE://localhost/workspace/./story.mmt",
        current: true,
    }];
    let targets = [ProjectedEditTarget {
        uri: SOURCE_URI,
        version: 2,
        class: ProjectedTargetClass::ReadOnlyVirtual,
        writable: false,
    }];
    let tx = transaction(
        vec![edit(&projection.emitted.source, alpha, alpha + 5, "beta")],
        "file:///workspace/%73tory.mmt",
        2,
    );
    assert!(matches!(
        validate_projected_edit_transaction(&tx, &retained, &targets, true),
        Err(ProjectedEditFailure::ReadOnlyTarget { .. })
    ));

    let mut duplicate = tx;
    duplicate.expected_versions.push(ProjectedTargetVersion {
        uri: SOURCE_URI.into(),
        version: 2,
    });
    assert!(matches!(
        validate_projected_edit_transaction(&duplicate, &retained, &targets, true),
        Err(ProjectedEditFailure::UnsafeEdit {
            reason: UnsafeEditReason::DuplicateUri
        })
    ));
}

#[test]
fn distinguishes_capability_read_only_classes_and_utf8_boundaries() {
    let source = "@typ: #let 名 = 1\n";
    let projection = project_text(
        source,
        &StaticPresetCatalog::default(),
        &EmitOptions::default(),
    )
    .unwrap();
    let name = projection.emitted.source.find('名').unwrap();
    let source_key = SourceContentKey("source-v1".into());
    let projection_key = ProjectionKey("projection-v1".into());
    let retained = [RetainedProjectedDocument {
        virtual_uri: VIRTUAL_URI,
        source_content: &source_key,
        projection_key: &projection_key,
        source: &projection.emitted.source,
        index: &projection.index,
        authored_target_uri: SOURCE_URI,
        current: true,
    }];
    let mut tx = transaction(
        vec![edit(
            &projection.emitted.source,
            name,
            name + "名".len(),
            "title",
        )],
        SOURCE_URI,
        8,
    );
    assert!(matches!(
        validate_projected_edit_transaction(&tx, &retained, &[], false),
        Err(ProjectedEditFailure::CapabilityUnavailable)
    ));

    for class in [
        ProjectedTargetClass::Template,
        ProjectedTargetClass::Package,
        ProjectedTargetClass::GeneratedWrapper,
        ProjectedTargetClass::MaterializedResource,
        ProjectedTargetClass::ReadOnlyVirtual,
    ] {
        let targets = [ProjectedEditTarget {
            uri: SOURCE_URI,
            version: 8,
            class,
            writable: false,
        }];
        assert!(matches!(
            validate_projected_edit_transaction(&tx, &retained, &targets, true),
            Err(ProjectedEditFailure::ReadOnlyTarget { .. })
        ));
    }

    tx.documents[0].encoding = ProjectedEditEncoding::Utf8;
    tx.edits[0].range.start = position(
        &projection.emitted.source,
        name,
        ProjectedEditEncoding::Utf8,
    );
    tx.edits[0].range.end = position(
        &projection.emitted.source,
        name + "名".len(),
        ProjectedEditEncoding::Utf8,
    );
    tx.edits[0].range.start.character += 1;
    let targets = [ProjectedEditTarget {
        uri: SOURCE_URI,
        version: 8,
        class: ProjectedTargetClass::Authored,
        writable: true,
    }];
    assert!(matches!(
        validate_projected_edit_transaction(&tx, &retained, &targets, true),
        Err(ProjectedEditFailure::UnsafeEdit {
            reason: UnsafeEditReason::InvalidPosition
        })
    ));
}
