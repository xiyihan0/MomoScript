use std::collections::BTreeMap;

use mmt_rs::{
    LogicalProjectFileId, ProjectDigestInput, canonical_bytes_digest, canonical_relative_path,
    derived_key, logical_source_id, materialization_key, project_snapshot_key, projection_key,
    render_key, runtime_artifact_key, source_content_key,
};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    workspace_id: String,
    relative_path: String,
    mount_uris: Vec<String>,
    source: String,
    expected: Expected,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Expected {
    logical_source: String,
    source_content: String,
    project: String,
    projection: String,
    materialization: String,
    runtime: String,
    render: String,
}

#[test]
fn rust_and_typescript_share_canonical_logical_identity_fixture() {
    let fixture: Fixture =
        serde_json::from_str(include_str!("fixtures/runtime-identity.json")).unwrap();
    let logical_source = logical_source_id(&fixture.workspace_id, &fixture.relative_path).unwrap();
    let source_content = source_content_key(&logical_source, fixture.source.as_bytes());
    let entry_file =
        LogicalProjectFileId::generated("authored", "producer-v1", "main.typ").unwrap();
    let files = BTreeMap::from([
        (
            entry_file.clone(),
            canonical_bytes_digest("mmt-file-v1", &[b"hello"]),
        ),
        (
            LogicalProjectFileId::workspace(&fixture.workspace_id, "assets/avatar.png").unwrap(),
            canonical_bytes_digest("mmt-file-v1", &[b"png"]),
        ),
        (
            LogicalProjectFileId::package("preview", "theme", "1.0.0", "pack-gen", "lib.typ")
                .unwrap(),
            canonical_bytes_digest("mmt-file-v1", &[b"theme"]),
        ),
    ]);
    let mapping_digest = derived_key("mmt-source-map-v1", &["identity"]);
    let project = project_snapshot_key(&ProjectDigestInput {
        logical_source: logical_source.clone(),
        source_content: source_content.clone(),
        entry_file: entry_file.clone(),
        files,
        package_generations: BTreeMap::from([("preview/theme:1.0.0".into(), "pack-gen".into())]),
        generated_dependencies: BTreeMap::from([("template".into(), "template-gen".into())]),
        project_options: BTreeMap::from([("compiledAt".into(), "none".into())]),
        source_map_digest: mapping_digest.clone(),
    });
    let projection = projection_key(
        &source_content,
        "session-a",
        7,
        &entry_file,
        &project,
        &mapping_digest,
    );
    let materialization = materialization_key(&projection, "pack", "plan", "bytes");
    let runtime = runtime_artifact_key("0.15.2", "compiler-wasm", "template", "fonts");
    let render = render_key(&materialization, &runtime, "options");

    assert_eq!(logical_source.0, fixture.expected.logical_source);
    assert_eq!(source_content.0, fixture.expected.source_content);
    assert_eq!(project.0, fixture.expected.project);
    assert_eq!(projection.0, fixture.expected.projection);
    assert_eq!(materialization.0, fixture.expected.materialization);
    assert_eq!(runtime.0, fixture.expected.runtime);
    assert_eq!(render.0, fixture.expected.render);
    for uri in fixture.mount_uris {
        assert!(
            canonical_relative_path(&uri).is_err(),
            "presentation URI entered canonical serializer: {uri}"
        );
    }
}
