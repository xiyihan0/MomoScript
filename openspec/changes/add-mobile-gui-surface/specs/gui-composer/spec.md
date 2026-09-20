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

#### Scenario: Advanced content is encountered

- GIVEN content is Typst-mode、irreversible macro-generated text or an Opaque node
- WHEN the author selects its source affordance
- THEN the GUI MUST navigate to its current authored TextDocument range
- AND MUST NOT guess a body replacement range from rendered content
- AND every directive/error/unsupported projection node MUST remain discoverable even if it has no rendered glyph
- AND a comment-looking line MUST remain a diagnostic-preserving `recoverableError`, not a fabricated `comment`
- AND Opaque nodes MUST NOT expose direct property、delete or move commands

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