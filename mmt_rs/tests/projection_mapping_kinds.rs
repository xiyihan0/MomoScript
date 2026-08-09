use mmt_rs::ProjectionMappingKind;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    wire_kinds: Vec<String>,
}

#[test]
fn rust_projection_mapping_kinds_match_shared_wire_fixture() {
    let fixture: Fixture =
        serde_json::from_str(include_str!("fixtures/projection-mapping-kinds.json")).unwrap();
    let actual: Vec<String> = [
        ProjectionMappingKind::AuthoredIdentity,
        ProjectionMappingKind::WorkspaceTypst,
        ProjectionMappingKind::PackageFile,
        ProjectionMappingKind::GeneratedProjection,
        ProjectionMappingKind::StaleUnknown,
    ]
    .into_iter()
    .map(|kind| {
        serde_json::to_value(kind)
            .unwrap()
            .as_str()
            .unwrap()
            .to_owned()
    })
    .collect();

    assert_eq!(actual, fixture.wire_kinds);
}
