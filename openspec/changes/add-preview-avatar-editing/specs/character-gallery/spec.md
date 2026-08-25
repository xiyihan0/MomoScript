## ADDED Requirements

### Requirement: Active Pack projection exposes complete avatar choices

The Web product catalog SHALL project every base/contribution avatar item into immutable canonical metadata without modifying pack-v3、Entity Catalog or IndexedDB schemas. Picker selectability is a derived delivery property, not loss of projection data.

#### Scenario: Base entity has multiple avatars

- GIVEN an entity avatar slot declares a default and multiple `items`
- WHEN the active manifest is projected
- THEN every item MUST retain canonical entity/contributor/variant、handles、storage and optional path/frame
- AND the declared base default MUST be marked as entity/source default
- AND existing `GalleryEntity.avatar` MUST continue to derive its card thumbnail from that default

#### Scenario: Extension Pack contributes avatars

- GIVEN an active contribution targets an existing canonical entity and declares avatar items
- WHEN the catalog is projected
- THEN every item MUST retain the target entity and contributing Pack namespace
- AND equal variant ids from different contributions MUST remain distinct identities
- AND the target display/search metadata MUST come from its base entity when available

#### Scenario: Catalog ordering is deterministic

- GIVEN several entities、base variants and contribution variants are active
- WHEN the catalog and picker groups are built
- THEN ordering MUST use entity display label/canonical id、base before contributions、contribution namespace、source default first and variant id
- AND only the picker MAY promote its exact current actor entity

#### Scenario: Duplicate identity metadata conflicts

- GIVEN active inputs claim the same entity/contribution/variant identity with different handles、storage、path、frame or default metadata
- WHEN the catalog is built
- THEN every conflicting copy MUST be absent
- AND load order MUST NOT choose a winner

### Requirement: Avatar thumbnails retain Pack URL safety

Avatar catalog items SHALL use the Gallery HTTPS、same-origin and pack-root URL boundary. All Pack items remain projected, but the first picker SHALL select only safe image-dir items with non-empty paths.

#### Scenario: Valid image-dir avatar

- GIVEN an avatar item references valid image-dir storage and a relative supported image path
- WHEN the catalog builds its thumbnail
- THEN URL MUST remain under the manifest HTTPS pack root
- AND the item MUST be selectable
- AND its image MUST be lazy loaded

#### Scenario: Pathless or image-sequence avatar

- GIVEN a schema-valid item has no path or uses image-sequence storage
- WHEN projection runs
- THEN metadata MUST remain in `GalleryAvatarVariant`
- AND its `AvatarCatalogItem` MUST be unavailable and carry no thumbnail URL
- AND it MUST NOT be sent to Composer

#### Scenario: Unsafe avatar source

- GIVEN storage/path escapes the pack root、uses another origin、uses unsupported type or lacks required storage metadata
- WHEN catalog construction runs
- THEN the item MUST be unavailable with no broken thumbnail
- AND MUST NOT be sent to Composer

### Requirement: Picker queries do not mutate sidebar Gallery state

The Composer avatar picker MAY reuse immutable Pack projection、search terms and thumbnail utilities, but SHALL NOT use the sidebar Gallery DOM or pending sticker insertion command as selection state.

#### Scenario: Picker opens while Gallery is browsing another entity

- GIVEN the sidebar Gallery currently displays a different entity or sticker set
- WHEN Preview Composer opens the avatar picker
- THEN picker filtering and selection MUST use its own transient controller state
- AND the sidebar navigation state MUST remain unchanged
- AND closing either surface MUST NOT dispose the other's resources
