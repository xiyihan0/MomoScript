//! No-I/O Typst projection and conservative bidirectional source mapping.

use serde::Serialize;

use crate::diag::Diagnostic;
use crate::emit::{
    EmitOptions, EmittedTypst, GeneratedKind, MaterializedContent, Origin, OriginKind, emit_typst,
};
use crate::semantic::{
    CharacterPresetCatalog, lower_actors, lower_assets, lower_resource_markers, resolve_body_modes,
};
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
}

#[derive(Debug, Clone)]
pub struct TypstProjection {
    pub emitted: EmittedTypst,
    pub index: ProjectionIndex,
    pub diagnostics: Vec<Diagnostic>,
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
            let (mmt_range, kind, mapping) = classify_origin(origin);
            if let Some(range) = mmt_range {
                if !valid_range(mmt_source, range) {
                    return Err(ProjectionError::InvalidBoundary {
                        space: "mmt",
                        range,
                    });
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

pub fn project_text(
    source: &str,
    catalog: &impl CharacterPresetCatalog,
    emit_options: &EmitOptions,
) -> Result<TypstProjection, ProjectionError> {
    let document = crate::parse_text(source);
    let modes = resolve_body_modes(&document);
    let actors = lower_actors(&document, catalog);
    let assets = lower_assets(&document);
    let resources = lower_resource_markers(&document, &modes, &actors);

    let mut placeholders = MaterializedContent::default();
    for marker in &resources.markers {
        placeholders
            .inline_images
            .insert(marker.range, PROJECTION_PLACEHOLDER_IMAGE.to_string());
    }
    for actor in &actors.actors {
        for revision in &actor.revisions {
            if revision.state.avatar.is_some() {
                placeholders.actor_avatars.insert(
                    (actor.id, revision.number),
                    PROJECTION_PLACEHOLDER_IMAGE.to_string(),
                );
            }
        }
    }

    let mut emitted = emit_typst(&document, &modes, &actors, &placeholders, emit_options);
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
    let index = ProjectionIndex::new(source, &emitted)?;
    let diagnostics = [
        document.diagnostics.as_slice(),
        modes.diagnostics.as_slice(),
        actors.diagnostics.as_slice(),
        assets.diagnostics.as_slice(),
        resources.diagnostics.as_slice(),
        emitted.diagnostics.as_slice(),
    ]
    .into_iter()
    .flatten()
    .cloned()
    .collect();
    Ok(TypstProjection {
        emitted,
        index,
        diagnostics,
    })
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
}
