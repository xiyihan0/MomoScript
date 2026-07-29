# Proposal: Optimize Web preview compilation

## Summary

MomoScript SHALL reduce warm edit-to-preview latency without weakening MMT semantics, preview navigation, snapshot identity, resource safety, exact export, or Desktop/Web parity.

The change focuses on compilation in three layers:

1. reuse the browser Typst compiler's warm state instead of invalidating unchanged virtual files on every revision;
2. stop rebuilding and retransmitting unchanged MMT projection work;
3. add a true incremental MMT analysis/emission path only after stage timings prove that the Rust frontend remains material.

Incremental renderer deltas are a later, capability-gated optimization. They are not a prerequisite for the compilation work and SHALL NOT replace the current renderer until a pinned producer/consumer pair passes navigation and artifact-identity fixtures.

## Why

Warm edits currently repeat full MMT analysis/emission, remap unchanged browser virtual files, and compile through a revision-specific preview entry path. This discards reusable compiler state and makes a one-character edit behave like a fresh project. The optimization needs its own change because the safe fix crosses Rust snapshots, projection protocol, browser compiler state, runtime scheduling, preview artifact identity, and navigation regression gates.

## Observed baseline

Current code has several deterministic cold-path behaviors on every edit:

- `LanguageService::upsert` rebuilds `analyze_text_with_pack` from the complete source;
- `ProjectionStore::upsert` emits a placeholder language projection, and `build_render_project_generation` emits/checks a second render projection for the same analysis;
- every render response is `full: true` and includes all embedded templates again;
- the preview maps a file again whenever the deserialized `TypstVirtualFile` object is different, even when its path and bytes are unchanged;
- the render entry URI inherits the language projection's revision-scoped `main-<revision>.typ`, so the browser compiler never sees a stable live entry path;
- preview output is still one full debug SVG, followed by full parse/sanitize/mount.

A 42.6 KiB / 973-line source trace captured on 2026-07-19 measured approximately 7.96 s from edit to preview-ready: 1.40 s in Typst render/compile, 0.91 s SVG parse/sanitize, 4.12 s DOM mount, and 18.3 ms location measurement. The first change in this proposal targets the avoidable compiler invalidation and duplicate projection work. DOM replacement remains measured but is not allowed to redirect this change into another broad UI rewrite.

The restored current checkout passes `npm run test:e2e:preview-interaction` with 3/3 Chromium cases, including selectable text, workspace images, bidirectional navigation, and scroll preservation. Those behaviors are the regression baseline, not optional follow-up work.

## What Changes

- Instrument the complete edit-to-preview path with revision-bound stage timings and reuse counters.
- Give the browser preview compiler a stable live entry path while keeping Tinymist language entries revision-scoped and preview artifacts immutable.
- Make render virtual files content-addressed, transmit lossless full/delta project updates, and stop remapping unchanged templates/resources.
- Share profile-independent MMT analysis/projection work, then add checkpointed incremental parsing, semantic lowering, emission, and source maps only when measured.
- Extend the runtime-owned latest-wins queue across render-project construction, materialization, compilation, and publication.
- Keep incremental renderer/vector deltas behind a separate pinned producer/consumer qualification gate.

## Goals

### G1. Warm compiler state

Unchanged templates, fonts, packages, resources, and compiler entry identity SHALL remain reusable across source-only edits. A one-character edit SHALL invalidate only the authored render entry and its true dependents.

### G2. Incremental MMT work

MMT parsing, sequential semantic state, resource planning, Typst checking, emission, source-map construction, and project digesting SHALL expose per-stage timings and reuse unchanged work where correctness can be proven. Every incremental result MUST be byte-for-byte or structurally equivalent to a clean full rebuild.

### G3. Latest-wins scheduling

Rapid edits SHALL coalesce before expensive render-project construction. Work that has not started SHALL be discarded; asynchronous materialization and renderer work SHALL be aborted when superseded. Synchronous Rust/WASM work that cannot be interrupted SHALL be prevented from publishing stale results.

### G4. No navigation regression

Editor-to-preview and preview-to-source navigation SHALL remain bound to the displayed `RenderKey`, projection revision, mapping digest, and location-provider generation. A stable compiler path SHALL NOT become artifact identity and SHALL NOT permit an old preview to query a newer mapping.

### G5. Evidence-driven renderer decision

The project SHALL first measure the gains from stable compiler identity and incremental project updates. Tinymist/typst.ts `diff-v1` rendering MAY proceed only if a pinned producer is qualified and materially improves the remaining bottleneck.

## Success criteria

The benchmark harness SHALL use deterministic small, medium, and large fixtures, including a synthetic fixture matching the observed 40–50 KiB structural distribution without committing user content. It SHALL measure cold open and at least 20 warm edits at document start, middle, and end.

For the large warm-edit fixture, compared with the checked pre-change baseline on the same browser and build:

- MMT snapshot-to-render-project CPU time: at least 70% lower at p50 and 50% lower at p95;
- browser Typst compile/debug-SVG time: at least 50% lower at p50 and 35% lower at p95;
- edit-to-preview-ready time: at least 30% lower at p50, while reporting DOM time separately;
- unchanged template/resource remaps: zero;
- stale rendered publications: zero during a 20 Hz edit burst;
- incremental/full output mismatches: zero across deterministic randomized edit sequences;
- preview-navigation, exact-export, resource-limit, offline, and Desktop/Web parity fixtures: no regressions;
- retained snapshots, file generations, caches, and queues: bounded after 500 edits.

A phase that misses its own target SHALL remain behind its feature flag and SHALL NOT be used to justify the next architectural phase.

## Impact

- Rust: `mmt_rs` incremental analysis/emission boundaries and `mmt_lsp` document/projection stores and render-project protocol.
- Shared editor host: Typst project state, protocol identity, restart replay, and Desktop/Web parity fixtures.
- Web runtime: render scheduling, workspace asset mirror, preview compiler shadow VFS, timing, and publication guards.
- Compatibility: no DSL/rendering behavior change; full snapshots and clean full rebuild remain the recovery oracle during rollout.
- Risk: stable compiler paths can alias stale mappings unless the immutable artifact contract remains separate; every phase is gated on bidirectional navigation and exact-export tests.

## Non-Goals

- Changing MMT syntax, semantic meaning, Typst template output, resource-pack semantics, or visual layout.
- Replacing `ViewsService`, native `SplitView`, or `EditorRuntimeController` ownership.
- Making the language/Tinymist projection entry URI stable; revision-scoped language URIs remain required because Tinymist diagnostics do not carry document versions.
- Treating a stable renderer path as immutable preview identity.
- Copying Tinymist preview frontend code or enabling `diff-v1` from an unqualified producer.
- Hiding stale, mapping, fetch, decode, compile, or layout failures to improve timing numbers.

## Dependencies and ownership

This change extends, but does not redefine:

- `complete-editor-runtime-and-typst-tooling`: `RenderKey`, immutable preview artifacts, navigation, export, runtime ownership, and capability qualification;
- `add-mmt-lsp-vscode`: versioned MMT snapshots, separate language/render projections, no-I/O analysis, and revision-scoped Tinymist language documents;
- `redesign-dsl-syntax-v2`: syntax AST, semantic IR, source ranges, emitter, and resource resolution;
- `design-resource-pack-v3`: materialization identity, size limits, cache keys, and decoder policy.
