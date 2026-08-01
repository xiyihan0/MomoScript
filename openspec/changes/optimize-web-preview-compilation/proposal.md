# Proposal: Optimize Web preview compilation

## Summary

MomoScript SHALL reduce warm edit-to-preview latency without weakening MMT semantics, preview navigation, snapshot identity, resource safety, exact export, or Desktop/Web parity.

The change spans four coupled layers:

1. reuse the browser Typst compiler's warm state instead of invalidating unchanged virtual files on every revision;
2. stop rebuilding and retransmitting unchanged MMT projection work;
3. keep the clean Rust frontend because stage evidence proves it is already immaterial; and
4. activate a capability-gated persistent renderer because presentation and eager location work now dominate warm visual-ready latency.

The renderer uses a pinned Tinymist 0.15.2 `new`/`diff-v1` producer and pinned typst.ts 0.8.0-rc3 consumer. The visible Webview is the sole DOM and viewport owner. Full sanitized SVG remains an explicit differential/recovery oracle, not the ordinary per-edit publication path.

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

A second real-report trace on a 42,635-byte / 973-line, one-long-page source measured approximately 6.24 s for a one-character warm edit. Rust analysis was below 0.4%, while native DOM update, eager source-location geometry, and repeated image inlining accounted for roughly 64% of visual-ready time. This evidence activates the previously gated renderer phase: the remaining material work is presentation and location, not parser complexity.

The restored current checkout passes `npm run test:e2e:preview-interaction` with 3/3 Chromium cases, including selectable text, workspace images, bidirectional navigation, and scroll preservation. Those behaviors are the regression baseline, not optional follow-up work.

## What Changes

- Instrument the complete edit-to-preview path with revision-bound stage timings and reuse counters.
- Give the browser preview compiler a stable live entry path while keeping Tinymist language entries revision-scoped and preview artifacts immutable.
- Make render virtual files content-addressed, transmit lossless full/delta project updates, and stop remapping unchanged templates/resources.
- Share profile-independent MMT analysis/projection work, then add checkpointed incremental parsing, semantic lowering, emission, and source maps only when measured.
- Extend the runtime-owned latest-wins queue across render-project construction, materialization, compilation, and publication.
- Add a pinned persistent Tinymist/typst.ts renderer data plane with viewport-windowed structured DOM patching, generation-bound location queries, and immutable exact-export rebuilds.

## Goals

### G1. Warm compiler state

Unchanged templates, fonts, packages, resources, and compiler entry identity SHALL remain reusable across source-only edits. A one-character edit SHALL invalidate only the authored render entry and its true dependents.

### G2. Incremental MMT work

MMT parsing, sequential semantic state, resource planning, Typst checking, emission, source-map construction, and project digesting SHALL expose per-stage timings and reuse unchanged work where correctness can be proven. Every incremental result MUST be byte-for-byte or structurally equivalent to a clean full rebuild.

### G3. Latest-wins scheduling

Rapid edits SHALL coalesce before expensive render-project construction. Work that has not started SHALL be discarded; asynchronous materialization and renderer work SHALL be aborted when superseded. Synchronous Rust/WASM work that cannot be interrupted SHALL be prevented from publishing stale results.

### G4. No navigation regression

Editor-to-preview and preview-to-source navigation SHALL remain bound to the displayed `RenderKey`, projection revision, mapping digest, and location-provider generation. A stable compiler path SHALL NOT become artifact identity and SHALL NOT permit an old preview to query a newer mapping.

### G5. Qualified persistent rendering

The visible Webview SHALL own the only preview DOM and viewport. A pinned Tinymist producer and typst.ts consumer SHALL retain generation-bound `new`/`diff-v1` state, render only a bounded viewport window, patch structured DOM, and answer source queries on demand. Promotion remains capability-gated on native/Web transcript parity and full-oracle differential fixtures.

## Success criteria

The benchmark harness SHALL use deterministic small, medium, and large fixtures, including a synthetic fixture matching the observed 40–50 KiB structural distribution without committing user content. It SHALL measure cold open and at least 20 warm edits at document start, middle, and end.

For the generated real-report fixture, compared with explicit full-SVG oracle mode on the same browser and build:

- total visual-ready latency: at least 35% lower at p50 and 25% lower at p95;
- edit-to-painted-visual-ready Chromium `Performance.TaskDuration`: at least 70% lower at p50;
- eager full-document location measurements: zero;
- unchanged template/resource remaps and identity/protocol mismatches: zero;
- stale rendered publications: zero during a 20 Hz edit burst;
- renderer state: at most 8 backend sessions, 2 queryable generations per session, 8 populated page/window buffers, and a consumer replay log bounded to 64 frames / 128 MiB;
- retained traces: at most 512 samples;
- immutable artifact metadata: at most 32 MiB;
- active preview work: at most one job;
- full-oracle differential mismatches and preview-navigation, exact-export, resource-limit, offline, and Desktop/Web parity regressions: zero.

A phase that misses its own target SHALL remain behind its feature flag and SHALL NOT be used to justify the next architectural phase.

## Impact

- Rust/shared host: pinned Tinymist renderer and snapshot-bound location protocols, two-generation session state, synthetic preview-project synchronization, native/Web parity fixtures, and restart replay.
- Web runtime: one persistent typst.ts render session in the visible Webview, viewport-windowed DOM patching, latest-wins publication, immutable renderer artifacts, timing, and explicit full-SVG oracle mode.
- Compatibility: no DSL/rendering behavior change; exact SVG/PNG/JPG/PDF exports rebuild from retained immutable render/runtime inputs.
- Risk: mutable renderer generations can alias stale mappings unless committed and staged documents remain independently queryable and publication commits only after a matching visual-ready acknowledgement.
- Risk: stable compiler paths can alias stale mappings unless the immutable artifact contract remains separate; every phase is gated on bidirectional navigation and exact-export tests.

## Non-Goals

- Changing MMT syntax, semantic meaning, Typst template output, resource-pack semantics, or visual layout.
- Replacing `ViewsService`, native `SplitView`, or `EditorRuntimeController` ownership.
- Making the language/Tinymist projection entry URI stable; revision-scoped language URIs remain required because Tinymist diagnostics do not carry document versions.
- Treating a stable renderer path as immutable preview identity.
- Copying Tinymist preview frontend code, loading renderer code from a CDN, or enabling an unpinned producer/consumer pair.
- Hiding stale, mapping, fetch, decode, compile, or layout failures to improve timing numbers.
- Treating the explicit full sanitized-SVG oracle as a silent ordinary-render fallback.

## Dependencies and ownership

This change extends, but does not redefine:

- `complete-editor-runtime-and-typst-tooling`: `RenderKey`, immutable preview artifacts, navigation, export, runtime ownership, and capability qualification;
- `add-mmt-lsp-vscode`: versioned MMT snapshots, separate language/render projections, no-I/O analysis, and revision-scoped Tinymist language documents;
- `redesign-dsl-syntax-v2`: syntax AST, semantic IR, source ranges, emitter, and resource resolution;
- `design-resource-pack-v3`: materialization identity, size limits, cache keys, and decoder policy.
