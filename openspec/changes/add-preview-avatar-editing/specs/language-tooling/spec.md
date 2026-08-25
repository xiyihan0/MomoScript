## ADDED Requirements

### Requirement: Composer exposes a revision-bound avatar capability

The language service SHALL expose avatar editing only for one current left/right statement whose non-builtin actor and avatar resource context are uniquely resolved. The descriptor SHALL provide product-level pack identity without exposing ActorId or edit authority.

#### Scenario: Editable actor reports avatar context

- GIVEN a current MMT preview point resolves through projection ancestry to one statement
- AND that statement resolves to one non-builtin actor revision
- WHEN the host requests `mmt/previewComposerTarget`
- THEN the result MUST include `actorAvatar.scope = fromStatement`
- AND MUST include the actor's canonical preset id
- AND MUST describe the current resolved avatar as a strict pack-avatar identity、script-asset identity or null
- AND MUST NOT include ActorId、resource URL、storage path or mutable AST state

#### Scenario: Avatar context is unavailable

- GIVEN the target is builtin、unresolved、ambiguous、non-chat、stale or belongs to an errorful resource plan
- WHEN the service resolves Composer properties
- THEN it MUST omit or reject the avatar capability according to the existing strict target union
- AND MUST NOT infer an entity from display text、SVG label or gallery order

#### Scenario: Current avatar evidence has non-Pack forms

- GIVEN the exact actor revision resolves to ScriptAsset or PackAsset
- WHEN the service builds Composer properties
- THEN `current` MUST be `{ kind: asset, assetName: <resolved logical name> }`
- AND a resolved revision with no avatar MUST report null
- AND neither state authorizes an asset picker command

#### Scenario: Descriptor does not leak resource implementation

- GIVEN a Pack avatar resolves successfully
- WHEN the target descriptor is serialized
- THEN it MUST contain only entity、contribution and variant identity
- AND MUST NOT contain ActorId、authored selector、URL、storage id/path、frame or Pack source metadata

### Requirement: Avatar commands use structured Pack identities

`mmt/composerEdit` SHALL accept `setActorAvatarFromStatement` only with a bounded structured pack-avatar choice containing canonical entity id、contribution namespace and variant id. Rust SHALL serialize DSL source and remain the final resource authority.

#### Scenario: Current-character avatar is selected

- GIVEN the selected choice resolves to an avatar variant of the target actor's preset
- WHEN the command executes against current document version V
- THEN Rust MUST insert or minimally update one `@actor avatar:` revision from the target statement
- AND MUST return one single-document TextDocumentEdit with version V
- AND MUST NOT return `WorkspaceEdit.changes`

#### Scenario: Another character's avatar is selected

- GIVEN the selected pack-avatar entity differs from the target actor preset
- AND the exact entity/contribution/variant triple resolves uniquely
- WHEN the command executes
- THEN the target and later governed statements MUST retain the original ActorId、speaker and display-name
- AND their avatar resource identity MUST become the selected triple
- AND statements before the target MUST retain their prior avatar identity

#### Scenario: Client sends resource implementation details

- GIVEN a command contains unknown keys、URL、storage id、path、unbounded strings or a raw DSL selector
- WHEN native or WASM transport parses it
- THEN the request MUST be rejected as invalid params before core execution

#### Scenario: Avatar identity fields violate the wire grammar

- GIVEN any component is empty、over 1024 UTF-8 bytes、contains whitespace/control、`/` or `\\`
- OR entity id is not exactly one non-empty `namespace::id`
- OR contribution namespace contains `::`
- WHEN native、WASM or TypeScript parses it
- THEN the request MUST fail before core execution

#### Scenario: Avatar identity cannot be resolved

- GIVEN the selected entity、contribution or variant is missing、ambiguous or incompatible with the avatar slot
- WHEN Rust resolves the command using the current read-only PackRegistry
- THEN it MUST return an explicit rejection and no edit
- AND MUST NOT choose another contribution、default variant or similarly named entity

#### Scenario: No Pack registry is installed

- GIVEN the document has no current PackRegistry revision
- WHEN a client sends `setActorAvatarFromStatement`
- THEN the service MUST return `avatarUnavailable`
- AND MUST return no edit

#### Scenario: Selected identity is already current

- GIVEN the submitted triple equals the exact target revision's current resolved avatar
- WHEN the command executes
- THEN the service MUST return `avatarUnavailable`
- AND MUST NOT create a redundant actor revision or history entry

### Requirement: Avatar edits preserve unrelated authored and semantic state

The core SHALL use existing actor revision semantics and full candidate reanalysis. It SHALL reject any candidate that changes unrelated syntax、actor state or resources.

#### Scenario: Adjacent actor block can be updated minimally

- GIVEN an immediately adjacent same-actor block governs its first renderable node at the target
- AND it contains zero or one valid `avatar:` field
- WHEN the avatar command executes
- THEN the core MUST replace only that scalar or insert one field before `@end`
- AND MUST preserve comments、other fields、line endings and surrounding bytes

#### Scenario: A new revision is required

- GIVEN no eligible adjacent actor block exists
- WHEN the avatar command executes
- THEN the core MUST select one round-trippable authored actor name
- AND insert one canonical `@actor` block immediately before the target
- AND MUST NOT insert a hidden restoration block after the target

#### Scenario: Candidate changes unrelated semantics

- GIVEN candidate parsing succeeds but changes speaker identity、display-name history、actor names、preset、statement body/patch、sticker identity or pre-target avatar state
- WHEN candidate validation compares the current and candidate analyses
- THEN the command MUST return `candidateInvalid`
- AND MUST return no partial edit

#### Scenario: Avatar-specific candidate gate permits only the expected transition

- GIVEN common candidate checks would otherwise require identical avatar resources
- WHEN an avatar edit is reanalyzed
- THEN the core MUST skip only that generic equality
- AND an avatar-specific comparison MUST prove pre-target identity、target triple、later explicit-revision inheritance and every other actor/avatar resource
- AND any additional change MUST return `candidateInvalid`

#### Scenario: Avatar change affects automatic continuation

- GIVEN the selected avatar differs from the preceding rendered statement's avatar identity
- WHEN the accepted edit rerenders preview
- THEN normal automatic continuation MAY start a new visible message group
- AND this expected presentation consequence MUST NOT weaken source/candidate invariants
