use base64::Engine;
use std::collections::HashMap;

use lsp_types::{
    CompletionItem, CompletionTextEdit, Diagnostic, InsertReplaceEdit, Position,
    PositionEncodingKind, Range, TextEdit, Url,
};
#[cfg(test)]
use mmt_rs::StaticPresetCatalog;
use mmt_rs::{
    EmitOptions, MappingMode, PROJECTION_PLACEHOLDER_IMAGE, ProjectionEdit, ProjectionError,
    ProjectionKind, TypstProjection, project_text,
};
use serde::{Deserialize, Serialize};

use crate::position::LineIndex;

const EMBEDDED_TEMPLATE_TEXT_FILES: &[(&str, &str)] = &[
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
    (
        "typst_sandbox/mmt_render/special.typ",
        include_str!("../../typst_sandbox/mmt_render/special.typ"),
    ),
    (
        "typst_sandbox/mmt_render/resource.typ",
        include_str!("../../typst_sandbox/mmt_render/resource.typ"),
    ),
    (
        "typst_sandbox/mmt_render/themes/moetalk.typ",
        include_str!("../../typst_sandbox/mmt_render/themes/moetalk.typ"),
    ),
    (
        "typst_sandbox/mmt_render/vendor/shadowed/src/lib.typ",
        include_str!("../../typst_sandbox/mmt_render/vendor/shadowed/src/lib.typ"),
    ),
    (
        "typst_sandbox/mmt_render/vendor/shadowed/src/shadowed.typ",
        include_str!("../../typst_sandbox/mmt_render/vendor/shadowed/src/shadowed.typ"),
    ),
];

const EMBEDDED_TEMPLATE_BINARY_FILES: &[(&str, &[u8])] = &[
    (
        "typst_sandbox/mmt_render/mmt_options.webp",
        include_bytes!("../../typst_sandbox/mmt_render/mmt_options.webp"),
    ),
    (
        "typst_sandbox/mmt_render/mmt_favor.webp",
        include_bytes!("../../typst_sandbox/mmt_render/mmt_favor.webp"),
    ),
    (
        "typst_sandbox/mmt_render/vendor/shadowed/src/renderer.wasm",
        include_bytes!("../../typst_sandbox/mmt_render/vendor/shadowed/src/renderer.wasm"),
    ),
];

const EDITOR_PLACEHOLDER_SVG: &str =
    r#"<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" viewBox="0 0 1 1"/>"#;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypstVirtualFile {
    pub uri: Url,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_base64: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum TypstResourceRequest {
    ImageDir {
        id: usize,
        uri: Url,
        pack_namespace: String,
        base: String,
        file_name: String,
        range: Range,
    },
    WorkspaceFile {
        id: usize,
        uri: Url,
        file_name: String,
        range: Range,
    },
    ImageSequence {
        id: usize,
        uri: Url,
        pack_namespace: String,
        path: String,
        frame: u32,
        sha256: String,
        size: [u32; 2],
        frame_count: u32,
        container: String,
        codec: String,
        alpha: bool,
        profile: serde_json::Value,
        range: Range,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypstRenderDiagnosticLabel {
    pub range: Range,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypstRenderDiagnostic {
    pub severity: String,
    pub phase: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<Range>,
    pub labels: Vec<TypstRenderDiagnosticLabel>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypstProjectUpdate {
    pub source_uri: Url,
    /// LSP version of the authored MMT document.
    pub source_version: i32,
    /// Monotonic virtual Typst projection version; advances on every rebuild.
    pub revision: u64,
    pub entry_uri: Url,
    pub files: Vec<TypstVirtualFile>,
    pub full: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypstRenderProjectUpdate {
    pub source_uri: Url,
    /// LSP version of the authored MMT document.
    pub source_version: i32,
    /// Monotonic virtual Typst projection version; advances on every rebuild.
    pub revision: u64,
    pub entry_uri: Url,
    pub files: Vec<TypstVirtualFile>,
    pub full: bool,
    pub resources: Vec<TypstResourceRequest>,
    pub diagnostics: Vec<TypstRenderDiagnostic>,
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
        self.project_update_with_template(true)
    }

    pub fn project_delta(&self) -> TypstProjectUpdate {
        self.project_update_with_template(false)
    }

    fn project_update_with_template(&self, include_template: bool) -> TypstProjectUpdate {
        let mut files = Vec::new();
        if include_template {
            files.extend(EMBEDDED_TEMPLATE_TEXT_FILES.iter().map(|(path, text)| {
                TypstVirtualFile {
                    uri: self
                        .entry_uri
                        .join(path)
                        .expect("embedded template path forms a valid virtual URI"),
                    text: Some((*text).to_string()),
                    data_base64: None,
                }
            }));
            files.extend(EMBEDDED_TEMPLATE_BINARY_FILES.iter().map(|(path, data)| {
                TypstVirtualFile {
                    uri: self
                        .entry_uri
                        .join(path)
                        .expect("embedded template path forms a valid virtual URI"),
                    text: None,
                    data_base64: Some(base64::engine::general_purpose::STANDARD.encode(data)),
                }
            }));
            files.push(TypstVirtualFile {
                uri: self
                    .entry_uri
                    .join(PROJECTION_PLACEHOLDER_IMAGE)
                    .expect("placeholder path forms a valid virtual URI"),
                text: Some(EDITOR_PLACEHOLDER_SVG.to_string()),
                data_base64: None,
            });
        }
        files.push(TypstVirtualFile {
            uri: self.entry_uri.clone(),
            text: Some(self.projection.emitted.source.clone()),
            data_base64: None,
        });
        TypstProjectUpdate {
            source_uri: self.source_uri.clone(),
            source_version: self.source_version,
            revision: self.revision,
            entry_uri: self.entry_uri.clone(),
            files,
            full: include_template,
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

fn render_diagnostics(
    source: &str,
    source_lines: &LineIndex,
    diagnostics: &[mmt_rs::diag::Diagnostic],
) -> Vec<TypstRenderDiagnostic> {
    diagnostics
        .iter()
        .map(|diagnostic| TypstRenderDiagnostic {
            severity: match diagnostic.severity {
                mmt_rs::diag::Severity::Error => "error",
                mmt_rs::diag::Severity::Warning => "warning",
                mmt_rs::diag::Severity::Info => "info",
            }
            .to_string(),
            phase: match diagnostic.phase {
                mmt_rs::diag::DiagnosticPhase::Syntax => "syntax",
                mmt_rs::diag::DiagnosticPhase::Semantic => "semantic",
                mmt_rs::diag::DiagnosticPhase::Resolve => "resolve",
                mmt_rs::diag::DiagnosticPhase::Materialize => "materialize",
                mmt_rs::diag::DiagnosticPhase::Typst => "typst",
            }
            .to_string(),
            message: diagnostic.message.clone(),
            range: diagnostic.range.and_then(|range| {
                source_lines.range(source, range, &PositionEncodingKind::UTF16)
            }),
            labels: diagnostic
                .labels
                .iter()
                .filter_map(|label| {
                    Some(TypstRenderDiagnosticLabel {
                        range: source_lines.range(
                            source,
                            label.range,
                            &PositionEncodingKind::UTF16,
                        )?,
                        message: label.message.clone(),
                    })
                })
                .collect(),
        })
        .collect()
}

pub fn build_render_project(
    source_uri: Url,
    source_version: i32,
    revision: u64,
    entry_uri: Url,
    source: &str,
    packs: &mmt_rs::pack::PackRegistry,
    timestamp: Option<mmt_rs::HostTimestamp>,
) -> Result<TypstRenderProjectUpdate, ProjectionError> {
    let projection = mmt_rs::project_text_with_pack(
        source,
        packs,
        &EmitOptions {
            timestamp,
            ..EmitOptions::default()
        },
    )?;
    let source_lines = LineIndex::new(source);
    let mut files = EMBEDDED_TEMPLATE_TEXT_FILES
        .iter()
        .map(|(path, text)| TypstVirtualFile {
            uri: entry_uri
                .join(path)
                .expect("embedded template path forms a valid virtual URI"),
            text: Some((*text).to_string()),
            data_base64: None,
        })
        .collect::<Vec<_>>();
    files.extend(EMBEDDED_TEMPLATE_BINARY_FILES.iter().map(|(path, data)| {
        TypstVirtualFile {
            uri: entry_uri
                .join(path)
                .expect("embedded template path forms a valid virtual URI"),
            text: None,
            data_base64: Some(base64::engine::general_purpose::STANDARD.encode(data)),
        }
    }));
    files.push(TypstVirtualFile {
        uri: entry_uri.clone(),
        text: Some(projection.emitted.source.clone()),
        data_base64: None,
    });
    let resources = projection
        .resources
        .iter()
        .enumerate()
        .map(|(id, resource)| {
            let uri = entry_uri
                .join(&resource.typst_path)
                .expect("resource path forms a valid virtual URI");
            let range = source_lines
                .range(source, resource.range, &PositionEncodingKind::UTF16)
                .expect("resource range belongs to source");
            match &resource.source {
                mmt_rs::ProjectedResourceSource::ImageDir { base, file_name } => {
                    TypstResourceRequest::ImageDir {
                        id,
                        uri,
                        pack_namespace: resource.pack_namespace.clone(),
                        base: base.clone(),
                        file_name: file_name.clone(),
                        range,
                    }
                }
                mmt_rs::ProjectedResourceSource::ImageSequence {
                    path,
                    frame,
                    sha256,
                    size,
                    frame_count,
                    container,
                    codec,
                    alpha,
                    profile,
                } => TypstResourceRequest::ImageSequence {
                    id,
                    uri,
                    pack_namespace: resource.pack_namespace.clone(),
                    path: path.clone(),
                    frame: *frame,
                    sha256: sha256.clone(),
                    size: *size,
                    frame_count: *frame_count,
                    container: container.clone(),
                    codec: codec.clone(),
                    alpha: *alpha,
                    profile: profile.clone(),
                    range,
                },
                mmt_rs::ProjectedResourceSource::WorkspaceFile { file_name } => {
                    TypstResourceRequest::WorkspaceFile {
                        id,
                        uri,
                        file_name: file_name.clone(),
                        range,
                    }
                }
            }
        })
        .collect();
    let diagnostics = render_diagnostics(source, &source_lines, &projection.diagnostics);
    Ok(TypstRenderProjectUpdate {
        source_uri,
        source_version,
        revision,
        entry_uri,
        full: true,
        files,
        resources,
        diagnostics,
    })
}

#[derive(Debug)]
pub struct ProjectionStore {
    documents: HashMap<Url, ProjectionDocument>,
    session_id: String,
    next_revision: u64,
}

impl Default for ProjectionStore {
    fn default() -> Self {
        Self {
            documents: HashMap::new(),
            next_revision: 1,
            session_id: uuid::Uuid::new_v4().simple().to_string(),
        }
    }
}

impl ProjectionStore {
    pub fn upsert(
        &mut self,
        source_uri: Url,
        source_version: i32,
        source: String,
        catalog: &impl mmt_rs::CharacterPresetCatalog,
    ) -> Result<&ProjectionDocument, ProjectionError> {
        let revision = self.next_revision;
        self.next_revision = self
            .next_revision
            .checked_add(1)
            .expect("Typst projection revision overflow");
        let entry_uri = virtual_entry_uri(&source_uri, &self.session_id, revision);
        let projection = project_text(&source, catalog, &EmitOptions::default())?;
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

fn virtual_entry_uri(source_uri: &Url, session_id: &str, revision: u64) -> Url {
    let identity = source_uri
        .as_str()
        .as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Url::parse(&format!(
        "untitled:/mmt-projection/{identity}/{session_id}/main-{revision}.typ"
    ))
    .expect("hex-encoded source URI, UUID session, and numeric revision form a valid virtual URI")
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
        let document = store
            .upsert(uri(), 1, source.clone(), &StaticPresetCatalog::default())
            .unwrap();
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
    fn virtual_entry_uri_is_revision_scoped_with_a_stable_project_root() {
        let mut store = ProjectionStore::default();
        let first = store
            .upsert(
                uri(),
                1,
                "@typ: #let x = 1".to_string(),
                &StaticPresetCatalog::default(),
            )
            .unwrap();
        let first_entry = first.entry_uri.clone();
        let first_template = first_entry
            .join("typst_sandbox/mmt_render/lib.typ")
            .unwrap();
        let first_revision = first.revision;
        let second = store
            .upsert(
                uri(),
                1,
                "@typ: #let x = 2".to_string(),
                &StaticPresetCatalog::default(),
            )
            .unwrap();
        let second_template = second
            .entry_uri
            .join("typst_sandbox/mmt_render/lib.typ")
            .unwrap();
        assert_ne!(first_entry, second.entry_uri);
        assert_eq!(first_template, second_template);
        assert_eq!(second.source_version, 1);
        assert!(second.revision > first_revision);
        let mut next_session = ProjectionStore::default();
        let next_session_entry = next_session
            .upsert(
                uri(),
                1,
                "@typ: #let x = 3".to_string(),
                &StaticPresetCatalog::default(),
            )
            .unwrap()
            .entry_uri
            .clone();
        let first_root = first_entry.as_str().rsplit_once('/').unwrap().0;
        let next_root = next_session_entry.as_str().rsplit_once('/').unwrap().0;
        assert_ne!(first_root, next_root);
    }

    #[test]
    fn project_update_contains_the_embedded_template_import_graph() {
        let mut store = ProjectionStore::default();
        let update = store
            .upsert(
                uri(),
                1,
                "@typ: #let x = 1".to_string(),
                &StaticPresetCatalog::default(),
            )
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
        assert_eq!(
            update.files.len(),
            2 + EMBEDDED_TEMPLATE_TEXT_FILES.len() + EMBEDDED_TEMPLATE_BINARY_FILES.len()
        );
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
        assert!(update.full);
        assert!(
            update
                .files
                .iter()
                .any(|file| file.uri.path().ends_with("special.typ")
                    && file.text.as_deref()
                        == Some(include_str!("../../typst_sandbox/mmt_render/special.typ")))
        );
        assert!(update.files.iter().any(
            |file| file.uri.path().ends_with("mmt_options.webp") && file.data_base64.is_some()
        ));
        let delta = store.get(&uri()).unwrap().project_delta();
        assert!(!delta.full);
        assert_eq!(delta.files.len(), 1);
        assert_eq!(delta.files[0].uri, delta.entry_uri);
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
        let document = store
            .upsert(
                uri(),
                1,
                source.to_string(),
                &StaticPresetCatalog::default(),
            )
            .unwrap();
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

    #[test]
    fn render_project_binds_planning_diagnostics_to_source_revision() {
        let manifest = mmt_rs::pack::PackManifest::from_json(r#"{
            "schema":"mmt-pack.v3",
            "pack":{"namespace":"ba","name":"Test","version":"1","type":"base"},
            "entities":{"花子":{"names":["花子"]}}
        }"#).unwrap();
        let packs = mmt_rs::pack::PackRegistry::new(vec![manifest]).unwrap();
        let source = "@asset hero\nsrc: first.png\n@end\n@asset hero\nsrc: second.png\n@end\n> 花子: [:missing:]";
        let render = build_render_project(
            uri(),
            37,
            91,
            virtual_entry_uri(&uri(), "render-diagnostics", 91),
            source,
            &packs,
            None,
        )
        .unwrap();

        assert_eq!(render.source_version, 37);
        assert_eq!(render.revision, 91);
        let duplicate = render
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.message.contains("duplicate asset name"))
            .expect("asset planning diagnostic");
        assert_eq!(duplicate.phase, "semantic");
        assert!(duplicate.range.is_some());
        assert_eq!(duplicate.labels.len(), 1);
        assert_eq!(duplicate.labels[0].message.as_deref(), Some("first declaration is here"));
        let unresolved = render
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.phase == "resolve")
            .expect("pack resolve diagnostic");
        assert!(unresolved.range.is_some());
    }

    #[test]
    fn render_project_plans_actor_avatar_without_changing_language_projection() {
        let manifest = mmt_rs::pack::PackManifest::from_json(r#"{
            "schema":"mmt-pack.v3",
            "pack":{"namespace":"ba","name":"Test","version":"1","type":"base"},
            "entities":{"hifumi":{"names":["Hifumi"],"slots":{"avatar":{"default":"default","items":{"default":{"storage":"avatars","path":"hifumi.png"}}}}}},
            "storage":{"avatars":{"kind":"image-dir","base":"assets/avatars"}}
        }"#).unwrap();
        let packs = mmt_rs::pack::PackRegistry::new(vec![manifest]).unwrap();
        let source = "@actor hifumi\npreset: ba::hifumi\n@end\n> hifumi: Hello";
        let planned =
            mmt_rs::project_text_with_pack(source, &packs, &EmitOptions::default()).unwrap();
        assert_eq!(
            planned.resources.len(),
            1,
            "diagnostics: {:?}\nsource: {}",
            planned.diagnostics,
            planned.emitted.source
        );
        let render = build_render_project(
            uri(),
            1,
            1,
            virtual_entry_uri(&uri(), "render-test", 1),
            source,
            &packs,
            None,
        )
        .unwrap();
        assert_eq!(
            render.resources.len(),
            1,
            "render files: {:?}",
            render.files
        );
        assert!(matches!(
            &render.resources[0],
            TypstResourceRequest::ImageDir { pack_namespace, base, file_name, .. }
                if pack_namespace == "ba" && base == "assets/avatars" && file_name == "hifumi.png"
        ));
        assert!(render.files.iter().any(|file| {
            file.uri == render.entry_uri
                && file
                    .text
                    .as_deref()
                    .is_some_and(|text| text.contains("mmt-resources/0.png"))
        }));

        let mut language_store = ProjectionStore::default();
        let language = language_store
            .upsert(uri(), 1, source.to_string(), &packs)
            .unwrap();
        assert!(
            language
                .projection
                .emitted
                .source
                .contains(PROJECTION_PLACEHOLDER_IMAGE)
        );
    }

    #[test]
    fn render_project_uses_host_time_while_language_projection_stays_clock_free() {
        let packs = mmt_rs::pack::PackRegistry::new(Vec::new()).unwrap();
        let source = "@document\n\
                      compiled-at: auto\n\
                      timezone: local\n\
                      @end\n\
                      - hello";
        let language =
            mmt_rs::project_text_with_pack(source, &packs, &EmitOptions::default()).unwrap();
        assert!(language.emitted.source.contains("compiled-at: none"));

        let timestamp = mmt_rs::HostTimestamp::new(0, 480).unwrap();
        let first = build_render_project(
            uri(),
            1,
            1,
            virtual_entry_uri(&uri(), "render-time", 1),
            source,
            &packs,
            Some(timestamp),
        )
        .unwrap();
        let second = build_render_project(
            uri(),
            1,
            1,
            virtual_entry_uri(&uri(), "render-time", 1),
            source,
            &packs,
            Some(timestamp),
        )
        .unwrap();
        let entry_text = |project: &TypstRenderProjectUpdate| {
            project
                .files
                .iter()
                .find(|file| file.uri == project.entry_uri)
                .and_then(|file| file.text.clone())
                .unwrap()
        };
        assert!(entry_text(&first).contains("compiled-at: \"1970-01-01 08:00:00\""));
        assert_eq!(entry_text(&first), entry_text(&second));
    }

    #[test]
    fn render_project_preserves_image_sequence_frame_metadata() {
        let manifest = mmt_rs::pack::PackManifest::from_json(r#"{
            "schema":"mmt-pack.v3",
            "pack":{"namespace":"ba","name":"Test","version":"1","type":"base"},
            "entities":{"花子":{"names":["花子"],"slots":{"sticker":{"default":"default","sets":{"default":{"storage":"hanako","variants":[{"id":"default_001","ordinal":1,"frame":0}]}}}}}},
            "storage":{"hanako":{"kind":"image-sequence","path":"blobs/花子/default.avifs","container":"avifs","codec":"av1","alpha":true,"frame_count":1,"size":[400,479],"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","profile":{"keyframe_interval":30},"random_access":"keyframe"}}
        }"#).unwrap();
        let packs = mmt_rs::pack::PackRegistry::new(vec![manifest]).unwrap();
        let source = "> 花子: [:#1:]";
        let render = build_render_project(
            uri(),
            1,
            1,
            virtual_entry_uri(&uri(), "render-test", 1),
            source,
            &packs,
            None,
        )
        .unwrap();
        assert_eq!(render.resources.len(), 1);
        assert!(matches!(
            &render.resources[0],
            TypstResourceRequest::ImageSequence {
                pack_namespace, path, frame, size, frame_count, container, codec, alpha, ..
            } if pack_namespace == "ba"
                && path == "blobs/花子/default.avifs"
                && *frame == 0
                && *size == [400, 479]
                && *frame_count == 1
                && container == "avifs"
                && codec == "av1"
                && *alpha
        ));
        assert!(render.files.iter().any(|file| {
            file.uri == render.entry_uri
                && file
                    .text
                    .as_deref()
                    .is_some_and(|text| text.contains("mmt-resources/0.png"))
        }));
    }
}
