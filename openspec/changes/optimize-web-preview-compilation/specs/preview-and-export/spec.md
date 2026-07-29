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

### Requirement: Incremental renderer use is capability-qualified

A persistent vector/diff renderer SHALL remain unavailable until a pinned producer and consumer prove the same snapshot, navigation, selectable-text, page, resource, export, cancellation, and restart behavior as the full renderer.

#### Scenario: Consumer supports diff but producer is unqualified

- GIVEN the installed renderer accepts `diff-v1`
- AND the active compiler/preview backend has no qualified delta producer transcript
- WHEN the editor selects a preview path
- THEN it MUST keep the validated full-render path
- AND MUST NOT infer that consumer support alone makes incremental rendering safe

## MODIFIED Requirements

### Requirement: Preview location mapping is artifact- and capability-versioned

Editor/preview navigation SHALL use a qualified versioned location provider whose artifact digest, backend generation, method, and coordinate version are captured by the immutable `PreviewArtifact`, or SHALL use an immutable location map stored with that artifact. A stable mutable compiler path SHALL never substitute for any of these identity fields. The editor SHALL NOT infer semantic source positions by searching rendered text or DOM order.

#### Scenario: Stable compiler path is reused

- GIVEN previews R and R+1 were compiled from the same live compiler path
- AND they captured different render keys or mapping revisions
- WHEN navigation is requested against R
- THEN only R's captured provider/map may answer
- AND R+1's live compiler contents MUST NOT be consulted
