## ADDED Requirements

### Requirement: Preview displays immutable render artifacts

A preview panel SHALL display one immutable `PreviewArtifact` identified by `RenderKey`. A newer source、resource、package、font or runtime generation SHALL mark the artifact stale rather than mutating its identity.

#### Scenario: Source changes after preview

- GIVEN preview displays render key R for source version N
- WHEN the source advances to N+1
- THEN R MUST be marked stale immediately
- AND MAY remain visible until a new artifact is ready
- AND no location or export action may treat R as version N+1

### Requirement: Preview output is page-aware and validated

Renderer output SHALL be normalized into page records with compiler coordinate geometry. SVG、XHTML selection layers and links SHALL be validated before mounting.

#### Scenario: Renderer returns invalid SVG root

- GIVEN renderer output has no valid SVG namespace root
- WHEN preview processing runs
- THEN the artifact MUST fail validation
- AND the invalid DOM MUST NOT be mounted
- AND a revision-bound preview/build diagnostic MUST be published

#### Scenario: Multiple pages are displayed

- GIVEN a render contains multiple pages
- WHEN page gaps and zoom are applied
- THEN compiler page coordinates MUST remain independent of presentation gaps
- AND location mapping MUST use normalized page geometry

### Requirement: Preview location mapping is artifact- and capability-versioned

Editor/preview navigation SHALL use a qualified versioned location provider whose artifact digest、backend generation、method and coordinate version are captured by the immutable `PreviewArtifact`, or SHALL use an immutable location map stored with that artifact. The editor SHALL NOT infer semantic source positions by searching rendered text or DOM order.

#### Scenario: No qualified location provider exists

- GIVEN the active backend/renderer does not expose a compatible location method
- WHEN the user requests editor-to-preview navigation
- THEN the command MUST be unavailable or explain the capability absence
- AND MUST NOT guess a page by text matching

#### Scenario: Location provider restarts while old preview remains displayed

- GIVEN preview R captured location provider generation G
- AND the backend restarts as generation G+1 with no retained immutable map for R
- WHEN navigation is requested against R
- THEN navigation MUST report stale or capability unavailable
- AND MUST NOT query G+1 under R's old coordinate contract

### Requirement: Editor-to-preview navigation is snapshot-bound

Selection navigation SHALL capture the current source snapshot and displayed render key, map MMT through the exact projection and reject stale identities.

#### Scenario: Displayed preview is older than editor

- GIVEN editor is on source version N+1
- AND preview displays a render derived from N
- WHEN the selection changes
- THEN preview MUST NOT jump using N+1 coordinates against N
- AND status MUST identify that preview is stale

#### Scenario: Multiple preview locations exist

- GIVEN a source location maps to points on several pages
- WHEN preview navigates
- THEN it SHOULD choose the candidate nearest the currently visible page
- AND MUST show a bounded visual position indicator

### Requirement: Preview-to-source navigation preserves authored boundaries

A preview location SHALL navigate to authored MMT for Identity mappings、writable workspace Typst for real files or read-only virtual projection/package files for retained generated dependencies.

#### Scenario: User clicks generated wrapper output

- GIVEN the selected preview location resolves to Synthetic projection content
- WHEN source navigation runs
- THEN the editor MUST NOT invent an MMT authored range
- AND MAY open the exact retained virtual projection read-only

#### Scenario: Location generation was evicted

- GIVEN preview still displays an artifact whose mapping generation is no longer retained
- WHEN the user requests source navigation
- THEN navigation MUST fail visibly as unavailable
- AND MUST NOT map against the latest projection

### Requirement: Viewport and cursor state are per document

Viewport page、normalized position、zoom、fit mode and cursor overlay SHALL be keyed by logical workspace and source URI. Generated DOM identifiers SHALL not be persisted.

#### Scenario: User switches between documents

- GIVEN documents A and B have distinct preview viewports
- WHEN the user returns from B to A
- THEN A's compatible viewport and zoom SHOULD restore
- AND B's state MUST NOT overwrite A

#### Scenario: Cursor source becomes stale

- GIVEN a cursor overlay belongs to render key R
- WHEN a new source or render key becomes active
- THEN the old overlay MUST be removed before the new artifact is interactive

### Requirement: Incremental and partial rendering never mix snapshots

Incremental or partial rendering MAY be enabled only when compatible protocol capability is negotiated. Every batch SHALL belong to one render generation; gaps or reordering SHALL force a full refresh.

#### Scenario: Incremental batch is missing

- GIVEN artifact generation expects batch K
- WHEN batch K+1 arrives first
- THEN the host MUST discard incomplete incremental state
- AND request or wait for a complete full artifact

#### Scenario: Partial pages are rendering

- GIVEN only part of a render key is available
- WHEN export is requested
- THEN export MUST reject the partial artifact

### Requirement: Export uses the displayed exact snapshot

SVG、PNG and JPEG SHALL derive from the displayed sanitized SVG artifact. PDF SHALL compile from immutable files、resources、fonts and runtime artifacts represented by the displayed `RenderKey`.

#### Scenario: User exports stale displayed revision

- GIVEN displayed render key R is stale and latest render is pending
- WHEN export is requested
- THEN the UI MUST offer an explicit choice to export R or wait for latest
- AND MUST NOT silently export mutable current renderer state

#### Scenario: PDF inputs were evicted

- GIVEN displayed SVG remains but immutable compiler inputs for R are unavailable
- WHEN PDF export is requested
- THEN export MUST fail as `ArtifactUnavailable`
- AND MUST NOT compile the current project under R's filename

#### Scenario: Raster export is requested

- GIVEN displayed SVG artifact passed sanitization
- WHEN PNG or JPEG export runs
- THEN rasterization MUST consume that artifact and its page geometry
- AND output MUST identify R in host-side export evidence

### Requirement: Preview diagnostics are durable and revision-bound

Renderer、package、resource fetch/decode、layout and location failures tied to a source SHALL use preview/build diagnostics for that exact revision. Toasts MAY summarize but SHALL not be the only record.

#### Scenario: Resource failure occurs for old render

- GIVEN resource materialization for R1 fails after R2 is requested
- WHEN diagnostics publish
- THEN R1 failure MUST NOT replace R2 diagnostics
- AND MAY be retained only as historical/debug state
