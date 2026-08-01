## ADDED Requirements

### Requirement: Preview compilation exposes comparable stage evidence

The editor SHALL measure MMT frontend, project delivery/materialization, Typst compilation/debug output, presentation, and total visual-ready latency under one revision-bound trace identity. Benchmark evidence SHALL distinguish cold and warm runs and SHALL report p50/p95 rather than one favorable sample.

#### Scenario: One-character warm edit

- GIVEN the large deterministic benchmark document has rendered successfully
- WHEN one character changes at the start, middle, or end
- THEN the trace MUST identify the same source version/projection revision across all stages
- AND MUST report rebuilt/reused work, virtual-file changes, compile time, DOM time, stale outcome, and total visual-ready time

### Requirement: Mutable compiler mount identity is not artifact identity

The browser preview compiler MAY use one stable live entry path per logical source and render session. Preview navigation, diagnostics, exact export, and publication SHALL continue to use immutable source content, projection revision/key, mapping digest, materialization/runtime identity, and `RenderKey`. The language/Tinymist projection SHALL retain its revision-scoped entry URI.
The stable compiler mount is mutable execution state only and MUST NOT participate in `SourceContentKey`, `TypstProjectSnapshotKey`, `ProjectionKey`, `MaterializationKey`, `RenderKey`, or location-provider identity.

#### Scenario: Compiler path advances while an old artifact remains displayed

- GIVEN artifact R captured projection revision N and mapping digest M
- AND the live compiler path now contains revision N+1
- WHEN the user navigates or exports artifact R
- THEN the operation MUST use R's captured revision, mapping/location data, and render key
- AND MUST NOT query or export the mutable N+1 compiler world as R

### Requirement: Unchanged virtual inputs are not invalidated

A warm source-only edit SHALL update only virtual files whose canonical content digest changed. Template, font, package, workspace asset, and materialized-resource generations SHALL remain mapped when their digests are unchanged.

#### Scenario: Source-only edit with stable dependencies

- GIVEN the preview compiler already mapped the entry, templates, fonts, packages, and resources
- WHEN only authored MMT text changes
- THEN the host MUST update the stable live entry file
- AND MUST perform zero map/unmap operations for unchanged dependencies

### Requirement: Render-project deltas are lossless and recoverable

A render-project delta SHALL identify its base and target revision, file upserts/deletes, resource-plan changes, and complete immutable target identity. Unknown base, restart, sequence gap, or digest mismatch SHALL reject the entire delta and obtain one clean full snapshot.

#### Scenario: Delta arrives after a missed revision

- GIVEN the host retained revision N
- AND receives a delta based on N+1 targeting N+2
- WHEN the update is applied
- THEN no partial file/resource state MUST be visible
- AND the host MUST request or accept a full N+2 snapshot before compiling

### Requirement: Incremental MMT results equal clean full rebuilds

Incremental parse, semantic lowering, resolution, emission, Typst checking, source maps, resources, diagnostics, and canonical identities SHALL have one clean full-rebuild oracle. Ambiguous resynchronization or any mismatch SHALL fall back to that oracle and SHALL remain observable in benchmark diagnostics.

#### Scenario: Sequential semantic state changes

- GIVEN a document uses `@mode`, actor revisions, omitted speakers, `_n` back references, `~n` unique references, and resources after the edited node
- WHEN an edit changes a prefix-state input
- THEN incremental analysis MUST recompute until a verified semantic fixed point or EOF
- AND its final outputs MUST equal a clean full rebuild for the same source and external generations

#### Scenario: Fence or directive boundary becomes ambiguous

- GIVEN an edit changes a fence, directive opener, directive terminator, or reply boundary
- WHEN the incremental parser cannot prove suffix resynchronization within its bound
- THEN it MUST perform a clean full parse
- AND MUST NOT publish a partially reused AST

### Requirement: Rapid preview work is latest-wins

Ordinary typing preview work SHALL be coalesced per source. Queued superseded work SHALL be replaced, asynchronous work SHALL be aborted where supported, and non-interruptible work SHALL be rejected at publication by request sequence and complete snapshot identity. Manual render and exact export SHALL remain explicit operations.

#### Scenario: Edits arrive faster than compilation

- GIVEN revisions N through N+9 arrive while revision N is compiling
- WHEN the queue drains
- THEN intermediate queued revisions SHOULD NOT start expensive preview work
- AND no revision older than N+9 may publish preview, navigation mapping, diagnostics, or export state

### Requirement: Persistent renderer use is capability-qualified

The editor SHALL use a pinned Tinymist 0.15.2 `new`/`diff-v1` producer and typst.ts 0.8.0-rc3 consumer behind one qualification gate. The visible Webview SHALL be the sole preview DOM and viewport owner. It SHALL retain one persistent render session, create page shells from immutable page metadata, and patch only a bounded visible document window with the package-exported structured DOM patcher. No window SHALL retain more than eight populated page buffers. Consumer replay SHALL be bounded to 64 frames and 128 MiB. The producer SHALL compile with the same pinned immutable font bytes as the browser compiler; each font SHALL be content-digested, resource-bounded, and validated before use.

#### Scenario: One-character edit on a tall report

- GIVEN the displayed artifact has a committed renderer generation
- WHEN a one-character edit produces a sequential delta
- THEN the Webview MUST require the exact base generation
- AND MUST patch the visible document window without replacing the complete SVG
- AND MUST perform zero eager full-document source-location measurements
- AND MUST acknowledge visual readiness only after viewport restoration, its queued window render, two animation frames, and a final matching render-generation check

#### Scenario: Viewport repeatedly crosses window boundaries

- GIVEN the renderer has a displayed SVG root and bounded resource headers
- WHEN scrolling repeatedly changes the rendered window and returns to the same viewport
- THEN the displayed SVG root identity MUST remain unchanged
- AND complete glyph, clip, and style headers MUST replace or deduplicate prior headers rather than append duplicates
- AND the resource-rule count, populated page buffers, and rendered DOM count at that viewport MUST remain bounded

#### Scenario: Renderer compiles selectable text with pinned fonts

- GIVEN the projected Typst document contains text using a pinned browser font
- WHEN the producer registers and renders the immutable project snapshot
- THEN its compiler world MUST resolve that exact content-digested font record
- AND the rendered generation MUST contain the expected selectable glyph text
- AND a missing, invalid, oversized, or digest-mismatched font record MUST fail without publication

### Requirement: Renderer generations preserve displayed navigation

Each backend session SHALL retain exactly the committed/displayed and staged document generations. A staged render SHALL NOT invalidate location queries for the displayed artifact. Commit SHALL occur only after a matching visual-ready acknowledgement; cancellation, staleness, failure, or close SHALL discard staged state.

#### Scenario: New generation compiles behind displayed artifact

- GIVEN generation N is displayed and queryable
- AND generation N+1 is staged
- WHEN navigation targets generation N
- THEN the backend MUST resolve the request against generation N
- AND MUST NOT consult generation N+1

### Requirement: Renderer artifacts support immutable exact export

A renderer-backed `PreviewArtifact` MAY retain immutable identity, artifact digest, page geometry, and page count instead of canonical full-SVG bytes. SVG, PNG, JPG, and PDF export SHALL rebuild the requested render key from pinned retained render/runtime inputs and SHALL NOT read mutable live DOM or compiler state. Full sanitized SVG SHALL remain an explicit differential/recovery oracle and MUST NOT be invoked silently for ordinary edits.

#### Scenario: Export renderer artifact after live state advances

- GIVEN renderer artifact R remains retained after the live renderer advances
- WHEN the user exports R
- THEN export MUST pin R and its immutable inputs for the operation
- AND MUST rebuild bytes for R
- AND MUST reject stale current-preview selection according to the existing render-key policy

### Requirement: Renderer resynchronization is bounded

Unknown base, restart, sequence gap, digest mismatch, or malformed frame SHALL publish no partial generation and SHALL permit exactly one forced-full retry. A second mismatch SHALL fail visibly and close the affected renderer session.

#### Scenario: Delta base is missing

- GIVEN the consumer does not retain the requested base generation
- WHEN a `diff-v1` frame arrives
- THEN it MUST reject the frame without mutation
- AND the host MUST request one forced `new` frame
- AND an accepted `new` frame MUST replace the consumer session and complete resource headers while preserving the displayed SVG root identity
- AND no further automatic full fallback may occur

## MODIFIED Requirements

### Requirement: Preview location mapping is artifact- and capability-versioned

Editor/preview navigation SHALL use a qualified versioned location provider whose session id, snapshot token, artifact digest, backend generation, method, and coordinate version are captured by the immutable `PreviewArtifact`, or SHALL use an immutable location map stored with a full-SVG oracle artifact. The provider SHALL resolve the requested committed or staged renderer generation before querying the Typst document. A stable mutable compiler path SHALL never substitute for any identity field. The editor SHALL NOT infer semantic source positions by searching rendered text or DOM order.

#### Scenario: Stable compiler path is reused

- GIVEN previews R and R+1 were compiled from the same live compiler path
- AND they captured different render keys or mapping revisions
- WHEN navigation is requested against R
- THEN only R's captured provider/map may answer
- AND R+1's live compiler contents MUST NOT be consulted
