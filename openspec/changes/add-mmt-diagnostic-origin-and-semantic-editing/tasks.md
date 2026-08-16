## 1. Diagnostic origin mapping

- [x] 1.1 Add one `EmittedTypst` authored-parent convergence query covering every overlapping source-map chunk and point diagnostics
- [x] 1.2 Map diagnostics exact-first then coarse-parent; apply the same rule to related information and remove patch overlap exceptions
- [x] 1.3 Parent generated text wrappers to exact `TextBody` ranges without relaxing Identity-only projection edit APIs
- [x] 1.4 Return nullable per-item `mmt/mapTypstDiagnostics` results and strictly validate them in TypeScript

## 2. Fixed renderer diagnostics

- [x] 2.1 Convert compiler diagnostics with Tinymist's existing converter and emit stable URI-keyed records
- [x] 2.2 Add successful warning records and the identity-bound `compileFailed` response without generation advancement
- [x] 2.3 Strictly validate renderer diagnostic records and response discriminants for native/WASM parity
- [x] 2.4 Cover structured compile failure, successful warnings, and committed-generation recovery in process and Worker transcripts

## 3. Workbench diagnostic lifecycle

- [x] 3.1 Map synthetic renderer URIs back through immutable project URI identity and expose typed compilation failure
- [x] 3.2 Map entry diagnostics through current projection identity, preserve dependency/generated URIs, and reject stale batches
- [x] 3.3 Group preview Problems by actual target URI, preserve source ownership, shadow duplicate language diagnostics, and restore them on clear
- [x] 3.4 Preserve and mark the last preview stale on Layout failure; clear diagnostics and commit the next generation after repair

## 4. Semantic index

- [x] 4.1 Add actor/asset navigation keys, actor-name/asset rename keys, exact occurrence roles, and syntax classifications
- [x] 4.2 Record primary/alias/reopen/speaker/history/resource actor occurrences only after identity resolution
- [x] 4.3 Preserve script asset declaration ranges and resolved resource selector occurrences; keep Pack/builtin identities read-only
- [x] 4.4 Implement deterministic `symbol_at`, Definition target selection, References aggregation, and rename-binding aggregation

## 5. Native semantic LSP operations

- [x] 5.1 Implement Definition and References from immutable snapshot analysis with negotiated UTF-8/UTF-16 conversion
- [x] 5.2 Implement conservative Prepare Rename with exact editable-binding and error-free snapshot gates
- [x] 5.3 Serialize actor/asset candidates with existing parsers, reject collisions or non-round-trippable occurrences, and reanalyze atomically
- [x] 5.4 Return one current-version `TextDocumentEdit` and declare standard definition/references/prepare-rename capabilities in native and WASM transports

## 6. Single semantic provider routing

- [x] 6.1 Add read-only `mmt/semanticRoute` with native/projected/none token-zone and current-Identity rules
- [x] 6.2 Install one composed semantic middleware in Desktop, Web Extension Host, and standalone Workbench
- [x] 6.3 Extract a late-bound projected semantic dispatcher for read locations and validated projected rename
- [x] 6.4 Remove the competing MMT projected-rename registration while retaining projected formatting and code actions

## 7. Fixed artifacts

- [x] 7.1 Recapture the maintained renderer patch and update its pin digest
- [x] 7.2 Verify and build-promote native/WASM Tinymist artifacts
- [x] 7.3 Pass structured diagnostic, generation recovery, process/Worker parity, Desktop, and Web Extension Host transcripts
- [x] 7.4 Repin through the artifact script and verify updated vendored package, fixtures, sizes, and SHA-256 inventory

## 8. Verification and closure

- [x] 8.1 Validate this OpenSpec change strictly and preserve the independent preview-navigation decision gates
- [x] 8.2 Run complete `mmt_rs` and `mmt_lsp` suites including origin, semantic, UTF-8/UTF-16, stale, collision, and versioned-edit fixtures
- [x] 8.3 Run VS Code extension checks plus renderer protocol, position, projected read/edit, Worker, native process, Web Worker, Desktop, and Web host tests
- [x] 8.4 Run Workbench checks, preview diagnostic/session/artifact tests, preview interaction/smoke E2E, and browser semantic/Problems scenarios
- [x] 8.5 Mark `redesign-dsl-syntax-v2` task 6.4 complete only after implementation evidence passes; do not close preview-click fallback gates
