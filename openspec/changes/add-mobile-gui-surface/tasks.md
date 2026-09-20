## 0. Correct the implementation contract

- [x] 0.1 Fix proposal/design/spec deltas to require native `SimpleEditorPane`/`SimpleEditorInput` registration and a URI-only serializer
- [x] 0.2 Fix desktop source default、`max-width: 550px` page-lifetime first-open GUI default and 320px minimum product verification
- [x] 0.3 Keep current comment-looking lines as diagnostic-preserving `recoverableError`; reserve `comment` for future parser support
- [x] 0.4 Fix bounded Opaque wire、canonical source digest/node key framing、strict edit envelope and server-provided capability contracts
- [ ] 0.5 Re-run `openspec validate add-mobile-gui-surface --strict` for the SVG-first revision before production implementation
  - Note: Final strict validation passed, but its pre-implementation execution timing cannot be attested.
- [x] 0.6 Replace card-primary contracts in this existing change with SVG-first character/cross-body behavior、strict text APIs、parser serialization、shared overlay、IME/native history and exact acceptance; do not create a competing change
- [x] 0.7 Record the independent real-Chrome `WiMiWi` DOM caret errors (offset 5: 5.370695 CSS px; offset 1: 1.925096 CSS px) above the 1px limit and require the conditional renderer branch
- [x] 0.8 Complete live geometry characterization for ASCII/CJK/emoji/combining/proportional/long/fenced/repeated text、offset zero/end、click offsets、caret/range boxes and reflow; isolate worker-panic-contaminated queries and retain only valid evidence

## 1. Lossless Rust document projection

- [x] 1.1 Define surface-independent `ComposerDocumentProjection` and Message/Narration/Opaque unions with UTF-8 ranges、snapshot-local keys and no AST/ActorId leakage
- [x] 1.2 Scan physical lines and partition every nonempty source byte exactly once; preserve UTF-8 boundaries、whole CRLF/LF terminators、BOM and unterminated final lines
- [x] 1.3 Keep each blank line separate; project directives、Reply/Bond、recoverable errors、comment-looking errors and unsupported gaps as explicit Opaque nodes
- [x] 1.4 Share one statement product descriptor with Preview Composer; separate immutable product descriptions from server-authorized mutation capabilities
- [x] 1.5 Compute canonical `mmt-composer-document-v1` digest and `mmt-composer-node-v1` snapshot-local keys
- [x] 1.6 Prove ordered adjacency、`[0, len)` coverage、CRLF indivisibility and byte-exact concatenation for valid、recoverable and empty documents
- [x] 1.7 Add fixtures for empty/no-final-EOL、LF/CRLF、Unicode/emoji、BOM、multiline statements、blank runs、directive blocks、Reply/Bond、unexpected `@end`、unknown syntax and comment-looking recoverable errors

## 2. Strict native/WASM projection contract

- [x] 2.1 Add pure exact-key `mmt/composerDocument` bound to current open TextDocument URI/version and canonical source digest
- [x] 2.2 Serialize strict Message/Narration/Opaque nodes、bounded Opaque previews、script actor choices and server-carried mutation boundaries/capabilities
- [x] 2.3 Add TypeScript exact parser and current-TextDocument validator for digest parity、unique keys、reversible ranges、ordered adjacency and full coverage
- [x] 2.4 Reject stale/unavailable documents and malformed result fields without preserving a partial projection snapshot
- [x] 2.5 Route native stdio and WASM through the same Rust request; add valid、empty、error、stale、unknown-key and native/WASM parity transcripts
- [x] 2.6 Rebuild/promote vendored MMT LSP WASM only through the owning script

## 3. Rust structural Composer commands

- [x] 3.1 Extend existing `mmt/composerEdit` with the strict shared target/command envelope and no aliases
- [x] 3.2 Add `insertStatement` for exact partition boundaries、five body modes and Pack/script speakers with Rust-selected deterministic EOL
- [x] 3.3 Add `deleteNode` for Message/Narration owned ranges only; never consume adjacent Opaque nodes
- [x] 3.4 Add adjacent `moveNode` capabilities for continuous movable runs; reconcile homogeneous LF/CRLF and final-EOL state
- [x] 3.5 Add `setStatementSpeaker` only for serializable Pack/script actors; keep Builtin messages speaker-read-only
- [x] 3.6 Reproject current source and validate version、digest、node/boundary exact identity and capability for every command
- [x] 3.7 Fully reanalyze candidates and prove exact allowed structural/semantic changes while preserving all Opaque and unrelated authored bytes
- [x] 3.8 Return one current-version TextDocumentEdit/TextEdit without server apply、retry or retarget
- [x] 3.9 Cover insertion boundaries/modes/speakers/EOL、delete barriers、move barriers/mixed-EOL/duplicates/inheritance、speaker failures、stale identity、unknown keys and exact `A\nB`/`A\r\nB`/final-EOL results

## 4. Surface-independent ComposerRuntime

- [x] 4.1 Add pure runtime/controller consuming immutable snapshots、catalogs and narrow request/apply/navigation/preview/history/save/export ports
- [x] 4.2 Bind only workspace `.mmt`/`.mmt.txt` TextDocuments and accept requests only for exact generation、incarnation、version and epoch
- [x] 4.3 Distinguish expected own text edits from external changes: revoke old snapshot authority but preserve the own input bridge; cancel authorization/automatic pending apply on external edits、document switch or Pack drift
- [x] 4.4 Derive every semantic action from current capability; keep discrete one-shot apply and add ordered text-session admission rather than card state mutation
- [x] 4.5 Reuse discrete body/mode、continued、display-name、avatar controllers and rejection mapping while routing direct SVG body input through the new text command without serializer duplication
- [x] 4.6 Keep Pack refresh derived/picker-only; cancel captured operations and text authority on Pack/document/runtime drift, preserving uncommitted text for recovery
- [x] 4.7 Update runtime behavioral proof for own versus external changes、ordered input、apply drift、one-shot apply、Pack/barriers/errors、recovery and reverse disposal

## 5. Native Workbench editor and product wiring

- [x] 5.1 Browser-characterize pinned 21.6.0 public native editor registration、`openWith`、single TextDocument/model、source switching and serializer reload
- [x] 5.2 Register `mmt.guiComposer` using bound `SimpleEditorPane`/`SimpleEditorInput` classes before `api.start()` and the existing runtime controller
- [x] 5.3 Register optional single-per-resource editors for `**/*.mmt` and `**/*.mmt.txt`; persist only versioned `{uri}` input state
- [x] 5.4 Add `mmt.composer.open` to commands、Sidebar、palette and editor title; add explicit advanced-source navigation over the same TextDocument
- [x] 5.5 Implement desktop source default and page-lifetime `max-width: 550px` first-open GUI admission without repeated forced switching
- [x] 5.6 Implement strict workspace-scoped create/open、TextDocument save、history/checkpoint and current-source preview actions without new stores
- [x] 5.7 Refactor source/render/export binding into one `bindPreviewSource(document)` and migrate PreviewWebviewHost callers to the shared overlay/native preview claimant without replacing exact-export owners

## 6. Shared desktop and mobile GUI presentation

- [x] 6.1 Replace card-primary rendering/events/CSS with SVG placeholder、caret/selection/IME overlays、toolbar and explicit source entries; remove the card list, not hide it behind a mode switch
- [x] 6.2 Bind explicit insert/delete/up/down/speaker/property controls and SVG avatar/name/bubble/narration-label actions to capabilities; retain every compact blank identity and source affordance
- [x] 6.3 Merge server script actors with verified Gallery Pack choices; keep Builtin speakers out of the picker
- [x] 6.4 Mount one retained SVG overlay in the desktop GUI pane; source-side `mmt.previewHost` is only an alternate mount, while GUI preview focuses its current canvas
- [x] 6.5 Use the same SVG/input adapter at `max-width: 550px`, retaining full-screen Picker/Sheet accessibility and existing first-open default
- [x] 6.6 Requalify 320px without outer horizontal scroll、with one SVG canvas scroll owner、44px targets、safe-area/viewport-fit and visualViewport caret/keyboard reachability
- [x] 6.7 Preserve inert Sheet behavior and captured discrete operations while keeping text composition/input stable across rerender; failures offer copy/discard recovery

## 7. Verification and delivery

- [x] 7.1 Extend the strict existing E2E bridge for real SVG/semantic selection state and instrumentation without parser bypasses
- [x] 7.2 Replace card-driven GUI E2E with real SVG paths and cover exact geometry、native surface、lossless boundaries、stale handling、551/550/320 and offline authoring
- [x] 7.3 Update existing Composer document/edit/runtime and preview protocol/session behavioral scripts plus native/WASM transport contracts
- [x] 7.4 Update existing architecture/runbooks for shared overlay/native preview pane、text authority/history and SVG acceptance
- [x] 7.5 Run centralized OpenSpec、Rust core/LSP、MMT WASM vendor、TypeScript/worker contracts、runtime-delivery and production build verification after all concurrent edits land
- [x] 7.6 Browser-qualify desktop、551px、550px and 320px actual Workbench SVG surfaces including exact source bytes、save/history/reload/offline and canonical PDF export

## 8. Rust text selection and atomic body edits

- [x] 8.1 Use exported-symbol references before editing core APIs; add `composer_text.rs` without a second AST and extend existing composer/document/structure paths
- [x] 8.2 Add Rust-generated `textEditing: {text} | null` for uniquely addressable LF-normalized `textMacro`/`textRaw` Message/Narration bodies and strict UTF-16 node endpoints
- [x] 8.3 Convert UTF-16 → scalar → original UTF-8 per body; reject surrogate/grapheme interiors and enforce existing size limits using locked unicode-segmentation through Cargo dependency management
- [x] 8.4 Add pure `mmt/composerTextSelection` returning exact direction-preserving semantic selection and source-ordered plain copy text; empty entry uses a fresh node plus offset zero, not fake glyphs
- [x] 8.5 Extend existing `mmt/composerEdit` with `textSelection`/`replaceTextSelection` and `TextEdit` result; retain original property/structure `Edit` and `setStatementBody` contracts
- [x] 8.6 Implement same-node edits and cross-Message/Narration selection with LF-separated copy、first envelope prefix+replacement+suffix merge、subsequent selected statement deletion and byte-exact intervening blanks
- [x] 8.7 Reject non-blank opaque/different resolved mode spans without partial copy/edit; reject candidates changing unselected inherited semantics without automatic repair
- [x] 8.8 Reuse full candidate parse/analyze/PackRegistry/outside-target proof and one versioned TextDocumentEdit with non-overlapping edits; compute candidate digest and exact post-edit statementRange/collapsed offset in Rust
- [x] 8.9 Preserve legal empty statements with semantic label bounds/no sentinel; Enter/Shift+Enter insert body LF, collapsed boundary Backspace/Delete do not implicitly merge
- [x] 8.10 Extend existing core Composer document/edit/structure tests for actual Unicode/multiline/empty/cross-body outcomes、rejections and original-byte undo inputs, not field forwarding

## 9. Reversible fenced parser and exact text wire cutover

- [x] 9.1 Change `try_parse_fenced_body` to exact raw source slicing after body_start/body_end discovery; retain opening delimiter exclusion、leading/trailing blank lines、CRLF、empty range and unterminated recovery
- [x] 9.2 Build reversible raw/semantic EOL mapping without trimming body trailing LF; normalize incoming CRLF/CR to semantic LF
- [x] 9.3 Preserve safe existing inline text or serialize a fenced envelope with `N=max(3,longest quote run+1)`, standalone opener and original mode/inherit prefix
- [x] 9.4 Make `find_fence_close` scan a whole run and use its final N quotes; prove trailing 1/2/N−1 quotes、internal short runs、historical fences and recovery without adding body LF
- [x] 9.5 Put nonempty closer immediately after final body character and empty closer on opener's next line; keep adjacent six quotes as opener, not empty shorthand
- [x] 9.6 Use uniform body EOL → statement terminator → first document terminator → LF; preserve final-EOL state and unselected bytes, permit mixed-EOL display/copy but reject direct modification
- [x] 9.7 Update LSP service/server、stdio/WASM、browserWorker、composerDocument/Edit/Runtime exact-key validators and dispatch together for text request/command/result and encoding conversions
- [x] 9.8 Add strict transport/consumer cases for unknown keys/enums、stale digest/NodeRef/version、invalid UTF offsets、body limits and native/WASM parity; no aliases or browser-only command
- [x] 9.9 Rebuild/promote MMT LSP WASM through its owning script after core/wire agreement

## 10. Shared overlay and native preview mounting

- [x] 10.1 Create one `IOverlayWebview` in PreviewWebviewHost with retainContextWhenHidden、existing scripts/localResourceRoots/CSP and `setHtml/postMessage/onMessage(event.message)` transport
- [x] 10.2 Add attachSurface/releaseSurface/layoutSurface with claimant identity、claim/layoutWebviewOverElement/release and clippingContainer; old release cannot detach a new claimant
- [x] 10.3 Preserve publication ready/ACK/resync/committed session-generation and destroy the overlay only with product runtime disposal
- [x] 10.4 Add native `mmt.previewHost` as source-side read-only mount, not renderer/session/store owner; expose GUI canvas container from its mount handler
- [x] 10.5 Integrate `bindPreviewSource(document)` in GUI activation and source preview/export; migrate panel-only open/reveal/close、ViewColumn helpers and fixture/export callsites cleanly
- [x] 10.6 Use native active/visible editor events, one active document and focusable inactive placeholders; gate input against bound sourceUri so A's old SVG cannot edit B
- [x] 10.7 Re-layout on ResizeObserver、pane/window resize and Part visibility/layout with clipping; prove no overlay coverage of unrelated native parts
- [x] 10.8 Retain `{version:1,uri}` serializer、550px default、320px Sheet accessibility and existing reverse disposal graph; persist no selection/nodeKey/composition

## 11. Exact geometry and experimentally required renderer branch

- [x] 11.1 Add pure composerTextGeometry hitTest/caret/selection/move ports bound to URI/version/digest、renderKey、renderer session/generation and returning exact endpoints/page-normalized boxes/affinity
- [x] 11.2 Reuse `.tsel` normalization、glyph bounds、preview text location and source mapping solely for exact space/span correspondence; no full-page equal-text search、midpoint or average-width fallback
- [x] 11.3 Add strict pure `mmt/composerTextProjection` using existing PreviewComposerTarget identity fields minus location plus selection, returning anchor/focus/separate reversible segments through source-map origins and escaped-character boundaries
- [x] 11.4 Implement required renderer `hitTestText`/`locateCaret`/`locateRange` actions in existing `0002-mmt-preview-renderer.patch`, with committed identity echo、group transforms、glyph clusters/advances、escape offsets and multiple occurrences
- [x] 11.5 Reject ambiguous geometry and keep empty label-bound entry; support visual up/down preferredX、word/Home/End、cross-line/page drag and no adjacent-line rectangle spill
- [x] 11.6 Update renderer protocol/capabilities/session and native/WASM process/worker consumers together
- [x] 11.7 Extend capture to compute renderer patch pin, then run managed apply/verify/build-promote/repin with owning toolchain; no manual patch/artifact hashes or vendor edits
- [x] 11.8 Extend repin/publication prepare to compute decoded identity and consume encoded manifest digest/size/URL; publish only new immutable runtime digest when authorized credentials exist, not the site
- [x] 11.9 Make Workbench runtime-delivery verify and consume newly built artifacts rather than old CDN files; missing credentials remain an explicit delivery blocker
- [x] 11.10 Re-run the full live sample matrix after implementation: exact hits including offset zero/end、caret ≤1 CSS px、selection intended lines only、repeated text and zoom/reflow/resync correspondence

## 12. Ordered input session IME clipboard and native history

- [x] 12.1 Add ComposerRuntime-owned composerTextSession with authorized selection/sequence/pending intents/composition/geometry/bookmarks only, not persistent text
- [x] 12.2 Add strict identity/sequence/size-checked composer-intent and composer-state messages with approved pointer/move/replace/composition/history/copy variants and normalized geometry
- [x] 12.3 Add caret/selection overlays and stable near-caret textarea; pointer → mapping → Rust selection read grants authority; only drag points and render requests may coalesce
- [x] 12.4 Serialize every accepted replacement through apply → new snapshot/digest/exact statementRange → next intent, without old nodeKey reuse、overlap guessing or 300ms whole-field debounce
- [x] 12.5 Preserve input bridge on own expected edits; block stale pointer mapping and cancel authorization on external edit/document/Pack drift without consuming old pending authority
- [x] 12.6 Implement composition start/update/end/cancel with captured version/selection、temporary HTML only、one commit and duplicate-input suppression; rerenders never recreate textarea or steal composition focus
- [x] 12.7 Implement Rust plain-text copy/cut/paste; cut deletes only after clipboard success and DSL-looking paste remains body text
- [x] 12.8 Provide existing notification/Sheet recovery for uncommitted input after failures/conflicts; close/switch settles queue or offers copy/discard without persisting IME draft
- [x] 12.9 Add applyComposerTextEdit over the same IModelService model with strict Rust edit/URI/version/digest/model/canApply gate and pushEditOperations only; retain discrete workspace.applyEdit
- [x] 12.10 Implement continuous typing native groups and 750ms idle、navigation/pointer、newline、paste/cut、IME、structure/focus boundaries; IME and cross-body replacement each one group
- [x] 12.11 Pass native before/after source selections and restore GUI presentation through model alternativeVersionId bookmarks; no separate undo stack and external/discrete edits close text groups
- [x] 12.12 Re-query selection on every accepted render/zoom/resize/diff/full resync, retaining occurrence/direction/preferredX/viewport anchor; user scroll cancels late reveal
- [x] 12.13 Add Pointer Events drag/edge-scroll and mobile handles bound to host semantic selection, with visualViewport caret visibility and no cross-foreignObject browser selection dependency
- [x] 12.14 Quiesce input/drag/clipboard/Sheets in the original lifecycle and export only confirmed canonical revisions, excluding uncommitted composition

## 13. Required end-to-end SVG behavior proof

- [x] 13.1 Prove `A😀é中` insertion/deletion removes whole emoji/graphemes, never half surrogates, and supports body offset zero/end
- [x] 13.2 Prove Enter/Shift+Enter keep `first` plus `> @不是语法 """` in one exact semantic body; erase to empty and re-enter with no sentinel; assert LF/CRLF/leading/trailing blank/final-EOL bytes
- [x] 13.3 Prove forward/reverse first-offset-1 to second-offset-2 copy of `abc`/`def` is `bc\nde`, replacement `X` gives `aXf`, one undo restores original bytes and redo merges; cover different speakers、blanks and unaffected inherited semantics
- [x] 13.4 Prove directive/error/Typst/different-mode barriers、unknown keys、stale identities/wrong generation and surrogate/grapheme interiors fail without partial mutation/copy
- [x] 13.5 Prove delayed snapshot/compile fast input/newlines are ordered and lossless, own edits keep bridge open, external conflicts stop old authorization and expose recovery
- [ ] 13.6 Automate IME start/update/end/cancel and duplicate-input suppression; separately manually qualify real Chrome Chinese OS IME candidate anchor、one commit/cancel/undo and rerender continuity, explicitly reporting absence
  - Note: Real Chrome synthetic composition, duplicate-input suppression, and native undo passed; physical Chinese OS IME/candidate-window testing was unavailable and is not claimed.
- [x] 13.7 Prove real SVG multiline/multifragment/multipage selection and vertical navigation, caret error ≤1px, exact boxes, repeated-text isolation and zoom/reflow/full-resync remapping
- [x] 13.8 Prove GUI/source native undo/redo and Local History/save/reload/PDF export observe one model; GUI/source/two-document switches retain one renderer owner and clip overlay correctly
- [x] 13.9 Prove 320px/soft-keyboard caret and Picker/Sheet access、44px targets、offline cached-project editing/saving and export exclusion of uncommitted IME
  - Note: Keyboard evidence uses a shrunken viewport, not a real-device software keyboard.
- [x] 13.10 Finish all required implementation and centralized validation before delivery; report inaccessible real-IME/Chrome/publication prerequisites honestly, never call geometry-only or single-field work complete