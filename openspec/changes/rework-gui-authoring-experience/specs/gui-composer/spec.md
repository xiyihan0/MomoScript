## ADDED Requirements

### Requirement: Authoring has three URI-bound modes with explicit defaults

The product SHALL expose chat, layout and source over one canonical MMT TextDocument and native history. New ordinary works SHALL default to chat at every viewport width. Restored existing source workspaces SHALL retain source mode and split state. This requirement supersedes the width-based first-open/source defaults in `add-mobile-gui-surface`; 550 CSS px SHALL be a layout breakpoint, not authority to override restoration or explicit mode choice.

#### Scenario: A new work is created without an extension prompt

- GIVEN the author chooses New work
- WHEN a work name is submitted
- THEN the host MUST trim it, preserve Chinese, replace path separators/control characters with `_`, reject empty names and `.`/`..`, and append `.mmt` only once
- AND it MUST use existing workspace.fs/openComposerDocument and increment collisions as `名称 (2).mmt` without overwriting
- AND displayed work name MUST be basename without extension, without a second project database
- AND existing `.mmt`/`.mmt.txt` opening MUST remain unchanged

#### Scenario: First use opens the existing story in chat

- GIVEN a fresh workspace has no restored active native editor input after restoration settles
- WHEN the existing startup fallback chooses its document
- THEN it MUST open the existing seeded STORY through the ordinary chat GUI entry rather than default to intro.typ source
- AND this MUST change only the fresh fallback branch, without creating another story model or landing pane
- AND restored source/split inputs MUST remain untouched
- AND intro/source tooling MUST remain explicitly openable through advanced entries

#### Scenario: Mode is selected or restored

- GIVEN one URI is open with a native model and possibly an unsent draft
- WHEN chat, layout or source becomes active
- THEN it MUST use the same model, native undo stack and existing runtime
- AND chat MUST show a persistent next-message composer while layout MUST NOT
- AND source MAY show one current SVG split, never two active SVG owners
- AND at widths at or below550px source/canvas MUST switch within one EditorGroup rather than form two narrow columns

### Requirement: Mode transitions preserve accepted input and URI-local drafts

Mode/surface switches SHALL be input transactions using the existing ComposerTextSession drain and retired-session routes. Existing composerDrafts SHALL retain unsent body, speaker, avatarChoice, append/insert target and recovery text per URI; these SHALL NOT become another authored document or enter the URI-only editor serializer.

#### Scenario: A mode switch is requested during composition

- GIVEN composition or accepted text is pending
- WHEN the author changes mode or mount
- THEN composition MUST finish before switching without discarding its candidate
- AND accepted intents MUST drain in order before the old surface unbinds
- AND late retired-session messages MUST NOT mutate the new session or another URI
- AND unsent text/speaker/avatar/target MUST survive remount without entering save/history/render/export

#### Scenario: A selection is restored after mode or source change

- GIVEN an authored endpoint/range bookmark with native alternativeVersionId
- WHEN a new snapshot is accepted
- THEN restoration MUST transform authored positions and request fresh Rust authorization
- AND old nodeKey MUST NOT be reused
- AND deleted targets or external conflicts MUST clear old authority and expose recovery, not search identical text for a substitute

### Requirement: Product chrome exposes genuine state without replacing native owners

Chat/layout SHALL present work name, true save state, named mode control and Export work; work menu SHALL expose new/open/save/history/restore/native undo/redo/source download/advanced workspace. Existing native Parts and EditorPart SHALL temporarily hide product-irrelevant chrome and restore the author's source configuration without persistent preference writes.

#### Scenario: Saving fails or a mode changes

- GIVEN current TextDocument dirty state and an actual save operation
- WHEN UI shows unsaved, saving, saved or error
- THEN the label MUST derive from dirty, save Promise and filesystem success/failure rather than a timer
- AND failure MUST offer retry without clearing content
- AND mode switches and export MUST NOT implicitly save

#### Scenario: Chat canvas is empty or updating

- GIVEN no authored statements or a pending replacement render
- WHEN chat is shown
- THEN empty state MUST provide Start the first dialogue and role/teacher entry points
- AND chat MUST NOT show generated title blocks, page numbers, paper shadow, zoom or fit chrome
- AND updating MUST retain the last accepted SVG with a gentle updating state; skeleton is allowed only before a first accepted frame
- AND authored SVG graphics MUST NOT be hidden to obtain this presentation

### Requirement: Continuous creation is independent of existing-body editing

The chat bottom composer SHALL create next-message or explicit insert drafts; clicking existing SVG body SHALL edit through the existing exact input bridge without copying old content into the bottom composer. This mode-specific contract supersedes the previous always-present GUI zoom/fit row and undifferentiated bottom-composer chrome.

#### Scenario: Two messages are sent with a selected expression

- GIVEN a current role, avatarChoice and authorized insertion boundary
- WHEN Enter sends a non-composing draft
- THEN one Rust insertStatement with literal ordinary-body mode MUST apply before body clears
- AND role and expression MUST remain for the next message
- AND Shift+Enter MUST insert a draft newline
- AND isComposing, composition-event and keyCode229 safeguards MUST prevent IME Enter from sending
- AND wait/rejection/failure MUST preserve the draft without optimistic SVG content

#### Scenario: Existing text is edited while a draft exists

- GIVEN unsent next-message body and role
- WHEN an old SVG body is edited or its property/history action runs
- THEN bottom body, role, expression and insertion state MUST remain unchanged
- AND the surface MUST identify Editing message N and offer Finish editing without pretending to save
- AND existing body Enter/newline and cross-body semantics MUST remain unchanged by draft Enter-to-send behavior

#### Scenario: Explicit insertion is selected

- GIVEN an authorized boundary beside a selected message
- WHEN Insert is chosen
- THEN the bottom composer MUST show adjacent-message summaries, label its action Insert and offer Return to end
- AND ordinary default MUST append at document end
- AND an invalidated target MUST require explicit reselection, never silently append or guess another boundary

### Requirement: Selection actions remain semantic and capability-driven

Selection SHALL prioritize Edit, Insert, Move and Delete with target summary and current capability state. Properties and advanced actions SHALL remain reachable through More/auxiliary panel, not a permanent full inspector. Actions SHALL remain usable by keyboard and touch without hover, right-click or drag.

#### Scenario: Author moves or deletes a message

- GIVEN current Rust movement/deletion capability
- WHEN up, down, move-to or delete is chosen
- THEN one current moveNode/deleteNode command MUST execute through Rust
- AND movement across an Opaque barrier MUST be unavailable with a reason
- AND native undo MUST restore deletion through the same model history
- AND advanced continued/body modes/Source Lens MUST remain available, not removed by ordinary text defaults

#### Scenario: Properties affect subsequent statements

- GIVEN display-name/avatar scope is fromStatement
- WHEN properties are displayed or changed
- THEN UI MUST state that this and later governed messages for that actor are affected
- AND it MUST NOT claim a nonexistent only-this-message scope
- AND side controls MUST derive from allowed setSide values, never client sigil replacement

### Requirement: Media creation uses semantic intents and workspace persistence

Add SHALL offer text message, narration, image and character sticker. Narration SHALL reuse existing insertStatement. GUI media SHALL submit strict Rust media intent rather than call source gallery's raw-source insertion.

#### Scenario: Local PNG or JPEG is imported

- GIVEN a current document and explicit legal insertion target
- WHEN the native file picker successfully decodes a PNG/JPEG
- THEN the host MUST write it via the existing fs provider under the document directory at safe `assets/<uuid>.png|jpg` before submitting workspaceImage
- AND write failure MUST leave source unchanged
- AND Rust rejection MUST retain draft and remove only this import's newly created, not-accepted-referenced file
- AND existing files MUST NOT be removed

#### Scenario: Existing asset or sticker is inserted

- GIVEN current snapshot asset choices or existing set-aware sticker picker
- WHEN the author confirms media
- THEN GUI MUST submit the structured asset/sticker choice to Rust at the current boundary
- AND TS MUST NOT construct @asset, @actor or marker source
- AND media MAY expose selection/properties/move/delete but MUST NOT obtain a body caret absent Rust textEditing capability
- AND native source gallery line/selection insertion MUST keep its original entry points and conditions

### Requirement: Role choice preserves explicit resource identity and custom fallbacks

Chat SHALL offer current-work/recent roles and on-demand complete people→form→expression selection backed by validated catalog projection. Choosing a role SHALL preserve full speaker reference/entity/contribution namespace/variant identity. A single available step MAY advance directly.

#### Scenario: A role or expression is changed

- GIVEN a verified Pack or script role is available
- WHEN it is chosen for the next message
- THEN it MUST remain in the stable recent/work tray without mutating source before send
- AND teacher MUST use builtin identity and current right-side capability
- AND editing an old avatar MAY choose another person's avatar without changing that message's speaker

#### Scenario: Catalog, connectivity or custom write capability is absent

- GIVEN old manifest, missing Catalog, offline resources or custom script actors/assets
- WHEN the role chooser opens
- THEN all originally available items MUST remain discoverable without guessed grouping or hidden unknown names
- AND existing custom role/avatar state MUST display with a real Custom roles and resources source/local-source entry
- AND UI MUST NOT claim a nonexistent custom-avatar GUI write pipeline

### Requirement: One auxiliary panel remains accessible across viewport and keyboard changes

Role, form/expression, properties, Add and export SHALL share one mutually exclusive auxiliary slot. Mobile SHALL use one Bottom Sheet with internal forward/back navigation rather than stacked overlays. Modal Sheets SHALL have accessible title/close, independent scrolling, focus constraint/restoration and Escape dismissal. Wide-desktop properties SHALL use that same slot as an allocated nonmodal panel, preserving canvas reading rather than hiding or covering it.

#### Scenario: Wide-desktop properties preserve canvas reading

- GIVEN a viewport at least960 CSS px wide and a selected message
- WHEN its properties panel opens
- THEN the same retained SVG MUST remain visible and scrollable beside the allocated panel
- AND the native overlay MUST NOT cover the panel or require another renderer or document owner
- AND the panel MUST expose a title, close and independent scrolling without a modal backdrop or focus trap
- AND property actions MUST retain their exact target and freshness checks
- AND other actions MUST NOT silently discard uncommitted property input


#### Scenario: A narrow viewport or software keyboard is active

- GIVEN 320px width, safe areas or visualViewport shrunk to about360px high
- WHEN input or Sheet search receives focus
- THEN visualViewport height/offset and safe-area insets MUST keep input, Send, caret and close visible
- AND touch targets MUST be at least44 CSS px
- AND role shortcuts MUST NOT consume the body input row; low height MUST limit input to about3 lines and condense tray to current role/Choose role
- AND root MUST NOT gain unintended horizontal scrolling; intentional role-tray scrolling MAY remain
- AND overlay MUST NOT click through to another message

#### Scenario: Landscape editing constrains height above the phone-width breakpoint

- GIVEN an 844×390 or 740×320 viewport and active SVG text editing
- WHEN selected-content actions and the bottom draft are visible together
- THEN constrained-height layout MUST apply independently of viewport width
- AND the canvas MUST retain enough visible height for its caret, with no clipped input, Send or Export controls
- AND the current-role picker and selected-content actions MUST remain reachable at44 CSS px or larger
- AND compact layout MUST NOT change document content, mode authority or the separate550px native-group rule


### Requirement: Visual and recovery states remain honest and readable

Product chrome SHALL use system Chinese font stack, 16px body, 13px secondary, 18px/600 title and 14px/500 controls; primary/selection SHALL be blue rather than generic brand-pink semantics. Workbench dark theme SHALL affect chrome, not invert SVG or modify authored colors. Rendering status SHALL use gentle aria-live rather than announce each frame/keystroke.

#### Scenario: Authorization becomes invalid while input exists

- GIVEN a stale, external-conflict or rejected text session
- WHEN automatic apply stops
- THEN recovery text, Copy and Reselect target then retry MUST remain available
- AND retry MUST acquire fresh Rust authority and require target confirmation
- AND no text MUST be auto-replayed to another or identically worded body
- AND failure MUST NOT be hidden, input cleared or freshness/sequence/geometry checks weakened

#### Scenario: Recovery can be read without a current authoring snapshot

- GIVEN external invalidation has temporarily removed the current snapshot while unsubmitted text remains
- WHEN the author opens its read-only recovery viewer or copies it
- THEN that recovery MUST remain available without granting source-edit authority
- AND retry MUST still require a freshly selected target and explicit confirmation

#### Scenario: A dismissed confirmation cannot consume another target

- GIVEN recovery target A was prepared for a now-dismissed confirmation panel and a new panel presents prepared target B
- WHEN a delayed event activates A's detached confirmation control
- THEN it MUST NOT dismiss B, issue a recovery edit or consume B's prepared authorization
- AND source and recovery text MUST remain unchanged
- AND only B's current explicit confirmation MAY submit the recovery to that exact prepared target


#### Scenario: Advanced content fails at chat width

- GIVEN advanced @typ cannot render within chat presentation
- WHEN the renderer reports failure
- THEN UI MUST show the real error with Layout preview and Local source recovery entries
- AND original content/source permissions MUST remain intact
- AND clipping, silent omission, source rewriting or approximate-location edit authorization MUST NOT replace recovery

### Requirement: Qualification proves four runnable slices and actual products

Delivery SHALL include slice-by-slice actual application operation, desktop/mobile screenshots, migration coverage, automated and manual results, opened export evidence and unverified-device limits. Slice1 SHALL be integrated and verified before Slice2 implementation; no static mock or inactive button collection SHALL count as a runnable slice.

#### Scenario: Full ordinary story is accepted

- GIVEN a current production Workbench runtime
- WHEN author creates by name, selects two people, sends three messages, edits second, reorders, undoes/redoes and exports
- THEN evidence MUST observe canonical TextDocument, corresponding SVG statements, retained role/expression and one native history
- AND desktop1440×900, narrow900×720, phone390×844 and320×740,550px breakpoint, landscape and reduced visualViewport MUST be covered
- AND LF/CRLF/blanks/fences/EOF/Unicode/opaque/@typ/custom/old-pack/contribution/AVIFS/read-only fixtures MUST preserve non-target bytes and identities

#### Scenario: Geometry, performance and device limits are reported

- GIVEN existing viewport/performance fixes and thresholds
- WHEN final qualification runs
- THEN Fit width MUST preserve current semantic/page reading anchor and native-scrollbar selection relative error MUST stay within1 CSS px per-rAF
- AND the visible-scrollbar run MUST NOT inherit `--hide-scrollbars`
- AND the same120-avatar-message/80-wheel scenario MUST retain existing performance thresholds without calling historical16.8ms/0 results current measurements
- AND actual Chinese OS IME, iOS/Android, physical touch, Safari address bar, screen reader and novice-use evidence MUST be separated from synthetic/browser-viewport tests and listed unverified if absent
