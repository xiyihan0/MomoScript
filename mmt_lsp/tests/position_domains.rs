use lsp_types::{Position, Url};
use mmt_lsp::{LanguageService, ProjectionStore};
use mmt_lsp::position::{
    LineIndex, MmtClientPosition, PositionConversionError, PositionEncoding,
};
use serde::Deserialize;

#[derive(Deserialize)]
struct Fixture {
    text: String,
    boundaries: Vec<Boundary>,
    families: Vec<String>,
}

#[derive(Deserialize)]
struct Boundary {
    line: u32,
    utf8: u32,
    utf16: u32,
}

#[test]
fn shared_unicode_fixture_round_trips_every_position_family() {
    let fixture: Fixture = serde_json::from_str(include_str!("fixtures/position-domains.json")).unwrap();
    let index = LineIndex::new(&fixture.text);
    for boundary in &fixture.boundaries {
        let client = MmtClientPosition::new(Position::new(boundary.line, boundary.utf8));
        let byte = index.mmt_offset(client, PositionEncoding::Utf8).unwrap();
        let backend = index.backend_position(byte, PositionEncoding::Utf16).unwrap();
        assert_eq!(backend.into_lsp(), Position::new(boundary.line, boundary.utf16));
        let returned = index.backend_offset(backend, PositionEncoding::Utf16).unwrap();
        assert_eq!(
            index.mmt_position(returned, PositionEncoding::Utf8).unwrap().into_lsp(),
            client.into_lsp()
        );
    }

    assert_eq!(
        fixture.families,
        [
            "request",
            "location",
            "range",
            "edit",
            "diagnostic",
            "symbol",
            "selectionRange",
            "previewNavigation",
        ]
    );
}

#[test]
fn retained_generation_lookup_distinguishes_stale_mismatch_and_absence() {
    let uri = Url::parse("file:///workspace/unicode.mmt").unwrap();
    let mut service = LanguageService::default();
    let first = service.open(uri.clone(), 1, "@typ: #let 中文 = [é 😀]".into()).clone();
    let mut store = ProjectionStore::default();
    let first_projection = store.upsert(uri.clone(), &first).unwrap();
    let first_entry = first_projection.entry_uri.clone();
    let first_revision = first_projection.revision;

    let second = service.change(uri.clone(), 2, "@typ: #let 中文 = [é 😀 next]".into()).unwrap().clone();
    store.upsert(uri.clone(), &second).unwrap();

    assert_eq!(
        store.response_generation(&uri, &first_entry, first_revision).unwrap_err(),
        PositionConversionError::StaleProjection
    );
    assert_eq!(store.generation(&uri, &first_entry, first_revision).unwrap().revision, first_revision);
    assert_eq!(
        store.generation(&uri, &Url::parse("untitled:/wrong.typ").unwrap(), first_revision).unwrap_err(),
        PositionConversionError::ProjectionMismatch
    );
    assert_eq!(
        store.generation(&uri, &Url::parse("untitled:/missing.typ").unwrap(), 999).unwrap_err(),
        PositionConversionError::AbsentGeneration
    );
}
