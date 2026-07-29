# Design: Incremental MMT-to-Typst preview compilation

## 1. Performance model

The edit path is divided into four independently measured planes:

```text
MMT edit
  -> A. Rust frontend
       apply edit -> parse -> semantic checkpoints -> resolve/plan
       -> emit -> Typst precheck -> source map/index -> identity/digests
  -> B. project delivery
       serialize -> Worker/LSP response -> apply delta -> materialize assets
  -> C. Typst compilation
       update shadow VFS -> compile/layout -> debug-span SVG/vector output
  -> D. presentation
       parse/sanitize -> mount/update DOM -> measure locations -> visual-ready
```

The primary scope is A–C. Plane D remains instrumented because an end-to-end number that hides DOM work is not actionable.

Every preview request carries one trace id and reports at least:

- source URI, source version, projection revision, request sequence, and render key when available;
- changed UTF-8 byte range and changed top-level node count;
- parse, semantic, resolve, emit, Typst-precheck, index, digest, and serialization times;
- reused/rebuilt node/chunk/resource counts;
- full/delta project bytes and file upsert/delete counts;
- shadow-VFS map/unmap/skip counts;
- Typst compile/debug-output time;
- SVG parse, DOM update, location measurement, and total visual-ready time;
- coalesced, aborted, stale-discarded, or published outcome.

Production logging remains bounded and disabled by default; benchmark builds retain detailed samples.

## 2. Phase 1: Preserve warm Typst compiler state

### 2.1 Separate language URI from preview compiler URI

The language/Tinymist entry remains revision-scoped:

```text
untitled:/mmt-projection/<source>/<session>/main-<revision>.typ
```

This is required to reject versionless stale Tinymist diagnostics.

The browser preview compiler receives a second, session-stable live path:

```text
/mmt-preview/<logical-source>/<render-session>/main.typ
```

`TypstRenderProjectUpdate` therefore distinguishes:

- immutable mapping identity: source content, projection revision/key, mapping digest, and revision-scoped projection entry;
- mutable compiler mount identity: stable preview session and live entry path.

Only the latter is passed to `$typst.mapShadow` and compile. `PreviewArtifact`, `PreviewSourceIdentity`, exact export, and location requests continue to use immutable `RenderKey`/revision/mapping identity. An old artifact can share the same compiler path with a new artifact because the path is never sufficient to resolve a location.

### 2.2 Content-address virtual files

Each virtual file carries a canonical content digest. `TypstPreviewController` stores `{ path -> digest }`, not `{ path -> deserialized object }`.

On an update:

- equal path + equal digest: do nothing;
- equal path + different digest: `mapShadow` once;
- removed path: `unmapShadow` once;
- new path: `mapShadow` once.

Embedded templates and bundled binary files are installed once per template generation. A source-only edit MUST map only the live entry file. Materialized resources are addressed by the existing materialization/resource-byte keys and are remapped only when their bytes change.

### 2.3 Render-project deltas

The first update in a render session is full. Later updates carry a base revision and explicit file upserts/deletes, resource-plan changes, and immutable identity for the target revision. A gap, restart, unknown base, or digest mismatch rejects the delta and requests one full snapshot; it never guesses or partially applies.

The existing complete project remains available for restart replay and exact export. Deltas are a transport/application representation, not a weakened snapshot model.

### 2.4 Workspace assets

The initial preview may inventory workspace images under the existing limits. Subsequent renders consume a runtime-owned asset mirror updated by workspace file events. They do not recursively read every image again. Raw Typst `image(...)` remains supported; undeclared workspace assets are not silently removed.

## 3. Phase 2: Remove duplicate projection work

`LanguageService` remains the owner of one analyzed snapshot. `ProjectionStore` derives two profiles from it:

- language profile: placeholder-only, revision-scoped entry, no platform I/O;
- render profile: deterministic resource requests and pinned host timestamp.

The shared projection plan contains normalized semantic nodes, actor/resource decisions, local Typst fragments, and dependency keys. Profile-specific emission substitutes only the placeholder/materialized path and timestamp-dependent fragments.

Typst syntax/precheck results are cached by fragment content plus mode/facade version. Unchanged profile-independent fragments are checked once, not once per language projection and again per render request. Whole-source validation remains as a fallback for raw `@typ` or any join that cannot prove syntactic isolation.

Render-project construction is memoized by:

```text
(source content, pack registry digest, emit options/timestamp, template generation)
```

A repeated request for the same revision returns the retained result without re-emission.

## 4. Phase 3: Incremental MMT frontend

This phase begins only if post-Phase-2 timings show that parse/semantic work still consumes at least 15% of warm edit-to-debug-output time and the shared projection phase misses its Rust or total-preview target. A miss in a non-Rust plane does not justify parser complexity.

### 4.1 Incremental document input

The LSP negotiates incremental text synchronization. `DocumentSnapshot` accepts validated UTF-8 edits derived through the existing `LineIndex`; malformed or out-of-order edits retain the last valid snapshot. Full sync remains the recovery path after a version gap.

The implementation starts with `String` plus measured range replacement. A rope/piece table is introduced only if edit application or line-index rebuild is itself material; 40–50 KiB documents do not justify an unmeasured text-storage abstraction.

### 4.2 Parse island resynchronization

Top-level syntax nodes are the parse islands. An edit invalidates the old nodes it intersects and expands to the nearest safe top-level boundary. Fenced bodies, directive blocks, `@reply`, and block open/close edits expand until the new parser reaches a boundary whose normalized content fingerprint and parser state match the old suffix.

If resynchronization is ambiguous, exceeds a bounded scan, or encounters recovery nodes, the parser performs a clean full parse. Incrementality is an optimization, never a second grammar.

Node fingerprints exclude absolute byte offsets. Reused suffix nodes receive shifted ranges through one checked range-delta operation; invalid UTF-8 boundaries or overflow force a full parse.

### 4.3 Semantic dependency checkpoints

Semantic passes are classified explicitly:

- local: body parts, local patch checks, asset/resource marker syntax;
- prefix-state: `@mode`, actor revisions/names, current speaker, back-reference history, unique-actor order;
- document-wide/config: fields whose change affects every emitted node;
- external generation: pack registry/catalog and template/facade generation.

Each top-level node stores an input-state digest, output-state digest, local result digest, diagnostics, and emitted chunk dependency key. After an edit, prefix-state passes restart at the checkpoint before the first changed node and continue until both the incoming state and resulting output match a retained checkpoint. A global/config or external-generation change invalidates its declared dependents directly.

Pack updates invalidate catalog/resolve results but retain syntax. Template updates invalidate emission/precheck but retain parse and semantic results.

### 4.4 Incremental emission and source maps

The emitter produces relative `EmittedChunk` values for the fixed prelude, each semantic top-level unit, and fixed trailer. A chunk contains:

- generated bytes;
- relative source-map entries and origins;
- diagnostics;
- content and dependency digests.

Unchanged chunks are reused. Final assembly may still copy the complete emitted Typst string because the compiler API consumes complete bytes, but it does not repeat semantic formatting, escaping, checking, resource lookup, or source-map classification. Absolute generated ranges are computed by prefix lengths during assembly.

The incremental projection index MUST be equivalent to `ProjectionIndex::new` over a clean full emission. Debug builds and shadow verification compare both paths.

### 4.5 Correctness oracle

Before cutover, incremental mode runs in shadow mode for deterministic edit traces:

```text
incremental snapshot/result
  vs
clean parse + analyze + project with the same inputs
```

The comparison covers AST shape and ranges, diagnostics and labels, actor revisions/speakers, assets/resources, emitted Typst bytes, origins/source map, projected resources, mapping/project/projection digests, and render diagnostics. Any mismatch records the minimal edit trace and falls back to the full result.

## 5. Scheduling and cancellation

One latest-wins queue is owned by `EditorRuntimeController` for render-project request, materialization, and preview compile publication. Per source:

- debounce ordinary typing with a measured 32–75 ms window;
- replace queued work immediately with the newest revision;
- abort fetch/decode/materialization and renderer work on supersession;
- let already-running synchronous Rust/WASM calls finish only if they cannot be interrupted, then discard by request sequence and snapshot identity;
- keep manual Render/Export requests explicit and never coalesce them with ordinary typing.

The current Webview `LatestPreviewRenderQueue` pattern is reused; no second ad-hoc queue or mutable owner is introduced.

## 6. Navigation and artifact invariants

Performance state and artifact state remain separate:

```text
stable live compiler path
  != projection revision
  != mapping/location provider generation
  != RenderKey
```

The location resolver for a displayed artifact captures its render key, mapping digest, coordinate version, revision, exact emitted entry bytes, and immutable measured debug-span map. Preview-to-source requests include the captured revision and are rejected if that generation has been evicted. Editor-to-preview requests reject a displayed artifact older than the editor source. No path performs rendered-text search or DOM-order inference.

A compiler path update may mutate the compiler universe only after the previous artifact has captured all mapping inputs required for navigation and exact export. The mutable compiler world is never queried to answer an old artifact.

## 7. Optional Phase 4: Incremental renderer data plane

The installed typst.ts renderer can consume persistent-session vector data and exposes experimental `renderSvgDiff`; its DOM adapter accepts `new` and `diff-v1`. The current production compiler path, however, produces a full debug SVG and does not produce compatible deltas.

Therefore this phase has a hard qualification gate:

1. pin a native/Web producer artifact and protocol version;
2. prove full snapshot, delta, gap recovery, cancellation, page deletion/reorder, selectable text, debug locations, outline, export, and renderer restart;
3. prove a material improvement after Phases 1–3;
4. retain the full-SVG path until the new producer/consumer passes the same artifact/navigation suite.

No code is copied from Tinymist preview frontend. Integration occurs through a narrow producer/consumer protocol and existing runtime ownership.

## 8. Rollout

Each phase has an independent feature flag and telemetry label:

1. metrics only;
2. digest-based shadow mapping;
3. stable preview compiler entry plus render deltas;
4. shared projection plan;
5. incremental MMT frontend;
6. optional qualified renderer deltas.

Flags support immediate fallback to the clean full rebuild. Release promotion requires focused unit/contract tests, deterministic shadow equivalence, Chromium user-flow verification, Desktop/Web project-protocol parity, and the phase's benchmark target.
