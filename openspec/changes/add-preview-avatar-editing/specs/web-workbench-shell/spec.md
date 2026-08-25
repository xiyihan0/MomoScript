## ADDED Requirements

### Requirement: Preview Composer offers a transient avatar picker

The production Web Workbench SHALL offer **“从本条起更换人物头像…”** for a current avatar-capable statement target. The picker SHALL remain a transient client of the current Composer operation、TextDocument、PreviewArtifact and active Pack catalog.

#### Scenario: Author opens the avatar picker

- GIVEN a current editable statement exposes an `actorAvatar` descriptor
- AND the active catalog contains selectable pack avatars
- WHEN the author invokes the avatar action from a bubble、avatar、display-name or exact text context menu
- THEN the Workbench MUST open a pointer-adjacent context view with lazy image choices
- AND MUST place the target actor's avatar variants first
- AND MUST offer searchable variants from other entities
- AND MUST keep the source document as the only authored state

#### Scenario: Another character's avatar is chosen

- GIVEN the target actor is 小雪 and the selected choice belongs to 佳代子
- WHEN the picker presents the item
- THEN it MUST state `小雪将从本条起使用「佳代子 / <variant>」头像`
- AND MUST NOT describe the operation as changing speaker or actor
- WHEN the author clicks that non-current thumbnail
- THEN selection MUST apply immediately exactly once
- AND the client MUST send one structured `setActorAvatarFromStatement` command
- AND MUST NOT send resource URL、path、storage key or constructed MMT text

#### Scenario: Picker displays current non-selectable state

- GIVEN current is the selected Pack triple、custom asset、null or an unsupported Pack source
- WHEN the picker opens
- THEN the Pack item MUST be disabled、or status MUST be “当前：自定义资源 <name>”、 “当前：无头像” or “当前头像暂不支持预览”
- AND interacting with that current state MUST NOT send a command

#### Scenario: Avatar action is unavailable

- GIVEN the target is builtin、unresolved、non-chat or lacks an avatar descriptor
- OR the active catalog has no valid selectable avatar
- WHEN the native context menu opens
- THEN the avatar action MUST be absent
- AND existing navigation、continued and display-name actions MUST retain their behavior

### Requirement: Avatar picker lifecycle follows Composer identity

Every picker resource and request SHALL be owned by the current EditorRuntimeController/Composer operation. Identity changes SHALL cancel rather than retarget.

#### Scenario: Document、preview or Pack identity changes

- GIVEN an avatar picker is open
- WHEN the TextDocument version、PreviewArtifact identity or runtime owner changes
- OR `galleryPacksChanged` fires after accepted manifest projection changes
- THEN the picker MUST close
- AND pending thumbnail/query work MUST be cancelled where supported
- AND no avatar command may apply from the stale picker

#### Scenario: Apply fails or becomes stale

- GIVEN an item was selected but the returned edit is stale、rejected or `workspace.applyEdit` returns false
- WHEN the operation completes
- THEN the Workbench MUST show one concise native MomoScript notification
- AND MUST NOT retry against a newer document or silently select another avatar

#### Scenario: Picker remains bounded on a narrow desktop viewport

- GIVEN the Workbench viewport is 240–320 px wide
- WHEN the pointer-anchored picker opens
- THEN its context view MUST remain inside the viewport
- AND only its results grid MAY scroll
- AND Preview viewport MUST remain the sole preview scroll container

### Requirement: Avatar choice logic is presentation-independent

Avatar catalog query、filter、current selection and one-shot command invocation SHALL be implemented behind a product-level controller that does not depend on pointer coordinates、Workbench context-view DOM or a mobile layout.

#### Scenario: Desktop adapter hosts the picker

- GIVEN the controller has actor preset/display context and immutable `AvatarCatalogItem` choices
- WHEN the desktop Preview Composer opens it
- THEN search MUST match entity names、handles、variant and contribution
- AND a Workbench context-view adapter MAY render the snapshot beside the pointer
- AND disposal MUST release subscriptions、DOM and image work without changing controller semantics

#### Scenario: Future mobile surface reuses the controller

- GIVEN a later mobile shell uses a bottom sheet instead of a pointer context view
- WHEN it consumes the same controller
- THEN it MUST produce the same structured Composer command and cancellation behavior
- AND MUST NOT introduce a second document、Pack cache or apply path
