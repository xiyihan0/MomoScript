## 0. Prerequisite closure and characterization

- [x] 0.1 Complete `add-mmt-lsp-vscode` tasks 10.1–10.7 and record their focused test evidence
  - Evidence: same-branch closure history `09096fd`–`952aff8`; exact 10.1–10.7 implementation/regression commit mapping, focused commands, and observed positive/negative normalized results are recorded under “Focused evidence for 10.1–10.7 (2026-07-17)” in [`add-mmt-lsp-vscode/tasks.md`](../add-mmt-lsp-vscode/tasks.md).
- [x] 0.2 Complete the `add-workspace-storage-history-sync` workspace backend and journaled atomic batch/preimage contract before runtime cutover or multi-document edits
  - Evidence: `npm run test:workspace-atomic-apply` verifies migration/history/quota contracts and restores every preimage when the second target commit fails; rollback failure leaves the durable journal blocked. `npm run test:origin-storage` verifies protected workspace/history inventory and shell/pack hard gates.
- [ ] 0.3 Complete `add-pwa-offline-runtime` task 0.2 ownership handoff before production Web cutover; gate artifact identity、quiesce and persistent package cache separately on their owning PWA contracts
- [ ] 0.4 Capture complete normalized `initialize` results from the pinned native Tinymist process artifact
- [ ] 0.5 Capture complete normalized `initialize` results and dynamic registrations from the pinned browser Tinymist Worker artifact
- [ ] 0.6 Capture native/Web package-callback message shape、cancellation and error transcripts; require artifact upgrade or maintained patch if logical host callbacks are unavailable
- [ ] 0.7 Capture native/Web preview/location method、artifact digest and coordinate-version evidence
- [x] 0.8 Generate checked capability manifests containing artifact digest, backend version, position encoding, provider options and experimental methods
  - Evidence: `cd editors/vscode && npm run test:capability-manifest` checks `src/test/fixtures/tinymist-capability-manifest.json`, including native checksum reference `tinymist-native.sha256`, Web SHA-256 `d9b946…`, backend `0.15.2`, and UTF-16.
- [x] 0.9 Diff native/Web manifests and classify every provider as core-required, host-optional, deferred or unavailable
  - Evidence: the same deterministic command reports baseline completion/hover/semantic-token/signature providers as `core-required`, advertised P0 providers without shared positive/negative method transcripts as `unavailable` with machine-readable `patchRequired: true` and `patchRequiredProviders`, and location/package callback as explicit host-optional/unavailable.
- [x] 0.10 Remove any capability claim not supported by an explicitly enumerated provider and successful positive/negative method transcripts
  - Evidence: the generator rejects stale manifests and asserts no P0 provider is `core-required` without compatible advertisement plus shared positive/negative evidence; package callback remains unavailable rather than claimed.
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
- [ ] 2.14 Prove native process, browser Worker, Desktop Host and Web Host retain baseline behavior after cutover
  - Evidence: `cd editors/vscode && npm run check && npm run test:runtime-characterization && npm run test:worker`, `TINYMIST_WEB_PKG="$PWD/vendor/tinymist-0.15.2" npm run test:tinymist-worker`, `TINYMIST_BIN=/home/xiyihan/MomoScript-worktrees/artifacts/tinymist-3d63da4f/target/release/tinymist npm run test:tinymist-process`, and the same fixed-binary `npm run test:desktop` pass unchanged Worker、Web Worker、native process and Desktop Host transcripts. The single permitted Web Host attempt built and downloaded VS Code Web Insiders, but infrastructure failed before host execution with `EADDRINUSE 127.0.0.1:3000`, followed by `ERR_CONNECTION_REFUSED`; keep 2.14 unchecked because Web Host behavior was not proven.
- [x] 2.15 Delete duplicated project lifecycle state from Worker/process clients
  - Evidence: `TinymistHostSession` is the sole owner of notification handlers、readiness、terminal stop and serialized recovery; Worker/process clients retain their public APIs and only adapt host-specific boot/initialize details. `cd editors/vscode && npm run check && npm run test:runtime-inventory && npm run test:project-lifecycle && npm run test:typst-project-state` passes with `duplicatedClientState: 0`, one recovery generation/event pair, latest-complete replay, idempotent disposal and post-stop rejection.

## 3. Generic Typst feature router

- [ ] 3.1 Introduce runtime capability registry from initialize results and dynamic registrations
- [ ] 3.2 Implement generic request metadata containing backend generation, logical source/content identity, local document-incarnation/version stale token, complete Typst project snapshot, projection key and request sequence
- [ ] 3.3 Reject every standalone/projected response when its complete project graph changes, even if the requesting document version is unchanged
- [ ] 3.4 Implement standalone Typst routing with explicit backend position conversion
- [ ] 3.5 Implement MMT-first routing and current projected-position lookup
- [ ] 3.6 Migrate completion, hover and signature help to the router without changing results
- [ ] 3.7 Migrate Typst diagnostics and semantic tokens to shared request/revision handling
- [ ] 3.8 Preserve completion item defaults, resolve data and trigger/retrigger characters from negotiated capabilities
- [ ] 3.9 Expose user-visible unavailable state instead of registering commands/providers that always fail
- [ ] 3.10 Add provider-registration tests for native/Web capability differences

## 4. Qualified standalone Typst authoring features

Every item in this section is enabled only if the active artifact advertises the provider. P0 items require native/Web convergence before completion.

- [ ] 4.1 Implement standalone go-to-definition and link navigation
- [ ] 4.2 Implement standalone references with cancellation and partial-result handling
- [ ] 4.3 Implement standalone prepare-rename and versioned rename workspace edits
- [ ] 4.4 Implement standalone full and range formatting and configure format-on-save only after a successful transcript
- [ ] 4.5 Implement standalone Typst document symbols
- [ ] 4.6 Implement type-definition and implementation routes when advertised
- [ ] 4.7 Implement workspace symbols and optional symbol resolve when advertised
- [ ] 4.8 Implement document highlights when advertised
- [ ] 4.9 Implement selection ranges when advertised
- [ ] 4.10 Implement document links and link resolve when advertised
- [ ] 4.11 Implement document colors and color presentations when advertised
- [ ] 4.12 Implement code actions and resolve when advertised
- [ ] 4.13 Implement inlay hints and resolve when advertised
- [ ] 4.14 Implement code lenses and resolve when advertised; keep disabled if artifacts do not qualify
- [ ] 4.15 Route edits、commands and URIs carried by color presentations, inlay hints, code lenses and document links through the same snapshot、target and allowlist validator
- [ ] 4.16 Strip an unsafe optional field only when the protocol proves the remaining item semantically complete; otherwise reject the item
- [ ] 4.17 Add negative transcripts for unsafe color edits、inlay-hint commands、code-lens commands and stale link targets
- [ ] 4.18 Add one native process and one browser Worker transcript per enabled provider

## 5. Projected read features

- [ ] 5.1 Add Rust mapping result kinds for authored MMT, workspace Typst, package file, generated projection and stale/unknown locations
- [ ] 5.2 Add read-only URI content providers for retained virtual projection and package generations
- [ ] 5.3 Map definition targets to authored MMT Identity ranges or explicit read-only virtual files
- [ ] 5.4 Map references item by item only where method semantics permit partial safe results
- [ ] 5.5 Map type-definition and implementation locations when the provider is qualified
- [ ] 5.6 Map document highlights conservatively and discard stale/unsafe ranges
- [ ] 5.7 Map nested selection ranges until the first unsafe ancestor
- [ ] 5.8 Map document links, colors, hints and lenses only under method-specific safe rules, validating every nested edit、command and URI payload
- [ ] 5.9 Hide generated projection symbols and deduplicate authored MMT/Typst workspace symbols
- [ ] 5.10 Keep package files read-only and restrict visibility to active project dependencies
- [ ] 5.11 Add fixtures for Identity, Synthetic, Escaped, MacroExpansion, cross-segment and retired-generation results
- [ ] 5.12 Prove MMT-native results retain precedence over Typst fallback

## 6. Atomic projected edit features

- [ ] 6.1 Define `ProjectedEditTransaction` protocol and Rust validator
- [ ] 6.2 Decode every backend range using the exact retained virtual document and encoding
- [ ] 6.3 Require every projection edit to lie wholly in one current Identity segment
- [ ] 6.4 Reject edits to templates, packages, generated wrappers, materialized resources and read-only virtual files
- [ ] 6.5 Normalize URIs and reject overlapping edits before returning a workspace edit
- [ ] 6.6 Version every edited writable document and reject changed versions before application
- [ ] 6.7 Implement projected prepare-rename with current Identity placeholder validation
- [ ] 6.8 Implement projected single-document rename first; enable multi-document rename only after journaled `WorkspaceCoordinator.atomicApply` rollback qualifies
- [ ] 6.9 Implement embedded Typst range formatting only within one Identity segment
- [ ] 6.10 Keep MMT full-document formatting outside Tinymist and disable embedded format-on-save composition
- [ ] 6.11 Implement code-action edit mapping only when all edits validate atomically
- [ ] 6.12 Add a shared allowlist for command-bearing code actions and reject host-I/O commands
- [ ] 6.13 Surface `UnsafeEdit`, `StaleProjection`, `ReadOnlyTarget` and `CapabilityUnavailable` distinctly
- [ ] 6.14 Add adversarial rename/format/code-action fixtures with mixed safe/unsafe edits, overlaps and concurrent changes
- [ ] 6.15 Prove applying an edit advances documents only through standard `didChange`
- [ ] 6.16 Capture preimages, journal the complete batch, commit all targets and restore every preimage on injected mid-commit failure
- [ ] 6.17 Reject multi-document projected edits as capability unavailable until atomic apply/rollback passes focused failure fixtures

## 7. Host-mediated Typst packages

- [ ] 7.1 Define versioned `mmt/typstPackageRequest.v1` request/response/cancellation schemas with backend generation and complete project snapshot identity
- [ ] 7.2 Add explicit Worker and process dispatcher branches and native/Web transcripts for the package callback
- [ ] 7.3 Define `PackageSpec`, registry adapter, cache adapter and dependency graph interfaces
- [ ] 7.4 Parse fully versioned `@preview/name:version` imports without allowing source-authored arbitrary URLs
- [ ] 7.5 Define Web and Desktop registry configuration and workspace-trust behavior for local namespaces
- [ ] 7.6 Implement coalesced package requests and cancellation by active dependent projects
- [ ] 7.7 Enforce HTTPS, status, redirect allowlist, content type and compressed-size limits
- [ ] 7.8 Verify declared archive size and SHA-256 when distribution metadata provides them
- [ ] 7.9 Stream downloads to staging without unbounded whole-response copies
- [ ] 7.10 Reject archive traversal, absolute paths, links/devices, duplicate/case-fold paths and unknown entry types
- [ ] 7.11 Enforce expanded-size, file-count and per-file bounds
- [ ] 7.12 Validate `typst.toml` namespace/name/version and require every path-bearing field, including `entrypoint`, to resolve to an existing regular file inside package root
- [ ] 7.13 Add absolute、parent-traversing、missing and non-file entrypoint fixtures
- [ ] 7.14 Activate immutable package generations atomically and preserve the last valid generation on failure
- [ ] 7.15 Mount package files through an internal read-only URI scheme and inject explicit virtual dependencies
- [ ] 7.16 Keep `mmt_rs`, `mmt_lsp` and Tinymist backend network-free
- [ ] 7.17 Emit an authored-range dependency diagnostic only for a unique import site; otherwise emit document-level package/dependency-chain diagnostics
- [ ] 7.18 Register Web package cache through `OriginStorageCoordinator` only after its owning PWA contract exists
- [ ] 7.19 Include package generation and build-pinned bundled font-set digests in project/render identities
- [ ] 7.20 Add native/Web fixtures for callback cancellation/errors, cached offline resolution, concurrent requests and every archive/manifest rejection boundary

## 8. Preview state and navigation

- [ ] 8.1 Introduce `PreviewDocumentState`, immutable `PreviewArtifact` and byte-bounded artifact cache
- [ ] 8.2 Normalize renderer output into validated page records and page geometry
- [ ] 8.3 Negotiate a `LocationProviderKey` containing backend/trace artifact digest, generation, method and coordinate version, or retain an immutable location map per artifact
- [ ] 8.4 Bind every location request/response and `PreviewArtifact` to both `RenderKey` and `LocationProviderKey`
- [ ] 8.5 Add debounced editor-to-preview positioning for standalone Typst
- [ ] 8.6 Map MMT selection through current projection before editor-to-preview positioning
- [ ] 8.7 Select the candidate location nearest the currently visible page and show a bounded visual indicator
- [ ] 8.8 Add preview-to-source navigation to authored MMT, workspace Typst or read-only virtual dependency files
- [ ] 8.9 Add cursor overlay and remove it when source/render identities diverge
- [ ] 8.10 Report viewport changes using normalized page-relative coordinates
- [ ] 8.11 Persist per-workspace/source zoom, fit mode and viewport without generated DOM IDs
- [ ] 8.12 Add fit-page and preserve existing fit-width/manual zoom
- [ ] 8.13 Add capability-gated incremental update batches with full-refresh fallback on gaps or reordering
- [ ] 8.14 Add capability-gated partial rendering without allowing mixed-render-key pages
- [ ] 8.15 Add outline presentation only from authored symbols or safely mapped locations
- [ ] 8.16 Add Desktop/Web interaction fixtures for navigation, stale preview, multi-document switching and renderer recovery
- [ ] 8.17 Reject navigation against an old displayed artifact after provider restart/version change unless that artifact retains an immutable location map

## 9. Exact-snapshot export

- [ ] 9.1 Bind displayed SVG, page geometry and renderer inputs to immutable `RenderKey`
- [ ] 9.2 Mark displayed preview stale immediately when authored source or any render dependency advances
- [ ] 9.3 Export SVG/PNG/JPEG only from the displayed sanitized SVG artifact
- [ ] 9.4 Reconstruct PDF compilation from immutable files/resources/fonts/runtime represented by the displayed key
- [ ] 9.5 Fail with `ArtifactUnavailable` rather than using mutable current shadow files after eviction
- [ ] 9.6 Offer explicit `export displayed revision` or `wait for latest` when preview is stale
- [ ] 9.7 Reject export from partial or failed preview state
- [ ] 9.8 Add races for export during source edit, materialization, render completion and backend/runtime update
- [ ] 9.9 Verify output metadata and content correspond to the requested `RenderKey`

## 10. Diagnostics, status and observability

- [ ] 10.1 Consume the existing unified live/resolve/preview diagnostic phases without a parallel collection
- [ ] 10.2 Publish package failures as source-bound preview/build diagnostics when current source content and document-incarnation stale tokens exist
- [ ] 10.3 Publish global runtime artifact/startup failures in runtime status and Output, not document syntax diagnostics
- [ ] 10.4 Verify the coordinator continues consuming the existing durable resource/preview Problems entries and optional summary notifications without creating a second publisher or collection
- [ ] 10.5 Expose active backend version, artifact digest prefix, position encoding, recovery state and queued project count
- [ ] 10.6 Expose stale preview/export state and unsafe edit reasons to users
- [ ] 10.7 Add structured debug records keyed by request, projection and render identities without logging source/package contents
- [ ] 10.8 Prove old revision diagnostics, status and preview results cannot overwrite current state

## 11. Cross-host parity and cutover

- [ ] 11.1 Generate the final native/Web capability matrix from captured manifests and passing transcripts
- [ ] 11.2 Run shared standalone Typst provider fixtures against native process and browser Worker
- [ ] 11.3 Run shared projected read/edit fixtures through Desktop and Web Extension Hosts
- [ ] 11.4 Run production standalone Web E2E for persistence, package, preview navigation and exact-snapshot export
- [ ] 11.5 Exercise backend restart, HMR, unload and PWA quiesce paths with no leaked Worker/process or stale publication
- [ ] 11.6 Exercise Unicode, cancellation, queue bounds and retained-generation eviction on every host
- [ ] 11.7 Confirm Desktop/Web semantic parity for every core-required capability by normalized logical identity and render-key components, excluding host URI scheme and local version counters
- [ ] 11.8 Document intentional host-optional differences and hide unsupported UI commands
- [ ] 11.9 Delete superseded Web maps, duplicated Worker/process state and feature-specific lifecycle code
- [ ] 11.10 Update implementation-status sections only after focused verification evidence exists
