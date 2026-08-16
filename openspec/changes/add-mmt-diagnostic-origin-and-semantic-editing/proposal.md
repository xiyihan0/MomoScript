## Why

MMT editor diagnostics currently stop at the language projection boundary. The fixed Tinymist preview renderer converts a real Typst compile/layout failure into a range-less JSON-RPC internal error when no document is produced, so the Problems UI cannot point to authored `.mmt` text or a dependency. The existing `mmt/mapTypstDiagnostics` request also maps a batch atomically: one malformed, dependency, or ambiguous item discards otherwise valid diagnostics.

MMT additionally lacks native Definition, References, and Rename. Projected Typst rename is independently registered for `{ language: "mmt" }`; adding ordinary MMT LSP capabilities without a single routing decision would make provider registration order determine whether an actor, asset, or embedded Typst symbol is edited.

The language core already owns immutable analysis snapshots, exact UTF-8 syntax ranges, semantic ActorId/AssetId identities, Typst source-map origins, and Identity-only projected edit validation. This change extends those existing contracts rather than introducing text search, a second semantic model, or a looser edit mapper.

## What Changes

- Preserve fixed-renderer compile/layout diagnostics as strictly validated, URI-keyed LSP diagnostic records for both successful renders and compile failures.
- Map entry-document diagnostics to the current `.mmt` snapshot with exact Identity precision when possible and a unique authored-parent coarse fallback otherwise. Preserve non-entry URI/range information.
- Publish preview/build diagnostics by their actual target URI, reject stale batches, keep the last committed preview on compile failure, and recover without consuming a generation.
- Build a snapshot-local semantic occurrence index during Rust lowering for actor and script-asset navigation identities and actor-name/asset rename bindings.
- Implement standard LSP Definition, References, Prepare Rename, and single-document versioned Rename from that immutable index, including full candidate reanalysis before returning edits.
- Add one semantic-route RPC and one language-client middleware path that deterministically selects native MMT, projected Typst, or no provider.
- Remove the competing standalone MMT projected-rename provider while retaining Identity-only formatting, code action, and projected edit validation.
- Rebuild and repin fixed Tinymist native/WASM artifacts only after protocol parity, structured diagnostics, and generation recovery pass.

## Goals

- Real Typst compile/layout diagnostics retain URI, range, severity, message, related information, and renderer identity through native and Web paths.
- One unmapppable diagnostic never removes independent exact or coarse diagnostics.
- Authored-parent fallback remains read-only evidence and never authorizes rename, formatting, code actions, or projected edits.
- Actor aliases share navigation identity while rename edits only the selected authored binding; history markers remain read-only references.
- Script assets support strict single-document semantic rename; Pack assets, Pack/headless actors, builtin speakers, positional identities, unresolved targets, and ambiguous targets do not.
- Native MMT and projected Typst semantic operations are mutually exclusive and independent of VS Code provider registration order.
- Every returned rename edit is versioned, round-trippable, conflict-free, and proven by full pure reanalysis.

## Non-Goals

- Cross-document symbol identity or multi-document rename.
- Preview-click `authoredFallback`, glyph offset refinement, or a decision about `refineRenderTextLocation`; those remain owned by `define-preview-navigation-fallback`.
- Relaxing `ProjectionIndex::typst_to_mmt`, `map_text_edit`, `mmt/validateProjectedEdit`, or any Identity-only editing rule.
- Synthesizing `(0,0)` authored diagnostics for project failures without source spans.
- Parsing Tinymist human-readable diagnostic strings or implementing another Span-to-LSP converter.
- Renaming omitted speakers, history markers, Pack assets, builtin speakers, or references that cannot be exactly reserialized.

## Impact

- Affected stable capability spec: `openspec/specs/language-tooling/spec.md`
- Rust language core: `mmt_rs/src/emit.rs`, projection diagnostic mapping, lowering/analysis semantic data
- Rust language service: `mmt_lsp/src/service.rs`, `mmt_lsp/src/server.rs`, native/WASM protocol transcripts
- Fixed renderer source patch: `third_party/tinymist/patches/0002-mmt-preview-renderer.patch`
- Shared extension/runtime: `editors/vscode/src/previewRendererProtocol.ts`, projected semantic providers and language-client middleware
- Production Workbench: preview renderer session, diagnostic mapping/publication, preview status, and lifecycle
- Fixed native/WASM artifacts, pin metadata, vendored Web package, and SHA-256 inventory

## Relationship to Preview Navigation

This change uses the emitter authored-parent graph only for diagnostic coarse fallback. It does not approve or implement preview-click fallback. `openspec/changes/define-preview-navigation-fallback/` retains its independent decision gates, protocol precision, glyph-offset, and Workbench refinement ownership.
