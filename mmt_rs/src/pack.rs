//! Resource pack v3 manifest model and deterministic logical resolver.

use std::collections::{HashMap, HashSet};

use serde::Deserialize;

use crate::semantic::{
    ActorLowering, CharacterPreset, CharacterPresetCatalog, PresetLookup, ResourceSelector,
    SubjectRef, VariantSelector,
};

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PackNamespace(pub String);

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct PackManifest {
    pub schema: String,
    pub pack: PackMetadata,
    #[serde(default)]
    pub entities: HashMap<String, Entity>,
    #[serde(default)]
    pub contributions: Vec<Contribution>,
    #[serde(default)]
    pub assets: HashMap<String, PackAsset>,
    #[serde(default)]
    pub thumbnails: HashMap<String, PackAssetSource>,
    #[serde(default)]
    pub storage: HashMap<String, StorageEntry>,
}

impl PackManifest {
    pub fn from_json(source: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(source)
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct PackMetadata {
    pub namespace: String,
    pub name: String,
    pub version: String,
    #[serde(rename = "type")]
    pub pack_type: String,
    #[serde(default)]
    pub requires: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct Entity {
    #[serde(default)]
    pub names: Vec<String>,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub slots: Slots,
}

#[derive(Debug, Clone, Deserialize, Default, PartialEq, Eq)]
pub struct Slots {
    #[serde(default)]
    pub avatar: Option<AvatarSlot>,
    #[serde(default)]
    pub sticker: Option<StickerSlot>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct AvatarSlot {
    #[serde(default)]
    pub default: Option<String>,
    #[serde(default)]
    pub items: HashMap<String, AvatarItem>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct AvatarItem {
    #[serde(default)]
    pub handles: Vec<String>,
    pub storage: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub frame: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct StickerSlot {
    #[serde(default)]
    pub default: Option<String>,
    #[serde(default)]
    pub sets: HashMap<String, StickerSet>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct StickerSet {
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub handles: Vec<String>,
    pub storage: String,
    #[serde(default)]
    pub variants: Vec<StickerVariant>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct StickerVariant {
    pub id: String,
    #[serde(default)]
    pub ordinal: Option<u32>,
    #[serde(default)]
    pub frame: Option<u32>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub handles: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct Contribution {
    pub target: String,
    #[serde(default)]
    pub slots: Slots,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct PackAsset {
    #[serde(default)]
    pub kind: Option<String>,
    pub source: PackAssetSource,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct PackAssetSource {
    pub storage: String,
    pub path: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct StorageEntry {
    pub kind: String,
    #[serde(default)]
    pub base: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub container: Option<String>,
    #[serde(default)]
    pub codec: Option<String>,
    #[serde(default)]
    pub alpha: Option<bool>,
    #[serde(default)]
    pub frame_count: Option<u32>,
    #[serde(default)]
    pub fps: Option<u32>,
    #[serde(default)]
    pub size: Option<[u32; 2]>,
    #[serde(default)]
    pub profile: Option<serde_json::Value>,
    #[serde(default)]
    pub random_access: Option<String>,
    #[serde(default)]
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackValidationError {
    pub pack_namespace: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct PackRegistry {
    manifests: Vec<PackManifest>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedSticker {
    pub entity_id: String,
    pub contribution_namespace: String,
    pub set_id: String,
    pub variant_id: String,
    pub storage_pack_namespace: String,
    pub storage_id: String,
    pub path: Option<String>,
    pub frame: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedAvatar {
    pub entity_id: String,
    pub contribution_namespace: String,
    pub variant_id: String,
    pub storage_pack_namespace: String,
    pub storage_id: String,
    pub path: Option<String>,
    pub frame: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedPackAsset {
    pub pack_namespace: String,
    pub name: String,
    pub storage_id: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolveError {
    Invalid(String),
    Missing(String),
    Ambiguous {
        reference: String,
        candidates: Vec<String>,
    },
}

impl PackRegistry {
    pub fn new(manifests: Vec<PackManifest>) -> Result<Self, Vec<PackValidationError>> {
        let registry = Self { manifests };
        let errors = registry.validate();
        if errors.is_empty() {
            Ok(registry)
        } else {
            Err(errors)
        }
    }

    pub fn manifests(&self) -> &[PackManifest] {
        &self.manifests
    }

    pub fn resolve_sticker(
        &self,
        selector: &ResourceSelector,
        actors: &ActorLowering,
    ) -> Result<ResolvedSticker, ResolveError> {
        let ResourceSelector::Sticker {
            subject,
            contribution,
            set,
            variant,
        } = selector
        else {
            return Err(ResolveError::Invalid(
                "selector is not a sticker resource".to_string(),
            ));
        };
        let entity_id = self.resolve_subject(subject, actors)?;
        let mut matches = Vec::new();

        for source in self.sticker_sources(&entity_id) {
            if contribution
                .as_ref()
                .is_some_and(|expected| expected != source.namespace)
            {
                continue;
            }
            let sets = matching_sets(source.slot, set.as_deref());
            for (set_id, sticker_set) in sets {
                for sticker_variant in &sticker_set.variants {
                    if variant_matches(sticker_variant, variant) {
                        matches.push(ResolvedSticker {
                            entity_id: entity_id.clone(),
                            contribution_namespace: source.namespace.to_string(),
                            set_id: set_id.to_string(),
                            variant_id: sticker_variant.id.clone(),
                            storage_pack_namespace: source.namespace.to_string(),
                            storage_id: sticker_set.storage.clone(),
                            path: sticker_variant.path.clone(),
                            frame: sticker_variant.frame,
                        });
                    }
                }
            }
        }

        unique_resolution(
            format_sticker_reference(&entity_id, contribution, set, variant),
            matches,
            |item| {
                format!(
                    "{}/{}/sticker/{}/{}",
                    item.entity_id, item.contribution_namespace, item.set_id, item.variant_id
                )
            },
        )
    }

    pub fn resolve_asset(&self, name: &str) -> Result<ResolvedPackAsset, ResolveError> {
        let matches = self
            .manifests
            .iter()
            .filter_map(|manifest| {
                manifest.assets.get(name).map(|asset| ResolvedPackAsset {
                    pack_namespace: manifest.pack.namespace.clone(),
                    name: name.to_string(),
                    storage_id: asset.source.storage.clone(),
                    path: asset.source.path.clone(),
                })
            })
            .collect::<Vec<_>>();
        unique_resolution(format!("asset::{name}"), matches, |item| {
            format!("{}::asset/{}", item.pack_namespace, item.name)
        })
    }

    pub fn resolve_avatar(
        &self,
        entity_id: &str,
        contribution: Option<&str>,
        variant: &str,
    ) -> Result<ResolvedAvatar, ResolveError> {
        let mut matches = Vec::new();
        for source in self.avatar_sources(entity_id) {
            if contribution.is_some_and(|expected| expected != source.namespace) {
                continue;
            }
            for (variant_id, item) in &source.slot.items {
                if variant_id == variant || item.handles.iter().any(|handle| handle == variant) {
                    matches.push(ResolvedAvatar {
                        entity_id: entity_id.to_string(),
                        contribution_namespace: source.namespace.to_string(),
                        variant_id: variant_id.clone(),
                        storage_pack_namespace: source.namespace.to_string(),
                        storage_id: item.storage.clone(),
                        path: item.path.clone(),
                        frame: item.frame,
                    });
                }
            }
        }
        unique_resolution(
            format!(
                "{entity_id}/{}avatar/{variant}",
                contribution
                    .map(|namespace| format!("{namespace}::"))
                    .unwrap_or_default()
            ),
            matches,
            |item| {
                format!(
                    "{}/{}/avatar/{}",
                    item.entity_id, item.contribution_namespace, item.variant_id
                )
            },
        )
    }

    pub fn storage(&self, pack_namespace: &str, storage_id: &str) -> Option<&StorageEntry> {
        self.manifests
            .iter()
            .find(|manifest| manifest.pack.namespace == pack_namespace)?
            .storage
            .get(storage_id)
    }

    fn validate(&self) -> Vec<PackValidationError> {
        let mut errors = Vec::new();
        let mut namespaces = HashSet::new();
        let entity_ids = self
            .manifests
            .iter()
            .flat_map(|manifest| {
                manifest
                    .entities
                    .keys()
                    .map(|id| canonical_entity_id(&manifest.pack.namespace, id))
            })
            .collect::<HashSet<_>>();

        for manifest in &self.manifests {
            let namespace = &manifest.pack.namespace;
            if manifest.schema != "mmt-pack.v3" {
                errors.push(validation_error(
                    Some(namespace),
                    format!("unsupported pack schema '{}'", manifest.schema),
                ));
            }
            if namespace.is_empty() || !namespaces.insert(namespace.clone()) {
                errors.push(validation_error(
                    Some(namespace),
                    "pack namespace is empty or duplicated",
                ));
            }
            for (storage_id, entry) in &manifest.storage {
                validate_storage(namespace, storage_id, entry, &mut errors);
            }
            for (local_id, entity) in &manifest.entities {
                let entity_id = canonical_entity_id(namespace, local_id);
                if entity.names.is_empty() || entity.names.iter().any(String::is_empty) {
                    errors.push(validation_error(
                        Some(namespace),
                        format!("entity '{entity_id}' requires non-empty names"),
                    ));
                }
                validate_slots(
                    namespace,
                    &entity_id,
                    &entity.slots,
                    &manifest.storage,
                    &mut errors,
                );
            }
            for contribution in &manifest.contributions {
                if !entity_ids.contains(&contribution.target) {
                    errors.push(validation_error(
                        Some(namespace),
                        format!(
                            "contribution target '{}' does not exist",
                            contribution.target
                        ),
                    ));
                }
                validate_slots(
                    namespace,
                    &contribution.target,
                    &contribution.slots,
                    &manifest.storage,
                    &mut errors,
                );
            }
            for (name, asset) in &manifest.assets {
                if !manifest.storage.contains_key(&asset.source.storage) {
                    errors.push(validation_error(
                        Some(namespace),
                        format!(
                            "asset '{name}' references missing storage '{}'",
                            asset.source.storage
                        ),
                    ));
                }
                if !is_safe_pack_path(&asset.source.path) {
                    errors.push(validation_error(
                        Some(namespace),
                        format!("asset '{name}' contains an unsafe pack-relative path"),
                    ));
                }
            }
            for (resource_id, thumbnail) in &manifest.thumbnails {
                match manifest.storage.get(&thumbnail.storage) {
                    Some(storage) if storage.kind == "image-dir" => {}
                    Some(_) => errors.push(validation_error(
                        Some(namespace),
                        format!(
                            "thumbnail '{resource_id}' must reference image-dir storage '{}'",
                            thumbnail.storage
                        ),
                    )),
                    None => errors.push(validation_error(
                        Some(namespace),
                        format!(
                            "thumbnail '{resource_id}' references missing storage '{}'",
                            thumbnail.storage
                        ),
                    )),
                }
                if !is_safe_pack_path(&thumbnail.path) {
                    errors.push(validation_error(
                        Some(namespace),
                        format!("thumbnail '{resource_id}' contains an unsafe pack-relative path"),
                    ));
                }
            }
        }
        errors
    }

    fn resolve_subject(
        &self,
        subject: &SubjectRef,
        actors: &ActorLowering,
    ) -> Result<String, ResolveError> {
        match subject {
            SubjectRef::Actor(actor_id) => actors
                .actors
                .get(actor_id.0 as usize)
                .map(|actor| actor.preset_id.clone())
                .ok_or_else(|| ResolveError::Invalid("unknown script actor id".to_string())),
            SubjectRef::Entity { namespace, name } => {
                let matches = self
                    .entities()
                    .filter(|entity| {
                        namespace
                            .as_ref()
                            .is_none_or(|namespace| entity.namespace == namespace)
                            && (entity.canonical_id == *name
                                || entity.local_id == name
                                || entity
                                    .entity
                                    .names
                                    .iter()
                                    .any(|candidate| candidate == name))
                    })
                    .map(|entity| entity.canonical_id)
                    .collect::<Vec<_>>();
                unique_resolution(
                    namespace
                        .as_ref()
                        .map(|namespace| format!("{namespace}::{name}"))
                        .unwrap_or_else(|| name.clone()),
                    matches,
                    Clone::clone,
                )
            }
        }
    }

    fn entities(&self) -> impl Iterator<Item = EntityRef<'_>> {
        self.manifests.iter().flat_map(|manifest| {
            manifest
                .entities
                .iter()
                .map(|(local_id, entity)| EntityRef {
                    namespace: &manifest.pack.namespace,
                    local_id,
                    canonical_id: canonical_entity_id(&manifest.pack.namespace, local_id),
                    entity,
                })
        })
    }

    fn sticker_sources<'a>(&'a self, entity_id: &'a str) -> Vec<StickerSource<'a>> {
        let mut sources = Vec::new();
        for manifest in &self.manifests {
            for (local_id, entity) in &manifest.entities {
                if canonical_entity_id(&manifest.pack.namespace, local_id) == entity_id
                    && let Some(slot) = &entity.slots.sticker
                {
                    sources.push(StickerSource {
                        namespace: &manifest.pack.namespace,
                        slot,
                    });
                }
            }
            for contribution in &manifest.contributions {
                if contribution.target == entity_id
                    && let Some(slot) = &contribution.slots.sticker
                {
                    sources.push(StickerSource {
                        namespace: &manifest.pack.namespace,
                        slot,
                    });
                }
            }
        }
        sources
    }

    fn avatar_sources<'a>(&'a self, entity_id: &'a str) -> Vec<AvatarSource<'a>> {
        let mut sources = Vec::new();
        for manifest in &self.manifests {
            for (local_id, entity) in &manifest.entities {
                if canonical_entity_id(&manifest.pack.namespace, local_id) == entity_id
                    && let Some(slot) = &entity.slots.avatar
                {
                    sources.push(AvatarSource {
                        namespace: &manifest.pack.namespace,
                        slot,
                    });
                }
            }
            for contribution in &manifest.contributions {
                if contribution.target == entity_id
                    && let Some(slot) = &contribution.slots.avatar
                {
                    sources.push(AvatarSource {
                        namespace: &manifest.pack.namespace,
                        slot,
                    });
                }
            }
        }
        sources
    }
}

impl CharacterPresetCatalog for PackRegistry {
    fn resolve(&self, reference: &str) -> PresetLookup {
        let matches = self
            .entities()
            .filter(|entity| {
                entity.canonical_id == reference
                    || entity.entity.names.iter().any(|name| name == reference)
            })
            .map(|entity| {
                let primary = entity.entity.names.first().cloned().unwrap_or_default();
                let avatar = entity
                    .entity
                    .slots
                    .avatar
                    .as_ref()
                    .and_then(|slot| slot.default.as_ref())
                    .map(|variant| format!("{}/avatar/{variant}", entity.canonical_id));
                CharacterPreset {
                    id: entity.canonical_id,
                    names: entity.entity.names.clone(),
                    display_name: entity.entity.display_name.clone().or(Some(primary)),
                    avatar,
                }
            })
            .collect::<Vec<_>>();
        match matches.as_slice() {
            [] => PresetLookup::Missing,
            [preset] => PresetLookup::Found(preset.clone()),
            _ => PresetLookup::Ambiguous {
                preset_ids: matches.into_iter().map(|preset| preset.id).collect(),
            },
        }
    }
}

struct EntityRef<'a> {
    namespace: &'a str,
    local_id: &'a str,
    canonical_id: String,
    entity: &'a Entity,
}

struct StickerSource<'a> {
    namespace: &'a str,
    slot: &'a StickerSlot,
}

struct AvatarSource<'a> {
    namespace: &'a str,
    slot: &'a AvatarSlot,
}

fn canonical_entity_id(namespace: &str, id: &str) -> String {
    if id.contains("::") {
        id.to_string()
    } else {
        format!("{namespace}::{id}")
    }
}

fn matching_sets<'a>(
    slot: &'a StickerSlot,
    requested: Option<&str>,
) -> Vec<(&'a str, &'a StickerSet)> {
    if let Some(requested) = requested {
        slot.sets
            .iter()
            .filter(|(id, set)| {
                id.as_str() == requested || set.handles.iter().any(|handle| handle == requested)
            })
            .map(|(id, set)| (id.as_str(), set))
            .collect()
    } else {
        slot.default
            .as_ref()
            .and_then(|id| slot.sets.get_key_value(id))
            .map(|(id, set)| vec![(id.as_str(), set)])
            .unwrap_or_default()
    }
}

fn variant_matches(variant: &StickerVariant, selector: &VariantSelector) -> bool {
    match selector {
        VariantSelector::Name(name) => {
            variant.id == *name || variant.handles.iter().any(|handle| handle == name)
        }
        VariantSelector::Ordinal(ordinal) => variant.ordinal == Some(*ordinal),
    }
}

fn validate_slots(
    namespace: &str,
    owner: &str,
    slots: &Slots,
    storage: &HashMap<String, StorageEntry>,
    errors: &mut Vec<PackValidationError>,
) {
    if let Some(avatar) = &slots.avatar {
        if avatar
            .default
            .as_ref()
            .is_some_and(|default| !avatar.items.contains_key(default))
        {
            errors.push(validation_error(
                Some(namespace),
                format!("'{owner}' avatar default does not exist"),
            ));
        }
        for (id, item) in &avatar.items {
            if !storage.contains_key(&item.storage) {
                errors.push(validation_error(
                    Some(namespace),
                    format!(
                        "'{owner}' avatar '{id}' references missing storage '{}'",
                        item.storage
                    ),
                ));
            }
            if item
                .path
                .as_deref()
                .is_some_and(|path| !is_safe_pack_path(path))
            {
                errors.push(validation_error(
                    Some(namespace),
                    format!("'{owner}' avatar '{id}' contains an unsafe path"),
                ));
            }
        }
    }
    if let Some(sticker) = &slots.sticker {
        if sticker
            .default
            .as_ref()
            .is_some_and(|default| !sticker.sets.contains_key(default))
        {
            errors.push(validation_error(
                Some(namespace),
                format!("'{owner}' sticker default set does not exist"),
            ));
        }
        for (set_id, set) in &sticker.sets {
            if !storage.contains_key(&set.storage) {
                errors.push(validation_error(
                    Some(namespace),
                    format!(
                        "'{owner}' sticker set '{set_id}' references missing storage '{}'",
                        set.storage
                    ),
                ));
            }
            let mut ordinals = HashSet::new();
            let mut ids = HashSet::new();
            for variant in &set.variants {
                if variant.id.is_empty() || !ids.insert(&variant.id) {
                    errors.push(validation_error(
                        Some(namespace),
                        format!("'{owner}' sticker set '{set_id}' has duplicate/empty variant id"),
                    ));
                }
                if let Some(ordinal) = variant.ordinal
                    && (ordinal == 0 || !ordinals.insert(ordinal))
                {
                    errors.push(validation_error(
                        Some(namespace),
                        format!("'{owner}' sticker set '{set_id}' has invalid ordinal"),
                    ));
                }
                if let (Some(frame), Some(frame_count)) = (
                    variant.frame,
                    storage
                        .get(&set.storage)
                        .and_then(|entry| entry.frame_count),
                ) && frame >= frame_count
                {
                    errors.push(validation_error(
                        Some(namespace),
                        format!(
                            "'{owner}' sticker set '{set_id}' variant '{}' references frame {frame} outside storage '{}'",
                            variant.id, set.storage
                        ),
                    ));
                }
                if variant
                    .path
                    .as_deref()
                    .is_some_and(|path| !is_safe_pack_path(path))
                {
                    errors.push(validation_error(
                        Some(namespace),
                        format!(
                            "'{owner}' sticker set '{set_id}' variant '{}' contains an unsafe path",
                            variant.id
                        ),
                    ));
                }
            }
        }
    }
}

fn validate_storage(
    namespace: &str,
    storage_id: &str,
    entry: &StorageEntry,
    errors: &mut Vec<PackValidationError>,
) {
    for path in [entry.base.as_deref(), entry.path.as_deref()]
        .into_iter()
        .flatten()
    {
        if !is_safe_pack_path(path) {
            errors.push(validation_error(
                Some(namespace),
                format!("storage '{storage_id}' contains an unsafe pack-relative path"),
            ));
        }
    }
    match entry.kind.as_str() {
        "image-dir" => {
            if entry.base.is_none() {
                errors.push(validation_error(
                    Some(namespace),
                    format!("image-dir storage '{storage_id}' requires base"),
                ));
            }
        }
        "image-sequence" => {
            let has_random_access = entry.random_access.is_some()
                || entry
                    .profile
                    .as_ref()
                    .and_then(|profile| profile.get("keyframe_interval"))
                    .is_some();
            let complete = entry.path.is_some()
                && entry.container.is_some()
                && entry.codec.is_some()
                && entry.alpha.is_some()
                && entry.frame_count.is_some_and(|count| count > 0)
                && entry
                    .size
                    .is_some_and(|[width, height]| width > 0 && height > 0)
                && entry.sha256.as_ref().is_some_and(|hash| !hash.is_empty())
                && entry.profile.is_some()
                && has_random_access;
            if !complete {
                errors.push(validation_error(
                    Some(namespace),
                    format!(
                        "image-sequence storage '{storage_id}' requires path, container, codec, alpha, frame_count, size, sha256, profile, and random-access metadata"
                    ),
                ));
            }
        }
        kind => errors.push(validation_error(
            Some(namespace),
            format!("storage '{storage_id}' has unsupported kind '{kind}'"),
        )),
    }
}

fn is_safe_pack_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains(['\\', ':', '?', '#', '%'])
        && !path
            .split('/')
            .any(|component| component.is_empty() || component == "." || component == "..")
}

fn validation_error(namespace: Option<&str>, message: impl Into<String>) -> PackValidationError {
    PackValidationError {
        pack_namespace: namespace.map(str::to_string),
        message: message.into(),
    }
}

fn unique_resolution<T>(
    reference: String,
    matches: Vec<T>,
    describe: impl Fn(&T) -> String,
) -> Result<T, ResolveError> {
    match matches.len() {
        0 => Err(ResolveError::Missing(reference)),
        1 => Ok(matches.into_iter().next().expect("length checked")),
        _ => Err(ResolveError::Ambiguous {
            reference,
            candidates: matches.iter().map(describe).collect(),
        }),
    }
}

fn format_sticker_reference(
    entity: &str,
    contribution: &Option<String>,
    set: &Option<String>,
    variant: &VariantSelector,
) -> String {
    let contribution = contribution
        .as_ref()
        .map(|namespace| format!("{namespace}::"))
        .unwrap_or_default();
    let set = set
        .as_ref()
        .map(|set| format!("{set}/"))
        .unwrap_or_default();
    let variant = match variant {
        VariantSelector::Name(name) => name.clone(),
        VariantSelector::Ordinal(n) => format!("#{n}"),
    };
    format!("{entity}/{contribution}sticker/{set}{variant}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse_text;
    use crate::semantic::{
        CharacterPresetCatalog, StaticPresetCatalog, lower_actors, lower_resource_markers,
        resolve_body_modes,
    };

    const BASE: &str = r#"{
      "schema": "mmt-pack.v3",
      "pack": {"namespace":"ba","name":"BA","version":"1","type":"base"},
      "entities": {
        "柚子": {
          "names": ["柚子"],
          "display_name": "花冈柚子",
          "slots": {
            "avatar": {"default":"default","items":{"default":{"storage":"avatars","path":"yuzu.png"}}},
            "sticker": {"default":"default","sets":{"default":{
              "handles":["初始"],"storage":"stickers","variants":[
                {"id":"happy","ordinal":1,"frame":0,"handles":["开心"]},
                {"id":"sad","ordinal":2,"frame":1}
              ]
            }}}
          }
        }
      },
      "assets": {"logo":{"kind":"image","source":{"storage":"assets","path":"logo.png"}}},
      "storage": {
        "avatars":{"kind":"image-dir","base":"avatars"},
        "stickers":{"kind":"image-sequence","path":"stickers.avifs","container":"avifs","codec":"av1","alpha":true,"frame_count":2,"size":[512,512],"sha256":"basehash","profile":{"qcolor":80,"keyframe_interval":30}},
        "assets":{"kind":"image-dir","base":"assets"}
      }
    }"#;

    const EXTENSION: &str = r#"{
      "schema": "mmt-pack.v3",
      "pack": {"namespace":"ba_extpack","name":"Ext","version":"1","type":"extension","requires":["ba"]},
      "contributions": [{
        "target":"ba::柚子",
        "slots":{"sticker":{"default":"default","sets":{"default":{
          "storage":"ext_stickers","variants":[{"id":"happy_ext","ordinal":1,"frame":0,"handles":["开心"]}]
        }}}}
      }],
      "storage":{"ext_stickers":{"kind":"image-sequence","path":"ext.avifs","container":"avifs","codec":"av1","alpha":true,"frame_count":1,"size":[512,512],"sha256":"exthash","profile":{"qcolor":80,"keyframe_interval":30}}}
    }"#;

    fn registry() -> PackRegistry {
        PackRegistry::new(vec![
            PackManifest::from_json(BASE).expect("base manifest"),
            PackManifest::from_json(EXTENSION).expect("extension manifest"),
        ])
        .expect("valid registry")
    }

    fn selector(source: &str, registry: &PackRegistry) -> (ResourceSelector, ActorLowering) {
        let document = parse_text(source);
        let modes = resolve_body_modes(&document);
        let actors = lower_actors(&document, registry);
        let resources = lower_resource_markers(&document, &modes, &actors);
        assert!(document.diagnostics.is_empty());
        assert!(actors.diagnostics.is_empty());
        assert!(resources.diagnostics.is_empty());
        (resources.markers[0].selector.clone(), actors)
    }

    #[test]
    fn manifest_registry_provides_character_presets() {
        let registry = registry();

        assert!(matches!(
            registry.resolve("ba::柚子"),
            PresetLookup::Found(CharacterPreset { ref id, ref display_name, ref avatar, .. })
                if id == "ba::柚子"
                    && display_name.as_deref() == Some("花冈柚子")
                    && avatar.as_deref() == Some("ba::柚子/avatar/default")
        ));
    }

    #[test]
    fn sticker_resolution_requires_contribution_disambiguation() {
        let registry = registry();
        let (ambiguous, actors) = selector("> 柚子: [:开心:]", &registry);
        let (explicit, explicit_actors) = selector("> 柚子: [:ba_extpack::开心:]", &registry);

        assert!(matches!(
            registry.resolve_sticker(&ambiguous, &actors),
            Err(ResolveError::Ambiguous { .. })
        ));
        let resolved = registry
            .resolve_sticker(&explicit, &explicit_actors)
            .expect("explicit contribution should resolve");
        assert_eq!(resolved.contribution_namespace, "ba_extpack");
        assert_eq!(resolved.storage_pack_namespace, "ba_extpack");
        assert_eq!(resolved.storage_id, "ext_stickers");
        assert_eq!(resolved.frame, Some(0));
    }

    #[test]
    fn ordinal_and_set_defaults_resolve_stably() {
        let registry = PackRegistry::new(vec![PackManifest::from_json(BASE).unwrap()]).unwrap();
        let (selector, actors) = selector("> 柚子: [:#2:]", &registry);
        let resolved = registry.resolve_sticker(&selector, &actors).unwrap();

        assert_eq!(resolved.entity_id, "ba::柚子");
        assert_eq!(resolved.set_id, "default");
        assert_eq!(resolved.variant_id, "sad");
        assert_eq!(resolved.frame, Some(1));
    }

    #[test]
    fn pack_assets_are_unique_across_loaded_manifests() {
        let registry = registry();
        let asset = registry.resolve_asset("logo").unwrap();

        assert_eq!(asset.pack_namespace, "ba");
        assert_eq!(asset.storage_id, "assets");
        assert_eq!(asset.path, "logo.png");
    }

    #[test]
    fn validation_rejects_missing_storage_and_invalid_entity_names() {
        let invalid = PackManifest::from_json(
            r#"{
              "schema":"mmt-pack.v3",
              "pack":{"namespace":"bad","name":"Bad","version":"1","type":"base"},
              "entities":{"x":{"names":[],"slots":{"avatar":{"default":"x","items":{"x":{"storage":"missing"}}}}}}
            }"#,
        )
        .unwrap();
        let errors = PackRegistry::new(vec![invalid]).unwrap_err();

        assert!(errors.len() >= 2);
    }

    #[test]
    fn pack_paths_reject_url_syntax_and_encoded_traversal() {
        assert!(is_safe_pack_path("students/yuzu/001.webp"));
        for unsafe_path in [
            "https:evil.example/x",
            "data:image/png;base64,x",
            "images/file.webp?download=1",
            "images/file.webp#fragment",
            "%2e%2e/secret.webp",
            "images\\secret.webp",
        ] {
            assert!(!is_safe_pack_path(unsafe_path), "accepted {unsafe_path}");
        }
    }

    #[test]
    fn validation_rejects_thumbnail_storage_and_paths_outside_pack() {
        let invalid = PackManifest::from_json(
            r#"{
              "schema":"mmt-pack.v3",
              "pack":{"namespace":"bad","name":"Bad","version":"1","type":"base"},
              "thumbnails":{
                "x/sticker/default/one":{"storage":"sequence","path":"https:evil.example/x"},
                "x/sticker/default/two":{"storage":"missing","path":"%2e%2e/secret.webp"}
              },
              "storage":{
                "sequence":{"kind":"image-sequence","path":"frames.avifs","container":"avifs","codec":"av1","alpha":true,"frame_count":1,"size":[1,1],"sha256":"hash","profile":{},"random_access":"keyframe"}
              }
            }"#,
        )
        .unwrap();
        let errors = PackRegistry::new(vec![invalid]).unwrap_err();

        assert!(
            errors
                .iter()
                .any(|error| error.message.contains("must reference image-dir"))
        );
        assert!(
            errors
                .iter()
                .any(|error| error.message.contains("references missing storage"))
        );
        assert_eq!(
            errors
                .iter()
                .filter(|error| error.message.contains("unsafe pack-relative path"))
                .count(),
            2
        );
    }

    #[test]
    fn validation_rejects_unsafe_paths_and_incomplete_sequences() {
        let invalid = PackManifest::from_json(
            r#"{
              "schema":"mmt-pack.v3",
              "pack":{"namespace":"bad","name":"Bad","version":"1","type":"base"},
              "assets":{"escape":{"source":{"storage":"images","path":"../secret.png"}}},
              "storage":{
                "images":{"kind":"image-dir","base":"/absolute"},
                "sequence":{"kind":"image-sequence","path":"frames.avifs","frame_count":1}
              }
            }"#,
        )
        .unwrap();
        let errors = PackRegistry::new(vec![invalid]).unwrap_err();

        assert!(
            errors
                .iter()
                .any(|error| error.message.contains("unsafe pack-relative path"))
        );
        assert!(
            errors
                .iter()
                .any(|error| error.message.contains("requires path, container, codec"))
        );
    }

    #[test]
    fn registry_is_compatible_with_standalone_actor_catalog_contract() {
        let static_catalog = StaticPresetCatalog::new(Vec::new());
        assert!(matches!(
            static_catalog.resolve("missing"),
            PresetLookup::Missing
        ));
    }
}
