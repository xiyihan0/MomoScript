## 0. Prerequisite closure and characterization

- [x] 0.1 Complete `add-mmt-lsp-vscode` tasks 10.1–10.7 and record their focused test evidence
  - Evidence: same-branch closure history `09096fd`–`952aff8`; exact 10.1–10.7 implementation/regression commit mapping, focused commands, and observed positive/negative normalized results are recorded under “Focused evidence for 10.1–10.7 (2026-07-17)” in [`add-mmt-lsp-vscode/tasks.md`](../add-mmt-lsp-vscode/tasks.md).
- [x] 0.2 Complete the `add-workspace-storage-history-sync` workspace backend and journaled atomic batch/preimage contract before runtime cutover or multi-document edits
  - Evidence: `npm run test:workspace-atomic-apply` verifies migration/history/quota contracts and restores every preimage when the second target commit fails; rollback failure leaves the durable journal blocked. `npm run test:origin-storage` verifies protected workspace/history inventory and shell/pack hard gates.
- [x] 0.3 Complete `add-pwa-offline-runtime` task 0.2 ownership handoff before production Web cutover; gate artifact identity、quiesce and persistent package cache separately on their owning PWA contracts
  - Evidence: `add-pwa-offline-runtime` 0.2/0.4 and `add-workspace-storage-history-sync` 3.5/3.6 are complete. Production Web uses one `OriginStorageCoordinator`, one `EditorRuntimeController`, and the same `PwaSafeRestartQuiesceAdapter`; `npm run test:origin-storage`, `npm run test:pwa-quiesce`, `npm run test:pwa-update`, and the production `npm run test:e2e:pwa-offline` cold-start smoke cover the handoff without creating a second runtime owner.
- [x] 0.4 Capture complete normalized `initialize` results from the pinned native Tinymist process artifact
- [x] 0.5 Capture complete normalized `initialize` results and dynamic registrations from the pinned browser Tinymist Worker artifact
  - Evidence: checked `tinymist-native-evidence.json` and `tinymist-web-evidence.json` contain the complete normalized initialize result, dynamic registrations, backend/version/position encoding, and verified patched artifact SHA-256 values `b96ce119…` and `c9ff9b1d…`. `npm run test:capability-manifest`, the native process transcript, and browser Worker transcript reject artifact drift.
- [x] 0.6 Capture native/Web package-callback message shape、cancellation and error transcripts; require artifact upgrade or maintained patch if logical host callbacks are unavailable
  - Evidence: the maintained native/Web patch adds the versioned `mmt/typstPackageRequest.v1` callback to pinned artifacts `b96ce119…`/`c9ff9b1d…`. Both checked evidence files contain Ready、Unavailable、Cancelled and error transcripts; `npm run test:typst-package`, `npm run test:tinymist-process`, and `npm run test:tinymist-worker` exercise the shared host service.
- [x] 0.7 Capture native/Web preview/location method、artifact digest and coordinate-version evidence
  - Evidence: both checked artifact transcripts explicitly record that no versioned backend location method or coordinate version is advertised. `tinymist-capability-manifest.json` therefore qualifies only the retained `immutable-location-map` fallback; preview artifacts bind its digest and `typst-page-points-v1` coordinate version through `LocationProviderKey`. `npm run test:preview-artifact` and `npm run test:preview-interaction` pass.
- [x] 0.8 Generate checked capability manifests containing artifact digest, backend version, position encoding, provider options and experimental methods
  - Evidence: `cd editors/vscode && npm run test:capability-manifest` checks `src/test/fixtures/tinymist-capability-manifest.json`, including native checksum reference `tinymist-native-patched.sha256`, Web `SHA256SUMS`, SHA-256 values `b96ce119…`/`c9ff9b1d…`, backend `0.15.2`, and UTF-16.
- [x] 0.9 Diff native/Web manifests and classify every provider as core-required, host-optional, deferred or unavailable
  - Evidence: the deterministic manifest classifies converged baseline and seven P0 transcript-qualified providers as `core-required`, rich independently qualified providers as `host-optional`, the unsafe command-only code-lens provider as `unavailable`, package callback as `core-required`, and preview location as `host-optional` with immutable-map fallback.
- [x] 0.10 Remove any capability claim not supported by an explicitly enumerated provider and successful positive/negative method transcripts
  - Evidence: the generator rejects stale manifests and asserts no P0 provider is `core-required` without compatible advertisement plus shared positive/negative evidence. The maintained patch and checked transcripts leave `patchRequired: false`; unsafe code lens and unversioned backend preview location remain unclaimed.
- [x] 0.11 Inventory current runtime maps, listeners, timers, queues, AbortControllers, Workers, processes and dispose ownership
  - Evidence: `npm run test:runtime-inventory` machine-checks `src/test/fixtures/runtime-inventory.json`, including 13 long-lived `main.ts` collections, 21 listener groups, 3 timer classes, 8 Worker/process owners and 20 duplicated Worker/process client state fields.
- [x] 0.12 Add behavior-preserving Worker/process project lifecycle fixtures before extraction
  - Evidence: `npm run test:project-lifecycle` compares both production clients against `src/test/fixtures/project-lifecycle-baseline.json` for full/delta materialization, duplicate/unknown/retired rejection, prime, close, latest-complete restart replay and old-generation request rejection.
- [x] 0.13 Add current standalone and embedded baseline transcripts for diagnostics, completion, hover, signature help and semantic tokens
  - Evidence: `npm run test:typst-baseline` executes current middleware/diagnostic routes and compares normalized output with `src/test/fixtures/typst-language-baseline.json`; semantic-token ownership is checked as standalone Tinymist-direct and embedded MMT-native.
- [x] 0.14 Record the accepted Tinymist artifact upgrade/patch decision if a desired core provider、package callback or location contract is missing
  - Evidence: `npm run test:artifact-decision` checks `tinymist-artifact-decision.json`: retain the pinned `0.15.2` artifacts for qualified baseline work, keep seven unqualified P0 providers and package resolution disabled until a maintained native/Web patch plus positive/negative transcripts exists, and use only retained `immutable-location-map` data while the versioned location contract is absent.

## 1. Snapshot identity and position domains

- [x] 1.1 Define shared protocol types for `LogicalSourceId`, `SourceContentKey`, local-only `SourceStaleToken`, `TypstProjectSnapshotKey`, `ProjectionKey`, `MaterializationKey`, `RuntimeArtifactKey` and `RenderKey`
  - Evidence: `cargo test --manifest-path mmt_rs/Cargo.toml --test runtime_identity` and `cd editors/vscode && npm run test:runtime-identity` exercise the shared Rust/TypeScript typed constructors and identical pinned digests.
- [x] 1.2 Prove canonical derived keys transitively exclude host URI、document-incarnation nonce and editor-local version; retain all three only in request publish/apply guards and retire the nonce on close
  - Evidence: `cargo test --manifest-path mmt_rs/Cargo.toml --test runtime_identity`, `cd editors/vscode && npm run test:response-identity` and `npm run test:typst-baseline` prove canonical constructors never accept host-local values, equal canonical keys survive local version/incarnation changes, close/reopen issues a non-reused incarnation, and old local/backend generations cannot publish.
- [x] 1.3 Define canonical length-delimited SHA-256 serialization independent of map/filesystem order and platform separators
  - Evidence: Rust identity unit tests cover reversed map order and invalid separators; the shared Node/Rust fixture matches byte-for-byte SHA-256 outputs.
- [x] 1.4 Add complete workspace-file, package-generation, generated-dependency and project-option digests to every Typst project snapshot
  - Evidence: `ProjectDigestInput` and production MMT/standalone Typst builders populate all four domains; focused Rust backend tests pass.
- [x] 1.5 Define structured `LogicalProjectFileId` variants for workspace、package and generated files; canonical project serialization MUST reject presentation/backend URIs as digest inputs
  - Evidence: both implementations serialize the same structured variants, and reject `file:`, `mmtfs:`, absolute, traversal and backslash inputs.
- [x] 1.6 Add byte-for-byte parity fixtures for identical logical projects mounted as Desktop `file:`、Web `mmtfs:` and backend-internal URIs
  - Evidence: `mmt_rs/tests/fixtures/runtime-identity.json` is consumed by both focused commands and covers all three mount schemes plus Chinese/combining/astral content.
- [x] 1.7 Add project and mapping digests to `mmt/getTypstProject` responses
  - Evidence: `TypstProjectUpdate` carries `projectDigest`/`mappingDigest`; `cargo test --manifest-path mmt_lsp/Cargo.toml typst_backend::tests` verifies response construction without changing URI/file payloads.
- [x] 1.8 Add pack registry, resource plan and materialized byte digests to render-project results
  - Evidence: pack manifest JSON is canonicalized and snapshot-bound in Rust, render plans exclude presentation URIs, and Web materialization replaces the empty pre-materialization digest with the actual ordered bytes digest; Rust backend tests and Web `npm run check` pass.
- [x] 1.9 Generate runtime artifact keys from compiler, renderer, template bundle and bundled font-set versions/digests
  - Evidence: the shared fixture proves compiler/renderer versions plus both artifact, template and font digests compose the same `RuntimeArtifactKey` and transitive `RenderKey` in Rust/TypeScript.
- [x] 1.10 Introduce typed MMT-client, UTF-8-byte and Tinymist-backend position domains in Rust and TypeScript boundaries
- [x] 1.11 Convert projected requests through current source and projected `LineIndex` instances rather than passing plain positions
- [x] 1.12 Convert responses against the exact retained virtual file and complete Typst project generation used by the request
  - Evidence: `cargo test --manifest-path mmt_lsp/Cargo.toml`, `cd editors/vscode && npm run test:position-domains`, `npm run test:response-identity` and `npm run test:typst-baseline` bind response mapping to exact retained entry/revision plus `SourceContentKey`、`TypstProjectSnapshotKey`、`ProjectionKey` and backend generation; absent/mismatched/stale identities reject atomically before conversion/publication, including unchanged-document dependency advances.
- [x] 1.13 Reject invalid boundaries, absent generations, stale projects/projections and encoding ambiguity without clamping
- [x] 1.14 Add Chinese, combining mark and astral Unicode round-trip fixtures for every position-bearing protocol family
  - Position evidence: `cargo test --manifest-path mmt_lsp/Cargo.toml`, `npm run test:position-domains`, the focused `tsc` boundary check and `npm run test:typst-baseline` validate typed mixed-encoding conversion, exact retained `entryUri`/revision/project identity lookup, atomic stale/mismatch/ambiguity rejection, invalid completion edits、hover/diagnostic ranges、symbol selections and semantic-token boundaries without clamping, and unchanged diagnostics/completion/hover/signature-help/semantic-token characterization.
- [x] 1.15 Add canonical logical-identity/digest fixtures shared by Rust and TypeScript and prove `file:`/`mmtfs:` parity
  - Evidence: `cargo test --manifest-path mmt_rs/Cargo.toml --test runtime_identity` and `cd editors/vscode && npm run test:runtime-identity` consume the shared canonical identity fixture and match every digest across `file:`/`mmtfs:`/internal mounts; Rust and TypeScript also consume `mmt_lsp/tests/fixtures/position-domains.json` byte-for-byte for Chinese、combining-mark and astral boundary parity.

## 2. Shared runtime and project state

- [x] 2.1 Introduce `TinymistTransport` with Worker and process implementations limited to JSON-RPC transport lifecycle
- [x] 2.2 Extract open/applied/retained project file state from both Tinymist clients into shared `TypstProjectState`
- [x] 2.3 Extract accepted session/revision and retired-session rules into shared state
- [x] 2.4 Extract project prime debounce, in-flight tokens and close-grace scheduling into shared state
- [x] 2.5 Implement per-source full/delta/retire state transitions and invariant errors
- [x] 2.6 Implement backend generation tracking and reject responses from stopped/restarted generations
- [x] 2.7 Materialize latest accepted full+deltas into one complete newest-revision project and replay only that representation after Worker/process restart
- [x] 2.8 Implement bounded request, prime, close and replay queues with cancellation
  - Evidence: `cd editors/vscode && npm run check && npm run test:typst-project-state && npm run test:runtime-characterization` validates shared Worker/process transport and project-state ownership, monotonic backend generation rejection, bounded cancellation, newest-complete replay, unchanged lifecycle transitions and unchanged diagnostics/completion/hover/signature-help/semantic-token characterization.
- [x] 2.9 Introduce `EditorRuntimeController` with serialized startup, reverse-order rollback, ready, quiesce and dispose states
- [x] 2.10 Move production Web document/project/preview/materialization subscriptions under the controller
- [x] 2.11 Replace related `main.ts` maps with coordinator-owned typed stores
- [x] 2.12 Implement graceful dispose deadline and synchronous terminate fallback for unload/HMR
  - Evidence: production `editors/vscode-web/src/runtimeController.ts` is the single `RuntimeOwner` composition root; `main.ts` registers document/project/preview/materialization subscriptions through `controller.subscribe`, consumes controller-owned typed stores, registers both language Worker terminators during startup and routes HMR/unload through the same controller. `cd editors/vscode-web && npm run check && npm run test:runtime-controller && npm run test:runtime-owner && npm run test:e2e:lifecycle` passes, covering serialized startup, reverse rollback/dispose, rejected quiesce recovery, deadline termination, synchronous unload termination and real Vite HMR/beforeunload Worker closure.
- [x] 2.13 Connect PWA safe-restart quiesce only after the owning PWA contract is complete, without defining a second lifecycle
  - Evidence: production `main.ts` publishes the narrow `PwaSafeRestartQuiesceAdapter` port backed by the same `EditorRuntimeController`; work admission, durable persistence, materialization abort/drain and final runtime quiesce remain one lifecycle, and no Service Worker activation/reload is introduced. `cd editors/vscode-web && npm run test:pwa-quiesce && npm run test:runtime-owner && npm run check` passes.
- [x] 2.14 Prove native process, browser Worker, Desktop Host and Web Host retain baseline behavior after cutover
  - Evidence: `cd editors/vscode && npm run check && npm run test:runtime-characterization && npm run test:worker`, `TINYMIST_WEB_PKG="$PWD/vendor/tinymist-0.15.2" npm run test:tinymist-worker`, and `TINYMIST_BIN=/home/xiyihan/MomoScript-worktrees/artifacts/tinymist-3d63da4f/target/release/tinymist npm run test:tinymist-process` pass on the integrated cutover. The W1-Z slice at `35579c2` ran the same fixed-binary `npm run test:desktop` under VS Code 1.129.0; it ended with `[mmt-web-test] complete` and exit code 0 (`artifact://4137`). The subsequent integrated `languageEditing.ts` compatibility fix was exercised by a real Web Extension Host run on port 3100 with pinned `vendor/tinymist-0.15.2`; that run activated the extension and Tinymist Worker, exercised resource-marker editing, diagnostics, symbols, folding, MMT and projected Typst completion/hover/signature help, diagnostic recovery, statement patch completion, overlay routing and template façade hover, then reported `[mmt-web-test] complete`. A later attempt to redownload Desktop VS Code for final integrated HEAD verification was blocked by repeated `ECONNRESET`, so the Desktop claim is intentionally limited to the W1-Z cutover slice.
- [x] 2.15 Delete duplicated project lifecycle state from Worker/process clients
  - Evidence: `TinymistHostSession` is the sole owner of notification handlers、readiness、terminal stop and serialized recovery; Worker/process clients retain their public APIs and only adapt host-specific boot/initialize details. `cd editors/vscode && npm run check && npm run test:runtime-inventory && npm run test:project-lifecycle && npm run test:typst-project-state` passes with `duplicatedClientState: 0`, one recovery generation/event pair, latest-complete replay, idempotent disposal and post-stop rejection.

## 3. Generic Typst feature router

- [x] 3.1 Introduce runtime capability registry from initialize results and dynamic registrations
  - Evidence: `TinymistHostSession` installs the active generation's normalized `TinymistCapabilityRegistry` from the native/Web initialize result, routes typed `client/registerCapability` and `client/unregisterCapability` requests through `TinymistServerRequestDispatcher`, clears registrations on generation end/recovery and preserves `-32601` for unknown server requests. `cd editors/vscode && npm run test:capability-router && npm run test:capability-manifest` passes against the checked native/Web transcripts, including Web-only dynamic semantic-token registration, differing execute-command options, unregister and stale-generation cases.
- [x] 3.2 Implement generic request metadata containing backend generation, logical source/content identity, local document-incarnation/version stale token, complete Typst project snapshot, projection key and request sequence
  - Evidence: `tinymistRequestDispatcher.ts` defines a typed request map/envelope and assigns strictly monotonic local sequences while carrying every required canonical and host-local publication guard. `cd editors/vscode && npm run check && npm run test:capability-router` passes, including in-flight cancellation, same-scope supersession and independent-method sequencing.
- [x] 3.3 Reject every standalone/projected response when its complete project graph changes, even if the requesting document version is unchanged
  - Evidence: `TinymistRequestDispatcher` performs preflight and post-response equality checks for backend generation, logical/source content identity, incarnation/version token, complete `TypstProjectSnapshotKey` and optional `ProjectionKey`; the focused fixture advances only the project snapshot while keeping the requesting document token unchanged and receives `StaleProjectSnapshot`. `cd editors/vscode && npm run test:capability-router && npm run test:response-identity` passes.
- [x] 3.4 Implement standalone Typst routing with explicit backend position conversion
  - Evidence: `TypstFeatureRouter` converts retained UTF-16 editor positions through `LineIndex` into the active backend encoding before typed dispatch. `cd editors/vscode && npm run test:capability-router && npm run test:position-domains` passes, including Chinese-plus-astral UTF-16 character 3 → UTF-8 byte 7 and invalid-boundary rejection.
- [x] 3.5 Implement MMT-first routing and current projected-position lookup
  - Evidence: middleware returns definitive MMT completion/hover/signature and semantic-token results without a Tinymist request; otherwise the router resolves `mmt/typstPosition`, requires the exact retained project/projection, and rechecks signature routing before publication. `cd editors/vscode && npm run test:capability-router && npm run test:typst-baseline && npm run test:response-identity` passes with projected UTF-8 position 5, MMT precedence, close/reopen、backend-generation and graph-change rejection.
- [x] 3.6 Migrate completion, hover and signature help to the router without changing results
  - Evidence: `typstFeatures.ts` now delegates all three standalone/projected fallback families to `TypstFeatureRouter`; `cd editors/vscode && npm run test:typst-baseline` matches the checked `typst-language-baseline.json` byte-for-byte while `npm run test:capability-router` covers typed dispatch and sequence/cancellation guards.
- [x] 3.7 Migrate Typst diagnostics and semantic tokens to shared request/revision handling
  - Evidence: push diagnostics use the router's retained revision/project/projection publication guard and mapping path; standalone semantic tokens use the same capability gate、dispatcher and retained index while MMT semantic tokens remain native. `cd editors/vscode && npm run test:typst-baseline && npm run test:response-identity` passes; `TINYMIST_WEB_PKG="$PWD/vendor/tinymist-0.15.2" npm run test:tinymist-worker` and `TINYMIST_BIN=/home/xiyihan/MomoScript-worktrees/artifacts/tinymist-3d63da4f/target/release/tinymist npm run test:tinymist-process` exercise the real Worker/process interfaces.
- [x] 3.8 Preserve completion item defaults, resolve data and trigger/retrigger characters from negotiated capabilities
  - Evidence: projected completion reconstructs the original `CompletionList` around mapped items, preserving `itemDefaults`, `isIncomplete` and item `data`; registration metadata merges initialize/dynamic trigger and retrigger characters and resolve support. `cd editors/vscode && npm run test:capability-router` observes preserved `{ commitCharacters: ["."] }`, resolve data and synthetic negotiated trigger/retrigger options.
- [x] 3.9 Expose user-visible unavailable state instead of registering commands/providers that always fail
  - Evidence: absent active-generation methods are excluded from `registrations()`, return typed `CapabilityUnavailable` state and emit one generation/method-scoped VS Code status message. `cd editors/vscode && npm run test:capability-router` proves hover is omitted and the visible unavailable callback fires exactly once.
- [x] 3.10 Add provider-registration tests for native/Web capability differences
  - Evidence: `cd editors/vscode && npm run test:capability-router && npm run test:capability-manifest` consumes checked native/Web initialize plus dynamic-registration evidence, verifies the qualified baseline registration set and negotiated completion triggers, and retains Web dynamic semantic-token registration/unregister behavior. `npm run check`, `npm run test:worker`, `TINYMIST_WEB_PKG="$PWD/vendor/tinymist-0.15.2" npm run test:tinymist-worker` and `TINYMIST_BIN=/home/xiyihan/MomoScript-worktrees/artifacts/tinymist-3d63da4f/target/release/tinymist npm run test:tinymist-process` pass.

## 4. Qualified standalone Typst authoring features

Every item in this section is enabled only if the active artifact advertises the provider. P0 items require native/Web convergence before completion.

- [x] 4.1 Implement standalone go-to-definition and link navigation
- [x] 4.2 Implement standalone references with cancellation and partial-result handling
- [x] 4.3 Implement standalone prepare-rename and versioned rename workspace edits
- [x] 4.4 Implement standalone full and range formatting and configure format-on-save only after a successful transcript
  - Evidence: `TypstRichProviderRegistrations` registers rename、prepare-rename、full formatting and range formatting only for active qualified artifacts and writable standalone documents, then validates versioned edits against the exact retained snapshot. Native and Worker artifact probes both return a prepare result, versioned rename edit, one full-format edit, and one range-format edit; `node scripts/test-rich-providers.mjs` covers stale、read-only、unsafe and dynamic-unregister rejection.
- [x] 4.5 Implement standalone Typst document symbols
- [x] 4.6 Implement type-definition and implementation routes when advertised
- [x] 4.7 Implement workspace symbols and optional symbol resolve when advertised
- [x] 4.8 Implement document highlights when advertised
  - Evidence: `TypstNavigationProviders` installs only active, fixed-artifact-qualified standalone providers and routes through `TypstFeatureRouter.standaloneProvider`, whose request identity, retained-file position conversion and final generation/capability guard reject cancellation, stale graph, restart and unregister races. `node scripts/test-navigation-providers.mjs` covers dynamic absent/unregister, UTF-8↔UTF-16 conversion, multi-location references and nested document symbols; `TINYMIST_BIN=/home/xiyihan/MomoScript-worktrees/artifacts/tinymist-3d63da4f-w2-b0/target/release/tinymist TINYMIST_WEB_PKG="$PWD/vendor/tinymist-0.15.2" node scripts/test-navigation-artifacts.mjs` proves definition, references, hierarchical document symbols, workspace symbols and document highlights on both pinned artifacts while type-definition/implementation remain unavailable and unregistered.
- [x] 4.9 Implement selection ranges when advertised
- [x] 4.10 Implement document links and link resolve when advertised
  - Evidence: `RichTypstProviderRegistrations` registers the qualified standalone link family for native/Web and exposes resolve only when the negotiated `resolveProvider` option is active. Every item and resolved item passes `validateTypstProviderItemPayload`; unsafe external/host targets are stripped only when the range remains meaningful, stale or unauthenticated resolve data is rejected. The pinned native/Worker probe returns one safe path link on each host; `node ./scripts/test-rich-providers.mjs`, `npm run test:provider-payload-negative` and `npm run test:provider-descriptors` pass.
- [x] 4.11 Implement document colors and color presentations when advertised
  - Evidence: the rich family registers document-color and color-presentation together from the negotiated `colorProvider`, converts exact retained positions, and atomically rejects overlapping、readonly、cross-target or stale edits through the shared validator. Pinned native and Worker artifacts each return one color and ten presentations; `node ./scripts/test-rich-provider-artifact.mjs native|worker` is pinned by `tinymist-rich-provider-qualification.json`.
- [x] 4.12 Implement code actions and resolve when advertised
  - Evidence: code-action kinds and optional resolve are derived from active capability options; command-bearing and edit-bearing actions pass recursive atomic validation before conversion and publication, and resolve preserves authenticated metadata while rejecting generation/revision drift. Pinned native/Worker probes each return three actions; `node ./scripts/test-rich-providers.mjs` covers unsafe atomic rejection、cancellation and restart-before-resolve.
- [x] 4.13 Implement inlay hints and resolve when advertised
  - Evidence: native and Worker pinned artifacts each return two parameter hints for the checked `#let f(x, y)…/#f(1, 2)` fixture. The provider and optional resolve lifecycle are capability-derived; nested commands、text edits and locations pass recursive atomic validation before publication, and authenticated resolve metadata rejects generation/revision drift. `node ./scripts/test-rich-providers.mjs` proves unsafe optional-command stripping and safe resolve.
- [x] 4.14 Implement code lenses and resolve when advertised; keep disabled if artifacts do not qualify
  - Evidence: both fixed artifacts advertise `resolveProvider=false` and return an unresolved `tinymist.exportPdf` host-I/O command. Fixed qualification is therefore `unavailable`; the installer publishes no code-lens provider. `npm run test:provider-payload-negative` rejects effectful command-only lenses and `node ./scripts/test-rich-providers.mjs` proves zero registration.
- [x] 4.15 Route edits、commands and URIs carried by color presentations, inlay hints, code lenses and document links through the same snapshot、target and allowlist validator
  - Evidence: `validateTypstProviderItemPayload` recursively collects method-specific color、hint、lens、link and code-action payloads, including versioned `WorkspaceEdit.documentChanges` and resolve metadata, before one atomic W3-0 snapshot/target/allowlist validation; resource operations、unversioned or cross-identity edits and host/network/clipboard/shell effects are rejected. `cd editors/vscode && npm run check && npm run test:provider-payload-negative` passes.
- [x] 4.16 Strip an unsafe optional field only when the protocol proves the remaining item semantically complete; otherwise reject the item
  - Evidence: validated results expose immutable `strippedFields` entries with field paths and explicit reasons; document-link targets、inlay-hint commands/locations/text edits、unresolved code-lens commands and code-action commands are stripped only under their protocol-specific meaningful-remainder rule, while color edits、command-only actions/lenses and mixed unsafe atomic edits reject the item. The focused negative fixture asserts both sanitized values and reasons.
- [x] 4.17 Add negative transcripts for unsafe color edits、inlay-hint commands、code-lens commands and stale link targets
  - Evidence: `npm run test:provider-payload-negative` covers stale/read-only/overlapping color edits, unsafe hint text edits/commands/host locations, unsafe and command-only lenses, network/host-path/stale links, code-action diagnostics/commands/resource operations/mixed transactions, unauthenticated resolve data and resolve-after-restart for link、hint、lens and action methods. `npm run test:provider-descriptors`, `npm run test:runtime-identity`, `npm run test:response-identity` and `npm run test:position-domains` also pass without qualifying or registering a provider.
- [x] 4.18 Add one native process and one browser Worker transcript per enabled provider
  - Evidence: `typst-navigation-evidence.json` and `tinymist-rich-provider-qualification.json` are digest-pinned native/Worker transcript matrices. Fresh runs of `test-navigation-artifacts.mjs` and `test-rich-provider-artifact.mjs native|worker` reproduce every enabled navigation/rich provider result and retain type-definition、implementation and code-lens as explicitly unavailable.

## 5. Projected read features

- [x] 5.1 Add Rust mapping result kinds for authored MMT, workspace Typst, package file, generated projection and stale/unknown locations
  - Evidence: `ProjectionMappingKind` is the single Rust classification truth source; `ProjectionIndex::classify_read` and the exact Identity-only forward range mapper reject cross-segment/ambiguous input. `cargo test --manifest-path mmt_rs/Cargo.toml projection::tests` passes.
- [x] 5.2 Add read-only URI content providers for retained virtual projection and package generations
  - Evidence: `RetainedVirtualDocumentStore` plus `ProjectionTextDocumentContentProvider`/`PackageTextDocumentContentProvider` retain immutable bytes behind `mmt-projection:`/`mmt-package:` only; `node scripts/test-projected-reads.mjs` proves registration, immutable collision rejection, current-plus-two projection retention and eviction.
- [x] 5.3 Map definition targets to authored MMT Identity ranges or explicit read-only virtual files
  - Evidence: `mmt/mapTypstReadLocations` maps exact Identity locations to authored MMT and generated navigation to `mmt-projection:`; the focused server and TypeScript fixtures pass.
- [x] 5.4 Map references item by item only where method semantics permit partial safe results
  - Evidence: `mapNavigationLocations("references", ...)` retains safe items, counts omitted stale items and returns explicit `StaleUnknown` when every item is unsafe; `node scripts/test-projected-reads.mjs` passes.
- [x] 5.5 Map type-definition and implementation locations when the provider is qualified
  - Evidence: the shared navigation mapper returns `CapabilityUnavailable` for unqualified type-definition/implementation and uses the same exact location classification after qualification; the focused TypeScript fixture passes.
- [x] 5.6 Map document highlights conservatively and discard stale/unsafe ranges
  - Evidence: `mapDocumentHighlights` accepts authored Identity ranges in the requested MMT URI only and omits generated/stale/cross-document results; the focused TypeScript fixture passes.
- [x] 5.7 Map nested selection ranges until the first unsafe ancestor
  - Evidence: `mapSelectionRanges` rebuilds inner-to-outer authored chains and truncates at the first generated/stale/cross-document ancestor; `mmt/typstRange` provides exact forward Identity ranges without endpoint guessing. Focused Rust/RPC/TypeScript fixtures pass.
- [x] 5.8 Map document links, colors, hints and lenses only under method-specific safe rules, validating every nested edit、command and URI payload
  - Evidence: `mapProjectedProviderPayloadItems` batches every top-level/nested location through `parseProjectedReadLocations`, admits only current authored Identity or explicitly visible retained/workspace read-only targets, then atomically composes the mapped item with `validateTypstProviderItemPayload`. `npm run test:projected-payload` covers links、document colors、color presentations、inlay hints and code lenses plus optional stripping reasons、mixed edit rejection、Synthetic/Escaped/MacroExpansion、cross-segment/retired/inactive-package targets and resolve restart/cancellation races; `npm run check` and the existing projected-read/payload/identity/position fixtures pass.
- [x] 5.9 Hide generated projection symbols and deduplicate authored MMT/Typst workspace symbols
  - Evidence: `mergeWorkspaceSymbols` drops generated/stale symbols and deduplicates canonical URI/range/kind/name identities, retaining MMT-native entries first; the focused TypeScript fixture passes.
- [x] 5.10 Keep package files read-only and restrict visibility to active project dependencies
  - Evidence: package navigation is denied unless the caller proves visibility, and `PackageTextDocumentContentProvider` returns immutable content only while an active project snapshot names the exact package generation. The inactive/active/closed/retired fixture passes.
- [x] 5.11 Add fixtures for Identity, Synthetic, Escaped, MacroExpansion, cross-segment and retired-generation results
  - Evidence: `cargo test --manifest-path mmt_rs/Cargo.toml projection::tests` covers all four mapping modes plus cross-segment rejection; `cargo test --manifest-path mmt_lsp/Cargo.toml read_locations_classify_virtual_targets_and_reject_retired_generations` proves retired responses become explicit `staleUnknown`.
- [x] 5.12 Prove MMT-native results retain precedence over Typst fallback
  - Evidence: `mmtNativeFirst` does not invoke the projected callback for a definitive MMT result and invokes it only for a non-definitive empty result; `node scripts/test-projected-reads.mjs` passes.

## 6. Atomic projected edit features

- [x] 6.1 Define `ProjectedEditTransaction` protocol and Rust validator
- [x] 6.2 Decode every backend range using the exact retained virtual document and encoding
- [x] 6.3 Require every projection edit to lie wholly in one current Identity segment
- [x] 6.4 Reject edits to templates, packages, generated wrappers, materialized resources and read-only virtual files
- [x] 6.5 Normalize URIs and reject overlapping edits before returning a workspace edit
- [x] 6.6 Version every edited writable document and reject changed versions before application
  - Evidence: `mmt_rs::projected_edit` binds protocol v1 edits to exact `SourceContentKey`、`ProjectionKey`、retained virtual bytes and negotiated UTF-8/UTF-16 encoding, consumes `ProjectionIndex::classify_read`, and returns borrowed replacement text plus precise authored byte ranges only after URI normalization、Identity-only mapping、writable-target、non-overlap and exact-version checks all succeed. `cargo test --manifest-path mmt_rs/Cargo.toml --test projected_edit_validator` passes.
- [x] 6.7 Implement projected prepare-rename with current Identity placeholder validation
- [x] 6.8 Implement projected single-document rename first; enable multi-document rename only after journaled `WorkspaceCoordinator.atomicApply` rollback qualifies
- [x] 6.9 Implement embedded Typst range formatting only within one Identity segment
- [x] 6.10 Keep MMT full-document formatting outside Tinymist and disable embedded format-on-save composition
- [x] 6.11 Implement code-action edit mapping only when all edits validate atomically
- [x] 6.12 Add a shared allowlist for command-bearing code actions and reject host-I/O commands
  - Evidence: `ProjectedTypstEditProviders` routes only MMT prepare-rename、rename、explicit embedded range-format and code-action requests through exact projected position/range identities; `ProjectedEditAdapter` submits every backend text edit to the real `mmt/validateProjectedEdit` Rust RPC, requires one current authored document, and keeps the default `MultiDocumentEditApplier` capability unavailable. Prepare placeholders must equal the mapped current source text, full-document/format-on-save composition is refused, and the shared command gate rejects shell、path、network and clipboard effects. `cd editors/vscode && npm run check && npm run test:projected-edits`、`node scripts/test-rich-providers.mjs` and `npm run test:provider-payload-negative` pass; focused Rust validator/RPC tests pass.
- [x] 6.13 Surface `UnsafeEdit`, `StaleProjection`, `ReadOnlyTarget` and `CapabilityUnavailable` distinctly
- [x] 6.14 Add adversarial rename/format/code-action fixtures with mixed safe/unsafe edits, overlaps and concurrent changes
  - Evidence: the focused Rust fixture covers valid authored mapping、UTF-8 codepoint and UTF-16 surrogate splits、mixed safe/unsafe atomic rejection、generated and five host read-only target classes、overlaps、concurrent version changes and normalized URI aliases. `cd editors/vscode && npm run test:projected-edits` now also runs `test-multi-document-projected-edits.mjs`: the production applier rechecks both retained projection revisions、both authored document versions、all returned byte boundaries and overlaps before constructing one complete `WorkspaceEdit`; partial validator output、mixed unsafe/read-only results、resource operations、cancellation、unsupported hosts and stale secondary projections make zero mutation calls, while injected second-target failure restores both fixture preimages. `npm run check` and the focused protocol `npx tsc --noEmit --strict --skipLibCheck --target ES2022 --module ESNext --moduleResolution Bundler src/projectedEditProtocol.ts` pass.
- [x] 6.15 Prove applying an edit advances documents only through standard `didChange`
  - Evidence: the single-document fixture applies through `vscode.workspace.applyEdit` with an immediate version recheck, observes exactly one normal `didChange`, and proves neither the adapter nor provider routing emits `mmt/updateDocument`; stale、overlap、cross-segment、read-only、multi-document and unsafe-command refusals never reach `WorkspaceEdit.applyEdit`. `cd editors/vscode && npm run test:projected-edits` passes.
- [x] 6.16 Capture preimages, journal the complete batch, commit all targets and restore every preimage on injected mid-commit failure
- [x] 6.17 Reject multi-document projected edits as capability unavailable until atomic apply/rollback passes focused failure fixtures
  - Evidence: `WorkspaceCoordinator.atomicApply` durably records every preimage before mutation, commits the complete target set, restores all preimages after an injected second-target failure, and leaves a blocked journal if restoration itself fails. `npm run test:workspace-atomic-apply` and `npm run test:projected-edits` pass; multi-document capability is exposed only after this gate and otherwise returns `CapabilityUnavailable` with zero mutation calls.

## 7. Host-mediated Typst packages

- [x] 7.1 Define versioned `mmt/typstPackageRequest.v1` request/response/cancellation schemas with backend generation and complete project snapshot identity
  - Evidence: `typstPackageProtocol.ts` validates the literal v1 request/context methods and the `Ready | Unavailable | Cancelled` union; `TypstPackageService.isCurrent` requires both active backend generation and a registered complete `projectDigest` before and after asynchronous work.
- [x] 7.2 Add explicit Worker and process dispatcher branches and native/Web transcripts for the package callback
  - Evidence: `TinymistServerRequestDispatcher` routes the literal package method through the cancellable async `JsonRpcTinymistTransport` server-request path used by both clients. Checked `tinymist-native-evidence.json` and `tinymist-web-evidence.json` were captured from patched native digest `b96ce119…` and Web WASM digest `c9ff9b1d…` using the real `PackageTranscriptHost` service.
- [x] 7.3 Define `PackageSpec`, registry adapter, cache adapter and dependency graph interfaces
  - Evidence: `typstPackageProtocol.ts`, `typstPackageArchive.ts` and `typstPackageService.ts` define these contracts; Desktop, memory and IndexedDB adapters implement the same immutable cache interface.
- [x] 7.4 Parse fully versioned `@preview/name:version` imports without allowing source-authored arbitrary URLs
- [x] 7.5 Define Web and Desktop registry configuration and workspace-trust behavior for local namespaces
  - Evidence: `OfficialPreviewRegistry` derives allowlisted HTTPS URLs only for normalized `preview` identities. Neither host installs a local namespace adapter; therefore source-authored URLs and untrusted local namespaces deterministically return unavailable.
- [x] 7.6 Implement coalesced package requests and cancellation by active dependent projects
- [x] 7.7 Enforce HTTPS, status, redirect allowlist, content type and compressed-size limits
- [x] 7.8 Verify declared archive size and SHA-256 when distribution metadata provides them
- [x] 7.9 Stream downloads to staging without unbounded whole-response copies
  - Evidence: `acquireTypstPackage` reads response streams chunk-by-chunk under a hard compressed limit, validates every redirect hop/final URL and verifies declared size/digest before bounded decompression; `npm run test:typst-package` covers redirect, status, type, oversize and integrity failures.
- [x] 7.10 Reject archive traversal, absolute paths, links/devices, duplicate/case-fold paths and unknown entry types
- [x] 7.11 Enforce expanded-size, file-count and per-file bounds
- [x] 7.12 Validate `typst.toml` namespace/name/version and require every path-bearing field, including `entrypoint`, to resolve to an existing regular file inside package root
- [x] 7.13 Add absolute、parent-traversing、missing and non-file entrypoint fixtures
  - Evidence: `src/test/packageService.ts` exercises traversal, POSIX/drive absolute paths, alternate separators, links, devices, unknown types, duplicate/case-fold collisions, all three expansion bounds, manifest identity mismatch, and absolute/parent/missing/non-file entrypoints; `npm run test:typst-package` passes.
- [x] 7.14 Activate immutable package generations atomically and preserve the last valid generation on failure
  - Evidence: digest-addressed Desktop and IndexedDB stores write immutable generation bytes before atomically replacing the active pointer; the focused failure/race fixture proves cancelled or stale completion cannot activate and the previous generation remains readable.
- [x] 7.15 Mount package files through an internal read-only URI scheme and inject explicit virtual dependencies
- [x] 7.16 Keep `mmt_rs`, `mmt_lsp` and Tinymist backend network-free
  - Evidence: package files are returned only as validated `content_base64`, mounted as digest-bound `mmt-package:` files by read-only Desktop/Web filesystem providers, and recorded in `TypstPackageDependencyGraph`. Native/Web transcript network assertions observe no backend-originated external request.
- [x] 7.17 Emit an authored-range dependency diagnostic only for a unique import site; otherwise emit document-level package/dependency-chain diagnostics
  - Evidence: package status construction attaches a range only for one import in the authored source URI and otherwise emits source/snapshot-bound dependency-chain status.
- [x] 7.18 Register Web package cache through `OriginStorageCoordinator` only after its owning PWA contract exists
  - Evidence: `IndexedDbTypstPackageCache` is opened from the runtime controller's sole `TypstPackageCacheStorageOwner`; new validated generations reserve and commit `typst-package-cache` inventory, while eviction deletes only reproducible generation bytes and invalidates dependent snapshots. `npm run test:origin-storage` covers quota, pin and protected-byte precedence.
- [x] 7.19 Include package generation and build-pinned bundled font-set digests in project/render identities
  - Evidence: active dependencies expose exact `packageGeneration`/`filesDigest`; Wave 1 `ProjectDigestInput.packageGenerations` and `RuntimeArtifactKey.fontSetDigest` consume these generation and build-pinned font inputs rather than host paths or mutable cache state.
- [x] 7.20 Add native/Web fixtures for callback cancellation/errors, cached offline resolution, concurrent requests and every archive/manifest rejection boundary
  - Evidence: `npm run test:typst-package`, `TINYMIST_BIN=… npm run test:tinymist-process`, and `TINYMIST_WEB_PKG=… npm run test:tinymist-worker` pass with checked Ready/Unavailable/error/Cancelled service responses, cached offline resolution, one-fetch coalescing and stale/cancellation races.

## 8. Preview state and navigation

- [x] 8.1 Introduce `PreviewDocumentState`, immutable `PreviewArtifact` and byte-bounded artifact cache
- [x] 8.2 Normalize renderer output into validated page records and page geometry
- [x] 8.3 Negotiate a `LocationProviderKey` containing backend/trace artifact digest, generation, method and coordinate version, or retain an immutable location map per artifact
- [x] 8.4 Bind every location request/response and `PreviewArtifact` to both `RenderKey` and `LocationProviderKey`
  - Evidence: `PreviewArtifactStore` owns byte-bounded pinned LRU artifacts and per-source `PreviewDocumentState`; `createPreviewArtifact` validates immutable normalized pages/geometry and requires either a fully qualified provider key or a matching retained immutable map. `npm run test:preview-artifact` proves immutable identity binding、normalization、eviction and stale failure guards; `npm run test:preview-interaction` proves every request/response and overlay remains bound to the displayed render/location keys.
- [x] 8.5 Add debounced editor-to-preview positioning for standalone Typst
- [x] 8.6 Map MMT selection through current projection before editor-to-preview positioning
- [x] 8.7 Select the candidate location nearest the currently visible page and show a bounded visual indicator
- [x] 8.8 Add preview-to-source navigation to authored MMT, workspace Typst or read-only virtual dependency files
- [x] 8.9 Add cursor overlay and remove it when source/render identities diverge
- [x] 8.10 Report viewport changes using normalized page-relative coordinates
- [x] 8.11 Persist per-workspace/source zoom, fit mode and viewport without generated DOM IDs
- [x] 8.12 Add fit-page and preserve existing fit-width/manual zoom
- [x] 8.13 Add capability-gated incremental update batches with full-refresh fallback on gaps or reordering
- [x] 8.14 Add capability-gated partial rendering without allowing mixed-render-key pages
- [x] 8.15 Add outline presentation only from authored symbols or safely mapped locations
- [x] 8.16 Add Desktop/Web interaction fixtures for navigation, stale preview, multi-document switching and renderer recovery
- [x] 8.17 Reject navigation against an old displayed artifact after provider restart/version change unless that artifact retains an immutable location map
  - Evidence: `PreviewInteractionController` binds every request、indicator and cursor to the displayed immutable `PreviewArtifact`、`RenderKey`、`LocationProviderKey` and complete source identity; standalone selections debounce, projected MMT ranges consume `mmt/typstRange`, reverse read navigation consumes `mmt/mapTypstReadLocations`, and stale source/provider drift cancels requests and removes both overlays. Viewports normalize page-relative coordinates and persist by workspace/source; Web and Desktop Webview controls share fit-width、fit-page and manual zoom messages. Incremental gaps/reordering request full refresh, partial batches reject mixed render keys, and outline targets accept only authored/safely mapped locations. `npm run test:preview-interaction`、`npm run test:preview-artifact`、`npm run test:preview-diagnostics`、`npm run test:runtime-controller`、`npm run test:runtime-owner` and `npx tsc --noEmit` pass. A real Chromium smoke opened the VS Code Webview Panel, exercised visible fit-page→manual 159% zoom and editor positioning with one bounded indicator/cursor, proved immutable-map navigation survives an unrelated provider restart, then proved provider-bound restart rejects navigation and removes both visible overlays.

## 9. Exact-snapshot export

- [x] 9.1 Bind displayed SVG, page geometry and renderer inputs to immutable `RenderKey`
- [x] 9.2 Mark displayed preview stale immediately when authored source or any render dependency advances
- [x] 9.3 Export SVG/PNG/JPEG only from the displayed sanitized SVG artifact
- [x] 9.4 Reconstruct PDF compilation from immutable files/resources/fonts/runtime represented by the displayed key
- [x] 9.5 Fail with `ArtifactUnavailable` rather than using mutable current shadow files after eviction
- [x] 9.6 Offer explicit `export displayed revision` or `wait for latest` when preview is stale
- [x] 9.7 Reject export from partial or failed preview state
- [x] 9.8 Add races for export during source edit, materialization, render completion and backend/runtime update
- [x] 9.9 Verify output metadata and content correspond to the requested `RenderKey`

Evidence (W4-D): `npm run check`, `npm run test:exact-export`, `npm run test:preview-artifact`, `npm run test:preview-interaction`, `npm run test:runtime-controller`, `npm run test:runtime-owner`, and `npm run test:origin-storage` pass. The exact-export fixture covers displayed A in SVG/PNG/JPEG/PDF after current B, wait-latest B, all six advance causes, immutable-input/artifact eviction, partial/failed rejection, pin release/disposal, and SHA-256 metadata. An isolated Vite browser smoke imported the host-neutral service and observed `ExportChoiceRequired`, `ArtifactUnavailable`, and only the explicitly selected displayed-A download.
Evidence (W4-E): `npm run check`, `npm run test:exact-export`, `npm run test:preview-artifact`, `npm run test:preview-interaction`, `npm run test:runtime-controller`, and `npm run test:runtime-owner` pass. Real Chromium runs `npm run test:e2e -- exact-export.spec.ts` and observes the actual Webview format selector, deterministic partial/failed/evicted disabled states, literal `Export displayed revision` and `Wait for latest` stale actions, cancellation, a displayed-A SVG download, and a wait-latest B SVG download. `npm run test:e2e:preview-interaction` also passes after exercising fit-page, fit-width, zoom, navigation, source switching, stale overlays and provider recovery against the same Webview protocol. Production startup no longer races the default VS Code API: top-level workspace constants use the low-level `URI`, and the read-only package provider registers only after `api.start()`.

Final 0.x–9.x closure evidence (2026-07-18): `cd editors/vscode && npm run check`, capability/identity/position/router/provider/navigation/rich-provider/projected-read/projected-payload/projected-edit/package transcripts, and fixed native/Worker artifact probes pass. `cd editors/vscode-web && npm run check`, runtime/storage/resource/preview/exact-export/PWA focused suites, production `npm run test:e2e` (3 passed), and production offline cold-start `npm run test:e2e:pwa-offline` (1 passed) pass. The browser cold-start proves cached shell membership, offline Workbench/MMT/Tinymist/Typst startup, editing, immutable preview, ready status, Output activity, and no network fallback.

## 10. Diagnostics, status and observability

- [x] 10.1 Consume the existing unified live/resolve/preview diagnostic phases without a parallel collection
- [x] 10.2 Publish package failures as source-bound preview/build diagnostics when current source content and document-incarnation stale tokens exist
- [x] 10.3 Publish global runtime artifact/startup failures in runtime status and Output, not document syntax diagnostics
- [x] 10.4 Verify the coordinator continues consuming the existing durable resource/preview Problems entries and optional summary notifications without creating a second publisher or collection
- [x] 10.5 Expose active backend version, artifact digest prefix, position encoding, recovery state and queued project count
- [x] 10.6 Expose stale preview/export state and unsafe edit reasons to users
- [x] 10.7 Add structured debug records keyed by request, projection and render identities without logging source/package contents
- [x] 10.8 Prove old revision diagnostics, status and preview results cannot overwrite current state
 
Evidence (W5-A, standalone Web scope, 2026-07-18): `npm run check`, `npm run test:preview-diagnostics`, `npm run test:runtime-status`, `npm run test:typst-project-state`, and `npm run test:typst-package` pass. Production Chromium `npx playwright test --project=local e2e/editor.spec.ts` proves runtime identity/recovery/queue details, global failure routing to status and Output, the Problems command, and a stale status while an older preview remains displayed after editing. `npm run test:e2e:preview-interaction` proves stale editor/preview navigation is rejected. Existing `preview:identity` and `resources:identity` records expose request/projection/render keys and bounded counts without source or package bytes.

## 11. Cross-host parity and cutover

- [ ] 11.1 Generate the final native/Web capability matrix from captured manifests and passing transcripts
- [ ] 11.2 Run shared standalone Typst provider fixtures against native process and browser Worker
- [ ] 11.3 Run shared projected read/edit fixtures through Desktop and Web Extension Hosts
- [x] 11.4 Run production standalone Web E2E for persistence, package, preview navigation and exact-snapshot export
- [ ] 11.5 Exercise backend restart, HMR, unload and PWA quiesce paths with no leaked Worker/process or stale publication
- [ ] 11.6 Exercise Unicode, cancellation, queue bounds and retained-generation eviction on every host
- [ ] 11.7 Confirm Desktop/Web semantic parity for every core-required capability by normalized logical identity and render-key components, excluding host URI scheme and local version counters
- [x] 11.8 Document intentional host-optional differences and hide unsupported UI commands
- [x] 11.9 Delete superseded Web maps, duplicated Worker/process state and feature-specific lifecycle code
- [x] 11.10 Update implementation-status sections only after focused verification evidence exists

Evidence (W5-B, standalone Web cutover, 2026-07-18): production Chromium editor and preview-interaction E2E pass against the Monaco Workbench host; the earlier focused current-preview exact-export E2E remains green. `npm run test:capability-router` and `npm run test:provider-descriptors` pass with unavailable capabilities omitted or surfaced as unavailable rather than registered as unsafe commands. `npm run test:runtime-inventory` reports `duplicatedClientState: 0`, and `npm run test:project-lifecycle` passes for the shared Worker/process session owner. Tasks 11.1-11.3 and 11.5-11.7 remain open because full native/Desktop/Web parity is outside this standalone Monaco cutover.
