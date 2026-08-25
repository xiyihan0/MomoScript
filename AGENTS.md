# MOMOSCRIPT (MMT) KNOWLEDGE BASE

**Updated:** 2026-08-25
**Platform:** Linux / Rust 1.92+ / Node.js 22.12+ / Python 3.10+

## OVERVIEW
MomoScript (MMT) is a DSL and product toolchain for scripted Momotalk/MoeTalk-style visual storytelling. Rust DSL v2 is the current implementation: it parses recoverable syntax, resolves semantic and pack references, emits Typst projects and projections, and powers native, browser, and NoneBot surfaces. Python DSL v1 and the old React editor are compatibility-only.

## STRUCTURE
```
.
├── mmt_rs/               # Rust DSL v2 parser, semantics, composer edits, packs, CLI, and WASM core
├── mmt_lsp/              # Shared native/WASM language service and versioned project snapshots
├── editors/README.md     # Editor architecture, ownership, validation matrix, and runbook index
├── editors/vscode/       # VS Code Desktop/Web extension, language clients, Workers, and vendored runtimes
├── editors/vscode-web/   # Production browser Workbench, preview, persistence, PWA, and product UI
├── typst_sandbox/        # Typst templates and local pack-v3 build inputs
├── mmt_nonebot_plugin/   # NoneBot adapter using the Rust v2 project pipeline
├── tools/                # Build, publication, validation, and historical workflow tools
├── openspec/             # Stable specs and active design changes
├── mmt_core/             # Legacy Python DSL v1 compatibility
├── web/                  # Retired React editor prototype; do not extend
└── examples/             # Reference scripts and historical outputs
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| **Rust v2 Parsing** | `mmt_rs/src/parser.rs` | Current recoverable syntax parser and source ranges |
| **Rust v2 Pipeline** | `mmt_rs/src/pipeline.rs`, `mmt_rs/src/projection.rs` | Lowering, resolve, materialize, Typst emission, and editor projection |
| **Semantic Composer Edits** | `mmt_rs/src/composer.rs`, `mmt_lsp/src/service.rs` | Preview-authorized, versioned source edits; UI must not synthesize DSL text |
| **Resource Pack v3** | `mmt_rs/src/pack/`, `openspec/changes/design-resource-pack-v3/` | Manifest, entity catalog, selectors, materialization, and EULA boundaries |
| **Language Server** | `mmt_lsp/` | Versioned snapshots, diagnostics, symbols, folding, stdio, and WASM transports |
| **Editor System Guide** | `editors/README.md` | First stop for cross-package architecture, ownership, build/test matrix, and artifact provenance |
| **VS Code Extension** | `editors/vscode/` | Desktop/Web clients, Workers, providers, grammar, pinned runtimes, and build scripts |
| **Standalone Workbench** | `editors/vscode-web/` | Production browser product; start with its `README.md` |
| **Workbench Composition** | `editors/vscode-web/src/main.ts`, `runtimeController.ts`, `runtimeOwner.ts` | Composition root, typed stores, lifecycle, quiesce, and disposal |
| **Preview Host and Protocol** | `previewWebviewHost.ts`, `previewWebviewProtocol.ts`, `previewWebviewRuntime.ts` under `editors/vscode-web/src/` | Typed host/webview boundary and isolated preview runtime |
| **Preview Interaction and Composer** | `previewInteraction.ts`, `previewComposer.ts`, `previewContextMenu.ts`, `avatarPicker.ts` under `editors/vscode-web/src/` | Navigation, semantic context editing, and native Workbench UI |
| **Workspace and PWA** | `filesystem.ts`, `indexedDbWorkspace.ts`, `originStorage.ts`, `pwaUpdate.ts` under `editors/vscode-web/src/` | Persistence, quota, recovery, and offline lifecycle |
| **Runtime Pins and Delivery** | `third_party/tinymist/pin.json`, `editors/vscode-web/src/runtimeArtifacts.ts`, `.github/workflows/editor-runtime.yml` | Source revisions, patches, digests, same-origin artifacts, and CI producer/consumer contracts |
| **Stable Editor Specs** | `openspec/specs/language-tooling/spec.md`, `openspec/specs/web-workbench-shell/spec.md` | Normative language tooling and Workbench topology contracts |
| **Rendering Templates** | `typst_sandbox/mmt_render` | Typst layout and rendering templates |
| **Rust Validation** | `mmt_rs/tests/`, `mmt_lsp/tests/` | Public API, pack, CLI, composer, projection, source-map, and transport contracts |
| **Legacy Python DSL** | `mmt_core/`, `tools/dsl_refactor_check.py` | Historical v1 behavior and golden regression only |

## CONVENTIONS
- **Current Truth Source**: Rust v2 behavior tests plus stable/active OpenSpec define new syntax and product behavior. Python v1 does not.
- **Editor Truth Source**: `editors/README.md` is the navigation and validation index. Preserve the stable `ViewsService` + nested `SplitView` shell and the single `EditorRuntimeController` ownership graph.
- **OpenSpec**: Changes to DSL semantics, rendering, resource resolution, editor behavior, runtime ownership, wire contracts, or public workflows require aligned specs under `openspec/`; validate changed proposals with `openspec validate <change> --strict`.
- **Wire Boundaries**: LSP responses, Worker messages, webview messages, pack manifests, and persisted state are untrusted. Parse with explicit allowlists before state ownership or source mutation.
- **Preview Editing**: Rust/LSP semantic Composer requests are the sole source-edit authority. Webview and Workbench UI pass normalized intent, identity, and coordinates only.
- **Runtime Artifacts**: Revisions, patches, sizes, and SHA-256 values are pinned. Update vendored artifacts through repository scripts; never hand-copy WASM or manually rewrite digests.
- **Browser Delivery**: Workbench production runtimes are verified, content-addressed, same-origin Brotli build artifacts with no external runtime fallback. Pack delivery remains a separate ESA contract.
- **Workspace Tooling**: Rust uses Cargo, editor packages use npm, and Python/NoneBot compatibility workflows use the root `uv` workspace.
- **Logging**: Follow the owning subsystem. Python uses `loguru`; Rust and TypeScript must not introduce a second logging path beside existing runtime/reporting facilities.
- **Assets**: Large pack binaries and local build workspaces remain untracked. Track only schemas, catalogs, fixtures, and metadata intentionally owned by Git.

## ANTI-PATTERNS (THIS PROJECT)
- **NO** root pollution: new tools belong under `tools/` or the owning package.
- **NO** new behavior in `mmt_core/` or `web/`: both are legacy compatibility surfaces.
- **NO** arbitrary file access: asset and pack paths must use the existing sanitized resolver/materializer boundaries.
- **NO** manual golden/vendor/digest edits: use the owning regeneration or vendor script.
- **NO** parallel runtime owners, protocol state, or settings forms: extend the existing controller/service and native VS Code settings contracts.
- **NO** permissive wire normalization: reject unknown enum values, keys, URI schemes, stale identities, and malformed payloads.
- **NO** permanent local paths or cache links in Git, including `.vscode-test` symlinks.

## COMMANDS
```bash
# Python/NoneBot compatibility dependencies
uv sync

# Rust v2 core and shared language server
cargo test --locked --manifest-path mmt_rs/Cargo.toml --all-targets
cargo test --locked --manifest-path mmt_lsp/Cargo.toml --all-targets

# VS Code Desktop/Web extension
npm --prefix editors/vscode ci
npm --prefix editors/vscode run check
npm --prefix editors/vscode run build
npm --prefix editors/vscode run test:grammar
npm --prefix editors/vscode run test:runtime-characterization

# Pinned Tinymist compatibility; paths must match the checked digest manifests
TINYMIST_BIN=/path/to/tinymist npm --prefix editors/vscode run test:tinymist-process
TINYMIST_WEB_PKG=/path/to/tinymist-web/pkg npm --prefix editors/vscode run test:tinymist-worker
TINYMIST_WEB_PKG=/path/to/tinymist-web/pkg npm --prefix editors/vscode run test:web

# Standalone browser Workbench
npm --prefix editors/vscode-web ci
npm --prefix editors/vscode-web run check
npm --prefix editors/vscode-web run test:runtime-delivery
npm --prefix editors/vscode-web run build
npm --prefix editors/vscode-web run test:e2e

# Validate an OpenSpec change
openspec validate <change-name> --strict

# Export a Rust v2 Typst project
cargo run --manifest-path mmt_rs/Cargo.toml --bin mmt-compile -- --help

# Run the legacy Python golden regression or the bot
uv run tools/dsl_refactor_check.py
uv run bot.py
```

## NOTES
- **OpenSpec Entry**: Start with `openspec/project.md`, then the relevant stable spec and active change. Research notes are not approved implementation contracts.
- **Web Product**: `editors/vscode-web/` is the production browser editor. `web/` is a retired prototype.
- **Typst**: Native final compilation targets Typst 0.15; browser preview uses pinned Tinymist/Typst compiler artifacts described by the editor guide and workflow.
- **Runtime Publication**: `tools/cdn/publish_tinymist_runtime.mjs` publishes immutable identity/Brotli objects; it does not re-run `wasm-opt`. Publication must verify public CORS, media type, encoding, digest, and `WebAssembly.validate`.
- **Credentials**: Never read, print, or modify ambient credential contents. Use a `mktemp` copy created under `umask 077`, pass it explicitly, and delete it with a trap.
- **EULA**: Some packs require user-specific acceptance and are not redistributed under the repository license.
- **Legacy Engine**: `MMT_DSL_ENGINE=legacy` is deprecated and unsupported for new behavior.
