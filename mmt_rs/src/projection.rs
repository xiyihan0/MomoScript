//! No-I/O Typst projection and conservative bidirectional source mapping.

use serde::Serialize;

use crate::diag::Diagnostic;
use crate::emit::{
    EmitOptions, EmittedTypst, GeneratedKind, MaterializedContent, Origin, OriginKind, emit_typst,
};
use crate::materialize::{MaterializeError, MaterializedImage, ResourceMaterializer};
use crate::pack::PackRegistry;
use crate::pipeline::AnalyzedDocument;
use crate::resolve::{ResolvedResource, ResolvedResourceKind};
use crate::semantic::CharacterPresetCatalog;
use crate::source::TextRange;
use crate::typst_check::check_typst_source;

pub const PROJECTION_PLACEHOLDER_IMAGE: &str = "mmt-assets/placeholder.svg";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectionKind {
    TypstBody,
    StatementPatch,
    ResourcePatch,
    TypDirective,
    TextBody,
    ResourceMarker,
    Generated(GeneratedKind),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MappingMode {
    Identity,
    Synthetic,
    Escaped,
    MacroExpansion,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProjectionSegment {
    pub mmt_range: Option<TextRange>,
    pub typst_range: TextRange,
    pub kind: ProjectionKind,
    pub mapping: MappingMode,
}

/// Trust classification for a location returned by a Typst language backend.
///
/// Only `AuthoredIdentity` carries a reverse mapping in a [`ProjectionIndex`].
/// Workspace and package variants are assigned by the host after it resolves a
/// logical project file. Generated projection text remains navigable only while
/// its immutable generation is retained.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectionMappingKind {
    AuthoredIdentity,
    WorkspaceTypst,
    PackageFile,
    GeneratedProjection,
    StaleUnknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ProjectionMappingResult {
    pub kind: ProjectionMappingKind,
    pub projected_range: TextRange,
    pub source_range: Option<TextRange>,
}

impl ProjectionMappingResult {
    pub const fn external(kind: ProjectionMappingKind, range: TextRange) -> Self {
        Self {
            kind,
            projected_range: range,
            source_range: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectionIndex {
    segments: Vec<ProjectionSegment>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectionEdit {
    pub range: TextRange,
    pub new_text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectionError {
    GapOrOverlap {
        expected_start: usize,
        actual_start: usize,
    },
    InvalidBoundary {
        space: &'static str,
        range: TextRange,
    },
    IdentityLengthMismatch {
        mmt_range: TextRange,
        typst_range: TextRange,
    },
    MissingOrigin {
        origin_id: usize,
    },
    UnsafeEdit {
        range: TextRange,
    },
    MissingResourceAnalysis,
    StalePackAnalysis {
        analyzed_revision: Option<u64>,
        requested_revision: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectedResourceSource {
    ImageDir {
        base: String,
        file_name: String,
    },
    ImageSequence {
        path: String,
        frame: u32,
        sha256: String,
        size: [u32; 2],
        frame_count: u32,
        container: String,
        codec: String,
        alpha: bool,
        profile: serde_json::Value,
    },
    WorkspaceFile {
        file_name: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectedResource {
    pub typst_path: String,
    pub pack_namespace: String,
    pub source: ProjectedResourceSource,
    pub range: TextRange,
}

#[derive(Debug, Clone)]
pub struct TypstProjection {
    pub emitted: EmittedTypst,
    pub index: ProjectionIndex,
    pub diagnostics: Vec<Diagnostic>,
    pub resources: Vec<ProjectedResource>,
}

impl ProjectionIndex {
    pub fn new(mmt_source: &str, emitted: &EmittedTypst) -> Result<Self, ProjectionError> {
        let mut segments = Vec::with_capacity(emitted.source_map.len());
        let mut expected_start = 0;
        for entry in &emitted.source_map {
            if entry.generated_range.start != expected_start {
                return Err(ProjectionError::GapOrOverlap {
                    expected_start,
                    actual_start: entry.generated_range.start,
                });
            }
            if !valid_range(&emitted.source, entry.generated_range) {
                return Err(ProjectionError::InvalidBoundary {
                    space: "typst",
                    range: entry.generated_range,
                });
            }
            let Some(origin) = emitted.origins.get(entry.origin_id) else {
                return Err(ProjectionError::MissingOrigin {
                    origin_id: entry.origin_id,
                });
            };
            let (mmt_range, kind, mut mapping) = classify_origin(origin);
            if let Some(range) = mmt_range {
                if !valid_range(mmt_source, range) {
                    return Err(ProjectionError::InvalidBoundary {
                        space: "mmt",
                        range,
                    });
                }
                if mapping == MappingMode::Escaped
                    && mmt_source.get(range.start..range.end)
                        == emitted.source.get(entry.generated_range.start..entry.generated_range.end)
                {
                    mapping = MappingMode::Identity;
                }
                if mapping == MappingMode::Identity && range.len() != entry.generated_range.len() {
                    return Err(ProjectionError::IdentityLengthMismatch {
                        mmt_range: range,
                        typst_range: entry.generated_range,
                    });
                }
            }
            segments.push(ProjectionSegment {
                mmt_range,
                typst_range: entry.generated_range,
                kind,
                mapping,
            });
            expected_start = entry.generated_range.end;
        }
        if expected_start != emitted.source.len() {
            return Err(ProjectionError::GapOrOverlap {
                expected_start,
                actual_start: emitted.source.len(),
            });
        }
        Ok(Self { segments })
    }

    pub fn segments(&self) -> &[ProjectionSegment] {
        &self.segments
    }

    pub fn mmt_to_typst(&self, offset: usize) -> Option<usize> {
        let mut mapped = None;
        for segment in self
            .segments
            .iter()
            .filter(|segment| segment.mapping == MappingMode::Identity)
        {
            let range = segment.mmt_range?;
            if range.start <= offset && offset <= range.end {
                let candidate = segment.typst_range.start + offset - range.start;
                if mapped.is_some_and(|previous| previous != candidate) {
                    return None;
                }
                mapped = Some(candidate);
            }
        }
        mapped
    }

    pub fn mmt_range_to_typst(&self, range: TextRange) -> Option<TextRange> {
        let mut candidates = self.segments.iter().filter(|segment| {
            segment.mapping == MappingMode::Identity
                && segment
                    .mmt_range
                    .is_some_and(|source| source.start <= range.start && range.end <= source.end)
        });
        let segment = candidates.next()?;
        if candidates.next().is_some() {
            return None;
        }
        let source = segment.mmt_range?;
        Some(TextRange::new(
            segment.typst_range.start + range.start - source.start,
            segment.typst_range.start + range.end - source.start,
        ))
    }

    pub fn typst_to_mmt(&self, range: TextRange) -> Option<TextRange> {
        let segment = self.segments.iter().find(|segment| {
            segment.mapping == MappingMode::Identity
                && segment.typst_range.start <= range.start
                && range.end <= segment.typst_range.end
        })?;
        let mmt = segment.mmt_range?;
        Some(TextRange::new(
            mmt.start + range.start - segment.typst_range.start,
            mmt.start + range.end - segment.typst_range.start,
        ))
    }

    /// Classifies a backend byte range without guessing across source-map
    /// segments. A range is authored only when it is wholly contained in one
    /// Identity segment. Other exact single-segment ranges are generated and
    /// remain useful for read-only navigation. Invalid, ambiguous, and
    /// cross-segment ranges are explicitly stale/unknown.
    pub fn classify_read(&self, range: TextRange) -> ProjectionMappingResult {
        let mut candidates = self.segments.iter().filter(|segment| {
            if range.start > range.end {
                return false;
            }
            if range.start == range.end {
                segment.typst_range.start <= range.start
                    && (range.start < segment.typst_range.end
                        || (range.start == segment.typst_range.end
                            && segment.typst_range.end
                                == self.segments.last().map_or(0, |last| last.typst_range.end)))
            } else {
                segment.typst_range.start <= range.start && range.end <= segment.typst_range.end
            }
        });
        let Some(segment) = candidates.next() else {
            return ProjectionMappingResult::external(ProjectionMappingKind::StaleUnknown, range);
        };
        if candidates.next().is_some() {
            return ProjectionMappingResult::external(ProjectionMappingKind::StaleUnknown, range);
        }
        if segment.mapping != MappingMode::Identity {
            return ProjectionMappingResult::external(
                ProjectionMappingKind::GeneratedProjection,
                range,
            );
        }
        let Some(source_range) = self.typst_to_mmt(range) else {
            return ProjectionMappingResult::external(ProjectionMappingKind::StaleUnknown, range);
        };
        ProjectionMappingResult {
            kind: ProjectionMappingKind::AuthoredIdentity,
            projected_range: range,
            source_range: Some(source_range),
        }
    }

    pub fn map_text_edit(&self, edit: &ProjectionEdit) -> Result<ProjectionEdit, ProjectionError> {
        let Some(range) = self.typst_to_mmt(edit.range) else {
            return Err(ProjectionError::UnsafeEdit { range: edit.range });
        };
        Ok(ProjectionEdit {
            range,
            new_text: edit.new_text.clone(),
        })
    }
}

pub fn diagnose_text(
    source: &str,
    catalog: &impl CharacterPresetCatalog,
    emit_options: &EmitOptions,
) -> Vec<Diagnostic> {
    let analysis = crate::pipeline::analyze_text(source, catalog);
    diagnose_analyzed(&analysis, emit_options)
}

pub fn diagnose_analyzed(
    analysis: &AnalyzedDocument,
    emit_options: &EmitOptions,
) -> Vec<Diagnostic> {
    diagnose_and_emit(analysis, emit_options).1
}

fn diagnose_and_emit(
    analysis: &AnalyzedDocument,
    emit_options: &EmitOptions,
) -> (EmittedTypst, Vec<Diagnostic>) {
    let mut placeholders = MaterializedContent::default();
    for marker in &analysis.resource_markers.markers {
        placeholders
            .inline_images
            .insert(marker.range, PROJECTION_PLACEHOLDER_IMAGE.to_string());
    }
    for actor in &analysis.actors.actors {
        for revision in &actor.revisions {
            if revision.state.avatar.is_some() {
                placeholders.actor_avatars.insert(
                    (actor.id, revision.number),
                    PROJECTION_PLACEHOLDER_IMAGE.to_string(),
                );
            }
        }
    }

    let mut emitted = emit_typst(
        &analysis.document,
        &analysis.document_config.config,
        &analysis.modes,
        &analysis.actors,
        &placeholders,
        emit_options,
    );
    let generated_range = TextRange::new(0, emitted.source.len());
    let generated_diagnostics = check_typst_source(&emitted.source, generated_range)
        .into_iter()
        .map(|diagnostic| {
            diagnostic
                .range
                .map(|range| emitted.map_typst_diagnostic(diagnostic.message.clone(), range))
                .unwrap_or(diagnostic)
        })
        .collect::<Vec<_>>();
    emitted.diagnostics.extend(generated_diagnostics);
    let resolution_diagnostics = analysis
        .resolution
        .as_ref()
        .map_or(&[][..], |resolution| resolution.diagnostics.as_slice());
    let diagnostics = [
        analysis.document.diagnostics.as_slice(),
        analysis.document_config.diagnostics.as_slice(),
        analysis.modes.diagnostics.as_slice(),
        analysis.actors.diagnostics.as_slice(),
        analysis.assets.diagnostics.as_slice(),
        analysis.resource_markers.diagnostics.as_slice(),
        resolution_diagnostics,
        emitted.diagnostics.as_slice(),
    ]
    .into_iter()
    .flatten()
    .cloned()
    .collect();
    (emitted, diagnostics)
}

pub fn project_text(
    source: &str,
    catalog: &impl CharacterPresetCatalog,
    emit_options: &EmitOptions,
) -> Result<TypstProjection, ProjectionError> {
    let analysis = crate::pipeline::analyze_text(source, catalog);
    project_analyzed(source, &analysis, emit_options)
}

pub fn project_analyzed(
    source: &str,
    analysis: &AnalyzedDocument,
    emit_options: &EmitOptions,
) -> Result<TypstProjection, ProjectionError> {
    let (emitted, diagnostics) = diagnose_and_emit(analysis, emit_options);
    let index = ProjectionIndex::new(source, &emitted)?;
    Ok(TypstProjection {
        emitted,
        index,
        diagnostics,
        resources: Vec::new(),
    })
}

pub fn diagnose_text_with_pack(
    source: &str,
    packs: &PackRegistry,
    emit_options: &EmitOptions,
) -> Vec<Diagnostic> {
    let analysis = crate::pipeline::analyze_text_with_pack(source, packs);
    diagnose_analyzed_with_pack(&analysis, emit_options)
        .expect("pack analysis always contains resource resolution")
}

pub fn diagnose_analyzed_with_pack(
    analysis: &AnalyzedDocument,
    emit_options: &EmitOptions,
) -> Result<Vec<Diagnostic>, ProjectionError> {
    let mut materializer = ProjectionMaterializer::default();
    let compilation = crate::pipeline::compile_analyzed(analysis, &mut materializer, emit_options)
        .ok_or(ProjectionError::MissingResourceAnalysis)?;
    Ok(compilation.diagnostics)
}

pub fn project_text_with_pack(
    source: &str,
    packs: &PackRegistry,
    emit_options: &EmitOptions,
) -> Result<TypstProjection, ProjectionError> {
    let analysis = crate::pipeline::analyze_text_with_pack(source, packs);
    project_analyzed_with_pack(source, &analysis, emit_options)
}

pub fn project_analyzed_with_pack(
    source: &str,
    analysis: &AnalyzedDocument,
    emit_options: &EmitOptions,
) -> Result<TypstProjection, ProjectionError> {
    let mut materializer = ProjectionMaterializer::default();
    let compilation = crate::pipeline::compile_analyzed(analysis, &mut materializer, emit_options)
        .ok_or(ProjectionError::MissingResourceAnalysis)?;
    let index = ProjectionIndex::new(source, &compilation.typst)?;
    Ok(TypstProjection {
        emitted: compilation.typst,
        index,
        diagnostics: compilation.diagnostics,
        resources: materializer.resources,
    })
}

#[derive(Default)]
struct ProjectionMaterializer {
    resources: Vec<ProjectedResource>,
}

impl ResourceMaterializer for ProjectionMaterializer {
    fn materialize(
        &mut self,
        resource: &ResolvedResource,
    ) -> Result<MaterializedImage, MaterializeError> {
        if let Some(path) = local_resource_path(&resource.kind) {
            let file_name = sanitized_basename(path)?;
            self.resources.push(ProjectedResource {
                typst_path: file_name.clone(),
                pack_namespace: String::new(),
                source: ProjectedResourceSource::WorkspaceFile {
                    file_name: file_name.clone(),
                },
                range: resource.range,
            });
            return Ok(MaterializedImage {
                typst_path: file_name,
            });
        }
        let source = match &resource.kind {
            ResolvedResourceKind::Avatar { source, .. }
            | ResolvedResourceKind::Sticker { source, .. }
            | ResolvedResourceKind::PackAsset { source, .. } => source,
            _ => {
                return Err(MaterializeError::new(
                    "Web preview cannot materialize this resource source",
                ));
            }
        };
        let (typst_path, projected_source) =
            match source.storage.kind.as_str() {
                "image-dir" => {
                    let file_name =
                        sanitized_basename(source.path.as_deref().ok_or_else(|| {
                            MaterializeError::new("image-dir resource has no path")
                        })?)?;
                    let base =
                        source.storage.base.clone().ok_or_else(|| {
                            MaterializeError::new("image-dir storage has no base")
                        })?;
                    let extension = file_name
                        .rsplit_once('.')
                        .map(|(_, extension)| extension)
                        .unwrap_or("img");
                    (
                        format!("mmt-resources/{}.{}", self.resources.len(), extension),
                        ProjectedResourceSource::ImageDir { base, file_name },
                    )
                }
                "image-sequence" => {
                    let path = source.storage.path.clone().ok_or_else(|| {
                        MaterializeError::new("image-sequence storage has no path")
                    })?;
                    let frame = source.frame.ok_or_else(|| {
                        MaterializeError::new("image-sequence resource has no frame")
                    })?;
                    let frame_count = source.storage.frame_count.ok_or_else(|| {
                        MaterializeError::new("image-sequence storage has no frame_count")
                    })?;
                    if frame >= frame_count {
                        return Err(MaterializeError::new(
                            "image-sequence frame is outside frame_count",
                        ));
                    }
                    let sha256 = source.storage.sha256.clone().ok_or_else(|| {
                        MaterializeError::new("image-sequence storage has no sha256")
                    })?;
                    let size = source.storage.size.ok_or_else(|| {
                        MaterializeError::new("image-sequence storage has no size")
                    })?;
                    let container = source.storage.container.clone().ok_or_else(|| {
                        MaterializeError::new("image-sequence storage has no container")
                    })?;
                    let codec = source.storage.codec.clone().ok_or_else(|| {
                        MaterializeError::new("image-sequence storage has no codec")
                    })?;
                    let alpha = source.storage.alpha.ok_or_else(|| {
                        MaterializeError::new("image-sequence storage has no alpha metadata")
                    })?;
                    let profile = source.storage.profile.clone().ok_or_else(|| {
                        MaterializeError::new("image-sequence storage has no profile")
                    })?;
                    (
                        format!("mmt-resources/{}.png", self.resources.len()),
                        ProjectedResourceSource::ImageSequence {
                            path,
                            frame,
                            sha256,
                            size,
                            frame_count,
                            container,
                            codec,
                            alpha,
                            profile,
                        },
                    )
                }
                kind => {
                    return Err(MaterializeError::new(format!(
                        "Web preview does not support '{kind}' storage"
                    )));
                }
            };
        self.resources.push(ProjectedResource {
            typst_path: typst_path.clone(),
            pack_namespace: source.pack_namespace.clone(),
            source: projected_source,
            range: resource.range,
        });
        Ok(MaterializedImage { typst_path })
    }
}

fn local_resource_path(kind: &ResolvedResourceKind) -> Option<&str> {
    match kind {
        ResolvedResourceKind::WorkspaceFile { path } => Some(path),
        ResolvedResourceKind::ScriptAsset {
            source: crate::semantic::AssetSource::LocalFile(path),
            ..
        } => Some(path),
        _ => None,
    }
}

fn sanitized_basename(path: &str) -> Result<String, MaterializeError> {
    if path.is_empty() || path == "." || path == ".." || path.contains('/') || path.contains('\\') {
        return Err(MaterializeError::new(
            "workspace resource path must be a basename",
        ));
    }
    Ok(path.to_string())
}
fn classify_origin(origin: &Origin) -> (Option<TextRange>, ProjectionKind, MappingMode) {
    match origin {
        Origin::MmtRange { range, kind } => {
            let (kind, mapping) = match kind {
                OriginKind::TypstBody => (ProjectionKind::TypstBody, MappingMode::Identity),
                OriginKind::StatementPatch => {
                    (ProjectionKind::StatementPatch, MappingMode::Identity)
                }
                OriginKind::ResourcePatch => (ProjectionKind::ResourcePatch, MappingMode::Identity),
                OriginKind::TypDirective => (ProjectionKind::TypDirective, MappingMode::Identity),
                OriginKind::TextBody | OriginKind::DirectiveField => {
                    (ProjectionKind::TextBody, MappingMode::Escaped)
                }
                OriginKind::ResourceMarker => {
                    (ProjectionKind::ResourceMarker, MappingMode::MacroExpansion)
                }
            };
            (Some(*range), kind, mapping)
        }
        Origin::Generated { kind, .. } => (
            None,
            ProjectionKind::Generated(kind.clone()),
            MappingMode::Synthetic,
        ),
    }
}

fn valid_range(source: &str, range: TextRange) -> bool {
    range.start <= range.end
        && range.end <= source.len()
        && source.is_char_boundary(range.start)
        && source.is_char_boundary(range.end)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::semantic::{CharacterPreset, StaticPresetCatalog};

    fn catalog() -> StaticPresetCatalog {
        StaticPresetCatalog::new(vec![CharacterPreset {
            id: "ba::柚子".to_string(),
            names: vec!["柚子".to_string()],
            display_name: None,
            avatar: Some("avatar/default".to_string()),
        }])
    }

    #[test]
    fn no_io_projection_maps_only_identity_regions() {
        let source = "@actor 柚子\npreset: ba::柚子\n@end\n\
                      @typ: #let accent = blue\n\
                      >(fill: accent) 柚子: T\"\"\"hello [:#1:](width: 2em)\"\"\"";
        let projection = project_text(source, &catalog(), &EmitOptions::default()).unwrap();
        assert!(projection.diagnostics.is_empty());
        assert!(
            projection
                .emitted
                .source
                .contains(PROJECTION_PLACEHOLDER_IMAGE)
        );
        assert_eq!(
            projection
                .index
                .segments()
                .first()
                .unwrap()
                .typst_range
                .start,
            0
        );
        assert_eq!(
            projection.index.segments().last().unwrap().typst_range.end,
            projection.emitted.source.len()
        );

        let mmt_offset = source.find("accent = blue").unwrap();
        let typst_offset = projection.index.mmt_to_typst(mmt_offset).unwrap();
        assert_eq!(
            &projection.emitted.source[typst_offset..typst_offset + "accent".len()],
            "accent"
        );
        let patch_offset = projection.emitted.source.find("width: 2em").unwrap();
        let mapped_patch = projection
            .index
            .typst_to_mmt(TextRange::new(patch_offset, patch_offset + "width".len()))
            .unwrap();
        assert_eq!(&source[mapped_patch.start..mapped_patch.end], "width");

        let wrapper = projection.emitted.source.find("#mmt.chat-left").unwrap();
        assert!(
            projection
                .index
                .typst_to_mmt(TextRange::new(wrapper, wrapper + 4))
                .is_none()
        );
        assert!(matches!(
            projection.index.map_text_edit(&ProjectionEdit {
                range: TextRange::new(wrapper, wrapper + 4),
                new_text: "#foo".to_string(),
            }),
            Err(ProjectionError::UnsafeEdit { .. })
        ));
    }
    #[test]
    fn read_classification_is_exact_and_conservative() {
        let index = ProjectionIndex {
            segments: vec![
                ProjectionSegment {
                    mmt_range: Some(TextRange::new(10, 14)),
                    typst_range: TextRange::new(0, 4),
                    kind: ProjectionKind::TypDirective,
                    mapping: MappingMode::Identity,
                },
                ProjectionSegment {
                    mmt_range: Some(TextRange::new(20, 24)),
                    typst_range: TextRange::new(4, 8),
                    kind: ProjectionKind::TextBody,
                    mapping: MappingMode::Synthetic,
                },
                ProjectionSegment {
                    mmt_range: Some(TextRange::new(30, 34)),
                    typst_range: TextRange::new(8, 12),
                    kind: ProjectionKind::TextBody,
                    mapping: MappingMode::Escaped,
                },
                ProjectionSegment {
                    mmt_range: Some(TextRange::new(40, 44)),
                    typst_range: TextRange::new(12, 16),
                    kind: ProjectionKind::TextBody,
                    mapping: MappingMode::MacroExpansion,
                },
            ],
        };

        assert_eq!(
            index.classify_read(TextRange::new(1, 3)),
            ProjectionMappingResult {
                kind: ProjectionMappingKind::AuthoredIdentity,
                projected_range: TextRange::new(1, 3),
                source_range: Some(TextRange::new(11, 13)),
            }
        );
        assert_eq!(
            index.mmt_range_to_typst(TextRange::new(11, 13)),
            Some(TextRange::new(1, 3))
        );
        assert_eq!(index.mmt_range_to_typst(TextRange::new(13, 21)), None);
        for range in [
            TextRange::new(5, 7),
            TextRange::new(9, 11),
            TextRange::new(13, 15),
        ] {
            assert_eq!(
                index.classify_read(range),
                ProjectionMappingResult::external(
                    ProjectionMappingKind::GeneratedProjection,
                    range,
                )
            );
        }
        for range in [TextRange::new(3, 5), TextRange::new(17, 17)] {
            assert_eq!(
                index.classify_read(range).kind,
                ProjectionMappingKind::StaleUnknown
            );
        }
    }

    #[test]
    fn projection_materializes_only_basename_workspace_files() {
        let resource = ResolvedResource {
            range: TextRange::new(0, 1),
            target: crate::resolve::ResourceTarget::Inline,
            kind: ResolvedResourceKind::WorkspaceFile {
                path: "image.png".to_string(),
            },
            render_patch: None,
        };
        let mut materializer = ProjectionMaterializer::default();
        let image = materializer.materialize(&resource).unwrap();
        assert_eq!(image.typst_path, "image.png");
        assert!(
            matches!(&materializer.resources[0].source, ProjectedResourceSource::WorkspaceFile { file_name } if file_name == "image.png")
        );

        for path in ["../image.png", "dir/image.png", "dir\\image.png", ".", ".."] {
            let invalid = ResolvedResource {
                kind: ResolvedResourceKind::WorkspaceFile {
                    path: path.to_string(),
                },
                ..resource.clone()
            };
            assert!(
                materializer.materialize(&invalid).is_err(),
                "accepted unsafe path: {path}"
            );
        }
    }
}
