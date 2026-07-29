## 0. Baseline and correctness gates

- [x] 0.1 Add one cross-plane trace id and timing schema for Rust analysis/projection, project delivery/materialization, Typst compile/debug output, DOM update, and visual-ready
- [x] 0.2 Add deterministic small, medium, and 40–50 KiB synthetic benchmark fixtures without committing user-authored source
- [x] 0.3 Record cold open plus 20 warm start/middle/end edits on the pinned local Chromium build
- [x] 0.4 Record rebuilt/reused nodes/chunks/resources, protocol bytes, shadow map/unmap/skip counts, stale discards, and queue depth
- [x] 0.5 Pin the current bidirectional navigation, selectable-text, workspace-image, scroll, exact-export, diagnostics, resource-limit, and offline behavior as hard regression gates
- [x] 0.6 Add a 20 Hz edit-burst fixture proving only the newest revision can publish
- [x] 0.7 Add a 500-edit soak fixture proving retained generations, caches, mappings, and queues stay bounded

## 1. Warm browser compiler reuse

- [x] 1.1 Add canonical content digests to render-project virtual files and materialized resource files
- [x] 1.2 Compare preview shadow files by path plus digest instead of deserialized object identity
- [x] 1.3 Install template/font/package generations once and prove a source-only edit remaps only the authored entry
- [x] 1.4 Introduce a stable preview-compiler entry path while retaining revision-scoped Tinymist language entries
- [x] 1.5 Keep projection entry/revision/mapping digest separate from mutable preview compiler mount identity in protocol types
- [x] 1.6 Add full-first, base-revision render-project file/resource deltas with reject-and-resnapshot gap recovery
- [x] 1.7 Replace per-render recursive workspace image reads with a runtime-owned, file-event-updated bounded asset mirror
- [x] 1.8 Verify old displayed artifacts navigate/export from captured immutable data after the live compiler path advances
- [x] 1.9 Run the Phase-1 benchmark and keep the cutover disabled unless unchanged remaps reach zero and Typst compile p50 improves by at least 50%

## 2. Shared analysis and projection plan

- [x] 2.1 Instrument the current duplicate language/render emit, Typst-precheck, source-map, and digest work
- [x] 2.2 Introduce one profile-independent projection plan derived from the existing analyzed snapshot
- [x] 2.3 Emit placeholder language and resource-aware render profiles from shared normalized nodes and dependency keys
- [x] 2.4 Cache local Typst body/patch checks by content, mode, and façade generation with full-source fallback for unsafe joins/raw Typst
- [x] 2.5 Memoize repeated render-project requests by source, pack registry, emit options/timestamp, and template generation
- [x] 2.6 Preserve all current diagnostics, labels, resource requests, source maps, and canonical identity digests under full-vs-shared differential tests
- [x] 2.7 Run the Phase-2 benchmark and start Phase 3 only if parse/semantic time remains at least 15% of warm edit-to-debug-output time and the shared projection phase misses its Rust or total-preview target

## 3. Incremental Rust frontend

Phase 3 was not started: full parse/semantic/resolve measured 0 ms p50 for every warm fixture and at most 1 ms p95. The remaining Rust emission/index work is 1–4 ms p50 and below 0.4% of visual-ready time, so parser islands/checkpoints cannot materially close the missed end-to-end target.

- [ ] 3.1 Negotiate LSP incremental sync and apply validated UTF-8 edits through the existing position-domain bridge, with full-sync recovery on gaps
- [ ] 3.2 Add top-level parse-island fingerprints and bounded fence/directive/reply resynchronization with full-parse fallback
- [ ] 3.3 Add checked suffix range shifting for reused syntax nodes and diagnostics
- [ ] 3.4 Classify semantic dependencies as local, prefix-state, document-wide/config, or external generation
- [ ] 3.5 Store per-node semantic input/output checkpoints and recompute to a verified fixed point
- [ ] 3.6 Retain syntax across pack changes and retain parse/semantic results across template-only changes
- [ ] 3.7 Emit reusable relative chunks with local origins/source-map entries and assemble checked absolute ranges
- [ ] 3.8 Incrementally maintain resource-plan, mapping, and project digests without using host URI, local version, or mutable compiler path as canonical inputs
- [ ] 3.9 Add deterministic randomized Unicode/fence/block/actor/back-reference/resource edit traces comparing every incremental result with a clean full rebuild
- [ ] 3.10 Keep automatic full fallback on ambiguity or mismatch and expose fallback reason/count in benchmark diagnostics
- [ ] 3.11 Run the Phase-3 benchmark and require the proposal's Rust CPU and zero-mismatch targets before default enablement

## 4. Latest-wins project and preview scheduling

- [x] 4.1 Extend the runtime-owned latest-wins queue across render-project requests, materialization, and preview compile publication
- [x] 4.2 Coalesce ordinary typing per source with a measured debounce while keeping manual Render and exact Export explicit
- [x] 4.3 Abort fetch/decode/materialization and renderer work on supersession; discard non-interruptible Rust/WASM results by request sequence and full snapshot identity
- [x] 4.4 Prove restart replay reconstructs only the newest complete project after any full/delta sequence
- [x] 4.5 Prove rapid edits never publish stale diagnostics, preview, navigation maps, or exact-export state

## 5. Optional qualified incremental renderer

Phase 5 was not started: pinned Tinymist 0.15.2 exposes no qualified `diff-v1` producer preserving selectable text, debug locations, page identity, and immutable-artifact navigation.

- [ ] 5.1 Capture a pinned producer/consumer protocol transcript for full vector state, `diff-v1`, gap recovery, cancellation, and restart on native and Web
- [x] 5.2 Keep this phase unavailable if the producer cannot preserve selectable text, debug locations, page identity, and bounded partial rendering
- [ ] 5.3 Add a persistent renderer session behind a feature flag without changing `PreviewArtifact` or `PreviewInteractionController` contracts
- [ ] 5.4 Verify page insert/delete/reorder, zoom/scroll restore, cursor/indicator, outline, workspace images, and bidirectional navigation against full-render behavior
- [ ] 5.5 Promote only if the post-Phase-3 benchmark proves material additional latency/DOM savings and all capability transcripts pass

## 6. Final cutover verification

- [x] 6.1 Run focused Rust core/LSP tests plus TypeScript project-state, preview-artifact, preview-interaction, resource, runtime-owner, and exact-export contracts
- [x] 6.2 Run real Chromium online/offline preview interaction and rapid-edit scenarios
- [x] 6.3 Run native/Web project protocol parity and restart recovery scenarios
- [x] 6.4 Publish before/after p50/p95 tables for every plane and fixture, including failures and fallbacks
- [x] 6.5 Remove superseded full-update/cache paths only after the default path passes all gates; retain one explicit clean full-rebuild oracle for recovery and differential verification
