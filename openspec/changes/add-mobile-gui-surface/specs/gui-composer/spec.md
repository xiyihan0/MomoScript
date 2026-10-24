## ADDED Requirements

### Requirement: GUI Composer keeps the MMT TextDocument as its only authored state

The GUI Composer SHALL be an SVG-first product surface over the current versioned Composer document projection and Rust Composer commands. It SHALL NOT create a second mutable document、client AST、MMT serializer or persistence format.

#### Scenario: GUI opens an existing project

- GIVEN an `.mmt` TextDocument is open in the current workspace
- WHEN the GUI surface becomes active
- THEN it MUST request the current URI/version Composer snapshot and bind the existing preview runtime to that document
- AND durable bytes MUST remain owned by the existing `mmtfs` workspace/TextDocument path
- AND reload MUST reconstruct the GUI from persisted MMT rather than restore separate card/text content

#### Scenario: A Composer text edit is accepted

- GIVEN Rust returns a current-version `TextEdit` result whose edits produce an exact candidate matching `sourceDigestAfter`, and the host applies it once
- WHEN the TextDocument advances to a new version
- THEN the old snapshot and node keys MUST lose edit authority
- AND the text session MUST restore the returned selection only through the new digest and exact candidate statementRange
- AND an expected own edit MUST update the session without closing its input bridge only when the resulting complete document text equals the registered candidate under the existing incarnation/version/signal gates
- AND Local History、diagnostics、preview、persistence and export MUST observe the same ordinary TextDocument change
- AND Monaco content-change array count、ranges or coalescing MUST NOT classify ownership

#### Scenario: Snapshot parsing fails in the client

- GIVEN a projection is unknown、malformed、partial or non-covering
- WHEN strict parsing runs
- THEN the entire snapshot MUST fail closed while source recovery remains available
- AND the client MUST NOT synthesize nodes、body text or edit capabilities from raw MMT or preview DOM

### Requirement: SVG is the primary canvas and complete projection ownership remains visible

The GUI SHALL use the real Typst/Tinymist SVG as its sole primary authoring canvas. The primary card list、its event/render path and its CSS SHALL be removed rather than hidden behind another card/canvas switch. HTML SHALL be limited to caret/selection overlays、temporary IME feedback、toolbar、Picker/Sheet and source entries.

#### Scenario: Ordinary conversation is displayed

- GIVEN the snapshot contains Message and Narration nodes
- WHEN the GUI becomes active
- THEN the existing preview SVG MUST occupy the native GUI canvas
- AND body interaction MUST use authorized text endpoints rather than open a card body form
- AND speaker、mode、continued、display-name、avatar and structural controls MUST derive only from server capabilities
- AND body clicks MUST NOT also navigate away to source
- AND avatar/name/bubble/narration-label actions MUST continue to use existing semantic Picker/Sheet/PreviewComposer commands

#### Scenario: Production hosting preserves native Webview asset URLs

- GIVEN the GUI uses the native Webview and the production PWA controls the parent page
- WHEN the Webview navigates to its versioned HTML asset with native identity and service-worker query parameters
- THEN hosting MUST serve the exact case-sensitive `.html` URL directly without Pretty URL redirection
- AND the native SVG canvas MUST become ready without bypassing the PWA or adding a runtime retry/fallback

#### Scenario: A native Part receives its first shell layout

- GIVEN ViewsService has created a native Editor Part with an initial measurement layout
- WHEN the existing shell attaches the Part or changes its SplitView allocation
- THEN the shell MUST propagate the allocated dimensions through that same native Part's layout path
- AND GUI and preview mounts MUST mirror native visibility before claiming the retained canvas
- AND the first visual-ready acknowledgment MUST use the actual visible allocation rather than measurement-placeholder geometry

#### Scenario: Advanced content is encountered

- GIVEN content is Typst-mode、irreversible macro-generated text or an Opaque node
- WHEN the author chooses its local source affordance
- THEN the GUI MUST offer a pointer-adjacent multiline source editor only when the current Rust snapshot authorizes replacement of that exact node
- AND full authored-source navigation MUST remain available
- AND the GUI MUST NOT guess a body replacement range from rendered content
- AND every directive/error/unsupported projection node MUST remain discoverable even if it has no rendered glyph
- AND a comment-looking line MUST remain a diagnostic-preserving `recoverableError`, not a fabricated `comment`
- AND Opaque nodes MUST NOT acquire ordinary property、delete or move capabilities through their source editor

#### Scenario: Blank nodes are visually compact

- GIVEN separate `Opaque.blank` nodes lie between rendered statements
- WHEN the GUI compresses their visual presentation
- THEN their distinct projection identities and exact bytes MUST remain present
- AND they MUST remain barriers for structural movement
- AND an authorized cross-body text selection MAY span them without copying or deleting their bytes

### Requirement: GUI structure actions use explicit server capabilities

Insert、delete、move and speaker actions SHALL continue through current snapshot structural capabilities and explicit controls. Every supported ordering action SHALL remain usable without drag.

#### Scenario: Author inserts a statement

- GIVEN a current capability exposes a legal insertion boundary
- WHEN the author chooses the authorized kind、speaker、body and mode and confirms
- THEN the GUI MUST send `insertStatement` for that boundary
- AND MUST NOT concatenate MMT or pre-insert an authored local node
- AND the result MUST appear from the next Rust snapshot

#### Scenario: Author deletes a statement beside Opaque content

- GIVEN a Message/Narration is adjacent to an Opaque blank、directive or unsupported node
- WHEN the author explicitly confirms structural deletion
- THEN the GUI MUST send `deleteNode` for that statement alone
- AND adjacent Opaque bytes MUST remain exact
- AND deleting all body characters through text editing MUST instead leave a valid empty statement

#### Scenario: Author reorders statements

- GIVEN move capability permits movement within a continuous movable run
- WHEN the author invokes an up/down control
- THEN the GUI MUST send one `moveNode` command
- AND keyboard、touch and screen-reader users MUST be able to perform it without drag
- AND movement across any Opaque barrier MUST remain unavailable

#### Scenario: Builtin speaker remains read-only

- GIVEN a Message uses implicit Builtin `__Sensei`
- WHEN controls are presented
- THEN permitted body/mode editing MAY remain available
- BUT speaker mutation MUST remain absent
- AND speaker choices MUST be authorized script actors or verified Pack entity references

#### Scenario: A discrete operation becomes stale

- GIVEN a confirmation or property Sheet captured one snapshot/operation
- WHEN document、Pack or runtime authority changes before confirmation
- THEN it MUST close or reject without stale request/apply
- AND MUST NOT retarget a visually similar statement

### Requirement: One surface-independent ComposerRuntime owns GUI orchestration

Snapshot replacement、capability admission、discrete commands and text-session orchestration SHALL remain behind one presentation-independent ComposerRuntime. Its text sub-session SHALL hold only authorized selection、sequence、pending semantic intents、composition、geometry feedback and presentation bookmarks, not a second persistent document.

#### Scenario: Desktop and mobile invoke semantic controls

- GIVEN both presentations offer the same current property/structure capability
- WHEN an operation is confirmed
- THEN they MUST share command payload、freshness checks、one-shot apply and rejection mapping
- AND MUST reuse existing Pack resolution and body/mode、continued、display-name and avatar controllers where applicable
- AND DOM/context-view state MUST remain in adapters rather than become runtime-owned authored data

#### Scenario: Expected and external changes are distinguished

- GIVEN the text session has an accepted input queue
- WHEN its own expected edit produces the next document version
- THEN it MUST reauthorize through the returned digest/statementRange and process the next input without dropping text
- WHEN an external edit、document switch or Pack change invalidates authority
- THEN it MUST stop automatic pending apply and preserve uncommitted text for explicit recovery
- AND MUST NOT retry stale commands or reuse old node keys

#### Scenario: Runtime disposes

- GIVEN input、drag、clipboard、projection requests or transient Sheets are active
- WHEN the owning runtime quiesces or disposes
- THEN it MUST stop new work and cancel/dispose owned operations and subscriptions through the existing lifecycle
- AND late callbacks MUST NOT mutate a new runtime or another document
- AND already-applied text MUST persist through the ordinary TextDocument path

### Requirement: SVG Composer supports the complete ordinary authoring loop

The PWA GUI SHALL support create/open、direct supported-body composition、explicit structure/resource operations、history、persistence and exact export without source editing for the supported path. Advanced source SHALL remain the explicit exit for unsupported content.

#### Scenario: Author completes a supported story

- GIVEN supported Message/Narration bodies and Pack choices
- WHEN the author types、selects across bodies、inserts、moves and deletes statements
- THEN the author MUST be able to use speakers/resources、mode/continued/display-name/avatar、live typesetting、save、Local History and exact export
- AND every authored mutation MUST retain Rust authority and the same TextDocument
- AND GUI preview activation MUST focus its current SVG rather than create a duplicate preview

#### Scenario: Story contains unsupported syntax

- GIVEN reply、bond、directives or advanced Typst coexist with editable bodies
- WHEN supported text elsewhere is edited
- THEN unrelated authored bytes and resolved semantics MUST remain exact
- AND unsupported content MUST retain its source entry
- AND supported editing MUST NOT normalize、relocate or implicitly repair it

#### Scenario: Author switches between GUI and source

- GIVEN source and GUI address the same TextDocument/model
- WHEN either edits、undoes or redoes
- THEN both MUST observe the same native model history and version chain
- AND source edits MUST rebind the GUI through a fresh Rust snapshot
- AND no merge、dual-save or separate history protocol may exist

### Requirement: GUI Composer uses one native Workbench editor surface

The primary SVG surface SHALL remain native editor `mmt.guiComposer` registered through `SimpleEditorPane`/`SimpleEditorInput`. Its input/serializer SHALL persist only `{version:1,uri}`; the SVG SHALL mount the existing shared preview overlay rather than create another renderer owner.

#### Scenario: Native GUI editor restores

- GIVEN the GUI input for URI U is serialized and reloaded
- WHEN Workbench restores it
- THEN it MUST reopen the existing TextDocument/model for U and request the current Rust snapshot
- AND MUST NOT restore body bytes、selection、nodeKey、IME draft or another model

#### Scenario: Responsive default is applied

- GIVEN an MMT URI/document incarnation first opens in one page lifecycle
- WHEN width is 551 CSS px
- THEN source MUST remain the default
- WHEN width is 550 CSS px or 320 CSS px
- THEN `mmt.guiComposer` MUST open by default
- AND explicit source activation MUST prevent forced GUI reopening for that incarnation in the same lifecycle

### Requirement: Mobile creation remains accessible and offline-capable

The SVG GUI SHALL preserve the same authoring contracts at 550 CSS px and below, with 320 CSS px the minimum required verification width. Structural actions SHALL NOT rely on hover、right click or drag. Text dragging SHALL use Pointer Events and host semantic selection rather than browser selection across SVG foreignObjects.

#### Scenario: GUI runs at 320 CSS pixels

- GIVEN a 320 CSS px viewport with mobile safe area
- WHEN canvas、Picker or Sheet is active
- THEN primary controls MUST remain reachable without outer horizontal scrolling
- AND primary touch targets MUST be at least 44 CSS px
- AND safe-area padding MUST protect fixed actions
- AND the SVG preview viewport MUST remain the primary canvas scroll owner without a second card-list scroll container

#### Scenario: Soft keyboard and touch selection are used

- GIVEN a body input or search field has focus
- WHEN visualViewport shrinks or touch selection handles move
- THEN the caret、input and Sheet actions MUST remain reachable
- AND handles MUST update the same authorized host selection
- AND covered taps MUST NOT retarget another body
- AND keyboard closure or rerender MUST NOT silently discard uncommitted input

#### Scenario: App restarts offline

- GIVEN shell/runtime artifacts and workspace data were cached
- WHEN the PWA restarts offline
- THEN persisted MMT MUST reopen and rebuild local projection
- AND supported text MUST remain editable and savable through the same local language service/model
- AND unavailable remote Pack media MAY degrade under existing contracts without losing authored text
- AND no GUI-specific offline database may be required

### Requirement: Direct body editing is grapheme-safe and supports newline and empty content

Character editing SHALL be available only for uniquely mapped Message/Narration semantic bodies with resolved mode `textMacro` or `textRaw`. Enter and Shift+Enter SHALL insert body newlines; empty content SHALL remain a real editable statement with no hidden placeholder character.

#### Scenario: Unicode editing respects grapheme boundaries

- GIVEN source `- A😀é中\n- 第二条\n`
- WHEN the author inserts `X` after the emoji, deletes `X`, then presses Backspace again
- THEN the complete emoji MUST be removed without a half surrogate or damaged neighboring combining cluster
- AND caret placement/insertion at body offset zero and body end MUST work

#### Scenario: Enter remains inside one body

- GIVEN an editable body contains `first`
- WHEN the author presses Enter or Shift+Enter and types `> @不是语法 """`
- THEN the semantic body MUST exactly equal the entered text including one LF
- AND the text MUST remain in the same statement rather than become MMT syntax
- AND Rust MUST select a reversible inline/fenced serialization

#### Scenario: Body is erased and re-entered

- GIVEN all body characters are selected
- WHEN replacement is empty and later text is entered again
- THEN the statement MUST remain a legal empty fenced statement between the operations
- AND its semantic label bounds MUST expose a clickable offset-zero caret area without fake glyphs
- AND no node deletion or hidden sentinel MUST occur

#### Scenario: Collapsed deletion reaches a body boundary

- GIVEN a collapsed caret is at body start or end
- WHEN Backspace or Delete would cross that boundary
- THEN it MUST NOT implicitly merge or delete a neighboring statement
- AND structural deletion/ordering MUST remain explicit

### Requirement: Cross-body text selection has deterministic copy and replacement semantics

Cross-Message/Narration selection、copy、delete and replace SHALL be delivered with the character editor. Anchor/focus direction SHALL be retained; source order SHALL normalize execution. Each selected semantic body fragment SHALL contribute plain text separated by exactly one LF, excluding speaker prefixes、fences and Opaque bytes.

#### Scenario: Forward and reverse cross-body selection agree

- GIVEN source `- abc\n- def\n`
- WHEN selection spans first body offset 1 and second body offset 2 in either direction
- THEN copy MUST return `bc\nde`
- WHEN replacement is `X`
- THEN only the first statement MUST remain with semantic body `aXf` and its original kind/side/speaker/mode/properties
- AND selection MUST collapse after `aX`
- AND one native undo MUST restore both original statements byte-for-byte and redo MUST merge them again

#### Scenario: Blank bytes and unselected semantics survive

- GIVEN selected bodies have identical resolved modes with physical blank nodes between them and may have different speakers
- WHEN cross-body replacement executes
- THEN blank bytes MUST remain exact and the first statement envelope MUST be preserved
- AND all unselected statements' bytes and resolved actor/mode/resource semantics MUST remain unchanged
- AND a candidate that changes inherited semantics MUST be rejected rather than repaired

#### Scenario: Native auto-whitespace cannot widen a GUI edit

- GIVEN source-editor auto-indent has created whitespace outside an authorized GUI body selection
- WHEN the GUI edit is applied through the shared native model
- THEN every unselected byte including that whitespace MUST remain exact
- AND model auto-whitespace trimming MUST NOT add an implicit edit

#### Scenario: Selection meets an unsupported barrier

- GIVEN a range crosses a directive、error、other non-blank Opaque、Typst body or different resolved body mode
- WHEN copy、delete or replace is requested
- THEN the operation MUST report `unsupportedStructure`
- AND copy MUST NOT return a truncated prefix
- AND modification MUST leave the entire file unchanged

### Requirement: Text input is ordered and IME composition is one transaction

Accepted text intents SHALL execute serially and without loss while preview rendering remains latest-wins. A textarea input bridge near the caret SHALL provide temporary composition feedback without becoming a document or transient MMT/Typst compilation.

#### Scenario: Fast typing waits for authorization

- GIVEN snapshot or compile responses are delayed
- WHEN the author types a complete string with consecutive newlines
- THEN every accepted character MUST eventually occur in order at the authorized body
- AND pending geometry MAY retain visual caret feedback but MUST NOT authorize a new stale pointer edit
- AND no 300ms whole-field debounce or similar overwrite MAY discard events

#### Scenario: A stale pointer is rejected without wedging accepted input

- GIVEN a known current session has accepted text and then receives a new-sequence pointer after geometry becomes pending or stale
- WHEN the host performs explicit admission for that pointer
- THEN it MUST acknowledge the rejected sequence as blocked and revoke stale selection authority
- AND all preceding accepted text MUST drain in FIFO order before retirement
- AND later text MUST NOT reuse the old selection or retarget to another body/document

#### Scenario: Input pause waits for accepted work

- GIVEN accepted typing is draining when a focus、Sheet or transient pause begins
- WHEN admission is paused
- THEN the pause MUST remain active through settlement or retirement of that accepted work
- AND the undo boundary MUST close only after the accepted typing drains
- AND an obsolete drain MUST NOT cancel a newer composition or reopen stale admission

#### Scenario: A finished edit permits a fresh authorized GUI pointer

- GIVEN the author closes a role Picker, resizes the chat canvas and finishes editing an existing body
- WHEN the old text selection is retired
- THEN the active surface MUST refresh exact current geometry without restoring that selection or moving focus from the new-message draft
- WHEN the author subsequently clicks a current authored body
- THEN Rust MUST authorize a fresh caret and typing MUST change only that body while preserving the unsent draft and GUI mode
- AND blocked GUI admission MUST NOT fall through to native source navigation
- AND a captured properties Sheet MUST keep its visible canvas scrollable but noneditable until the Sheet releases admission
- AND plain read-only Typst preview MUST retain its source-navigation behavior

#### Scenario: IME updates commit once

- GIVEN compositionstart captures selection and document version
- WHEN compositionupdate events and rerenders occur
- THEN updates MUST remain temporary HTML and request no WorkspaceEdit
- AND rerender MUST NOT rebuild the textarea、steal focus or reset composition
- WHEN compositionend occurs
- THEN it MUST produce one replace and one undo group, deduplicating the subsequent input event
- AND compositioncancel MUST leave source bytes unchanged

#### Scenario: Oversized composition blur preserves the full draft

- GIVEN an active composition exceeds the transport limit and blur makes cancel serialization fail
- WHEN the input bridge clears composition state
- THEN it MUST first preserve the complete unsubmitted local draft as copyable recovery content
- AND it MUST NOT truncate the draft、apply any part or change source bytes

#### Scenario: Clipboard permission fails

- GIVEN a valid selected range
- WHEN cut cannot write the Rust-returned plain text to the clipboard
- THEN it MUST NOT delete any source
- AND paste text containing `>`、`@` or quotes MUST always be treated as body text, not as MMT syntax

#### Scenario: Uncommitted input encounters failure

- GIVEN pending text or composition cannot be applied because of conflict、backend failure or invalid candidate
- WHEN authority is cancelled or the user closes/switches document
- THEN the UI MUST preserve copyable temporary recovery content and explain the reason through existing notification/Sheet
- AND closing/switching MUST first settle the queue or offer copy/discard
- AND it MUST NOT retarget、silently drop text or persist an IME draft as workspace data

### Requirement: Caret and selection geometry remain exact through reflow

Every body hit、caret and range SHALL be tied to current source URI/version/digest、render key and committed renderer session/generation. Text-only pointer hits SHALL carry required normalized-page `uncertainty:{x,y}` with exact keys and finite `[0,1]` components; missing、unknown、nonfinite or out-of-range precision SHALL fail closed. Character geometry SHALL use exact source/glyph correspondence, not navigation midpoints、average character widths or full-page duplicate-text searches. Ordinary non-text preview navigation point contracts SHALL remain unchanged.

#### Scenario: Geometry is characterized and qualified

- GIVEN live preview samples cover ASCII、CJK、emoji、combining text、proportional long lines、fenced multiline and repeated text
- WHEN click offsets、caret boundaries and range rectangles are measured including offset zero and body end
- THEN every hit MUST return the correct semantic offset
- AND caret error from the glyph advance boundary MUST be at most 1 CSS px
- AND range boxes MUST cover intended lines without covering adjacent unselected lines
- AND merely counting `.preview-cursor` elements MUST NOT qualify geometry

#### Scenario: Pointer precision remains conservative without moving the caret

- GIVEN actual screen and local PointerEvent Float32 precision map through the inverse SVG CTM to normalized page uncertainty
- WHEN text hit containment is evaluated
- THEN uncertainty MAY expand containment only
- AND the chosen exact stop edge、source、affinity、distance and nearest-stop ordering MUST remain unchanged
- AND every intersecting distinct-source cluster MUST still make the hit ambiguous and unavailable
- AND normalized coordinates MUST use `ceil(f32(native page extent))` for each page dimension

#### Scenario: DOM and existing queries fail qualification

- GIVEN actual characterization proves at least one required geometry result unavailable or outside tolerance
- WHEN the implementation branch is chosen
- THEN the Tinymist fork implementation pinned by the full `source.revision` MUST provide identity-bound `hitTestText`、`locateCaret` and `locateRange`
- AND the product MUST NOT substitute approximate carets or body forms
- AND if every required case qualifies without it, that renderer branch MUST NOT be introduced

#### Scenario: Rendering changes after selection

- GIVEN an authorized selection, rendered occurrence, direction, preferredX and viewport anchor
- WHEN new render artifacts、zoom、resize、SVG diff or full resync change layout
- THEN current snapshot selection MUST be queried again rather than reuse old normalized points
- AND duplicate text MUST NOT redirect selection to another statement
- AND unavailable correspondence MUST show blocked state with source entry
- AND input MUST reveal only an offscreen caret; user scrolling MUST cancel late automatic reveal

#### Scenario: Visual navigation and multipage selection are used

- GIVEN a long multiline body spans `.tsel` fragments or pages and may continue into another message
- WHEN the author uses Shift selection、double-click word selection、visual arrows/Home/End or edge-autoscroll dragging
- THEN movement and extension MUST use grapheme/word/visual-line geometry and retain direction
- AND vertical movement MUST preserve preferredX without editing through stale geometry

#### Scenario: Selected decorations follow continuous scrolling

- GIVEN a current authorized selection or selected semantic block
- WHEN the author scrolls or drags the native scrollbar in either direction
- THEN its visual decorations MUST move in the same scrolling coordinate system as the SVG throughout the interaction
- AND block-outline edges MUST remain within 1 CSS px of the target's configured outline bounds, not merely converge after scrolling stops
- AND viewport clipping and tile replacement MUST NOT retarget or clear the selection
- AND the textarea and IME input owner MUST remain stable when visual decorations are remounted

#### Scenario: Block selection suspends text admission without erasing its decoration

- GIVEN a semantic block was selected on the current displayed render
- WHEN the host suspends and retires the text-input session while authorizing that block
- THEN the block decoration MUST remain bound to that render and MUST be hidden while text admission is blocked
- AND it MUST reappear when the active input channel resumes on the same render, including after its session identity changes
- AND render retirement or a changed render identity MUST clear the decoration rather than reuse stale block geometry
- AND text intents MUST still obey the existing session revocation and source-authorization checks

#### Scenario: Viewport refills preserve readable selected content

- GIVEN the accepted render identity is unchanged and the materialized buffer covers the visible viewport
- WHEN the author continues scrolling inside that coverage
- THEN the runtime MUST reuse the rendered content instead of repeating the full SVG materialization pipeline
- AND native text selection and clipboard content MUST remain intact
- WHEN the viewport needs another buffer
- THEN the existing validated renderer path MUST refill it while keeping avatars readable and selection identity unchanged

### Requirement: Browser evidence covers actual SVG authoring and real IME limits

Acceptance SHALL exercise the actual Workbench SVG surface, same TextDocument and production preview path. Synthetic input events SHALL NOT be represented as OS IME qualification.

#### Scenario: Complete behavior proof is collected

- GIVEN the integrated production runtime
- WHEN authoring is qualified
- THEN evidence MUST include Unicode deletion、multiline/fence/empty/EOL bytes、forward/reverse cross-body edits、blank/barrier/inheritance cases、delayed input、stale identity and geometry after reflow
- AND MUST include GUI/source undo/redo、native Local History、save/reload、two-document overlay switching、PDF exact export and 320px/offline operation
- AND uncommitted composition MUST be absent from file and PDF export

#### Scenario: Real Chinese IME is qualified

- GIVEN real Chrome and an actual Chinese OS input method are available
- WHEN composition is entered, cancelled, committed and undone across rerender
- THEN manual verification MUST observe candidate-window anchoring、one commit、cancel without edits、one undo and uninterrupted composition
- AND automated start/update/end/cancel/duplicate-input tests MUST be reported separately
- AND unavailable OS IME or Chrome MUST be explicitly reported as unverified rather than replaced with synthetic proof

### Requirement: Context menus distinguish text selection from whole content

The GUI SHALL provide native Workbench contextual actions beside the current selection. Text-range actions SHALL operate on the authorized text selection; whole-content actions SHALL operate on one current projected node and its server capabilities.

#### Scenario: A text selection is right-clicked

- GIVEN a current authorized non-collapsed body selection
- WHEN the author opens its context menu
- THEN opening the menu MUST preserve the existing range and direction
- AND Copy、Cut、Paste、Delete、Select All and native history actions MUST use the existing text session rather than synthesize source edits
- AND any clipboard read/write failure MUST leave source unchanged for the affected operation
- AND document、selection or runtime drift MUST dismiss or reject a pending action

#### Scenario: A whole message or narration is selected

- GIVEN a current projected node with property and structure capabilities
- WHEN the author opens its contextual actions
- THEN direct text entry、local body/mode editing、speaker and applicable continued/display-name/avatar actions MUST remain reachable
- AND legal insert-before/after、move-up/down and whole-node deletion MUST use the current Rust boundary/node commands
- AND unavailable capabilities MUST NOT be inferred from nearby nodes or semantic SVG labels
- AND keyboard and touch users MUST have a visible contextual entry without requiring a right mouse button

#### Scenario: The author selects words or a complete body

- GIVEN supported body text is visible
- WHEN the author double-clicks or triple-clicks
- THEN double-click MUST select a semantic word and triple-click MUST select the complete current body
- AND neither interaction may select a neighboring statement solely because its text is identical

#### Scenario: A drag briefly leaves mapped text

- GIVEN a valid drag selection with current document and render authority
- WHEN a move sample falls in an unmapped visual margin and later returns to mapped text
- THEN the gesture and last authorized selection MUST survive the unmapped sample
- AND the unmapped sample MUST NOT become an editable endpoint
- AND a range crossing a non-blank opaque or mode barrier MUST remain rejected

### Requirement: Keyboard clipboard operations preserve selection order and browser permissions

Copy and Cut SHALL use host-authorized plain text under the current selection identity. A browser ClipboardEvent MAY receive an ephemeral exact-selection payload synchronously; it SHALL NOT become a second document or obtain text from the rendered SVG.

#### Scenario: Copy or Cut originates from a keyboard event

- GIVEN selected plain text has been authorized for the exact current session and selection
- WHEN a trusted browser clipboard event is handled
- THEN the implementation MUST write that exact plain text within the clipboard event or a valid user activation
- AND Cut MUST submit its semantic deletion only after successful clipboard admission
- AND stale or pending selection payloads MUST NOT be copied or used to authorize deletion

#### Scenario: Copy or Cut follows pending selection movement

- GIVEN earlier accepted movement or typing is still settling in the input queue
- WHEN the author requests Copy or Cut
- THEN the clipboard request MUST execute after that earlier work and authorize its resulting exact semantic selection
- AND the native clipboard service MUST report successful admission before Cut can delete that same selection
- AND permission failure MUST remain visible without deletion or retry
- AND external source、session or render conflicts MUST retire the request without copying an old payload or retargeting another selection

#### Scenario: A script dispatches a synthetic clipboard event

- GIVEN a current authorized selection
- WHEN an untrusted synthetic Copy or Cut event contains a writable DataTransfer
- THEN it MUST NOT acknowledge clipboard success or enqueue a native clipboard request
- AND source MUST remain unchanged because synthetic event data does not prove a system clipboard write

### Requirement: The bottom composer supports continuous dialogue writing

The GUI SHALL use a slim document/action header, the retained SVG canvas and a compact persistent bottom composer. The permanent property inspector SHALL be removed; existing-content actions SHALL use contextual entries and an explicitly entered/exited arrange mode.

GUI controls SHALL use a scoped Momotalk-style conversation-product skin: pastel header, circular role portraits, light surfaces and a rounded chat input with a recognizable send action. The role picker, contextual actions and local-editor container SHALL share that visual language. This presentation SHALL preserve the native Workbench topology and SHALL NOT change the global source-editor/settings theme.

#### Scenario: GUI chrome stays compact at narrow widths

- GIVEN the GUI owns the preview surface
- WHEN the viewport is narrow or a text session is temporarily paused
- THEN the preview MUST retain one compact zoom/fit row without duplicate format/export controls
- AND the document header MUST retain the canonical export action
- AND normal non-GUI preview controls MUST remain unchanged
- AND header actions MUST remain reachable within the actual available native pane width, not only the outer viewport width
- AND compact GUI entry/restoration MUST use native navigation visibility to keep the editor in the viewport while retaining native view toggles and the existing Workbench topology
- AND presentation mode MUST NOT grant editing permission

#### Scenario: Two consecutive messages are sent

- GIVEN a current Rust-authorized insertion boundary and a selected speaker
- WHEN the author sends a bottom draft twice
- THEN each accepted send MUST create exactly one ordinary Rust-projected statement
- AND the ordinary draft MUST be submitted as explicit literal `textRaw` so a document-level Typst mode cannot reinterpret chat text as code
- AND only the successfully applied draft text MUST clear
- AND selected speaker and actor-avatar context MUST remain available for the next message
- AND Enter MAY send while Shift+Enter inserts a draft newline, but an active IME composition MUST NOT send

#### Scenario: A saved fenced message ends at EOF without a final newline

- GIVEN a complete final statement and a reopened current document with no final line terminator
- WHEN the author sends the next bottom draft
- THEN Rust MUST authorize the legal EOF insertion and supply any required statement separator in the same atomic edit
- AND every pre-existing source byte and neighboring semantic value MUST remain unchanged
- AND the client MUST NOT append a newline or synthesize a boundary to enable Send

#### Scenario: Pack semantics change without a source edit

- GIVEN a restored GUI or an accepted snapshot created under an earlier Pack/catalog context
- WHEN initial Pack synchronization completes or the semantic catalog changes
- THEN the existing runtime owner MUST bind or refresh current Rust authority at the unchanged source version
- AND stale snapshot、selection and transient authorization MUST be revoked before further editing
- AND draft text and role context MUST survive without a source-version nudge or manual source edit

#### Scenario: A role is selected before sending

- GIVEN an available script or verified Pack speaker
- WHEN the author selects it
- THEN the presentation role tray MUST retain it in a stable position without changing source
- AND Teacher/Sensei MUST remain one-step reachable through the boundary's explicit builtin insertion capability, not a fabricated actor reference; when no builtin side is authorized it MUST be visibly unavailable rather than silently submit as another speaker
- AND the full role library MUST open on demand rather than occupy a permanent canvas sidebar

#### Scenario: Old content is edited while a new draft exists

- GIVEN an unsent bottom draft and current new-message role
- WHEN the author edits an existing SVG body、opens a context menu、changes properties or uses native undo/redo
- THEN the draft and new-message role MUST remain unchanged
- AND unsent draft bytes MUST NOT enter the TextDocument、projection、history、save or export
- AND rejected or stale sends MUST preserve recoverable draft text without optimistic canvas content

#### Scenario: A lifecycle transition would discard a draft

- GIVEN an unsent draft would be lost during close、document switch or reload
- WHEN that transition is requested
- THEN existing recovery or browser unload protection MUST prevent silent loss
- AND the URI-only editor serializer MUST NOT acquire draft text or a second persistence format

### Requirement: Local source editing stays beside the typeset content

An authorized local source editor SHALL use multiline Monaco editing, remain near the selected content and commit through Rust Composer. Enter SHALL insert a newline, Ctrl/Cmd+Enter SHALL explicitly submit, and Escape SHALL cancel without changing source.

#### Scenario: A local Monaco widget receives focus

- GIVEN the GUI owns a current SVG canvas and an unsent bottom draft
- WHEN a local body or source editor receives focus
- THEN the native Workbench main editor part MUST remain the canonical GUI document owner
- AND the SVG、renderer session and committed generation MUST remain unchanged until an authored edit is applied
- AND the bottom draft MUST remain intact
- AND explicit navigation to a real source editor tab MUST still change the active editor normally

#### Scenario: A multiline body is replaced or inserted

- GIVEN a current body or insertion capability
- WHEN authored text includes newlines、quotes、empty content or DSL-looking markers
- THEN Rust MUST choose reversible inline/fenced serialization and preserve the requested semantic body
- AND all unrelated bytes、line endings and neighboring inherited semantics MUST remain exact
- AND the client MUST NOT construct a fence or statement prefix

#### Scenario: Advanced node source is replaced

- GIVEN a current exact node reference and explicit replacement capability
- WHEN the author submits local source text
- THEN Rust MUST validate URI/version/digest、node kind/range and the complete candidate before returning one versioned WorkspaceEdit
- AND source outside the authorized node MUST remain exact
- AND an unterminated fence or block MUST NOT absorb a neighboring original node
- AND stale identity、invalid candidate or changed neighboring ownership MUST reject without partial mutation
