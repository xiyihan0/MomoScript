use base64::Engine;
use std::{collections::{BTreeMap, HashMap, VecDeque}, sync::Arc};

use lsp_types::{
    CompletionItem, CompletionTextEdit, Diagnostic, InsertReplaceEdit, Location, Position,
    PositionEncodingKind, Range, TextEdit, Url,
};
#[cfg(test)]
use mmt_rs::{StaticPresetCatalog, project_text};
use mmt_rs::{
    AnalyzedDocument, EmitOptions, LogicalProjectFileId, MappingMode, PROJECTION_PLACEHOLDER_IMAGE,
    ProjectDigestInput, ProjectionEdit, ProjectionError, ProjectionKey, ProjectionKind,
    ProjectionMappingKind, ProjectionMappingResult, SourceContentKey, TypstProjectSnapshotKey,
    TypstProjection, canonical_bytes_digest, canonical_json_digest, logical_source_id,
    project_analyzed, project_analyzed_with_pack, project_snapshot_key, projection_key,
    source_content_key,
};
use serde::{Deserialize, Serialize};

use crate::{
    position::{
        LineIndex, MmtClientPosition, PositionConversionError, PositionEncoding,
        TinymistBackendPosition, Utf8ByteOffset, Utf8ByteRange,
    },
    service::DocumentSnapshot,
};

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
    pub project_digest: TypstProjectSnapshotKey,
    pub mapping_digest: String,
    pub source_content: SourceContentKey,
    pub projection_key: ProjectionKey,
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
    pub project_digest: TypstProjectSnapshotKey,
    pub mapping_digest: String,
    pub source_content: SourceContentKey,
    pub projection_key: ProjectionKey,
    pub pack_registry_digest: String,
    pub resource_plan_digest: String,
    pub resource_bytes_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedPosition {
    pub revision: u64,
    pub entry_uri: Url,
    pub position: Position,
    pub position_encoding: PositionEncoding,
    pub source_content: SourceContentKey,
    pub project_digest: TypstProjectSnapshotKey,
    pub projection_key: ProjectionKey,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedRange {
    pub revision: u64,
    pub entry_uri: Url,
    pub range: Range,
    pub position_encoding: PositionEncoding,
    pub source_content: SourceContentKey,
    pub project_digest: TypstProjectSnapshotKey,
    pub projection_key: ProjectionKey,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedReadLocation {
    pub kind: ProjectionMappingKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uri: Option<Url>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<Range>,
}

impl ProjectedReadLocation {
    fn stale_unknown() -> Self {
        Self {
            kind: ProjectionMappingKind::StaleUnknown,
            uri: None,
            range: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ProjectionDocument {
    pub source_uri: Url,
    pub source_version: i32,
    pub source_revision: u64,
    pub pack_revision: Option<u64>,
    pub pack_registry_digest: String,
    pub revision: u64,
    pub entry_uri: Url,
    session_id: String,
    pub source: String,
    pub analysis: Arc<AnalyzedDocument>,
    pub projection: TypstProjection,
    source_lines: Arc<LineIndex>,
    typst_lines: LineIndex,
    language_identity: ProjectIdentity,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProjectIdentity {
    source_content: SourceContentKey,
    project_digest: TypstProjectSnapshotKey,
    projection_key: ProjectionKey,
    mapping_digest: String,
}

#[derive(Clone, Copy)]
struct ProjectIdentityInput<'a> {
    source_uri: &'a Url,
    source: &'a str,
    pack_revision: Option<u64>,
    pack_registry_digest: &'a str,
    session_id: &'a str,
    revision: u64,
}

impl<'a> From<&'a ProjectionDocument> for ProjectIdentityInput<'a> {
    fn from(document: &'a ProjectionDocument) -> Self {
        Self {
            source_uri: &document.source_uri,
            source: &document.source,
            pack_revision: document.pack_revision,
            pack_registry_digest: &document.pack_registry_digest,
            session_id: &document.session_id,
            revision: document.revision,
        }
    }
}

fn project_identity(
    input: ProjectIdentityInput<'_>,
    projection: &TypstProjection,
    profile: &str,
) -> ProjectIdentity {
    let mapping_value = serde_json::json!({
        "origins": projection.emitted.origins,
        "sourceMap": projection.emitted.source_map,
    });
    let mapping_digest = canonical_json_digest("mmt-source-map-v1", &mapping_value);
    let path_segments = input
        .source_uri
        .path_segments()
        .map(|segments| segments.filter(|segment| !segment.is_empty()).collect::<Vec<_>>())
        .unwrap_or_default();
    let (workspace_id, relative_segments) = if input.source_uri.scheme() == "file" {
        let workspace = path_segments.first().copied().unwrap_or("workspace");
        (workspace, path_segments.get(1..).unwrap_or_default())
    } else if let Some(authority) = input.source_uri.host_str() {
        (authority, path_segments.as_slice())
    } else {
        ("workspace", path_segments.as_slice())
    };
    let relative_path = if relative_segments.is_empty() {
        "document.mmt".to_string()
    } else {
        relative_segments.join("/")
    };
    let logical_source = logical_source_id(workspace_id, relative_path)
        .expect("URL mount adapter produces canonical logical source components");
    let source_content = source_content_key(&logical_source, input.source.as_bytes());
    let template_bytes = EMBEDDED_TEMPLATE_TEXT_FILES
        .iter()
        .map(|(_, text)| text.as_bytes())
        .chain(EMBEDDED_TEMPLATE_BINARY_FILES.iter().map(|(_, bytes)| *bytes))
        .collect::<Vec<_>>();
    let template_digest = canonical_bytes_digest("mmt-template-bundle-v1", &template_bytes);
    let entry_file = LogicalProjectFileId::generated("authored", &mapping_digest, "main.typ")
        .expect("fixed generated entry identity is canonical");
    let mut files = BTreeMap::from([(
        entry_file.clone(),
        canonical_bytes_digest("mmt-project-file-v1", &[projection.emitted.source.as_bytes()]),
    )]);
    for (path, text) in EMBEDDED_TEMPLATE_TEXT_FILES {
        files.insert(
            LogicalProjectFileId::generated("template", &template_digest, *path)
                .expect("fixed template path is canonical"),
            canonical_bytes_digest("mmt-project-file-v1", &[text.as_bytes()]),
        );
    }
    for (path, bytes) in EMBEDDED_TEMPLATE_BINARY_FILES {
        files.insert(
            LogicalProjectFileId::generated("template", &template_digest, *path)
                .expect("fixed template path is canonical"),
            canonical_bytes_digest("mmt-project-file-v1", &[*bytes]),
        );
    }
    if profile == "language" {
        files.insert(
            LogicalProjectFileId::generated("template", &template_digest, PROJECTION_PLACEHOLDER_IMAGE)
                .expect("fixed placeholder path is canonical"),
            canonical_bytes_digest("mmt-project-file-v1", &[EDITOR_PLACEHOLDER_SVG.as_bytes()]),
        );
    }
    let project_digest = project_snapshot_key(&ProjectDigestInput {
        logical_source,
        source_content: source_content.clone(),
        entry_file: entry_file.clone(),
        files,
        package_generations: input.pack_revision.map_or_else(BTreeMap::new, |revision| {
            BTreeMap::from([(format!("registry-generation-{revision}"), input.pack_registry_digest.to_string())])
        }),
        generated_dependencies: BTreeMap::from([("template".into(), template_digest)]),
        project_options: BTreeMap::from([("profile".into(), profile.into())]),
        source_map_digest: mapping_digest.clone(),
    });
    let projection_key = projection_key(
        &source_content,
        input.session_id,
        input.revision,
        &entry_file,
        &project_digest,
        &mapping_digest,
    );
    ProjectIdentity { source_content, project_digest, projection_key, mapping_digest }
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
        let identity = &self.language_identity;
        TypstProjectUpdate {
            source_uri: self.source_uri.clone(),
            source_version: self.source_version,
            revision: self.revision,
            entry_uri: self.entry_uri.clone(),
            files,
            full: include_template,
            project_digest: identity.project_digest.clone(),
            mapping_digest: identity.mapping_digest.clone(),
            source_content: identity.source_content.clone(),
            projection_key: identity.projection_key.clone(),
        }
    }

    pub fn mmt_position_to_typst(
        &self,
        position: MmtClientPosition,
        client_encoding: PositionEncoding,
        backend_encoding: PositionEncoding,
    ) -> Result<TinymistBackendPosition, PositionConversionError> {
        let mmt_offset = self.source_lines.mmt_offset(position, client_encoding)?;
        let typst_offset = self
            .projection
            .index
            .mmt_to_typst(mmt_offset.get())
            .map(Utf8ByteOffset::new)
            .ok_or(PositionConversionError::ProjectionMismatch)?;
        self.typst_lines.backend_position(typst_offset, backend_encoding)
    }

    pub fn mmt_range_to_typst(
        &self,
        range: Range,
        client_encoding: PositionEncoding,
        backend_encoding: PositionEncoding,
    ) -> Result<Range, PositionConversionError> {
        let source = self.source_lines.backend_range(range, client_encoding)?;
        let projected = self
            .projection
            .index
            .mmt_range_to_typst(source.into_text_range())
            .ok_or(PositionConversionError::ProjectionMismatch)?;
        self.typst_lines.mmt_range(
            Utf8ByteRange::new(
                Utf8ByteOffset::new(projected.start),
                Utf8ByteOffset::new(projected.end),
            )?,
            backend_encoding,
        )
    }

    pub fn typst_range_to_mmt(
        &self,
        range: Range,
        backend_encoding: PositionEncoding,
        client_encoding: PositionEncoding,
    ) -> Result<Range, PositionConversionError> {
        let typst_range = self.typst_lines.backend_range(range, backend_encoding)?;
        let mmt_range = self
            .projection
            .index
            .typst_to_mmt(typst_range.into_text_range())
            .ok_or(PositionConversionError::ProjectionMismatch)?;
        self.source_lines.mmt_range(
            Utf8ByteRange::new(
                Utf8ByteOffset::new(mmt_range.start),
                Utf8ByteOffset::new(mmt_range.end),
            )?,
            client_encoding,
        )
    }

    /// Maps one backend location against the exact projection generation.
    /// Generated projection/template locations remain explicit read-only
    /// virtual targets; external workspace and package locations are classified
    /// for host policy without inventing an authored mapping.
    pub fn classify_read_location(
        &self,
        location: Location,
        backend_encoding: PositionEncoding,
        client_encoding: PositionEncoding,
    ) -> ProjectedReadLocation {
        if location.uri == self.entry_uri {
            let Ok(projected) = self.typst_lines.backend_range(location.range, backend_encoding)
            else {
                return ProjectedReadLocation::stale_unknown();
            };
            return self.mapped_projection_range(
                self.projection.index.classify_read(projected.into_text_range()),
                client_encoding,
            );
        }

        for (path, text) in EMBEDDED_TEMPLATE_TEXT_FILES {
            let Ok(template_uri) = self.entry_uri.join(path) else {
                continue;
            };
            if location.uri != template_uri {
                continue;
            }
            let lines = LineIndex::new(text);
            let Ok(bytes) = lines.backend_range(location.range, backend_encoding) else {
                return ProjectedReadLocation::stale_unknown();
            };
            let Ok(range) = lines.mmt_range(bytes, client_encoding) else {
                return ProjectedReadLocation::stale_unknown();
            };
            return ProjectedReadLocation {
                kind: ProjectionMappingKind::GeneratedProjection,
                uri: Some(read_only_projection_uri(&location.uri)),
                range: Some(range),
            };
        }

        let kind = match location.uri.scheme() {
            "file" | "mmtfs" | "vscode-remote" => ProjectionMappingKind::WorkspaceTypst,
            "mmt-package" => ProjectionMappingKind::PackageFile,
            _ => ProjectionMappingKind::StaleUnknown,
        };
        if kind == ProjectionMappingKind::StaleUnknown {
            ProjectedReadLocation::stale_unknown()
        } else {
            ProjectedReadLocation {
                kind,
                uri: Some(location.uri),
                range: Some(location.range),
            }
        }
    }

    fn mapped_projection_range(
        &self,
        mapped: ProjectionMappingResult,
        client_encoding: PositionEncoding,
    ) -> ProjectedReadLocation {
        match mapped.kind {
            ProjectionMappingKind::AuthoredIdentity => {
                let Some(source) = mapped.source_range else {
                    return ProjectedReadLocation::stale_unknown();
                };
                let Ok(range) = Utf8ByteRange::new(
                    Utf8ByteOffset::new(source.start),
                    Utf8ByteOffset::new(source.end),
                ).and_then(|source| self.source_lines.mmt_range(source, client_encoding)) else {
                    return ProjectedReadLocation::stale_unknown();
                };
                ProjectedReadLocation {
                    kind: ProjectionMappingKind::AuthoredIdentity,
                    uri: Some(self.source_uri.clone()),
                    range: Some(range),
                }
            }
            ProjectionMappingKind::GeneratedProjection => {
                let Ok(range) = Utf8ByteRange::new(
                    Utf8ByteOffset::new(mapped.projected_range.start),
                    Utf8ByteOffset::new(mapped.projected_range.end),
                ).and_then(|projected| self.typst_lines.mmt_range(projected, client_encoding)) else {
                    return ProjectedReadLocation::stale_unknown();
                };
                ProjectedReadLocation {
                    kind: ProjectionMappingKind::GeneratedProjection,
                    uri: Some(read_only_projection_uri(&self.entry_uri)),
                    range: Some(range),
                }
            }
            ProjectionMappingKind::WorkspaceTypst
            | ProjectionMappingKind::PackageFile
            | ProjectionMappingKind::StaleUnknown => ProjectedReadLocation::stale_unknown(),
        }
    }

    pub fn typst_edit_to_mmt(
        &self,
        edit: TextEdit,
        backend_encoding: PositionEncoding,
        client_encoding: PositionEncoding,
    ) -> Result<TextEdit, PositionConversionError> {
        let typst_range = self
            .typst_lines
            .backend_range(edit.range, backend_encoding)?
            .into_text_range();
        let mapped = self
            .projection
            .index
            .map_text_edit(&ProjectionEdit {
                range: typst_range,
                new_text: edit.new_text,
            })
            .map_err(|_| PositionConversionError::ProjectionMismatch)?;
        Ok(TextEdit {
            range: self.source_lines.mmt_range(
                Utf8ByteRange::new(
                    Utf8ByteOffset::new(mapped.range.start),
                    Utf8ByteOffset::new(mapped.range.end),
                )?,
                client_encoding,
            )?,
            new_text: mapped.new_text,
        })
    }

    pub fn map_completion_item(
        &self,
        mut item: CompletionItem,
        backend_encoding: PositionEncoding,
        client_encoding: PositionEncoding,
    ) -> Result<CompletionItem, PositionConversionError> {
        item.text_edit = match item.text_edit {
            Some(CompletionTextEdit::Edit(edit)) => Some(CompletionTextEdit::Edit(
                self.typst_edit_to_mmt(edit, backend_encoding, client_encoding)?,
            )),
            Some(CompletionTextEdit::InsertAndReplace(edit)) => {
                let insert = self.typst_range_to_mmt(edit.insert, backend_encoding, client_encoding)?;
                let replace = self.typst_range_to_mmt(edit.replace, backend_encoding, client_encoding)?;
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
                    .map(|edit| self.typst_edit_to_mmt(edit, backend_encoding, client_encoding))
                    .collect::<Result<Vec<_>, _>>()?,
            );
        }
        Ok(item)
    }

    pub fn map_diagnostic(
        &self,
        mut diagnostic: Diagnostic,
        backend_encoding: PositionEncoding,
        client_encoding: PositionEncoding,
    ) -> Result<Diagnostic, PositionConversionError> {
        diagnostic.range = self.typst_diagnostic_range_to_mmt(
            diagnostic.range,
            backend_encoding,
            client_encoding,
        )?;
        if let Some(information) = diagnostic.related_information.take() {
            let mut mapped = Vec::new();
            for mut related in information {
                if related.location.uri != self.entry_uri {
                    continue;
                }
                related.location.uri = self.source_uri.clone();
                related.location.range = self.typst_range_to_mmt(
                    related.location.range,
                    backend_encoding,
                    client_encoding,
                )?;
                mapped.push(related);
            }
            diagnostic.related_information = Some(mapped);
        }
        diagnostic.source = Some("typst".to_string());
        Ok(diagnostic)
    }

    fn typst_diagnostic_range_to_mmt(
        &self,
        range: Range,
        backend_encoding: PositionEncoding,
        client_encoding: PositionEncoding,
    ) -> Result<Range, PositionConversionError> {
        let typst_range = self
            .typst_lines
            .backend_range(range, backend_encoding)?
            .into_text_range();
        if let Some(mapped) = self.projection.index.typst_to_mmt(typst_range) {
            return self.source_lines.mmt_range(
                Utf8ByteRange::new(
                    Utf8ByteOffset::new(mapped.start),
                    Utf8ByteOffset::new(mapped.end),
                )?,
                client_encoding,
            );
        }

        // Semantic diagnostics can include generated call wrappers. Prefer the
        // single authored patch inside that span; multiple candidates are ambiguous.
        let mut authored = self.projection.index.segments().iter().filter(|segment| {
            segment.mapping == MappingMode::Identity
                && matches!(
                    segment.kind,
                    ProjectionKind::StatementPatch | ProjectionKind::ResourcePatch
                )
                && segment.typst_range.start < typst_range.end
                && typst_range.start < segment.typst_range.end
        });
        let segment = authored
            .next()
            .ok_or(PositionConversionError::ProjectionMismatch)?;
        if authored.next().is_some() {
            return Err(PositionConversionError::AmbiguousMapping);
        }
        let overlap = mmt_rs::source::TextRange::new(
            segment.typst_range.start.max(typst_range.start),
            segment.typst_range.end.min(typst_range.end),
        );
        let mapped = self
            .projection
            .index
            .typst_to_mmt(overlap)
            .ok_or(PositionConversionError::ProjectionMismatch)?;
        self.source_lines.mmt_range(
            Utf8ByteRange::new(
                Utf8ByteOffset::new(mapped.start),
                Utf8ByteOffset::new(mapped.end),
            )?,
            client_encoding,
        )
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
    document: &ProjectionDocument,
    pack_revision: u64,
    timestamp: Option<mmt_rs::HostTimestamp>,
) -> Result<TypstRenderProjectUpdate, ProjectionError> {
    if document.pack_revision != Some(pack_revision) {
        return Err(ProjectionError::StalePackAnalysis {
            analyzed_revision: document.pack_revision,
            requested_revision: pack_revision,
        });
    }
    let projection = project_analyzed_with_pack(
        &document.source,
        &document.analysis,
        &EmitOptions {
            timestamp,
            ..EmitOptions::default()
        },
    )?;
    let mut files = EMBEDDED_TEMPLATE_TEXT_FILES
        .iter()
        .map(|(path, text)| TypstVirtualFile {
            uri: document
                .entry_uri
                .join(path)
                .expect("embedded template path forms a valid virtual URI"),
            text: Some((*text).to_string()),
            data_base64: None,
        })
        .collect::<Vec<_>>();
    files.extend(EMBEDDED_TEMPLATE_BINARY_FILES.iter().map(|(path, data)| {
        TypstVirtualFile {
            uri: document
                .entry_uri
                .join(path)
                .expect("embedded template path forms a valid virtual URI"),
            text: None,
            data_base64: Some(base64::engine::general_purpose::STANDARD.encode(data)),
        }
    }));
    files.push(TypstVirtualFile {
        uri: document.entry_uri.clone(),
        text: Some(projection.emitted.source.clone()),
        data_base64: None,
    });
    let resources: Vec<TypstResourceRequest> = projection
        .resources
        .iter()
        .enumerate()
        .map(|(id, resource)| {
            let uri = document
                .entry_uri
                .join(&resource.typst_path)
                .expect("resource path forms a valid virtual URI");
            let range = document
                .source_lines
                .range(
                    &document.source,
                    resource.range,
                    &PositionEncodingKind::UTF16,
                )
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
    let identity = project_identity(document.into(), &projection, "render");
    let mut resource_plan = serde_json::to_value(&resources)
        .expect("resource plan protocol values are serializable");
    if let serde_json::Value::Array(items) = &mut resource_plan {
        for item in items {
            if let serde_json::Value::Object(fields) = item { fields.remove("uri"); }
        }
    }
    let resource_plan_digest = canonical_json_digest("mmt-resource-plan-v1", &resource_plan);
    let resource_bytes_digest = canonical_bytes_digest("mmt-resource-bytes-v1", &[]);
    let diagnostics = render_diagnostics(
        &document.source,
        &document.source_lines,
        &projection.diagnostics,
    );
    Ok(TypstRenderProjectUpdate {
        source_uri: document.source_uri.clone(),
        source_version: document.source_version,
        revision: document.revision,
        entry_uri: document.entry_uri.clone(),
        full: true,
        files,
        resources,
        diagnostics,
        project_digest: identity.project_digest,
        mapping_digest: identity.mapping_digest,
        source_content: identity.source_content,
        projection_key: identity.projection_key,
        pack_registry_digest: document.pack_registry_digest.clone(),
        resource_plan_digest,
        resource_bytes_digest,
    })
}

const RETAINED_POSITION_GENERATIONS: usize = 2;

#[derive(Debug)]
pub struct ProjectionStore {
    documents: HashMap<Url, ProjectionDocument>,
    retained: HashMap<Url, VecDeque<ProjectionDocument>>,
    session_id: String,
    next_revision: u64,
}

impl Default for ProjectionStore {
    fn default() -> Self {
        Self {
            documents: HashMap::new(),
            retained: HashMap::new(),
            next_revision: 1,
            session_id: uuid::Uuid::new_v4().simple().to_string(),
        }
    }
}

impl ProjectionStore {
    pub fn upsert(
        &mut self,
        source_uri: Url,
        snapshot: &DocumentSnapshot,
    ) -> Result<&ProjectionDocument, ProjectionError> {
        let revision = self.next_revision;
        self.next_revision = self
            .next_revision
            .checked_add(1)
            .expect("Typst projection revision overflow");
        let entry_uri = virtual_entry_uri(&source_uri, &self.session_id, revision);
        let projection = project_analyzed(
            &snapshot.text,
            &snapshot.analysis,
            &EmitOptions::default(),
        )?;
        let typst_lines = LineIndex::new(&projection.emitted.source);
        let language_identity = project_identity(
            ProjectIdentityInput {
                source_uri: &source_uri,
                source: &snapshot.text,
                pack_revision: snapshot.pack_revision,
                pack_registry_digest: &snapshot.pack_registry_digest,
                session_id: &self.session_id,
                revision,
            },
            &projection,
            "language",
        );
        let next = ProjectionDocument {
            source_uri: source_uri.clone(),
            source_version: snapshot.version,
            source_revision: snapshot.revision,
            pack_revision: snapshot.pack_revision,
            pack_registry_digest: snapshot.pack_registry_digest.clone(),
            revision,
            entry_uri,
            session_id: self.session_id.clone(),
            source: snapshot.text.clone(),
            analysis: Arc::clone(&snapshot.analysis),
            projection,
            source_lines: Arc::clone(&snapshot.lines),
            typst_lines,
            language_identity,
        };
        if let Some(previous) = self.documents.insert(source_uri.clone(), next) {
            let retained = self.retained.entry(source_uri.clone()).or_default();
            retained.push_back(previous);
            while retained.len() > RETAINED_POSITION_GENERATIONS {
                retained.pop_front();
            }
        }
        Ok(&self.documents[&source_uri])
    }

    pub fn get(&self, source_uri: &Url) -> Option<&ProjectionDocument> {
        self.documents.get(source_uri)
    }

    pub fn generation(
        &self,
        source_uri: &Url,
        entry_uri: &Url,
        revision: u64,
    ) -> Result<&ProjectionDocument, PositionConversionError> {
        let candidates = self
            .documents
            .get(source_uri)
            .into_iter()
            .chain(self.retained.get(source_uri).into_iter().flatten())
            .filter(|document| document.entry_uri == *entry_uri && document.revision == revision)
            .collect::<Vec<_>>();
        match candidates.as_slice() {
            [] => {
                let has_related_generation = self
                    .documents
                    .get(source_uri)
                    .into_iter()
                    .chain(self.retained.get(source_uri).into_iter().flatten())
                    .any(|document| document.entry_uri == *entry_uri || document.revision == revision);
                Err(if has_related_generation {
                    PositionConversionError::ProjectionMismatch
                } else {
                    PositionConversionError::AbsentGeneration
                })
            }
            [document] => Ok(document),
            _ => Err(PositionConversionError::AmbiguousGeneration),
        }
    }

    pub fn response_generation(
        &self,
        source_uri: &Url,
        entry_uri: &Url,
        revision: u64,
        source_content: &SourceContentKey,
        project_digest: &TypstProjectSnapshotKey,
        projection_key: &ProjectionKey,
    ) -> Result<&ProjectionDocument, PositionConversionError> {
        let document = self.generation(source_uri, entry_uri, revision)?;
        let current = self
            .documents
            .get(source_uri)
            .ok_or(PositionConversionError::AbsentGeneration)?;
        if current.entry_uri != document.entry_uri || current.revision != document.revision {
            return Err(PositionConversionError::StaleProjection);
        }
        let identity = &document.language_identity;
        if identity.source_content != *source_content
            || identity.project_digest != *project_digest
            || identity.projection_key != *projection_key
        {
            return Err(PositionConversionError::ProjectionMismatch);
        }
        Ok(document)
    }

    pub fn classify_response_location(
        &self,
        source_uri: &Url,
        entry_uri: &Url,
        revision: u64,
        source_content: &SourceContentKey,
        project_digest: &TypstProjectSnapshotKey,
        projection_key: &ProjectionKey,
        location: Location,
        backend_encoding: PositionEncoding,
        client_encoding: PositionEncoding,
    ) -> ProjectedReadLocation {
        let Ok(document) = self.response_generation(
            source_uri,
            entry_uri,
            revision,
            source_content,
            project_digest,
            projection_key,
        ) else {
            return ProjectedReadLocation::stale_unknown();
        };
        document.classify_read_location(location, backend_encoding, client_encoding)
    }

    pub fn remove(&mut self, source_uri: &Url) {
        self.documents.remove(source_uri);
        self.retained.remove(source_uri);
    }

    pub fn project_position(
        &self,
        source_uri: &Url,
        position: MmtClientPosition,
        client_encoding: PositionEncoding,
        backend_encoding: PositionEncoding,
    ) -> Result<ProjectedPosition, PositionConversionError> {
        let document = self
            .get(source_uri)
            .ok_or(PositionConversionError::AbsentGeneration)?;
        let identity = &document.language_identity;
        Ok(ProjectedPosition {
            revision: document.revision,
            entry_uri: document.entry_uri.clone(),
            position: document
                .mmt_position_to_typst(position, client_encoding, backend_encoding)?
                .into_lsp(),
            position_encoding: backend_encoding,
            source_content: identity.source_content.clone(),
            project_digest: identity.project_digest.clone(),
            projection_key: identity.projection_key.clone(),
        })
    }

    pub fn project_range(
        &self,
        source_uri: &Url,
        range: Range,
        client_encoding: PositionEncoding,
        backend_encoding: PositionEncoding,
    ) -> Result<ProjectedRange, PositionConversionError> {
        let document = self
            .get(source_uri)
            .ok_or(PositionConversionError::AbsentGeneration)?;
        let identity = &document.language_identity;
        Ok(ProjectedRange {
            revision: document.revision,
            entry_uri: document.entry_uri.clone(),
            range: document.mmt_range_to_typst(range, client_encoding, backend_encoding)?,
            position_encoding: backend_encoding,
            source_content: identity.source_content.clone(),
            project_digest: identity.project_digest.clone(),
            projection_key: identity.projection_key.clone(),
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

pub fn read_only_projection_uri(backend_uri: &Url) -> Url {
    let mut uri = backend_uri.clone();
    uri.set_scheme("mmt-projection")
        .expect("mmt-projection is a valid URI scheme");
    uri
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

    fn snapshot(
        version: i32,
        source: impl Into<String>,
        catalog: &impl mmt_rs::CharacterPresetCatalog,
    ) -> DocumentSnapshot {
        let text = source.into();
        DocumentSnapshot {
            version,
            revision: version as u64,
            analysis: Arc::new(mmt_rs::analyze_text(&text, catalog)),
            lines: Arc::new(LineIndex::new(&text)),
            text,
            pack_revision: None,
            pack_registry_digest: canonical_bytes_digest("mmt-pack-registry-v1", &[]),
        }
    }

    fn pack_snapshot(
        version: i32,
        source: impl Into<String>,
        packs: &mmt_rs::pack::PackRegistry,
        pack_revision: u64,
    ) -> DocumentSnapshot {
        let text = source.into();
        DocumentSnapshot {
            version,
            revision: version as u64,
            analysis: Arc::new(mmt_rs::analyze_text_with_pack(&text, packs)),
            lines: Arc::new(LineIndex::new(&text)),
            text,
            pack_revision: Some(pack_revision),
            pack_registry_digest: canonical_bytes_digest("mmt-pack-registry-v1", &[b"test-pack"]),
        }
    }

    fn stored_pack_document(
        version: i32,
        source: impl Into<String>,
        packs: &mmt_rs::pack::PackRegistry,
        pack_revision: u64,
    ) -> ProjectionDocument {
        let snapshot = pack_snapshot(version, source, packs, pack_revision);
        ProjectionStore::default()
            .upsert(uri(), &snapshot)
            .unwrap()
            .clone()
    }

    #[test]
    fn maps_only_identity_positions_and_edits() {
        let source = "@typ: #let accent = blue".to_string();
        let mut store = ProjectionStore::default();
        let document = store.upsert(uri(), &snapshot(1, source.clone(), &StaticPresetCatalog::default()))
            .unwrap();
        let offset = source.find("accent").unwrap();
        let position = LineIndex::new(&source)
            .position(&source, offset, &PositionEncodingKind::UTF16)
            .unwrap();
        let projected = document
            .mmt_position_to_typst(
                MmtClientPosition::new(position),
                PositionEncoding::Utf16,
                PositionEncoding::Utf16,
            )
            .unwrap()
            .into_lsp();
        let edit = document
            .typst_edit_to_mmt(
                TextEdit::new(Range::new(projected, projected), "theme".to_string()),
                PositionEncoding::Utf16,
                PositionEncoding::Utf16,
            )
            .unwrap();
        assert_eq!(edit.range.start, position);

        let generated = Range::new(Position::new(0, 0), Position::new(0, 0));
        assert_eq!(
            document.typst_range_to_mmt(
                generated,
                PositionEncoding::Utf16,
                PositionEncoding::Utf16,
            ),
            Err(PositionConversionError::ProjectionMismatch)
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
                PositionEncoding::Utf16,
                PositionEncoding::Utf16,
            )
            .unwrap();
        let Some(CompletionTextEdit::Edit(completion_edit)) = completion.text_edit else {
            panic!("mapped completion must preserve a simple text edit");
        };
        assert_eq!(completion_edit.range.start, position);

        let diagnostic = document
            .map_diagnostic(
                Diagnostic::new_simple(Range::new(projected, projected), "Typst error".to_string()),
                PositionEncoding::Utf16,
                PositionEncoding::Utf16,
            )
            .unwrap();
        assert_eq!(diagnostic.range.start, position);
        assert_eq!(diagnostic.source.as_deref(), Some("typst"));
    }

    #[test]
    fn read_locations_classify_virtual_targets_and_reject_retired_generations() {
        let source = "@typ: #let accent = blue".to_string();
        let mut store = ProjectionStore::default();
        let document = store
            .upsert(
                uri(),
                &snapshot(1, source.clone(), &StaticPresetCatalog::default()),
            )
            .unwrap();
        let offset = source.find("accent").unwrap() + 1;
        let authored_position = LineIndex::new(&source)
            .position(&source, offset, &PositionEncodingKind::UTF16)
            .unwrap();
        let projected_position = document
            .mmt_position_to_typst(
                MmtClientPosition::new(authored_position),
                PositionEncoding::Utf16,
                PositionEncoding::Utf16,
            )
            .unwrap()
            .into_lsp();
        let authored = document.classify_read_location(
            Location::new(
                document.entry_uri.clone(),
                Range::new(projected_position, projected_position),
            ),
            PositionEncoding::Utf16,
            PositionEncoding::Utf16,
        );
        assert_eq!(authored.kind, ProjectionMappingKind::AuthoredIdentity);
        assert_eq!(authored.uri.as_ref(), Some(&uri()));
        assert_eq!(authored.range.unwrap().start, authored_position);

        let generated = document.classify_read_location(
            Location::new(
                document.entry_uri.clone(),
                Range::new(Position::new(0, 0), Position::new(0, 1)),
            ),
            PositionEncoding::Utf16,
            PositionEncoding::Utf16,
        );
        assert_eq!(generated.kind, ProjectionMappingKind::GeneratedProjection);
        assert_eq!(generated.uri.unwrap().scheme(), "mmt-projection");

        for (target, expected) in [
            ("file:///workspace/dependency.typ", ProjectionMappingKind::WorkspaceTypst),
            ("mmt-package:/preview/example/1.0.0/lib.typ?digest=abc", ProjectionMappingKind::PackageFile),
        ] {
            let mapped = document.classify_read_location(
                Location::new(
                    Url::parse(target).unwrap(),
                    Range::new(Position::new(0, 0), Position::new(0, 1)),
                ),
                PositionEncoding::Utf16,
                PositionEncoding::Utf16,
            );
            assert_eq!(mapped.kind, expected);
        }
        assert_eq!(
            document
                .classify_read_location(
                    Location::new(
                        Url::parse("https://example.invalid/unknown.typ").unwrap(),
                        Range::default(),
                    ),
                    PositionEncoding::Utf16,
                    PositionEncoding::Utf16,
                )
                .kind,
            ProjectionMappingKind::StaleUnknown
        );

        let old_entry = document.entry_uri.clone();
        let old_revision = document.revision;
        let old_identity = document.language_identity.clone();
        store
            .upsert(
                uri(),
                &snapshot(2, "@typ: #let accent = red", &StaticPresetCatalog::default()),
            )
            .unwrap();
        let retired = store.classify_response_location(
            &uri(),
            &old_entry,
            old_revision,
            &old_identity.source_content,
            &old_identity.project_digest,
            &old_identity.projection_key,
            Location::new(old_entry.clone(), Range::new(projected_position, projected_position)),
            PositionEncoding::Utf16,
            PositionEncoding::Utf16,
        );
        assert_eq!(retired, ProjectedReadLocation::stale_unknown());
    }

    #[test]
    fn virtual_entry_uri_is_revision_scoped_with_a_stable_project_root() {
        let mut store = ProjectionStore::default();
        let first = store.upsert(uri(), &snapshot(1, "@typ: #let x = 1".to_string(), &StaticPresetCatalog::default()))
            .unwrap();
        let first_entry = first.entry_uri.clone();
        let first_template = first_entry
            .join("typst_sandbox/mmt_render/lib.typ")
            .unwrap();
        let first_revision = first.revision;
        let second = store.upsert(uri(), &snapshot(1, "@typ: #let x = 2".to_string(), &StaticPresetCatalog::default()))
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
        let next_session_entry = next_session.upsert(uri(), &snapshot(1, "@typ: #let x = 3".to_string(), &StaticPresetCatalog::default()))
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
        let update = store.upsert(uri(), &snapshot(1, "@typ: #let x = 1".to_string(), &StaticPresetCatalog::default()))
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
        assert_eq!(wire["projectDigest"].as_str().unwrap().len(), 64);
        assert_eq!(wire["mappingDigest"].as_str().unwrap().len(), 64);
        assert_eq!(wire["sourceContent"].as_str().unwrap().len(), 64);
        assert_eq!(wire["projectionKey"].as_str().unwrap().len(), 64);
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
        assert_eq!(delta.project_digest, update.project_digest);
        assert_eq!(delta.mapping_digest, update.mapping_digest);
        assert_eq!(delta.source_content, update.source_content);
        assert_eq!(delta.projection_key, update.projection_key);
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
        let document = store.upsert(uri(), &snapshot(1, source.to_string(), &StaticPresetCatalog::default()))
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
                PositionEncoding::Utf16,
                PositionEncoding::Utf16,
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
        let document = stored_pack_document(37, source, &packs, 1);
        let revision = document.revision;
        let render = build_render_project(&document, 1, None).unwrap();

        assert_eq!(render.source_version, 37);
        assert_eq!(render.revision, revision);
        assert_eq!(render.project_digest.0.len(), 64);
        assert_eq!(render.mapping_digest.len(), 64);
        assert_eq!(render.source_content.0.len(), 64);
        assert_eq!(render.projection_key.0.len(), 64);
        assert_eq!(render.pack_registry_digest, document.pack_registry_digest);
        assert_eq!(render.resource_plan_digest.len(), 64);
        assert_eq!(render.resource_bytes_digest.len(), 64);
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
        let document = stored_pack_document(1, source, &packs, 1);
        let render = build_render_project(&document, 1, None).unwrap();
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
            .upsert(uri(), &snapshot(1, source.to_string(), &packs))
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
        let document = stored_pack_document(1, source, &packs, 1);
        let first = build_render_project(&document, 1, Some(timestamp)).unwrap();
        let second = build_render_project(&document, 1, Some(timestamp)).unwrap();
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
        let document = stored_pack_document(1, source, &packs, 1);
        let render = build_render_project(&document, 1, None).unwrap();
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

    #[test]
    fn language_and_render_reuse_analysis_and_invalidate_by_source_and_pack() {
        let pack_v1 = r#"{
            "schema":"mmt-pack.v3",
            "pack":{"namespace":"ba","name":"Test","version":"1","type":"base"},
            "entities":{"hifumi":{"names":["Hifumi"],"slots":{"avatar":{"default":"default","items":{"default":{"storage":"avatars","path":"hifumi.png"}}}}}},
            "storage":{"avatars":{"kind":"image-dir","base":"assets/v1"}}
        }"#
        .to_string();
        let pack_v2 = r#"{
            "schema":"mmt-pack.v3",
            "pack":{"namespace":"ba","name":"Test","version":"2","type":"base"},
            "entities":{"hifumi":{"names":["Hifumi"],"slots":{"avatar":{"default":"default","items":{"default":{"storage":"avatars","path":"hifumi.png"}}}}}},
            "storage":{"avatars":{"kind":"image-dir","base":"assets/v2"}}
        }"#
        .to_string();
        let source_v1 = "@actor hifumi\npreset: ba::hifumi\n@end\n> hifumi: Hello";
        let source_v2 = "@actor hifumi\npreset: ba::hifumi\n@end\n> hifumi: Hello again";
        let mut service = crate::LanguageService::default();
        assert!(service.update_pack_manifests(1, &[pack_v1]).unwrap());
        let first_snapshot = service.open(uri(), 1, source_v1.to_string()).clone();
        assert_eq!(service.analysis_cache_counts(), (1, 1));
        let _ = service.diagnostics(&uri());
        assert_eq!(service.analysis_cache_counts(), (1, 1));

        let mut store = ProjectionStore::default();
        let first = store.upsert(uri(), &first_snapshot).unwrap().clone();
        assert!(Arc::ptr_eq(&first.analysis, &first_snapshot.analysis));
        assert!(Arc::ptr_eq(&first.source_lines, &first_snapshot.lines));
        assert!(first.projection.emitted.source.contains(PROJECTION_PLACEHOLDER_IMAGE));
        let first_render = build_render_project(&first, 1, None).unwrap();
        assert!(matches!(
            &first_render.resources[0],
            TypstResourceRequest::ImageDir { base, .. } if base == "assets/v1"
        ));
        assert_eq!(service.analysis_cache_counts(), (1, 1));

        let second_snapshot = service
            .change(uri(), 2, source_v2.to_string())
            .unwrap()
            .clone();
        assert_eq!(service.analysis_cache_counts(), (2, 2));
        let _ = service.diagnostics(&uri());
        assert_eq!(service.analysis_cache_counts(), (2, 2));
        assert!(!Arc::ptr_eq(
            &first_snapshot.analysis,
            &second_snapshot.analysis
        ));
        assert!(!Arc::ptr_eq(&first_snapshot.lines, &second_snapshot.lines));
        let second = store.upsert(uri(), &second_snapshot).unwrap().clone();
        assert!(Arc::ptr_eq(&second.analysis, &second_snapshot.analysis));
        assert!(Arc::ptr_eq(&second.source_lines, &second_snapshot.lines));
        assert!(build_render_project(&second, 1, None).is_ok());
        assert_eq!(service.analysis_cache_counts(), (2, 2));

        let before_pack = service.snapshot(&uri()).unwrap().clone();
        assert!(service.update_pack_manifests(2, &[pack_v2]).unwrap());
        let after_pack = service.snapshot(&uri()).unwrap().clone();
        assert_eq!(service.analysis_cache_counts(), (3, 2));
        let _ = service.diagnostics(&uri());
        assert_eq!(service.analysis_cache_counts(), (3, 2));
        assert!(!Arc::ptr_eq(&before_pack.analysis, &after_pack.analysis));
        assert!(Arc::ptr_eq(&before_pack.lines, &after_pack.lines));
        assert!(matches!(
            build_render_project(&second, 2, None),
            Err(ProjectionError::StalePackAnalysis {
                analyzed_revision: Some(1),
                requested_revision: 2,
            })
        ));

        let third = store.upsert(uri(), &after_pack).unwrap();
        assert!(Arc::ptr_eq(&third.analysis, &after_pack.analysis));
        assert!(Arc::ptr_eq(&third.source_lines, &after_pack.lines));
        assert!(third.projection.emitted.source.contains(PROJECTION_PLACEHOLDER_IMAGE));
        let third_render = build_render_project(third, 2, None).unwrap();
        assert!(matches!(
            &third_render.resources[0],
            TypstResourceRequest::ImageDir { base, .. } if base == "assets/v2"
        ));
        assert_eq!(service.analysis_cache_counts(), (3, 2));
    }
    #[test]
    fn response_identity_rejects_dependency_advance_and_closed_incarnation() {
        let source_uri = uri();
        let source = "@typ: #let value = [unchanged]";
        let catalog = StaticPresetCatalog::default();
        let mut first_snapshot = snapshot(1, source, &catalog);
        first_snapshot.pack_revision = Some(1);
        first_snapshot.pack_registry_digest = "pack-generation-a".into();
        let mut store = ProjectionStore::default();
        let first = store.upsert(source_uri.clone(), &first_snapshot).unwrap().clone();
        let first_identity = first.project_update();

        let mut dependency_advanced = snapshot(1, source, &catalog);
        dependency_advanced.pack_revision = Some(2);
        dependency_advanced.pack_registry_digest = "pack-generation-b".into();
        let current = store.upsert(source_uri.clone(), &dependency_advanced).unwrap().clone();
        let current_identity = current.project_update();
        assert_eq!(first_identity.source_content, current_identity.source_content);
        assert_ne!(first_identity.project_digest, current_identity.project_digest);
        assert!(store.response_generation(
            &source_uri,
            &current.entry_uri,
            current.revision,
            &current_identity.source_content,
            &current_identity.project_digest,
            &current_identity.projection_key,
        ).is_ok());
        assert_eq!(
            store.response_generation(
                &source_uri,
                &current.entry_uri,
                current.revision,
                &first_identity.source_content,
                &first_identity.project_digest,
                &first_identity.projection_key,
            ).unwrap_err(),
            PositionConversionError::ProjectionMismatch,
        );
        assert_eq!(
            store.response_generation(
                &source_uri,
                &first.entry_uri,
                first.revision,
                &first_identity.source_content,
                &first_identity.project_digest,
                &first_identity.projection_key,
            ).unwrap_err(),
            PositionConversionError::StaleProjection,
        );

        store.remove(&source_uri);
        let reopened = store.upsert(source_uri.clone(), &first_snapshot).unwrap().clone();
        assert_ne!(reopened.entry_uri, first.entry_uri);
        assert_eq!(
            store.response_generation(
                &source_uri,
                &first.entry_uri,
                first.revision,
                &first_identity.source_content,
                &first_identity.project_digest,
                &first_identity.projection_key,
            ).unwrap_err(),
            PositionConversionError::AbsentGeneration,
        );
    }

    #[test]
    fn duplicate_generation_is_rejected_as_ambiguous() {
        let source_uri = uri();
        let mut store = ProjectionStore::default();
        let document = store
            .upsert(
                source_uri.clone(),
                &snapshot(1, "@typ: #let value = 1", &StaticPresetCatalog::default()),
            )
            .unwrap()
            .clone();
        store
            .retained
            .entry(source_uri.clone())
            .or_default()
            .push_back(document.clone());
        assert_eq!(
            store
                .generation(&source_uri, &document.entry_uri, document.revision)
                .unwrap_err(),
            PositionConversionError::AmbiguousGeneration
        );
    }

}
