## ADDED Requirements

### Requirement: GUI Composer keeps the MMT TextDocument as its only authored state

The GUI Composer SHALL be a product surface over the current versioned Composer document projection and Rust Composer commands. It SHALL NOT create a second mutable card document、client AST or persistence format.

#### Scenario: GUI opens an existing project

- GIVEN an `.mmt` TextDocument is open in the current workspace
- WHEN the GUI surface becomes active
- THEN it MUST request a Composer document snapshot for the current URI/version
- AND cards MUST derive only from that immutable snapshot
- AND durable bytes MUST remain owned by the existing `mmtfs` workspace/TextDocument path
- AND reload MUST reconstruct cards from persisted MMT rather than restore a separate card model

#### Scenario: A Composer edit is accepted

- GIVEN the GUI sends one structured command and applies the returned current-version WorkspaceEdit
- WHEN the TextDocument advances to version V+1
- THEN the GUI MUST discard the V snapshot and request/accept a V+1 snapshot
- AND Local History、diagnostics、preview、persistence and export MUST observe the ordinary TextDocument change
- AND pending visual card state MUST NOT become authored state independently

#### Scenario: Snapshot parsing fails in the client

- GIVEN the client receives an unknown、malformed、partial or non-covering projection
- WHEN strict parsing runs
- THEN the entire GUI document view MUST fail closed
- AND the surface MUST retain source navigation/recovery without synthesizing cards from raw MMT or preview DOM

### Requirement: Supported and opaque nodes remain visible one-to-one

The GUI SHALL represent every current projection node. Message and Narration nodes MAY be editable cards according to server capability; Opaque nodes SHALL remain visible read-only advanced-source blocks.

#### Scenario: Ordinary conversation is displayed

- GIVEN the snapshot contains Message and Narration nodes
- WHEN card state is derived
- THEN card order MUST equal projection order
- AND speaker、body、mode、continued、display-name and avatar controls MUST appear only when the corresponding server capability exists
- AND the GUI MUST NOT infer missing capability from labels、Pack order or rendered preview content

#### Scenario: Advanced content is encountered

- GIVEN the snapshot contains blank、directive、recoverable-error or unsupported Opaque nodes
- WHEN the GUI renders the document
- THEN each node MUST remain represented in its exact projection position
- AND directive/error/unsupported content MUST have a visible advanced-source affordance
- AND the node MUST offer navigation to its current TextDocument range
- AND it MUST NOT expose delete、move or property-edit commands in the first slice
- AND a current comment-looking line MUST remain a visible `recoverableError` with its diagnostic rather than be relabeled as `comment`

#### Scenario: Blank nodes are visually compact

- GIVEN one or more Opaque blank nodes occur between cards
- WHEN the GUI uses compact presentation
- THEN it MAY collapse their visual height or group consecutive blank nodes for display
- BUT it MUST retain their node identities and barrier behavior
- AND it MUST NOT remove them from command anchoring or persistence

### Requirement: GUI structure actions use explicit server capabilities

Insert、delete、move and speaker actions SHALL be emitted only through the current snapshot's allowlisted structural capabilities. The GUI SHALL provide non-drag controls for every supported ordering action.

#### Scenario: Author inserts a message

- GIVEN the current snapshot exposes a legal insertion boundary
- WHEN the author chooses a speaker、body and mode and confirms insertion
- THEN the GUI MUST send one structured `insertStatement` command for that boundary
- AND MUST NOT pre-insert a local card or concatenate MMT
- AND accepted content MUST appear only from the next snapshot

#### Scenario: Author deletes a card beside Opaque content

- GIVEN a Message card is adjacent to an Opaque blank、directive or unsupported block
- WHEN the author confirms deletion
- THEN the GUI MUST send `deleteNode` for the Message target only
- AND the next snapshot MUST still contain the Opaque block byte-exact
- AND the GUI MUST NOT offer an implicit “delete attached advanced content” behavior

#### Scenario: Author reorders cards

- GIVEN move capability allows a Message/Narration card to move up or down within one continuous movable run
- WHEN the author activates the corresponding button
- THEN the GUI MUST send one `moveNode` command
- AND keyboard、touch and screen-reader users MUST be able to perform the same move without drag
- AND the UI MUST disable movement across an Opaque barrier rather than issue an optimistic request

#### Scenario: Builtin speaker remains read-only

- GIVEN a Message speaker is the implicit Builtin `__Sensei`
- WHEN the GUI renders mutation controls
- THEN body/mode capability MAY remain available
- BUT speaker mutation MUST be absent
- AND the speaker picker MUST contain only server-authorized script actors and verified Pack entity references

#### Scenario: Structure operation becomes stale

- GIVEN document version、snapshot digest or runtime identity changes while a confirmation/sheet is open
- WHEN the author confirms
- THEN the transient operation MUST close or reject without request/apply
- AND it MUST NOT retarget the selection to a visually similar card in the newer snapshot

### Requirement: One surface-independent ComposerRuntime owns GUI orchestration

Card projection replacement、selection、command admission、one-shot apply、catalog access and stale cancellation SHALL be implemented behind a presentation-independent ComposerRuntime/controller. Desktop and mobile adapters SHALL share this controller.

#### Scenario: Desktop surface invokes an existing property command

- GIVEN a Message card exposes body/mode、continued、display-name or avatar capability
- WHEN the desktop adapter opens its editor/picker
- THEN it MUST reuse the existing structured command/controller and rejection mapping
- AND MUST NOT duplicate source serialization、Pack resolution or WorkspaceEdit application

#### Scenario: Mobile surface invokes the same command

- GIVEN the mobile adapter presents a full-screen editor or bottom sheet for the same card capability
- WHEN the author confirms the operation
- THEN command payload、freshness checks、one-shot apply and cancellation MUST match desktop behavior
- AND pointer coordinates、Workbench context-view DOM and desktop menu state MUST NOT be ComposerRuntime inputs

#### Scenario: Runtime disposes

- GIVEN GUI projection requests、catalog subscriptions、transient sheets or pending commands exist
- WHEN the owning editor runtime quiesces、reloads or disposes
- THEN ComposerRuntime MUST stop admitting work、cancel pending operations and dispose subscriptions
- AND no callback may mutate a newer runtime or retain a second document snapshot owner

### Requirement: The first GUI slice supports a complete narrow authoring loop

The PWA-first GUI SHALL allow an ordinary author to create/open a project、compose supported conversation cards、preview、recover history、persist and export without requiring source editing for the supported path. Advanced source SHALL remain available as an explicit fallback.

#### Scenario: Author completes a supported story

- GIVEN a project uses supported Message/Narration cards and Pack choices
- WHEN the author inserts、edits、moves and deletes cards
- THEN the author MUST be able to select speakers/resources、edit body/mode/continued/display-name/avatar、open live preview、save、inspect Local History and export
- AND every mutation MUST flow through the shared Rust/TextDocument path

#### Scenario: Story contains unsupported syntax

- GIVEN a project also contains reply、bond、custom directives or Typst content not modeled by the first GUI slice
- WHEN the author edits supported cards elsewhere
- THEN unsupported bytes MUST remain exact and ordered in Opaque nodes
- AND the GUI MUST provide an advanced source entry for those nodes
- AND supported editing MUST NOT silently normalize、delete or relocate them

#### Scenario: Author switches between GUI and source

- GIVEN both surfaces address the same current TextDocument
- WHEN source editing changes the document
- THEN GUI snapshot identity MUST advance and rebuild from Rust projection
- AND when GUI editing changes the document the source editor MUST observe the same WorkspaceEdit
- AND no merge、synchronization or dual-save protocol may exist between the surfaces

### Requirement: GUI Composer uses one native Workbench editor surface

The primary card surface SHALL be native editor `mmt.guiComposer` registered through `SimpleEditorPane`/`SimpleEditorInput`. Its editor input and serializer SHALL own only the resource URI; the current TextDocument SHALL remain the sole document/model owner.

#### Scenario: Native GUI editor restores

- GIVEN a GUI editor for URI U is serialized and the page reloads
- WHEN Workbench restores the input
- THEN it MUST reopen the one TextDocument for U and request the current Rust snapshot
- AND it MUST NOT restore card bytes、a client AST or another Monaco model

#### Scenario: Responsive default is applied

- GIVEN an MMT document opens for the first time in one page-lifetime document incarnation
- WHEN viewport width is 551 CSS px
- THEN source MUST remain the default editor
- WHEN viewport width is 550 CSS px or 320 CSS px
- THEN `mmt.guiComposer` MUST open by default
- AND after the user explicitly opens advanced source that incarnation MUST NOT be forced back to GUI in the same page lifecycle

### Requirement: Mobile creation remains accessible and offline-capable

The native GUI editor SHALL support the same authoring contracts at viewports up to and including 550 CSS px without relying on hover、right click or drag. 320 CSS px SHALL be the minimum required product verification width. It SHALL reuse the existing PWA workspace and safe-restart lifecycle.

#### Scenario: GUI runs at 320 CSS pixels

- GIVEN the viewport is 320 CSS px wide with a mobile safe area
- WHEN the card list、editor、picker or preview is open
- THEN primary controls MUST remain reachable without horizontal page scrolling
- AND primary touch targets MUST be at least 44 CSS px
- AND safe-area insets MUST protect fixed actions
- AND preview viewport ownership MUST remain consistent with the existing single-scroll-container contract

#### Scenario: Soft keyboard opens

- GIVEN a body or search editor has focus
- WHEN the visual viewport shrinks for the soft keyboard
- THEN the active field and confirm/cancel actions MUST remain reachable
- AND background card selection MUST not change through accidental covered taps
- AND closing the keyboard MUST not discard unsent input unless the Composer operation became stale

#### Scenario: App reloads offline

- GIVEN shell/runtime artifacts and the workspace were previously available offline
- WHEN the PWA restarts without network access
- THEN the latest persisted MMT document MUST reopen
- AND GUI projection MUST rebuild from the local TextDocument/language service
- AND unavailable remote Pack media MAY degrade according to existing Pack contracts without losing authored cards
- AND no card-specific offline database may be required