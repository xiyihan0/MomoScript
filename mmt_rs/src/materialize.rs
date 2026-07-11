//! Platform-neutral materialization coordination.

use crate::diag::{Diagnostic, DiagnosticPhase, Severity};
use crate::emit::MaterializedContent;
use crate::resolve::{ResolvedResource, ResourceResolution, ResourceTarget};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MaterializedImage {
    pub typst_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MaterializeError {
    pub message: String,
}

impl MaterializeError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

pub trait ResourceMaterializer {
    fn materialize(
        &mut self,
        resource: &ResolvedResource,
    ) -> Result<MaterializedImage, MaterializeError>;
}

#[derive(Debug, Clone, Default)]
pub struct Materialization {
    pub content: MaterializedContent,
    pub diagnostics: Vec<Diagnostic>,
}

pub fn materialize_resources(
    resolution: &ResourceResolution,
    materializer: &mut impl ResourceMaterializer,
) -> Materialization {
    let mut result = Materialization::default();
    for failure in &resolution.failures {
        match failure.target {
            ResourceTarget::Inline => {
                result.content.failed_inline.insert(failure.range);
            }
            ResourceTarget::ActorAvatar { actor_id, revision } => {
                result
                    .content
                    .failed_actor_avatars
                    .insert((actor_id, revision));
            }
        }
    }
    for resource in &resolution.resources {
        match materializer.materialize(resource) {
            Ok(image) => match resource.target {
                ResourceTarget::Inline => {
                    result
                        .content
                        .inline_images
                        .insert(resource.range, image.typst_path);
                }
                ResourceTarget::ActorAvatar { actor_id, revision } => {
                    result
                        .content
                        .actor_avatars
                        .insert((actor_id, revision), image.typst_path);
                }
            },
            Err(error) => {
                match resource.target {
                    ResourceTarget::Inline => {
                        result.content.failed_inline.insert(resource.range);
                    }
                    ResourceTarget::ActorAvatar { actor_id, revision } => {
                        result
                            .content
                            .failed_actor_avatars
                            .insert((actor_id, revision));
                    }
                }
                result.diagnostics.push(Diagnostic::new(
                    Severity::Error,
                    DiagnosticPhase::Materialize,
                    error.message,
                    Some(resource.range),
                ));
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resolve::{ResolvedResourceKind, ResourceResolution};
    use crate::source::TextRange;

    struct FakeMaterializer;

    impl ResourceMaterializer for FakeMaterializer {
        fn materialize(
            &mut self,
            resource: &ResolvedResource,
        ) -> Result<MaterializedImage, MaterializeError> {
            match &resource.kind {
                ResolvedResourceKind::RemoteUrl { .. } => {
                    Err(MaterializeError::new("network disabled"))
                }
                _ => Ok(MaterializedImage {
                    typst_path: "cache/image.png".to_string(),
                }),
            }
        }
    }

    #[test]
    fn binds_successful_images_and_preserves_failure_ranges() {
        let local_range = TextRange::new(1, 5);
        let remote_range = TextRange::new(8, 12);
        let avatar_range = TextRange::new(15, 20);
        let resolution = ResourceResolution {
            resources: vec![
                ResolvedResource {
                    range: local_range,
                    target: ResourceTarget::Inline,
                    kind: ResolvedResourceKind::WorkspaceFile {
                        path: "image.png".to_string(),
                    },
                    render_patch: None,
                },
                ResolvedResource {
                    range: remote_range,
                    target: ResourceTarget::Inline,
                    kind: ResolvedResourceKind::RemoteUrl {
                        url: "https://example.com/image.png".to_string(),
                    },
                    render_patch: None,
                },
                ResolvedResource {
                    range: avatar_range,
                    target: ResourceTarget::ActorAvatar {
                        actor_id: crate::semantic::ActorId(2),
                        revision: 3,
                    },
                    kind: ResolvedResourceKind::WorkspaceFile {
                        path: "avatar.png".to_string(),
                    },
                    render_patch: None,
                },
            ],
            failures: Vec::new(),
            diagnostics: Vec::new(),
        };

        let result = materialize_resources(&resolution, &mut FakeMaterializer);

        assert_eq!(
            result
                .content
                .inline_images
                .get(&local_range)
                .map(String::as_str),
            Some("cache/image.png")
        );
        assert!(matches!(
            result.diagnostics.as_slice(),
            [Diagnostic { phase: DiagnosticPhase::Materialize, range: Some(range), .. }]
                if *range == remote_range
        ));
        assert_eq!(
            result
                .content
                .actor_avatars
                .get(&(crate::semantic::ActorId(2), 3))
                .map(String::as_str),
            Some("cache/image.png")
        );
    }
}
