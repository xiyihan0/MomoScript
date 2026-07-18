# Proposal: Complete editor runtime and Typst tooling

## Summary

MomoScript SHALL turn the current production editor foundation into one coherent Desktop/Web authoring runtime. The change is not a request to copy Tyraria or to turn MomoScript into a generic Typst SPA. It closes the architecture and capability gaps that currently prevent MMT, embedded Typst, standalone Typst, preview, resources, export and workspace state from behaving as one versioned system.

The change adds:

- one shared runtime coordinator and one shared Typst project-state engine;
- a snapshot identity carried from authored text through projection, resource materialization, render, preview and export;
- complete standalone Typst language tooling exposed by the negotiated Tinymist backend;
- conservative, atomic source projection for the subset of embedded Typst read and edit features that can be proven safe;
- host-mediated Typst package resolution without granting Tinymist arbitrary network or filesystem I/O;
- revision-bound preview navigation, page state and exact-snapshot export;
- a Desktop/Web parity contract and a capability-driven verification matrix.

## Why

The repository already has a strong editor foundation:

- `mmt_rs` is the single DSL parser/semantic truth source;
- `mmt_lsp` provides versioned snapshots, UTF-8/UTF-16 conversion, diagnostics, symbols, folding, completion, hover and semantic tokens;
- `editors/vscode/` provides native and WASM MMT transports, fixed Tinymist native/Worker backends and revision-bound no-I/O Typst projections;
- `editors/vscode-web/` is the production Monaco/VS Code Workbench, persists the workspace in IndexedDB, materializes pack-v3 resources and exports SVG/PDF/PNG/JPEG;
- Desktop and Web already share extension code and the Rust projection mapper.

The current implementation is nevertheless divided at the points that now matter most:

1. `editors/vscode-web/src/main.ts` owns many independent maps for language projections, render projects, retired sessions, requests, materialization controllers and displayed preview state. They encode related lifecycle rules without one owner or one state machine.
2. `TinymistWorkerClient` and `TinymistProcessClient` duplicate project open/apply/retain/prime/close/restart state. A transport difference has become a state-ownership difference.
3. standalone `.typ` documents receive only diagnostics, completion, hover and signature help through explicit middleware; the host neither records nor generically routes any other provider that a fixed backend artifact may advertise.
4. embedded Typst projection has the correct conservative mapping boundary, but the host lacks a general transaction for any future mapped definition, reference, rename, formatting, code-action, highlight, selection-range or hint provider that artifact qualification may enable.
5. MMT LSP positions may be negotiated as UTF-8 while the Tinymist host is initialized as UTF-16. Current paths are safe for the implemented features, but there is no explicit typed bridge contract for all future routed requests and responses.
6. preview and export keep mutable renderer state. Export can compile the latest mapped entry independently of the SVG the user is looking at; it does not identify the exact source/projection/resource/runtime snapshot.
7. browser resource failures are logged or shown as transient warnings. The existing `add-mmt-lsp-vscode` change already owns the diagnostic closure, but a later runtime must consume that result rather than invent a second error channel.
8. the editor has no host-controlled Typst Universe/local package service. Direct backend downloads would violate the no-I/O projection boundary and would produce different Desktop/Web security behavior.
9. preview supports zoom and fit-width but not editor-to-preview positioning, preview-to-source navigation, stable per-document viewport state, page-aware updates or partial render capability negotiation.

These are not independent feature checkboxes. Adding providers directly in middleware would multiply stale-response, encoding, lifecycle and edit-safety bugs. The runtime and snapshot contracts must land before the feature surface expands.

## Benchmark conclusion

The benchmark baseline is Tyraria commit `1edf023e98714277e3160814526e32ac14e79388` (repository state observed 2026-07-17), not an abstract claim about typst.app.

Tyraria demonstrates three useful implementation choices:

- a native Monaco language client provides a generic route for negotiated LSP capabilities without one hand-written provider per feature; the pinned Tyraria source does not capture its native/Web `initialize` results, so it does not establish any individual provider beyond behavior directly observed in that source;
- the browser host can satisfy Tinymist filesystem watches and package requests by injecting files into a virtual workspace;
- Tinymist preview protocol plus typst-dom directly implements incremental SVG changes, viewport reporting, editor-to-preview scrolling, cursor overlays, outline messages and partial-rendering messages.

Tyraria is not a complete product baseline for MomoScript:

- its README calls it a proof-of-concept;
- its workspace provider is in-memory and its own TODO still lists workspace font loading and automated build;
- package resolution fetches and extracts a requested archive without the redirect, size, MIME, digest, traversal and cache-generation contract required by MomoScript;
- its preview and language architecture models ordinary Typst source, not MMT-to-Typst projection, pack-v3 materialization or revision-bound source mapping;
- it does not replace MomoScript's DSL-aware completion, semantic tokens, actor/resource resolution or safe generated-code boundary.

The correct decision is therefore: reuse the capability shape and interaction lessons, not Tyraria's ownership or trust model.

Detailed evidence and the capability matrix are recorded in `tyraria-gap-analysis.md`.

## Goals

### G1. One owner per mutable lifecycle

A single `EditorRuntimeController` SHALL own startup, readiness, project synchronization, preview scheduling, cancellation, recovery, quiesce and disposal. A shared `TypstProjectState` SHALL own virtual project state for both Worker and process transports.

### G2. One snapshot identity end to end

Every projection, materialization, render, preview, diagnostic and export SHALL identify the authored source version and the exact derived inputs it used. A result from an older or retired snapshot SHALL never overwrite a newer state.

### G3. Qualified Typst capability without unsafe projection

Standalone `.typ` documents SHALL receive only the explicitly enumerated providers present in the checked capability manifest and backed by passing method transcripts. Embedded Typst SHALL receive a provider only when every returned URI、range、edit and command payload can be mapped or rejected atomically through the current project/projection identity. Advertised but unimplemented providers remain classified and unavailable rather than being implied by a broad “supported features” claim.

### G4. Desktop/Web core parity

Desktop and Web SHALL run the same MMT service, projection mapping, Typst project coordinator, feature router, package policy and preview protocol. Platform adapters MAY differ only for process/Worker transport, filesystem/network primitives and presentation integration.

### G5. Host-mediated I/O

Tinymist SHALL not gain arbitrary network or host filesystem access through this change. Workspace files, packages, fonts and generated dependencies SHALL be supplied through explicit host adapters with path, size, MIME, digest, cache and cancellation policy.

### G6. Preview and export identify what the user saw

Preview navigation SHALL be revision-bound. Export SHALL use an immutable `RenderKey` and SHALL either export the displayed artifact or state clearly that the displayed artifact is stale. It SHALL never silently mix source, resources or runtime generations.

## What Changes

### Runtime coordination

- Introduce `EditorRuntimeController`, `TypstProjectCoordinator`, `PreviewService`, `TypstFeatureRouter`, `TypstPackageService` and explicit platform adapters.
- Move project session/revision/open-file/retention/prime/close rules from both Tinymist clients into one shared engine.
- Define runtime and per-project state machines, cancellation ownership, bounded queues, restart replay and quiesce/dispose behavior.
- Replace related ad-hoc maps in production Web with typed stores owned by the coordinator.

### Snapshot and position contracts

- Define `LogicalSourceId`, canonical `SourceContentKey`, local-only `SourceStaleToken`, `TypstProjectSnapshotKey`, `ProjectionKey`, `MaterializationKey`, `RuntimeArtifactKey` and `RenderKey`.
- Carry canonical source content, complete Typst project graph, projection session/revision, mapping digest, resource-plan/materialized-resource digests and runtime artifact digest through derived results; keep host URI、document-incarnation nonce and editor-local version only in request publication/application guards.
- Add a typed position-encoding bridge. MMT client encoding and Tinymist encoding SHALL be explicit values; no routed range may be treated as encoding-neutral.

### Typst language tooling

- Route the negotiated standard Tinymist capability set for standalone `.typ` files, including navigation, references, rename, formatting, symbols, selection/document highlights, links/colors, code actions, hints and lenses when advertised.
- Add a generic projected-feature transaction for embedded Typst.
- Permit read-only navigation to authored MMT ranges, workspace Typst files, package files and read-only virtual projection files.
- Permit rename, formatting and workspace edits only after complete, current-revision, Identity-only validation.
- Preserve the existing MMT-first behavior: MMT-native results win where the core has an answer; Typst fallback is restricted to applicable Typst regions.

### Package and dependency resolution

- Introduce host-owned package registry/cache adapters for `@preview/name:version` and configured local namespaces.
- Keep MMT projection no-I/O: packages are fetched, validated, expanded and injected by the host, never fetched by the Rust core or Tinymist backend.
- Validate archive status, redirect policy, compressed and expanded size, file count, path normalization, duplicate paths, MIME/content expectations and optional distribution digest.
- Make package availability and offline state visible and deterministic across Desktop/Web.

### Preview, navigation and export

- Introduce a page-aware preview document model and per-document viewport state.
- Add editor-to-preview positioning, preview-to-source navigation, cursor indication and source-map-aware fallback behavior.
- Negotiate incremental/partial rendering instead of assuming it.
- Bind preview diagnostics and artifacts to `RenderKey`.
- Export only from the displayed immutable render snapshot, with explicit stale-state UI.

### Parity and verification

- Publish a capability matrix derived from actual backend `initialize` results.
- Run shared contract fixtures through native process, browser Worker, Desktop Extension Host and production standalone Web.
- Add race, restart, cancellation, encoding, stale-result, unsafe-edit, package-security and export-snapshot scenarios.

## Dependencies and change ownership

This change depends on, but SHALL NOT duplicate, the following active changes. The gates are staged rather than treated as one all-or-nothing prerequisite:

- `add-mmt-lsp-vscode`
  - tasks 10.1–10.7 and their focused evidence are a prerequisite for any runtime cutover;
  - this change consumes the established diagnostic publishers and phase model rather than replacing them.
- `add-workspace-storage-history-sync`
  - its workspace backend abstraction and atomic `WorkspaceCoordinator` batch/preimage contract are prerequisites for multi-document edits and coordinator cutover;
  - Local History、File System Access and WebDAV remain owned there and are not prerequisites for read-only language routing;
  - projected multi-document edits remain disabled until atomic apply/rollback is proven.
- `add-pwa-offline-runtime`
  - its task 0.2 ownership handoff、runtime artifact catalog/digest and quiesce contract are prerequisites respectively for production Web cutover、artifact-bound identities and PWA restart integration;
  - `OriginStorageCoordinator` is a prerequisite only for persistent reclaimable Web package cache; package protocol and ephemeral-cache fixtures may proceed earlier.
- `design-resource-pack-v3`
  - owns pack semantic manifest, installation index and resource materialization policy;
  - this change carries pack/materialization digests into `RenderKey` but does not redefine pack semantics.
- `redesign-dsl-syntax-v2`
  - owns MMT syntax, semantic IR and projection segment semantics;
  - this change does not reinterpret MMT syntax.

## Implementation order

1. Finish `add-mmt-lsp-vscode` diagnostics/runtime closure and capture native/Web capability、package-callback and location-provider evidence.
2. Establish logical workspace identity、complete Typst project snapshot keys and typed encoding without changing visible capabilities.
3. Land the workspace backend and atomic coordinator foundation; move Worker/process hosts only after their ownership gate is satisfied.
4. Expand only explicitly qualified standalone providers, then projected read providers with payload-specific safety validation.
5. Enable projected single-document edits; enable multi-document edits only after journaled atomic apply/rollback passes failure fixtures.
6. Define and connect the versioned package callback; qualify or patch artifacts before implementing package fetch. Add persistent Web cache only after `OriginStorageCoordinator` exists.
7. Bind preview navigation to immutable location-provider identity and implement exact-snapshot export.
8. Connect PWA quiesce/artifact catalog only after the PWA ownership contracts land.
9. Complete the cross-host parity matrix over canonical logical key components and only then remove superseded paths.

## Non-Goals

- Replacing MMT with Typst or treating generated Typst as the authored source of truth.
- Copying Tyraria UI, Vue components, typst-dom implementation or GPL-licensed code.
- Linking the full Tinymist Rust core directly into `mmt_lsp`.
- Granting Tinymist Worker/process unrestricted network or host filesystem access.
- Allowing rename, formatting or code actions to edit Synthetic, Escaped or MacroExpansion projection segments.
- Implementing PWA install/update, Local History, File System Access, WebDAV, real-time collaboration or CRDT in this change.
- Defining new pack-v3 resource semantics or weakening current resource download limits.
- Guaranteeing identical optional capabilities when a fixed native/Web Tinymist artifact genuinely does not advertise them. The user-visible absence must be explicit and tested.
- Maintaining compatibility shims for the duplicated coordinator after all hosts migrate.

## Implementation status

Sections 0.x–9.x are implemented on the integrated development branch as of 2026-07-18. Each checked task links focused contract/transcript evidence; fixed native/Web Tinymist artifacts are digest-pinned and the production Web editor has passing online and offline Chromium acceptance. Sections 10–11 remain explicit follow-on work unless individually checked; this status does not claim the separate full PWA install/update、Local History UX、File System Access or WebDAV changes.

## Impact

- Rust: `mmt_lsp/`, projection mapping APIs and protocol types shared with TypeScript.
- Shared extension: `editors/vscode/src/typstFeatures.ts`, Tinymist host interfaces, Worker/process clients and activation lifecycle.
- Production Web: `editors/vscode-web/src/main.ts`, preview controller, export commands, package/cache adapters and E2E fixtures.
- Build artifacts: native/Web Tinymist capability manifests and runtime digests.
- Specs: new editor runtime, Typst tooling, package resolution, preview/export and parity capabilities.
- Security: package archive handling, virtual file navigation, workspace edits, cancellation and stale-result rejection become explicit trust boundaries.
