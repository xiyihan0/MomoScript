use std::collections::HashMap;

use lsp_types::{
    CompletionItem, CompletionTextEdit, Diagnostic, InsertReplaceEdit, Position,
    PositionEncodingKind, Range, TextEdit, Url,
};
use mmt_rs::{
    EmitOptions, MappingMode, PROJECTION_PLACEHOLDER_IMAGE, ProjectionEdit, ProjectionError,
    ProjectionKind, StaticPresetCatalog, TypstProjection, project_text,
};
use serde::{Deserialize, Serialize};

use crate::position::LineIndex;

const EMBEDDED_TEMPLATE_FILES: &[(&str, &str)] = &[
    (
        "typst_sandbox/mmt_render/lib.typ",
        include_str!("../../typst_sandbox/mmt_render/lib.typ"),
    ),
    (
        "typst_sandbox/mmt_render/config.typ",
        include_str!("../../typst_sandbox/mmt_render/config.typ"),
    ),
    (
        "typst_sandbox/mmt_render/template.typ",
        include_str!("../../typst_sandbox/mmt_render/template.typ"),
    ),
    (
        "typst_sandbox/mmt_render/chat.typ",
        include_str!("../../typst_sandbox/mmt_render/chat.typ"),
    ),
    ("typst_sandbox/mmt_render/special.typ", EDITOR_SPECIAL_TYP),
    (
        "typst_sandbox/mmt_render/resource.typ",
        include_str!("../../typst_sandbox/mmt_render/resource.typ"),
    ),
    (
        "typst_sandbox/mmt_render/themes/moetalk.typ",
        include_str!("../../typst_sandbox/mmt_render/themes/moetalk.typ"),
    ),
];

// The production implementation depends on @preview/shadowed and raster
// decorations. Language analysis only needs stable function signatures and
// content flow, so the virtual project uses an I/O-free facade.
const EDITOR_SPECIAL_TYP: &str = r#"
#let narration(fill: auto, text-fill: auto, inset: auto, radius: auto, body) = body

#let reply(
  label: [回复],
  fill: rgb("e1edf0"),
  accent: rgb("4b6989"),
  decoration: none,
  ..items,
) = items.pos()

#let bond(
  label: [羁绊事件],
  fill: rgb("fc879b"),
  text-fill: white,
  decoration: none,
  body,
) = body
"#;

const EDITOR_PLACEHOLDER_SVG: &str =
    r#"<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" viewBox="0 0 1 1"/>"#;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypstVirtualFile {
    pub uri: Url,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypstProjectUpdate {
    pub source_uri: Url,
    pub source_version: i32,
    pub revision: u64,
    pub entry_uri: Url,
    pub files: Vec<TypstVirtualFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedPosition {
    pub revision: u64,
    pub entry_uri: Url,
    pub position: Position,
}

#[derive(Debug, Clone)]
pub struct ProjectionDocument {
    pub source_uri: Url,
    pub source_version: i32,
    pub revision: u64,
    pub entry_uri: Url,
    pub source: String,
    pub projection: TypstProjection,
    source_lines: LineIndex,
    typst_lines: LineIndex,
}

impl ProjectionDocument {
    pub fn project_update(&self) -> TypstProjectUpdate {
        let mut files = EMBEDDED_TEMPLATE_FILES
            .iter()
            .map(|(path, text)| TypstVirtualFile {
                uri: self
                    .entry_uri
                    .join(path)
                    .expect("embedded template path forms a valid virtual URI"),
                text: (*text).to_string(),
            })
            .collect::<Vec<_>>();
        files.push(TypstVirtualFile {
            uri: self
                .entry_uri
                .join(PROJECTION_PLACEHOLDER_IMAGE)
                .expect("placeholder path forms a valid virtual URI"),
            text: EDITOR_PLACEHOLDER_SVG.to_string(),
        });
        // Open the entry last so the backend's first analysis sees its complete
        // local import graph instead of caching a transient missing-file world.
        files.push(TypstVirtualFile {
            uri: self.entry_uri.clone(),
            text: self.projection.emitted.source.clone(),
        });
        TypstProjectUpdate {
            source_uri: self.source_uri.clone(),
            source_version: self.source_version,
            revision: self.revision,
            entry_uri: self.entry_uri.clone(),
            files,
        }
    }

    pub fn mmt_position_to_typst(
        &self,
        position: Position,
        encoding: &PositionEncodingKind,
    ) -> Option<Position> {
        let mmt_offset = self.source_lines.offset(&self.source, position, encoding)?;
        let typst_offset = self.projection.index.mmt_to_typst(mmt_offset)?;
        self.typst_lines
            .position(&self.projection.emitted.source, typst_offset, encoding)
    }

    pub fn typst_range_to_mmt(
        &self,
        range: Range,
        encoding: &PositionEncodingKind,
    ) -> Option<Range> {
        let typst_range = mmt_rs::source::TextRange::new(
            self.typst_lines
                .offset(&self.projection.emitted.source, range.start, encoding)?,
            self.typst_lines
                .offset(&self.projection.emitted.source, range.end, encoding)?,
        );
        let mmt_range = self.projection.index.typst_to_mmt(typst_range)?;
        self.source_lines.range(&self.source, mmt_range, encoding)
    }

    pub fn typst_edit_to_mmt(
        &self,
        edit: TextEdit,
        encoding: &PositionEncodingKind,
    ) -> Option<TextEdit> {
        let typst_range = mmt_rs::source::TextRange::new(
            self.typst_lines
                .offset(&self.projection.emitted.source, edit.range.start, encoding)?,
            self.typst_lines
                .offset(&self.projection.emitted.source, edit.range.end, encoding)?,
        );
        let mapped = self
            .projection
            .index
            .map_text_edit(&ProjectionEdit {
                range: typst_range,
                new_text: edit.new_text,
            })
            .ok()?;
        Some(TextEdit {
            range: self
                .source_lines
                .range(&self.source, mapped.range, encoding)?,
            new_text: mapped.new_text,
        })
    }

    pub fn map_completion_item(
        &self,
        mut item: CompletionItem,
        encoding: &PositionEncodingKind,
    ) -> Option<CompletionItem> {
        item.text_edit = match item.text_edit {
            Some(CompletionTextEdit::Edit(edit)) => Some(CompletionTextEdit::Edit(
                self.typst_edit_to_mmt(edit, encoding)?,
            )),
            Some(CompletionTextEdit::InsertAndReplace(edit)) => {
                let insert = self.typst_range_to_mmt(edit.insert, encoding)?;
                let replace = self.typst_range_to_mmt(edit.replace, encoding)?;
                Some(CompletionTextEdit::InsertAndReplace(InsertReplaceEdit {
                    new_text: edit.new_text,
                    insert,
                    replace,
                }))
            }
            None => None,
        };
        if let Some(edits) = item.additional_text_edits.take() {
            item.additional_text_edits = Some(
                edits
                    .into_iter()
                    .map(|edit| self.typst_edit_to_mmt(edit, encoding))
                    .collect::<Option<Vec<_>>>()?,
            );
        }
        Some(item)
    }

    pub fn map_diagnostic(
        &self,
        mut diagnostic: Diagnostic,
        encoding: &PositionEncodingKind,
    ) -> Option<Diagnostic> {
        diagnostic.range = self.typst_diagnostic_range_to_mmt(diagnostic.range, encoding)?;
        diagnostic.related_information = diagnostic.related_information.map(|information| {
            information
                .into_iter()
                .filter_map(|mut related| {
                    if related.location.uri != self.entry_uri {
                        return None;
                    }
                    related.location.uri = self.source_uri.clone();
                    related.location.range =
                        self.typst_range_to_mmt(related.location.range, encoding)?;
                    Some(related)
                })
                .collect()
        });
        diagnostic.source = Some("typst".to_string());
        Some(diagnostic)
    }

    fn typst_diagnostic_range_to_mmt(
        &self,
        range: Range,
        encoding: &PositionEncodingKind,
    ) -> Option<Range> {
        let typst_range = mmt_rs::source::TextRange::new(
            self.typst_lines
                .offset(&self.projection.emitted.source, range.start, encoding)?,
            self.typst_lines
                .offset(&self.projection.emitted.source, range.end, encoding)?,
        );
        if let Some(mapped) = self.projection.index.typst_to_mmt(typst_range) {
            return self.source_lines.range(&self.source, mapped, encoding);
        }

        // Semantic diagnostics can include generated call wrappers. Prefer the
        // authored patch inside that span instead of dropping the diagnostic.
        let mut authored = self.projection.index.segments().iter().filter(|segment| {
            segment.mapping == MappingMode::Identity
                && matches!(
                    segment.kind,
                    ProjectionKind::StatementPatch | ProjectionKind::ResourcePatch
                )
                && segment.typst_range.start < typst_range.end
                && typst_range.start < segment.typst_range.end
        });
        let segment = authored.next()?;
        if authored.next().is_some() {
            return None;
        }
        let overlap = mmt_rs::source::TextRange::new(
            segment.typst_range.start.max(typst_range.start),
            segment.typst_range.end.min(typst_range.end),
        );
        let mapped = self.projection.index.typst_to_mmt(overlap)?;
        self.source_lines.range(&self.source, mapped, encoding)
    }
}

#[derive(Debug, Default)]
pub struct ProjectionStore {
    documents: HashMap<Url, ProjectionDocument>,
}

impl ProjectionStore {
    pub fn upsert(
        &mut self,
        source_uri: Url,
        source_version: i32,
        revision: u64,
        source: String,
    ) -> Result<&ProjectionDocument, ProjectionError> {
        let entry_uri = virtual_entry_uri(&source_uri);
        let projection = project_text(
            &source,
            &StaticPresetCatalog::default(),
            &EmitOptions::default(),
        )?;
        let source_lines = LineIndex::new(&source);
        let typst_lines = LineIndex::new(&projection.emitted.source);
        self.documents.insert(
            source_uri.clone(),
            ProjectionDocument {
                source_uri: source_uri.clone(),
                source_version,
                revision,
                entry_uri,
                source,
                projection,
                source_lines,
                typst_lines,
            },
        );
        Ok(&self.documents[&source_uri])
    }

    pub fn get(&self, source_uri: &Url) -> Option<&ProjectionDocument> {
        self.documents.get(source_uri)
    }

    pub fn remove(&mut self, source_uri: &Url) {
        self.documents.remove(source_uri);
    }

    pub fn project_position(
        &self,
        source_uri: &Url,
        position: Position,
        encoding: &PositionEncodingKind,
    ) -> Option<ProjectedPosition> {
        let document = self.get(source_uri)?;
        Some(ProjectedPosition {
            revision: document.revision,
            entry_uri: document.entry_uri.clone(),
            position: document.mmt_position_to_typst(position, encoding)?,
        })
    }
}

fn virtual_entry_uri(source_uri: &Url) -> Url {
    let identity = source_uri
        .as_str()
        .as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Url::parse(&format!("untitled:/mmt-projection/{identity}/main.typ"))
        .expect("hex-encoded source URI always forms a valid virtual URI")
}

#[cfg(test)]
mod tests {

    use super::*;

    fn uri() -> Url {
        Url::parse("file:///workspace/example.mmt").unwrap()
    }

    fn catalog() -> StaticPresetCatalog {
        StaticPresetCatalog::new(vec![mmt_rs::CharacterPreset {
            id: "ba::柚子".to_string(),
            names: vec!["柚子".to_string()],
            display_name: Some("柚子".to_string()),
            avatar: None,
        }])
    }

    #[test]
    fn maps_only_identity_positions_and_edits() {
        let source = "@typ: #let accent = blue".to_string();
        let mut store = ProjectionStore::default();
        let document = store.upsert(uri(), 1, 7, source.clone()).unwrap();
        let offset = source.find("accent").unwrap();
        let position = LineIndex::new(&source)
            .position(&source, offset, &PositionEncodingKind::UTF16)
            .unwrap();
        let projected = document
            .mmt_position_to_typst(position, &PositionEncodingKind::UTF16)
            .unwrap();
        let edit = document
            .typst_edit_to_mmt(
                TextEdit::new(Range::new(projected, projected), "theme".to_string()),
                &PositionEncodingKind::UTF16,
            )
            .unwrap();
        assert_eq!(edit.range.start, position);

        let generated = Range::new(Position::new(0, 0), Position::new(0, 0));
        assert!(
            document
                .typst_range_to_mmt(generated, &PositionEncodingKind::UTF16)
                .is_none()
        );

        let completion = document
            .map_completion_item(
                CompletionItem {
                    label: "theme".to_string(),
                    text_edit: Some(CompletionTextEdit::Edit(TextEdit::new(
                        Range::new(projected, projected),
                        "theme".to_string(),
                    ))),
                    ..CompletionItem::default()
                },
                &PositionEncodingKind::UTF16,
            )
            .unwrap();
        let Some(CompletionTextEdit::Edit(completion_edit)) = completion.text_edit else {
            panic!("mapped completion must preserve a simple text edit");
        };
        assert_eq!(completion_edit.range.start, position);

        let diagnostic = document
            .map_diagnostic(
                Diagnostic::new_simple(Range::new(projected, projected), "Typst error".to_string()),
                &PositionEncodingKind::UTF16,
            )
            .unwrap();
        assert_eq!(diagnostic.range.start, position);
        assert_eq!(diagnostic.source.as_deref(), Some("typst"));
    }

    #[test]
    fn virtual_entry_uri_is_stable_across_revisions() {
        let mut store = ProjectionStore::default();
        let first = store
            .upsert(uri(), 1, 1, "@typ: #let x = 1".to_string())
            .unwrap()
            .entry_uri
            .clone();
        let second = store
            .upsert(uri(), 2, 2, "@typ: #let x = 2".to_string())
            .unwrap()
            .entry_uri
            .clone();
        assert_eq!(first, second);
    }

    #[test]
    fn project_update_contains_the_embedded_template_import_graph() {
        let mut store = ProjectionStore::default();
        let update = store
            .upsert(uri(), 1, 1, "@typ: #let x = 1".to_string())
            .unwrap()
            .project_update();
        let paths = update
            .files
            .iter()
            .map(|file| file.uri.path().to_string())
            .collect::<Vec<_>>();
        let wire = serde_json::to_value(&update).unwrap();
        assert_eq!(wire["sourceVersion"], 1);
        assert!(wire.get("source_version").is_none());
        assert_eq!(wire["entryUri"], update.entry_uri.as_str());
        assert_eq!(update.files.len(), 2 + EMBEDDED_TEMPLATE_FILES.len());
        assert_eq!(update.files.last().unwrap().uri, update.entry_uri);
        assert!(
            paths
                .iter()
                .any(|path| path.ends_with("typst_sandbox/mmt_render/lib.typ"))
        );
        assert!(
            paths
                .iter()
                .any(|path| path.ends_with("typst_sandbox/mmt_render/themes/moetalk.typ"))
        );
        assert!(
            paths
                .iter()
                .any(|path| path.ends_with(PROJECTION_PLACEHOLDER_IMAGE))
        );
    }

    #[test]
    fn recovery_fixtures_route_only_typst_identity_regions() {
        let fixtures = [
            ("@typ\n#let greet(name) = [Hello #name]\n#gre", "#gre"),
            ("- T\"\"\"#stro\"\"\"", "#stro"),
            (">(fill: gre) 柚子: hello", "gre"),
            (
                "@asset: hero src:https://example.com/a.png\n- T\"\"\"[:asset, hero:](width: 2em) #stro\"\"\"",
                "#stro",
            ),
        ];
        for (index, (source, needle)) in fixtures.into_iter().enumerate() {
            let projection = project_text(source, &catalog(), &EmitOptions::default()).unwrap();
            let offset = source.rfind(needle).unwrap() + needle.len();
            assert!(
                projection.index.mmt_to_typst(offset).is_some(),
                "fixture {index} did not preserve the Typst cursor: {:#?}\n{}",
                projection.index.segments(),
                projection.emitted.source,
            );
        }

        let narration_patch = "-(fill: gre) hello";
        let projection = project_text(
            narration_patch,
            &StaticPresetCatalog::default(),
            &EmitOptions::default(),
        )
        .unwrap();
        let patch_cursor = narration_patch.find("gre").unwrap() + "gre".len();
        assert!(projection.index.mmt_to_typst(patch_cursor).is_some());

        let overlay = "@asset: hero src:https://example.com/a.png\n- T\"\"\"[:asset, hero:] #strong[ok]\"\"\"";
        let marker_offset = overlay.find("asset, hero").unwrap();
        let projection = project_text(overlay, &catalog(), &EmitOptions::default()).unwrap();
        assert!(
            projection.index.mmt_to_typst(marker_offset).is_none(),
            "overlay selector must remain owned by the MMT provider"
        );

        let completion_start = overlay.find("#strong").unwrap();
        let completion_end = completion_start + "#strong".len();
        let typst_range = mmt_rs::source::TextRange::new(
            projection.index.mmt_to_typst(completion_start).unwrap(),
            projection.index.mmt_to_typst(completion_end).unwrap(),
        );
        let mapped = projection
            .index
            .map_text_edit(&ProjectionEdit {
                range: typst_range,
                new_text: "#strong".to_string(),
            })
            .unwrap();
        assert_eq!(mapped.range.start, completion_start);
        assert_eq!(mapped.range.end, completion_end);
        assert!(mapped.range.start > overlay.find(":]").unwrap() + 2);
    }

    #[test]
    fn maps_wrapper_spanning_diagnostic_to_its_resource_patch() {
        let source = "@asset: hero src:https://example.com/a.png\n- T\"\"\"[:asset, hero:](width: mmt.missing-style-token)\"\"\"";
        let mut store = ProjectionStore::default();
        let document = store.upsert(uri(), 1, 1, source.to_string()).unwrap();
        let generated_start = document
            .projection
            .emitted
            .source
            .find("#mmt.sticker")
            .unwrap();
        let generated_end = document
            .projection
            .emitted
            .source
            .find("mmt.missing-style-token")
            .unwrap()
            + "mmt.missing-style-token".len();
        let generated_range = document
            .typst_lines
            .range(
                &document.projection.emitted.source,
                mmt_rs::source::TextRange::new(generated_start, generated_end),
                &PositionEncodingKind::UTF16,
            )
            .unwrap();
        let mapped = document
            .map_diagnostic(
                Diagnostic::new_simple(generated_range, "unknown field".to_string()),
                &PositionEncodingKind::UTF16,
            )
            .unwrap();
        let mapped = mmt_rs::source::TextRange::new(
            document
                .source_lines
                .offset(
                    &document.source,
                    mapped.range.start,
                    &PositionEncodingKind::UTF16,
                )
                .unwrap(),
            document
                .source_lines
                .offset(
                    &document.source,
                    mapped.range.end,
                    &PositionEncodingKind::UTF16,
                )
                .unwrap(),
        );
        assert_eq!(
            &source[mapped.start..mapped.end],
            "width: mmt.missing-style-token"
        );
    }
}
