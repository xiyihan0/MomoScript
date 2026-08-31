## 0. Correct the implementation contract

- [ ] 0.1 Fix proposal/design/spec deltas to require native `SimpleEditorPane`/`SimpleEditorInput` registration and a URI-only serializer
- [ ] 0.2 Fix desktop source default、`max-width: 550px` page-lifetime first-open GUI default and 320px minimum product verification
- [ ] 0.3 Keep current comment-looking lines as diagnostic-preserving `recoverableError`; reserve `comment` for future parser support
- [ ] 0.4 Fix bounded Opaque wire、canonical source digest/node key framing、strict edit envelope and server-provided capability contracts
- [ ] 0.5 Run `openspec validate add-mobile-gui-surface --strict` before production implementation

## 1. Lossless Rust document projection

- [ ] 1.1 Define surface-independent `ComposerDocumentProjection` and Message/Narration/Opaque unions with UTF-8 ranges、snapshot-local keys and no AST/ActorId leakage
- [ ] 1.2 Scan physical lines and partition every nonempty source byte exactly once; preserve UTF-8 boundaries、whole CRLF/LF terminators、BOM and unterminated final lines
- [ ] 1.3 Keep each blank line separate; project directives、Reply/Bond、recoverable errors、comment-looking errors and unsupported gaps as explicit Opaque nodes
- [ ] 1.4 Share one statement product descriptor with Preview Composer; separate immutable product descriptions from server-authorized mutation capabilities
- [ ] 1.5 Compute canonical `mmt-composer-document-v1` digest and `mmt-composer-node-v1` snapshot-local keys
- [ ] 1.6 Prove ordered adjacency、`[0, len)` coverage、CRLF indivisibility and byte-exact concatenation for valid、recoverable and empty documents
- [ ] 1.7 Add fixtures for empty/no-final-EOL、LF/CRLF、Unicode/emoji、BOM、multiline statements、blank runs、directive blocks、Reply/Bond、unexpected `@end`、unknown syntax and comment-looking recoverable errors

## 2. Strict native/WASM projection contract

- [ ] 2.1 Add pure exact-key `mmt/composerDocument` bound to current open TextDocument URI/version and canonical source digest
- [ ] 2.2 Serialize strict Message/Narration/Opaque nodes、bounded Opaque previews、script actor choices and server-carried mutation boundaries/capabilities
- [ ] 2.3 Add TypeScript exact parser and current-TextDocument validator for digest parity、unique keys、reversible ranges、ordered adjacency and full coverage
- [ ] 2.4 Reject stale/unavailable documents and malformed result fields without preserving a partial card snapshot
- [ ] 2.5 Route native stdio and WASM through the same Rust request; add valid、empty、error、stale、unknown-key and native/WASM parity transcripts
- [ ] 2.6 Rebuild/promote vendored MMT LSP WASM only through the owning script

## 3. Rust structural Composer commands

- [ ] 3.1 Extend existing `mmt/composerEdit` with the strict shared target/command envelope and no aliases
- [ ] 3.2 Add `insertStatement` for exact partition boundaries、five body modes and Pack/script speakers with Rust-selected deterministic EOL
- [ ] 3.3 Add `deleteNode` for Message/Narration owned ranges only; never consume adjacent Opaque nodes
- [ ] 3.4 Add adjacent `moveNode` capabilities for continuous movable runs; reconcile homogeneous LF/CRLF and final-EOL state
- [ ] 3.5 Add `setStatementSpeaker` only for serializable Pack/script actors; keep Builtin messages speaker-read-only
- [ ] 3.6 Reproject current source and validate version、digest、node/boundary exact identity and capability for every command
- [ ] 3.7 Fully reanalyze candidates and prove exact allowed structural/semantic changes while preserving all Opaque and unrelated authored bytes
- [ ] 3.8 Return one current-version TextDocumentEdit/TextEdit without server apply、retry or retarget
- [ ] 3.9 Cover insertion boundaries/modes/speakers/EOL、delete barriers、move barriers/mixed-EOL/duplicates/inheritance、speaker failures、stale identity、unknown keys and exact `A\nB`/`A\r\nB`/final-EOL results

## 4. Surface-independent ComposerRuntime

- [ ] 4.1 Add pure runtime/controller consuming immutable snapshots、catalogs and narrow request/apply/navigation/preview/history/save/export ports
- [ ] 4.2 Bind only workspace `.mmt`/`.mmt.txt` TextDocuments and accept requests only for exact generation、incarnation、version and epoch
- [ ] 4.3 Clear snapshot/capability/transient operations on every document change; stale operations cancel rather than retry or retarget
- [ ] 4.4 Derive every card action from server capability and keep one-shot apply through the existing composer edit port
- [ ] 4.5 Reuse existing body/mode、continued、display-name、avatar controllers and notification mapping without serializer duplication
- [ ] 4.6 Keep Pack changes picker-only and cancel captured operations on Pack/document/runtime identity drift
- [ ] 4.7 Test latest-wins replacement、external edits、apply drift、one-shot apply、Pack change、barriers、errors and reverse disposal

## 5. Native Workbench editor and product wiring

- [ ] 5.1 Browser-characterize pinned 21.6.0 public native editor registration、`openWith`、single TextDocument/model、source switching and serializer reload
- [ ] 5.2 Register `mmt.guiComposer` using bound `SimpleEditorPane`/`SimpleEditorInput` classes before `api.start()` and the existing runtime controller
- [ ] 5.3 Register optional single-per-resource editors for `**/*.mmt` and `**/*.mmt.txt`; persist only versioned `{uri}` input state
- [ ] 5.4 Add `mmt.composer.open` to commands、Sidebar、palette and editor title; add explicit advanced-source navigation over the same TextDocument
- [ ] 5.5 Implement desktop source default and page-lifetime `max-width: 550px` first-open GUI admission without repeated forced switching
- [ ] 5.6 Implement strict workspace-scoped create/open、TextDocument save、history/checkpoint and current-source preview actions without new stores
- [ ] 5.7 Extract and reuse exact-snapshot export coordination and current PreviewWebviewHost behavior

## 6. Shared desktop and mobile GUI presentation

- [ ] 6.1 Render every snapshot node one-to-one as Message/Narration cards or visible read-only Opaque blocks
- [ ] 6.2 Render only capability-authorized insert/delete/up/down/speaker/property controls; preserve each visually compact blank identity/barrier
- [ ] 6.3 Merge server script actors with verified Gallery Pack choices; keep Builtin speakers out of the picker
- [ ] 6.4 Use desktop card list plus inspector/sheet and `ViewColumn.Beside` preview without a second controller
- [ ] 6.5 Use the same adapter at `max-width: 550px` with full-screen editors/pickers/sheets and current-column preview
- [ ] 6.6 At 320px enforce no horizontal page scroll、one GUI vertical scroll owner、44px targets、safe-area padding、`viewport-fit=cover` and visual-viewport keyboard reachability
- [ ] 6.7 Keep sheet background inert and unsent state bound to one captured operation until close or identity drift

## 7. Verification and delivery

- [ ] 7.1 Extend strict E2E bridge GUI state and instrumentation allowlists without production parser bypasses
- [ ] 7.2 Add native surface、desktop loop、lossless boundary、stale、551/550/320、preview scroll and offline GUI browser scenarios
- [ ] 7.3 Add Composer document/runtime scripts、CI contract jobs and production GUI E2E command
- [ ] 7.4 Update editor architecture/runbooks with editor id、command、ownership、550px rule and verification paths
- [ ] 7.5 Run ordered OpenSpec、Rust core/LSP、WASM vendor、TypeScript contract and production build checks
- [ ] 7.6 Browser-verify desktop、551px、550px and 320px actual Workbench surfaces including save/history/preview/export/reload/offline and exact source bytes