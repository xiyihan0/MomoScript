//! Deterministic resource resolution between semantic lowering and materialization.

use crate::diag::{Diagnostic, DiagnosticPhase, Severity};
use crate::pack::{PackRegistry, ResolveError, StorageEntry};
use crate::semantic::{
    ActorId, ActorLowering, AssetLowering, AssetSource, CharacterPresetCatalog, PresetLookup,
    ResolvedResourceMarker, ResourceLowering, ResourceSelector,
};
use crate::source::TextRange;
use crate::syntax::PatchSyntax;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedResource {
    pub range: TextRange,
    pub target: ResourceTarget,
    pub kind: ResolvedResourceKind,
    pub render_patch: Option<PatchSyntax>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResourceTarget {
    Inline,
    ActorAvatar { actor_id: ActorId, revision: u32 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolvedResourceKind {
    Sticker {
        entity_id: String,
        contribution_namespace: String,
        set_id: String,
        variant_id: String,
        source: PackStorageSource,
    },
    Avatar {
        entity_id: String,
        contribution_namespace: String,
        variant_id: String,
        source: PackStorageSource,
    },
    ScriptAsset {
        namespace: String,
        name: String,
        source: AssetSource,
    },
    PackAsset {
        name: String,
        source: PackStorageSource,
    },
    Temporary {
        name: String,
    },
    WorkspaceFile {
        path: String,
    },
    RemoteUrl {
        url: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackStorageSource {
    pub pack_namespace: String,
    pub storage_id: String,
    pub storage: StorageEntry,
    pub path: Option<String>,
    pub frame: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResourceResolution {
    pub resources: Vec<ResolvedResource>,
    pub failures: Vec<ResourceFailure>,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResourceFailure {
    pub range: TextRange,
    pub target: ResourceTarget,
}

pub fn resolve_resources(
    lowered: &ResourceLowering,
    actors: &ActorLowering,
    assets: &AssetLowering,
    packs: &PackRegistry,
) -> ResourceResolution {
    let mut resources = Vec::new();
    let mut failures = Vec::new();
    let mut diagnostics = Vec::new();
    for marker in &lowered.markers {
        match resolve_marker(marker, actors, assets, packs) {
            Ok(kind) => resources.push(ResolvedResource {
                range: marker.range,
                target: ResourceTarget::Inline,
                kind,
                render_patch: marker.render_patch.clone(),
            }),
            Err(message) => {
                failures.push(ResourceFailure {
                    range: marker.range,
                    target: ResourceTarget::Inline,
                });
                diagnostics.push(Diagnostic::new(
                    Severity::Error,
                    DiagnosticPhase::Resolve,
                    message,
                    Some(marker.range),
                ));
            }
        }
    }
    ResourceResolution {
        resources,
        failures,
        diagnostics,
    }
}

pub fn resolve_actor_avatars(
    actors: &ActorLowering,
    assets: &AssetLowering,
    packs: &PackRegistry,
) -> ResourceResolution {
    let mut resources = Vec::new();
    let mut failures = Vec::new();
    let mut diagnostics = Vec::new();
    for actor in &actors.actors {
        for revision in &actor.revisions {
            let Some(selector) = revision.state.avatar.as_deref() else {
                continue;
            };
            match resolve_avatar_selector(selector, &actor.preset_id, actors, assets, packs) {
                Ok(kind) => resources.push(ResolvedResource {
                    range: revision.origin,
                    target: ResourceTarget::ActorAvatar {
                        actor_id: actor.id,
                        revision: revision.number,
                    },
                    kind,
                    render_patch: None,
                }),
                Err(message) => {
                    failures.push(ResourceFailure {
                        range: revision.origin,
                        target: ResourceTarget::ActorAvatar {
                            actor_id: actor.id,
                            revision: revision.number,
                        },
                    });
                    diagnostics.push(Diagnostic::new(
                        Severity::Error,
                        DiagnosticPhase::Resolve,
                        message,
                        Some(revision.origin),
                    ));
                }
            }
        }
    }
    ResourceResolution {
        resources,
        failures,
        diagnostics,
    }
}

fn resolve_avatar_selector(
    selector: &str,
    current_entity: &str,
    actors: &ActorLowering,
    assets: &AssetLowering,
    packs: &PackRegistry,
) -> Result<ResolvedResourceKind, String> {
    if let Some(name) = selector.strip_prefix("asset::") {
        return resolve_asset_kind(name, assets, packs);
    }

    let (entity_id, contribution, variant) = if selector.contains('/') {
        let parts = selector.split('/').collect::<Vec<_>>();
        if parts.len() != 3 {
            return Err("avatar path must be <subject>/[namespace::]avatar/<variant>".to_string());
        }
        let entity_id = resolve_avatar_subject(parts[0], actors, packs)?;
        let contribution = if parts[1] == "avatar" {
            None
        } else {
            Some(
                parts[1]
                    .strip_suffix("::avatar")
                    .filter(|namespace| !namespace.is_empty())
                    .ok_or_else(|| "avatar path contains an invalid slot segment".to_string())?
                    .to_string(),
            )
        };
        (entity_id, contribution, parts[2].to_string())
    } else if let Some((namespace, variant)) = selector.split_once("::") {
        (
            current_entity.to_string(),
            Some(namespace.to_string()),
            variant.to_string(),
        )
    } else {
        (current_entity.to_string(), None, selector.to_string())
    };
    if variant.is_empty() {
        return Err("avatar selector requires a variant".to_string());
    }
    let avatar = packs
        .resolve_avatar(&entity_id, contribution.as_deref(), &variant)
        .map_err(format_resolve_error)?;
    let source = pack_source(
        packs,
        avatar.storage_pack_namespace,
        avatar.storage_id,
        avatar.path,
        avatar.frame,
    )?;
    Ok(ResolvedResourceKind::Avatar {
        entity_id: avatar.entity_id,
        contribution_namespace: avatar.contribution_namespace,
        variant_id: avatar.variant_id,
        source,
    })
}

fn resolve_avatar_subject(
    reference: &str,
    actors: &ActorLowering,
    packs: &PackRegistry,
) -> Result<String, String> {
    if let Some(actor) = actors
        .actors
        .iter()
        .find(|actor| actor.names.iter().any(|name| name == reference))
    {
        return Ok(actor.preset_id.clone());
    }
    match packs.resolve(reference) {
        PresetLookup::Found(preset) => Ok(preset.id),
        PresetLookup::Missing => Err(format!("avatar subject '{reference}' was not found")),
        PresetLookup::Ambiguous { preset_ids } => Err(format!(
            "avatar subject '{reference}' is ambiguous; candidates: {}",
            preset_ids.join(", ")
        )),
    }
}

fn resolve_marker(
    marker: &ResolvedResourceMarker,
    actors: &ActorLowering,
    assets: &AssetLowering,
    packs: &PackRegistry,
) -> Result<ResolvedResourceKind, String> {
    match &marker.selector {
        ResourceSelector::Sticker { .. } => {
            let sticker = packs
                .resolve_sticker(&marker.selector, actors)
                .map_err(format_resolve_error)?;
            let source = pack_source(
                packs,
                sticker.storage_pack_namespace,
                sticker.storage_id,
                sticker.path,
                sticker.frame,
            )?;
            Ok(ResolvedResourceKind::Sticker {
                entity_id: sticker.entity_id,
                contribution_namespace: sticker.contribution_namespace,
                set_id: sticker.set_id,
                variant_id: sticker.variant_id,
                source,
            })
        }
        ResourceSelector::Asset { name } => resolve_asset_kind(name, assets, packs),
        ResourceSelector::Temporary { name } => {
            Ok(ResolvedResourceKind::Temporary { name: name.clone() })
        }
        ResourceSelector::File { path } => {
            Ok(ResolvedResourceKind::WorkspaceFile { path: path.clone() })
        }
        ResourceSelector::Url { url } => Ok(ResolvedResourceKind::RemoteUrl { url: url.clone() }),
    }
}

fn resolve_asset_kind(
    name: &str,
    assets: &AssetLowering,
    packs: &PackRegistry,
) -> Result<ResolvedResourceKind, String> {
    if let Some(asset) = assets.resolve(name) {
        return Ok(ResolvedResourceKind::ScriptAsset {
            namespace: asset.id.namespace.clone(),
            name: asset.id.name.clone(),
            source: asset.source.clone(),
        });
    }
    let asset = packs.resolve_asset(name).map_err(format_resolve_error)?;
    let source = pack_source(
        packs,
        asset.pack_namespace,
        asset.storage_id,
        Some(asset.path),
        None,
    )?;
    Ok(ResolvedResourceKind::PackAsset {
        name: asset.name,
        source,
    })
}

fn pack_source(
    packs: &PackRegistry,
    pack_namespace: String,
    storage_id: String,
    path: Option<String>,
    frame: Option<u32>,
) -> Result<PackStorageSource, String> {
    let storage = packs
        .storage(&pack_namespace, &storage_id)
        .cloned()
        .ok_or_else(|| {
            format!("pack '{pack_namespace}' has no storage entry named '{storage_id}'")
        })?;
    Ok(PackStorageSource {
        pack_namespace,
        storage_id,
        storage,
        path,
        frame,
    })
}

fn format_resolve_error(error: ResolveError) -> String {
    match error {
        ResolveError::Invalid(message) => message,
        ResolveError::Missing(reference) => format!("resource '{reference}' was not found"),
        ResolveError::Ambiguous {
            reference,
            candidates,
        } => format!(
            "resource '{reference}' is ambiguous; candidates: {}",
            candidates.join(", ")
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pack::{PackManifest, PackRegistry};
    use crate::{
        lower_actors, lower_assets, lower_resource_markers, parse_text, resolve_body_modes,
    };

    const PACK: &str = r#"{
      "schema":"mmt-pack.v3",
      "pack":{"namespace":"ba","name":"BA","version":"1","type":"base"},
      "entities":{"柚子":{"names":["柚子"],"slots":{"avatar":{"default":"default","items":{"default":{"storage":"avatars","path":"default.png"},"smile":{"handles":["微笑"],"storage":"avatars","path":"smile.png"}}},"sticker":{"default":"default","sets":{"default":{"storage":"stickers","variants":[{"id":"happy","ordinal":1,"frame":0}]}}}}}},
      "assets":{"logo":{"source":{"storage":"images","path":"logo.png"}}},
      "storage":{"stickers":{"kind":"image-sequence","path":"stickers.avifs","container":"avifs","codec":"av1","alpha":true,"frame_count":1,"size":[512,512],"sha256":"hash","profile":{"qcolor":80,"keyframe_interval":30}},"avatars":{"kind":"image-dir","base":"avatars"},"images":{"kind":"image-dir","base":"images"}}
    }"#;

    fn lower(source: &str) -> (ResourceLowering, ActorLowering, AssetLowering, PackRegistry) {
        let packs = PackRegistry::new(vec![PackManifest::from_json(PACK).unwrap()]).unwrap();
        let document = parse_text(source);
        let modes = resolve_body_modes(&document);
        let actors = lower_actors(&document, &packs);
        let assets = lower_assets(&document);
        let resources = lower_resource_markers(&document, &modes, &actors);
        (resources, actors, assets, packs)
    }

    #[test]
    fn resolves_sticker_to_pack_scoped_storage_metadata() {
        let (markers, actors, assets, packs) = lower("> 柚子: [:#1:]");
        let resolved = resolve_resources(&markers, &actors, &assets, &packs);

        assert!(resolved.diagnostics.is_empty());
        assert!(matches!(
            &resolved.resources[0].kind,
            ResolvedResourceKind::Sticker { entity_id, source, .. }
                if entity_id == "ba::柚子"
                    && source.pack_namespace == "ba"
                    && source.storage_id == "stickers"
                    && source.frame == Some(0)
        ));
    }

    #[test]
    fn script_asset_shadows_same_named_pack_asset_explicitly() {
        let (markers, actors, assets, packs) = lower(
            "@asset logo\n\
             src: local.png\n\
             @end\n\
             - [:asset::logo:]",
        );
        let resolved = resolve_resources(&markers, &actors, &assets, &packs);

        assert!(matches!(
            &resolved.resources[0].kind,
            ResolvedResourceKind::ScriptAsset { source: AssetSource::LocalFile(path), .. }
                if path == "local.png"
        ));
    }

    #[test]
    fn missing_resources_report_resolve_phase_at_marker() {
        let (markers, actors, assets, packs) = lower("- [:asset::missing:]");
        let marker_range = markers.markers[0].range;
        let resolved = resolve_resources(&markers, &actors, &assets, &packs);

        assert!(resolved.resources.is_empty());
        assert!(matches!(
            resolved.diagnostics.as_slice(),
            [Diagnostic { phase: DiagnosticPhase::Resolve, range: Some(range), .. }]
                if *range == marker_range
        ));
    }

    #[test]
    fn resolves_default_shorthand_and_full_path_avatars() {
        for selector in ["default", "微笑", "ba::柚子/avatar/smile"] {
            let source = format!(
                "@actor\n\
                 preset: ba::柚子\n\
                 avatar: {selector}\n\
                 @end\n\
                 > 柚子: hello"
            );
            let (_, actors, assets, packs) = lower(&source);
            let resolved = resolve_actor_avatars(&actors, &assets, &packs);

            assert!(
                resolved.diagnostics.is_empty(),
                "{selector}: {:?}",
                resolved.diagnostics
            );
            assert!(matches!(
                &resolved.resources[0],
                ResolvedResource {
                    target: ResourceTarget::ActorAvatar { revision: 0, .. },
                    kind: ResolvedResourceKind::Avatar { source, .. },
                    ..
                } if source.storage_id == "avatars"
            ));
        }
    }

    #[test]
    fn actor_avatar_can_use_a_script_asset() {
        let source = "@asset portrait\n\
                      src: portrait.png\n\
                      @end\n\
                      @actor\n\
                      preset: ba::柚子\n\
                      avatar: asset::portrait\n\
                      @end\n\
                      > 柚子: hello";
        let (_, actors, assets, packs) = lower(source);
        let resolved = resolve_actor_avatars(&actors, &assets, &packs);

        assert!(matches!(
            &resolved.resources[0].kind,
            ResolvedResourceKind::ScriptAsset {
                source: AssetSource::LocalFile(path),
                ..
            } if path == "portrait.png"
        ));
    }
}
