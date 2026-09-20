## ADDED Requirements

### Requirement: GUI Composer is a native URI-only Workbench editor

The GUI Composer SHALL remain `mmt.guiComposer`, registered before `api.start()` through the pinned ViewsService public `SimpleEditorPane`、`SimpleEditorInput`、`registerEditorPane`、`registerEditor` and `registerEditorSerializer` APIs. The native pane SHALL host the existing shared SVG preview overlay, not a card editor、Sidebar replacement、WorkspaceService shell or second runtime.

#### Scenario: Native GUI editor registration succeeds

- GIVEN the pinned public editor APIs are available
- WHEN GUI Composer is registered
- THEN `**/*.mmt` and `**/*.mmt.txt` MUST retain an optional single-per-resource editor opened by `vscode.openWith(uri, "mmt.guiComposer")`
- AND the pane、ComposerRuntime、text session、subscriptions and Sheets MUST be owned by the current EditorRuntimeController
- AND they MUST consume the existing TextDocument、mmtfs、Pack、notification、PreviewArtifactStore、history and export owners
- AND no second document buffer、Monaco model、persistence queue、renderer session owner or runtime lifecycle MAY be created

#### Scenario: GUI input is serialized and restored

- GIVEN `ComposerEditorInput` is open for one resource
- WHEN Workbench serializes and restores it
- THEN the input MUST persist only `{version:1,uri}` with singleton resource capability
- AND restore through `openTextDocument(resource)` and a fresh Rust snapshot
- AND MUST NOT persist body bytes、selection、nodeKey、composition draft or another model

#### Scenario: Pinned GUI restoration wins startup fallback

- GIVEN `mmt.guiComposer` was opened and pinned for a source URI
- WHEN Workbench persists or reloads native editor state
- THEN completing the open and pin MUST flush the existing native `IStorageService`
- AND safe restart MUST flush that same service before reload, without a second storage owner、persistence queue or retry subsystem
- AND startup MUST await `IEditorGroupsService.whenRestored` before deciding whether to restore the remembered source or open the intro fallback
- AND a restored native GUI input MUST remain the active URI-only editor rather than be replaced by either fallback
- AND its initial SVG source bind MUST wait for initial Pack-registry synchronization to settle, including the validated empty-registry fallback, before requesting `mmt/getTypstRenderProject`
- AND this bind MUST NOT depend on automatic preview being enabled

#### Scenario: Author switches source and GUI

- GIVEN both editors address one MMT URI
- WHEN the active surface changes
- THEN they MUST retain the same TextDocument/model and current preview owner
- AND switching MUST NOT copy bytes、create a competing selected-document authority or close/reopen to synchronize content

#### Scenario: Runtime quiesces or PWA restarts

- GIVEN active input、drag、clipboard work、commands or Sheets
- WHEN quiesce、HMR、unload or safe PWA restart begins
- THEN admission MUST stop at the same EditorRuntimeController boundary
- AND owned pending work/subscriptions MUST cancel and dispose in reverse acquisition order
- AND already-applied TextDocument flushing and Service Worker activation MUST remain with the existing safe-restart path
- AND uncommitted text MUST follow copy/discard recovery rather than be silently promoted to durable data

### Requirement: Desktop and mobile presentations preserve stable shell geometry

The native SVG GUI SHALL preserve ViewsService Part ownership and existing SplitView geometry. Responsive styling and overlay placement SHALL NOT establish a second shell state machine.

#### Scenario: Desktop GUI is opened

- GIVEN width is greater than 550 CSS px with stable Activity Bar、Sidebar、Editor/Panel topology
- WHEN an MMT document first opens
- THEN source MUST remain the default editor
- AND explicit GUI activation MUST open the native pane without reconstructing Parts or changing SplitView ownership

#### Scenario: Mobile GUI is opened by default once

- GIVEN `matchMedia("(max-width: 550px)")` matches a URI/document incarnation not yet admitted in the page lifecycle
- WHEN it first opens or restores
- THEN Workbench MUST open `mmt.guiComposer` and MAY hide Sidebar through the existing Part API
- AND explicit source activation MUST prevent further forced GUI switching in that lifecycle/incarnation
- AND another URI/incarnation MUST independently apply the rule
- AND no legacy React shell or separate App bundle MAY own the mobile document

#### Scenario: Source fallback is requested

- GIVEN advanced、Opaque or non-reversible content requests source navigation
- WHEN the GUI opens its authored range
- THEN it MUST use the existing TextDocument/editor/navigation boundary
- AND MUST NOT turn an Opaque preview、navigation midpoint or client-calculated source range into edit authority

#### Scenario: Shell or keyboard changes geometry

- GIVEN the shared overlay is mounted in an active native pane
- WHEN ResizeObserver、pane/window resize、Part visibility/layout or visualViewport changes occur
- THEN it MUST re-layout over the current element using the correct clippingContainer
- AND MUST NOT cover Sidebar、another editor group or unrelated native Parts
- AND mobile caret reveal MUST preserve reachable Sheet/Picker actions and 44px targets without outer horizontal scrolling
- AND the SVG viewport MUST remain the primary canvas scroll owner without a hidden card-list scroll path

### Requirement: GUI observable behavior is browser-qualified at desktop and mobile boundaries

Ownership、exact geometry、input、freshness、accessibility and persistence SHALL be verified on the actual production Workbench/PWA SVG surface. Source-text assertions、cursor-count checks、standalone mocks and typecheck alone SHALL NOT qualify the UI.

#### Scenario: Desktop authoring loop is verified

- GIVEN a production Workbench with mixed supported/opaque content
- WHEN automation exercises real SVG character input、cross-body selection and explicit structure/resource controls
- THEN it MUST observe one versioned text transaction per accepted intent、one shared model/version chain、native undo/redo、Local History、current preview revisions、save/reload and exact export
- AND non-target authored bytes and resolved semantics MUST remain unchanged
- AND text bursts under delayed snapshot/compile responses MUST retain all accepted input in order

#### Scenario: Mobile controls are verified

- GIVEN 551px、550px and 320px viewports
- WHEN source/GUI、Picker、Sheet、history and canvas are opened
- THEN 551px MUST initially use source while 550px and 320px initially use GUI
- AND 320px MUST expose reachable 44px actions、safe-area protection、keyboard-safe caret and non-drag structure ordering
- AND required structure operations MUST NOT depend on hover、right click or drag
- AND text drag/handles MUST operate through Pointer Events and host semantic selection without body-level double scrolling
- AND previously cached projects MUST remain editable and savable offline

#### Scenario: Stale and own-edit transitions are verified

- GIVEN a property operation or text session captured document/runtime identity
- WHEN an external edit、Pack change or document switch invalidates it
- THEN the actual surface MUST reject stale work without retargeting another node/document
- AND pending text MUST remain recoverable through existing notification/Sheet
- WHEN an expected own text edit advances version
- THEN the same input bridge MUST remain open while selection is recovered through the new digest/exact statementRange
- AND a render-only change MUST trigger geometry refresh rather than close valid composition

#### Scenario: Real browser evidence records its limits

- GIVEN automated composition and renderer scenarios have passed
- WHEN delivery is reported
- THEN real Chrome visual interaction and an actual Chinese OS IME MUST separately qualify candidate-window anchoring、one commit、cancel、one undo and rerender continuity
- AND missing Chrome/OS IME/publication credentials MUST be explicitly listed as unverified or blocked
- AND synthetic events or an old runtime artifact MUST NOT substitute for those proofs

### Requirement: One retained preview overlay serves GUI and source preview panes

PreviewWebviewHost SHALL create one `IOverlayWebview` through the installed `IWebviewService.createWebviewOverlay`, with `retainContextWhenHidden:true` and existing scripts/localResourceRoots. It SHALL replace the WebviewPanel-only transport while retaining renderer、publication、ACK、resync、CSP and committed session/generation ownership.

#### Scenario: A pane claims the shared SVG

- GIVEN a current claimant and target container
- WHEN `attachSurface(claimant, container, clippingContainer)` is called
- THEN the host MUST use `claim(claimant, mainWindow, undefined)` and `layoutWebviewOverElement`
- AND `layoutSurface(claimant)` MUST layout only the matching live claimant
- AND `releaseSurface(claimant)` from an old claimant MUST NOT detach a new claimant
- AND moving/hiding the pane MUST NOT destroy/recreate the iframe
- AND only product runtime disposal MUST destroy the shared overlay

#### Scenario: Existing transport semantics survive remount

- GIVEN an overlay is created or moved between panes
- WHEN host/webview messages are exchanged
- THEN the host MUST use `setHtml`、`postMessage` and `onMessage` with `event.message`
- AND HTML URIs/CSP MUST use the same VS Code `asWebviewUri` and `webviewGenericCspSource`
- AND ready、publication ACK、resync and committed identity checks MUST retain their original semantics
- AND remount MUST NOT add another artifact store、renderer or session owner

#### Scenario: GUI and source request preview

- GIVEN preview source/render/export binding is shared through one `bindPreviewSource(document)` path
- WHEN a GUI pane opens or activates
- THEN it MUST bind that document and mount the shared SVG canvas
- WHEN GUI preview is invoked
- THEN it MUST focus that same canvas without opening a duplicate
- WHEN source preview is invoked
- THEN a native `mmt.previewHost` pane MUST provide the alternate read-only mount
- AND that pane MUST own no renderer/session/store
- AND source-to-preview navigation MUST remain available
- AND old panel-only open/reveal/close、ViewColumn helpers and their fixture/export callers MUST be removed or migrated, not retained as aliases

#### Scenario: Multiple documents or GUI panes are visible

- GIVEN more than one GUI/native preview pane exists
- WHEN active/visible editors change
- THEN `IEditorService.onDidActiveEditorChange/onDidVisibleEditorsChange` MUST determine the live claimant, not only TextEditor events
- AND the one overlay MUST display at most one active document
- AND other GUI panes MUST expose a focusable inactive placeholder
- AND new input MUST wait until bound sourceUri and renderer identity match the active document
- AND A's old SVG/messages MUST never authorize an edit to B

### Requirement: Webview text intents carry strict identity and no source authority

The protocol SHALL add exact `composer-intent` and `composer-state` variants plus a transport-only `composer-drained` acknowledgment using the existing `type` discriminator. The host SHALL admit only the current authored session with ordered bounded semantic intents and proven published render identities, never webview-authored MMT ranges or edits.

#### Scenario: Intent is admitted

- GIVEN a message `{type:"composer-intent",sessionId,sequence,renderKey,intent}`
- WHEN the consumption boundary parses it
- THEN it MUST validate exact keys、size、sequence、session and identity
- AND every well-formed known-session new sequence MUST be forwarded to the text session with an explicit admission decision, including rejection after geometry becomes pending
- AND intent MUST be one of `pointer` with phase start/move/end/cancel、point、required `uncertainty:{x,y}`、extend and normalized `clickCount:1|2`; `move` with direction left/right/up/down、granularity grapheme/word/visualLine/document、extend; `replace` with text and origin typing/paste/cut, or with exactly `text:""`、`origin:"delete"`、direction backward/forward and granularity grapheme/word; `composition` with phase start/update/end/cancel and text; `history` with direction undo/redo; or `copy`
- AND unknown fields/enums、stale sequence/session、unknown or retired render key、raw MMT range、TextEdit and DOM-as-source payloads MUST be rejected
- AND pointer coordinates MUST pass current geometry/mapping and Rust selection reading before becoming edit authority
- AND pointer clickCount MUST explicitly distinguish single-click from double-click word selection without timing heuristics or raw source/text payloads
- AND exact-key intent producers and consumers MUST migrate together using these variant-specific fields without adding a user-visible mode
- AND delete replacements MUST reject nonempty text、missing direction/granularity and unknown deletion fields or enums
- AND typing/paste/cut replacements MUST reject additional deletion direction/granularity keys
- AND pointer uncertainty MUST have exact keys and finite normalized-page components in `[0,1]`; it MUST NOT be absent、defaulted、clamped or added to ordinary navigation point payloads

#### Scenario: Deletion intent does not manufacture a cross-body selection

- GIVEN a delete replacement carries explicit direction and granularity
- WHEN the current authorized selection is collapsed at a body boundary
- THEN the host MUST NOT synthesize move-plus-delete to merge a neighboring statement
- AND backward/forward grapheme/word deletion MUST respect the current body's boundary
- WHEN the author already has an explicit noncollapsed cross-body selection
- THEN delete MAY replace that authorized interval with empty text under the existing Rust cross-body contract

#### Scenario: Host returns text presentation state

- GIVEN the host has accepted or blocked a current sequence
- WHEN it returns `{type:"composer-state",sessionId,sequence,renderKey,status,carets,boxes,screenCoordinatePrecision}`
- THEN status MUST be ready、pending or blocked
- AND required transport-only `screenCoordinatePrecision` MUST be finite in `[0,1]`, refreshed from current main-window layout/resize precision and MUST NOT enrich the semantic Composer session state
- AND boxes MUST use normalized page `{pageIndex,x,y,width,height}` geometry and carets MUST include before/after affinity
- AND state MUST match the authorized current identity rather than predict source bytes
- AND unavailable geometry MUST remain blocked/unavailable rather than use statement midpoints

#### Scenario: Intent queues have distinct loss policies

- GIVEN pointer motion、text input and preview renders arrive concurrently
- WHEN work is queued
- THEN drag MAY coalesce to the latest point and rendering MAY be latest-wins
- BUT every accepted text intent MUST be serialized without loss
- AND a pending old visual caret MUST NOT authorize a new pointer edit
- AND composition updates MUST remain temporary HTML without another compiled MMT/Typst document

#### Scenario: A well-formed pointer is rejected after admission becomes pending

- GIVEN a known current session sends a new sequence after prior text was accepted but its pointer render identity or geometry is now stale
- WHEN the host explicitly admits or rejects that sequence
- THEN it MUST acknowledge the rejected pointer with blocked state for that sequence and revoke the stale selection
- AND it MUST drain every preceding accepted text intent in order before retiring its route
- AND subsequent text MUST NOT reuse the revoked selection or retarget to a newer document/session

#### Scenario: Own rerender does not discard in-flight keyboard input

- GIVEN an ordered keyboard intent refers to a renderKey actually published in the same uninterrupted authored session
- WHEN a newer committed frame is published before that intent reaches the host
- THEN the keyboard intent MAY remain authorized by the session's issued-key allowlist and own-edit snapshot proof
- AND first receipt of a newer issued key MAY retire earlier keys using sender FIFO order
- AND a new pointer intent MUST still match current committed geometry exactly
- AND unknown keys or external semantic conflicts MUST NOT gain this authorization

#### Scenario: A surface handoff drains the old input channel without retargeting

- GIVEN the host blocks an input session during focus switch、Sheet opening or shutdown
- WHEN the iframe processes that blocked state
- THEN it MUST send exactly `{type:"composer-drained",sessionId,sequence}` after its prior intent messages, with the last sent sequence
- AND the host MUST retain the issued old-session route until the matching ordered acknowledgment
- AND late text from that route MUST be retained only by the original session's recovery path, never applied to a new document
- AND every blocked-to-admitting activation MUST use a new sessionId while ordinary pending-to-ready rendering MUST retain the session
- AND late IME update/end MUST update one stable recovery ID without duplicating already retained draft text
- AND acknowledged retired routes MUST be released without clearing unresolved recovery blocks
- AND a focus、Sheet or transient admission pause MUST remain active until all previously accepted work settles or retires
- AND an obsolete drain MUST NOT release a newer pause or cancel a newer composition

### Requirement: Text edits use the same native model and undo stack

`applyComposerTextEdit` SHALL validate the Rust edit, compute the exact candidate produced by all returned edits, verify it against `sourceDigestAfter`, and apply only those edits through the existing MMT model's `pushEditOperations`. Native model undo/redo SHALL remain the sole history; property/structure commands SHALL retain existing workspace.applyEdit behavior.

#### Scenario: A text edit applies once

- GIVEN a strict Rust `TextEdit` result and the original authorized document
- WHEN the host applies it
- THEN it MUST check URI/version、model version and sourceDigest, and pass the exact digest-validated candidate to synchronous `canApply(candidate)` immediately before mutation
- AND the runtime MUST register that candidate as the sole pending expected change only when its current permission checks succeed
- AND a resulting document event MUST count as own only when its complete text exactly equals that candidate under the existing incarnation/version/signal gates, independent of Monaco content-change array count、ranges or coalescing
- AND use IModelService to obtain the same model, opening the existing URI through current document/model services if necessary
- AND MUST NOT create a copied model、call `setValue`、serialize body text or author extra TextEdits
- AND all edits in the single versioned TextDocumentEdit MUST apply as one atomic text transaction
- AND an empty candidate MUST remain valid

#### Scenario: Native auto-whitespace is suspended only for the atomic edit

- GIVEN the existing model has `trimAutoWhitespace` enabled and unselected indentation or whitespace exists
- WHEN `pushEditOperations` applies the authorized GUI transaction
- THEN the apply owner MUST temporarily disable that option through the model's supported options API only for the synchronous call
- AND it MUST restore the prior value in `finally`
- AND unselected bytes MUST remain exact without globally changing the user's setting

#### Scenario: Typing is grouped and discrete operations close history boundaries

- GIVEN continuous typing in one text session with contiguous selection
- WHEN input continues before an idle boundary
- THEN native pushEditOperations MAY share one typing group without per-key stack elements
- WHEN 750ms idle、pointer/navigation、newline、paste/cut、IME、structure action or focus switch occurs
- THEN the typing boundary MUST close using pushStackElement before/after groups
- AND an input/transient pause MUST remain active until preceding accepted typing settles or retires, closing the undo boundary only after that drain
- AND IME commit and a cross-message replacement MUST each be one complete undo group
- AND before/after source selections MUST accompany edits
- AND external editing and discrete Composer commands MUST first finish the text group

#### Scenario: GUI selection returns after native history

- GIVEN a GUI edit is followed by source/GUI undo or redo
- WHEN the existing model alternativeVersionId changes
- THEN presentation bookmarks MAY restore current authorized GUI selection
- AND they MUST NOT form a separate document or undo stack
- AND Rust snapshot/digest identity MUST still gate subsequent edits
- AND native Local History、save/reload and export MUST observe this same model

### Requirement: Geometry adapter is pure identity-bound and reflow-aware

`composerTextGeometry` SHALL expose `hitTest(point,uncertainty,identity,signal)`、`caret(endpoint,identity,signal)`、`selection(selection,identity,signal)` and `move(selection,direction,granularity,extend,preferredX,identity,signal)`. It SHALL own geometry/mapping only, never source text or edit authority. `uncertainty` SHALL use the canonical `PreviewRendererPointUncertainty` exact object with required finite `[0,1]` normalized-page components carried by pointer intent.

#### Scenario: Geometry is resolved

- GIVEN identity binds sourceUri/version/sourceDigest、renderKey and renderer session/generation
- WHEN a hit、caret、selection or move is queried
- THEN the result MUST contain authored positions or already-authorized semantic endpoints and normalized page boxes
- AND caret results MUST include `affinity:"before"|"after"`
- AND text-hit uncertainty MAY expand containment only; exact stop edge、source、affinity、distance and nearest-stop ordering MUST remain invariant, while intersecting distinct-source clusters remain ambiguous
- AND page normalization MUST use `ceil(f32(native page extent))` for each dimension
- AND DOM `.tsel`/glyph bounds MAY measure space but offsets MUST match exact Rust body and projected source spans
- AND empty results MUST mean unavailable with no midpoint or equal-text fallback

#### Scenario: Browser pointer precision is propagated conservatively

- GIVEN the state message supplies top-level Float32 `screenCoordinatePrecision` and an actual PointerEvent supplies local Float32 precision
- WHEN the browser maps the sample through the inverse SVG CTM
- THEN it MUST combine both bounds with conservative absolute row sums into normalized page uncertainty and forward it unchanged
- AND it MUST NOT substitute fixed CSS-pixel padding
- AND synthesized touch-handle/native caret samples MUST use zero uncertainty

#### Scenario: Reflow replaces prior geometry

- GIVEN an authorized selection and active rendered occurrence
- WHEN a new artifact、zoom、resize or full/diff resync is accepted
- THEN the adapter MUST query from the current snapshot selection again
- AND preserve selection direction、preferredX and viewport anchor where correspondence exists
- AND MUST NOT reuse an old normalized point as a new caret
- AND missing correspondence MUST block text-pointer authority and retain source access
- AND user scrolling MUST cancel delayed automatic caret reveal

### Requirement: Canonical persistence and export exclude uncommitted composition

The existing persistence、History、PWA and Export owners SHALL remain unchanged. Only applied TextDocument bytes and confirmed canonical render revisions SHALL enter durable files or exports.

#### Scenario: Export occurs during composition

- GIVEN IME temporary HTML or pending uncommitted text exists
- WHEN save/export or canonical PDF export is requested
- THEN only committed TextDocument bytes and the confirmed canonical revision MUST be used
- AND temporary composition MUST NOT enter the file、PDF or a new offline store
- AND unresolved pending input MUST remain explicitly recoverable rather than be silently discarded