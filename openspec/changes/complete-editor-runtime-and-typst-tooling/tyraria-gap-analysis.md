# Tyraria capability gap analysis

## 1. Scope and evidence

This document compares the MomoScript editor implementation observed on 2026-07-17 with Tyraria commit
`1edf023e98714277e3160814526e32ac14e79388`.

It is an implementation input, not a product requirement by itself. Tyraria is used as evidence that certain browser interactions and Tinymist capabilities are practical. MomoScript's acceptance criteria remain the local specs and tests.

Primary Tyraria evidence:

- repository: <https://github.com/ParaN3xus/tyraria>
- pinned commit: <https://github.com/ParaN3xus/tyraria/commit/1edf023e98714277e3160814526e32ac14e79388>
- README: <https://github.com/ParaN3xus/tyraria/blob/1edf023e98714277e3160814526e32ac14e79388/README.md>
- Monaco/Tinymist setup: <https://github.com/ParaN3xus/tyraria/blob/1edf023e98714277e3160814526e32ac14e79388/src/monaco.mts>
- browser language host and package resolver: <https://github.com/ParaN3xus/tyraria/blob/1edf023e98714277e3160814526e32ac14e79388/src/tinymist-ls/ls.mts>
- preview host: <https://github.com/ParaN3xus/tyraria/blob/1edf023e98714277e3160814526e32ac14e79388/src/typst-preview/TypstPreview.vue>
- preview protocol/DOM implementation: <https://github.com/ParaN3xus/tyraria/blob/1edf023e98714277e3160814526e32ac14e79388/src/typst-preview/preview.mts>
- workspace provider: <https://github.com/ParaN3xus/tyraria/blob/1edf023e98714277e3160814526e32ac14e79388/src/fs-provider/fs-provider.mts>

Primary MomoScript evidence:

- `openspec/changes/add-mmt-lsp-vscode/`
- `mmt_lsp/src/server.rs`
- `mmt_lsp/src/service.rs`
- `editors/vscode/src/typstFeatures.ts`
- `editors/vscode/src/tinymistClient.ts`
- `editors/vscode/src/tinymistProcessClient.ts`
- `editors/vscode-web/src/main.ts`
- `editors/vscode-web/src/preview.ts`

## 2. Architectural comparison

| Dimension | Tyraria | MomoScript now | Decision |
|---|---|---|---|
| Authored language | ordinary Typst | MMT DSL plus embedded/standalone Typst | MMT remains source of truth |
| Language core | Tinymist WASM language client | Rust MMT LSP plus fixed Tinymist sidecar | retain two-layer architecture |
| Source projection | not required | revision-bound MMT-to-Typst projection with Identity/Synthetic/Escaped/MacroExpansion segments | never weaken mapping |
| Browser workspace | in-memory VS Code filesystem | IndexedDB-backed `mmtfs` workspace | MomoScript is stronger; evolve through workspace change |
| Resources | ordinary workspace/package files | pack-v3 resolver, materialization, image-dir/AVIFS and safe download | keep separate render project |
| Preview | Tinymist preview protocol plus typst-dom incremental DOM | typst.ts full SVG mapped through shadow VFS | adopt protocol concepts, not code |
| Package I/O | backend asks host to fetch and untar URL | no package resolver; projection intentionally no-I/O | add host-mediated validated service |
| Persistence/share | pastebin snapshot; in-memory session | durable IndexedDB; separate history/sync design | do not copy pastebin as persistence |
| License posture | GPL-3.0 proof-of-concept | project-specific implementation | no code copying; architecture only |

## 3. Capability matrix

Legend:

- `implemented`: observable current capability exists.
- `partial`: a narrower capability or only one host exists.
- `missing`: no current route or behavior found.
- `not applicable`: Tyraria capability does not map directly to MMT's product.
- `deferred owner`: another active OpenSpec change owns the capability.

### 3.1 Editing and language service

| Capability | Tyraria evidence | MomoScript status | Target | Priority |
|---|---|---|---|---|
| Basic multi-file editor/explorer | VS Code Workbench services and in-memory provider | implemented with persistent `mmtfs` | retain | baseline |
| Typst diagnostics | Tinymist language client | implemented for standalone and embedded mapped diagnostics | unify through existing diagnostic closure | prerequisite |
| Completion | generic language client route; pinned Tyraria `initialize` result not captured | implemented for MMT, standalone Typst and safe embedded fallback; Momo artifacts explicitly require this provider | preserve MMT-first routing | baseline |
| Hover | generic language client route; pinned Tyraria provider advertisement not captured | implemented for MMT, standalone and embedded Typst; Momo artifacts explicitly require this provider | preserve | baseline |
| Signature help | generic language client route; pinned Tyraria provider advertisement not captured | implemented for standalone and embedded Typst; Momo artifacts explicitly require this provider | preserve | baseline |
| Semantic tokens | Tyraria loads Tinymist scopes, but its pinned `initialize` result is not captured | implemented for MMT and routed Typst semantic tokens; Momo artifacts explicitly require a legend | preserve merged layers | baseline |
| Go to definition | not established for Tyraria's pinned artifacts; only a generic language client route is shown | missing explicit Momo middleware route | qualify both Momo artifacts, then add standalone and mapped read navigation | P0 gate |
| Go to type definition/implementation | not established for Tyraria's pinned artifacts | missing | capability-gated after native/Web artifact qualification | P1 optional |
| Find references | not established for Tyraria's pinned artifacts | missing | qualify both Momo artifacts, then add standalone and safe mapped references | P0 gate |
| Prepare rename/rename | not established for Tyraria's pinned artifacts | missing | qualify both Momo artifacts, then add atomic Identity-only projected edits | P0 gate |
| Document formatting | Tyraria configures `formatterMode: typstyle` and `formatOnSave`; provider advertisement and successful response are not captured | missing route | qualify both Momo artifacts, then add standalone full/range and safe embedded range formatting | P0 gate |
| Document symbols | not established for Tyraria's pinned artifacts | MMT symbols implemented; standalone Typst not explicitly routed | capability-gated union by language, never mix stale projections | P0 gate |
| Workspace symbols | not established for Tyraria's pinned artifacts | missing | capability-gated MMT/Typst merge and dedupe | P1 optional |
| Document highlights | not established for Tyraria's pinned artifacts | missing | capability-gated read-only range mapping | P1 optional |
| Selection ranges | not established for Tyraria's pinned artifacts | missing | capability-gated nested mapping until first unsafe ancestor | P1 optional |
| Document links/colors | not established for Tyraria's pinned artifacts | missing | capability-gated standalone route; embedded only for current Identity ranges | P1 optional |
| Code actions | not established for Tyraria's pinned artifacts | missing | capability-gated; allow only safe edits and allowlisted commands | P1 optional |
| Inlay hints | not established for Tyraria's pinned artifacts | missing | capability-gated read-only mapping | P2 optional |
| Code lens | not established; Tyraria explicitly disables editor code lens in config | missing | capability-gated and not a parity requirement | P2 optional |
| Inline value/completion | not established by pinned code | missing | not required by parity; evaluate separately | deferred |
| MMT DSL-aware actor/resource features | not applicable | implemented and stronger | retain MMT precedence | baseline |

### 3.2 Preview and render

| Capability | Tyraria evidence | MomoScript status | Target | Priority |
|---|---|---|---|---|
| Live preview | Tinymist start-preview plus typst-dom | implemented through typst.ts SVG | retain | baseline |
| Incremental DOM update | `addChangement`, batched messages | missing; full SVG replacement | capability-gated incremental path after snapshot coordinator | P1 |
| Partial rendering | `partial-rendering` protocol message | missing | optional negotiated optimization | P2 |
| Editor to preview scroll | `tinymist.scrollPreview` on selection | missing | revision-bound MMT/Typst source to page/point | P0 |
| Preview cursor overlay | `cursor` and `cursor-paths` messages | missing | add after location map | P1 |
| Preview to source | preview websocket/protocol supports interaction building blocks | missing | click/selection maps to authored MMT or read-only virtual Typst | P1 |
| Viewport feedback | scroll/resize calls `addViewportChange` | missing | per-document viewport store and backend notification | P1 |
| Outline | protocol handles outline data | partial: MMT document symbols exist but no preview outline | derive from authored structure; do not expose generated wrappers | P2 |
| Dark preview inversion | strategy support in preview DOM | missing | optional presentation feature, no semantic impact | P2 |
| Zoom/fit | responsive typst-dom | implemented zoom and fit-width | add fit-page and persistence | P1 |
| Export PDF/SVG/PNG/JPEG | not central in pinned UI | implemented | bind to exact `RenderKey`; keep Momo advantage | P0 |
| Pack-v3 real avatar/resource preview | not applicable | implemented | preserve | baseline |

### 3.3 Workspace, offline and distribution

| Capability | Tyraria | MomoScript status | Owner |
|---|---|---|---|
| durable workspace | in-memory only | IndexedDB implemented | current editor |
| Local History | absent | designed, not implemented | `add-workspace-storage-history-sync` |
| local directory | absent | designed, not implemented | `add-workspace-storage-history-sync` |
| WebDAV | absent | designed, not implemented | `add-workspace-storage-history-sync` |
| pastebin share URL | implemented | missing | out of this change; separate privacy/product proposal if desired |
| PWA install/offline | absent | designed, not implemented | `add-pwa-offline-runtime` |
| offline pack install | absent | designed, not implemented | `add-pwa-offline-runtime` + pack-v3 |
| Typst package download | direct fetch+untar | missing | this change, with stronger host policy |
| workspace fonts | Tyraria TODO | missing general workflow | this change may resolve language/render injection; UI import belongs workspace change |

## 4. What Tyraria proves

### 4.1 A generic Tinymist LSP connection is practical in a browser

Tyraria starts a normal `MonacoLanguageClient` against a browser Worker. This proves that the Web host can carry standard negotiated LSP requests without one middleware implementation per method. The pinned source does not capture the Worker's `initialize` result and therefore does not prove that definition, references, rename, formatting or any other individual optional provider is available.

MomoScript must first capture and compare the fixed native/Web artifacts' actual capability objects. It also cannot use Tyraria's identical connection shape for embedded MMT because requests must pass through a current projection and preserve MMT-native answers. After qualification, a generic feature router and common mapping transaction can avoid feature-specific lifecycle code.

### 4.2 A host-owned virtual filesystem can satisfy backend reads

Tyraria handles `tinymist/fs/watch` and returns inserted/removed file content from the VS Code filesystem. This is the right trust direction: the backend asks; the host decides what bytes are visible.

MomoScript should retain that direction but use its persistent `mmtfs` backend and explicit dependency graph. The backend must not infer arbitrary paths or read the host filesystem directly.

### 4.3 Preview interaction is protocol work, not only SVG rendering

Tyraria's preview:

- batches incremental messages;
- reports viewport changes on resize and scroll;
- receives jump/viewport/cursor/cursor-path/partial-rendering/outline messages;
- selects the location nearest the current page;
- scrolls smoothly and shows a ripple;
- keeps DOM selection layers and pseudo links.

The useful lesson is to define a versioned preview protocol and page/location model. Replacing MomoScript preview with typst-dom is not required and is risky because MomoScript also sanitizes render output, injects resources and exports raster formats.

## 5. What must not be copied

### 5.1 Direct package fetch and extraction

Tyraria's `_doResolvePackage` fetches a URL, reads the complete response into memory, ungzips it, loads a tar, and writes each entry into the workspace. The pinned implementation does not establish:

- URL allowlisting or HTTPS enforcement;
- redirect rejection;
- compressed/expanded size and file-count limits;
- digest or immutable version verification;
- canonical path and archive traversal rejection;
- duplicate path handling;
- atomic staging/activation;
- cancellation or origin quota coordination.

MomoScript's package service must implement all of these before enabling external packages.

### 5.2 In-memory workspace as source of truth

Tyraria serializes the in-memory workspace for pastebin sharing but its provider itself is not durable. MomoScript already has a stronger persistent foundation and an active storage/history design. A pastebin flow must never become the primary workspace model.

### 5.3 Product claims based on a proof-of-concept

Tyraria's README explicitly calls the project a proof-of-concept demo and lists missing automated build and workspace fonts. Its existence proves feasibility, not production reliability or completeness.

### 5.4 GPL implementation reuse

Tyraria is GPL-3.0-only. This change uses public behavior and architecture as research evidence; no source code or component is to be copied.

## 6. MomoScript-specific advantages to preserve

1. MMT is a first-class language, not a text wrapper around Typst.
2. Rust DSL v2 provides recoverable syntax, semantic lowering, pack-aware resources and stable source ranges.
3. Embedded Typst is projected with explicit safety modes instead of guessed offset translation.
4. Desktop and Web already share MMT language behavior and fixed Tinymist artifacts.
5. pack-v3 materialization provides real authored avatars and stickers while language projection stays no-I/O.
6. production Web persists edits in IndexedDB and restores them after reload.
7. export already supports four formats.
8. resource downloads already have path, HTTPS, redirect, size, cache and stale-revision boundaries.

The new architecture must make these strengths more coherent, not trade them for a generic Typst editor.

## 7. Prioritization

### P0: correctness before breadth

- finish existing diagnostic/runtime closure;
- one runtime owner and one Typst project-state engine;
- explicit position encoding bridge;
- end-to-end snapshot identity and exact-snapshot export;
- standalone definition/references/rename/formatting/symbols;
- editor-to-preview positioning;
- race/restart/cancellation/unsafe-edit tests.

### P1: complete daily authoring loop

- projected navigation/references/selection/highlights;
- safe projected rename/range formatting/code actions;
- workspace symbols;
- package service with persistent validated cache;
- preview-to-source navigation, viewport state and cursor overlay;
- page-aware incremental preview where supported.

### P2: polish after invariants

- inlay hints, code lens and optional advanced Tinymist providers;
- partial rendering optimization;
- outline presentation;
- preview invert-color strategies;
- fit-page and persistent layout preferences.

### Separate proposals

- public URL sharing/import and privacy/retention policy;
- real-time collaboration/CRDT;
- marketplace or extension ecosystem;
- generic Typst template creation UX.

## 8. Acceptance interpretation

This change is not complete when a capability appears in one host. A capability is complete only when:

1. the fixed native and Web backend artifacts advertise the required provider or the matrix records an intentional absence;
2. standalone `.typ` behavior passes shared native/Worker fixtures;
3. applicable embedded Typst behavior passes Identity-only and unsafe-region fixtures;
4. Desktop Extension Host and production standalone Web exhibit the same semantic result;
5. stale, cancelled and restarted requests cannot publish or edit a newer snapshot;
6. user-visible failure identifies whether it is language, projection, package, resource, render or platform state.
