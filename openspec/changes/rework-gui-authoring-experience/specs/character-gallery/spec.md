## ADDED Requirements

### Requirement: People grouping uses only validated catalog identity

The existing catalog projection SHALL preserve verified external_ids.character and multilingual names.given/names.skin. external_ids.character SHALL be treated as external form-record identity, not canonical person identity. Role-selection PersonGroup SHALL be a UI projection scoped to one namespace/catalog using explicit typed alternate_skin connectivity; it SHALL NOT merge Pack entities. No Pack schema change, real-time Kivo API or name-based inference SHALL be introduced.

#### Scenario: Explicit alternate-skin relations connect different external records

- GIVEN validated entities in one namespace/catalog are connected by typed alternate_skin relations
- WHEN people groups are projected
- THEN the connected component MUST form one person group while preserving all independent form entities and their external IDs
- AND differing external_ids.character values MUST NOT veto that explicit relation
- AND unrelated relation types MUST NOT establish grouping
- AND groups MUST NOT cross namespace/catalog boundaries

#### Scenario: Duplicate external records or independent entities are projected

- GIVEN validated entities have the same external_ids.character or lack typed alternate_skin connections
- WHEN people groups are projected
- THEN equal external record IDs MAY unify duplicate form records within the same namespace/catalog
- AND canonical entity IDs MUST be sorted to derive deterministic private component keys
- AND an entity without typed alternate_skin connectivity or duplicate-record identity MUST remain independently selectable and distinguishable by its original display name/entity ID
- AND missing external IDs MUST NOT prevent explicit alternate_skin grouping
- AND equal names, underscores, parentheses or guessed clothing labels MUST NOT establish grouping

#### Scenario: Person and form labels are rendered

- GIVEN grouped entities expose verified localized given and skin names
- WHEN UI titles are chosen
- THEN a multi-form person title MUST prefer common given name and otherwise use existing Catalog display name; an independent entity MUST retain its distinguishable original display name/entity ID
- AND form label MUST prefer skin zh-CN, then another existing localization
- AND missing skin MUST show Form unspecified with original display name/entity ID rather than invent a label
- AND avatar expressions MUST remain variants within the chosen form entity, never be treated as clothing forms

### Requirement: Role grouping preserves gallery search and resource selection

People→form→expression selection SHALL reuse existing gallery/Pack/avatar resolution and retain canonical speaker/entity/contribution namespace/variant identity. Catalog names SHALL remain display/search metadata, never DSL selectors. Grouping supersedes the old requirement for separate top-level alternate-skin list items only in the role-picker UI; independent entities, sets and selectors SHALL remain unchanged.

#### Scenario: The author searches across forms

- GIVEN multiple languages, aliases and school/organization names from valid metadata
- WHEN complete-library search runs
- THEN all existing multilingual names/aliases/taxonomy search MUST continue to match
- AND matching forms MUST remain reachable through their person group
- AND recent/current-work entries MUST be offered before opening the complete library
- AND a single available form/expression MAY advance directly without discarding its identity

#### Scenario: Catalog is unavailable or a custom item exists

- GIVEN manifest-only, old/offline Pack or script-defined actor/asset data
- WHEN roles or avatars are presented
- THEN all previously usable items MUST remain visible/selectable under their actual capabilities
- AND missing metadata MUST NOT hide unknown-name entities or merge them by display heuristics
- AND existing custom state MUST retain source/local-source entry rather than claim a new GUI avatar-write pipeline
- AND existing HTTPS/root constraints, AVIFS frame resolution, cache bounds and cancellation ownership MUST remain in force

### Requirement: People grouping does not relax whole-Catalog validation

Grouping SHALL consume only the existing strictly validated, manifest-bound Catalog. A malformed entity, unknown taxonomy reference or invalid related-entity target SHALL reject the entire Catalog for that Pack under existing manifest-only fallback; the client SHALL NOT repair individual records or silently discard invalid references.

#### Scenario: An entity refers to unknown taxonomy zero

- GIVEN a Catalog entity references taxonomy ID `0` without a matching allowed taxonomy target
- WHEN Catalog validation runs before grouping
- THEN the complete Catalog MUST be rejected, including when the offending entity is 七海
- AND the client MUST NOT normalize `0` into missing affiliation, patch production metadata or group the remaining partial Catalog
- AND existing manifest-only browsing MUST remain available without modifying online data or relaxing validation

### Requirement: GUI media choice and source gallery insertion retain separate contracts

Embedding the existing sticker selector in GUI SHALL return a structured media choice for a Rust-authorized insertion boundary. The native source command `mmt.gallery.insertSticker(entityName, ordinal, setId?)` SHALL retain its existing mmt editor cursor/selection insertion behavior and default/nondefault set selectors.

#### Scenario: A sticker is chosen for GUI

- GIVEN a current GUI insertion target and canonical entity/set/ordinal
- WHEN the embedded selector confirms
- THEN it MUST return a semantic sticker choice to Composer, not invoke native raw-source insertion
- AND Rust MUST validate the current registry and serialize the media statement

#### Scenario: A sticker is chosen in source

- GIVEN an active writable mmt source editor with a cursor or selection
- WHEN the original gallery insert command is invoked
- THEN existing entity-qualified inline/selection insertion MUST remain available
- AND the source use MUST NOT require a GUI node boundary, selected structure node or GUI mode
- AND original non-mmt/readonly restrictions MUST remain unchanged
