## ADDED Requirements

### Requirement: One controller owns the editor runtime lifecycle

The editor SHALL create MMT language service, Typst backend, project coordination, package/resource services, preview, export and subscriptions through one `EditorRuntimeController`.

#### Scenario: Startup fails after a child service is created

- GIVEN startup has created one or more child services
- WHEN a later startup stage fails
- THEN the controller MUST dispose created services in reverse creation order
- AND MUST synchronously terminate any Worker or process that misses the graceful deadline
- AND MUST NOT publish editor-ready state

#### Scenario: Runtime quiesces for controlled restart

- GIVEN the editor is ready with active projects
- WHEN PWA update or host shutdown requests quiesce
- THEN the controller MUST reject new preview、package、export and edit-producing feature work
- AND MUST wait for registered persistence barriers and cancellable work up to a bounded deadline
- AND MUST expose one idempotent terminate fallback for unload and HMR

### Requirement: Transport and project state have separate ownership

Worker and process transports SHALL own JSON-RPC transport only. One shared project-state engine SHALL own session、revision、open/applied/retained files、prime scheduling、close grace and replay selection.

#### Scenario: Native and Web accept the same project sequence

- GIVEN a fixture contains full project、increasing deltas、same-revision duplicate、new session and retired-session delta
- WHEN it runs against process and Worker transports
- THEN both MUST accept and reject the same updates
- AND both MUST produce the same open/apply/retain/close transitions

#### Scenario: Backend restarts after deltas

- GIVEN each open source has an accepted full representation followed by zero or more accepted deltas
- WHEN the backend generation fails and a new transport session starts
- THEN all old-generation requests MUST fail
- AND the coordinator MUST materialize each latest applied revision into one complete project representation
- AND MUST replay only those complete latest representations
- AND no retired session or superseded revision may be replayed

### Requirement: Project sessions and revisions are monotonic

A source SHALL have at most one current projection session. New sessions SHALL begin with a full project and revisions SHALL increase strictly within a session.

#### Scenario: Delta arrives for unknown session

- GIVEN no full project was accepted for session S
- WHEN a delta for S arrives
- THEN it MUST be rejected without mutating current state

#### Scenario: Retired session sends a newer-looking revision

- GIVEN session S was retired by accepting full session T
- WHEN S sends a revision larger than T's current numeric revision
- THEN S MUST still be rejected
- AND session-local revision numbers MUST NOT supersede session identity

### Requirement: Every asynchronous request has publishable identity

Feature、package、materialization、preview and export requests SHALL carry enough identity to reject cancellation、old backend generation、old canonical source content、old local document incarnation/version、old complete Typst project graph、old projection and old render inputs. Standalone and projected language requests SHALL include a `TypstProjectSnapshotKey` covering workspace file content and dependency generations. Each open document SHALL receive a non-reused incarnation nonce that is retired on close.

#### Scenario: Old feature response arrives after edit

- GIVEN a projected feature request targets source snapshot N and projection P
- AND the document advances to snapshot N+1
- WHEN the response for N arrives
- THEN it MUST be discarded before range mapping or UI publication

#### Scenario: Materialization completes after a newer render request

- GIVEN materialization for render key R1 is in flight
- AND the source schedules R2
- WHEN R1 completes
- THEN R1 MAY remain in a bounded artifact cache
- BUT MUST NOT replace R2's requested/displayed state

#### Scenario: Dependency changes during standalone request

- GIVEN a standalone definition request captures Typst project snapshot P
- AND another workspace file or package dependency advances the project to P+1
- WHEN the response for P arrives
- THEN it MUST be discarded before publication
- AND the unchanged requesting document version MUST NOT make the response current

#### Scenario: Document closes and reopens with repeated version

- GIVEN a request captured URI U、incarnation I、version V and content C
- AND the document closes and reopens as incarnation I+1 with the same U、V and C
- WHEN the old response arrives
- THEN it MUST be discarded because the incarnation differs
- AND MUST NOT publish or apply edits to the reopened document

### Requirement: Derived artifacts use canonical content keys

The runtime SHALL identify source content、projection、materialization、runtime and render inputs with canonical keys and SHA-256 digests that do not depend on host URI scheme、document-incarnation nonce、editor-local version、object insertion order、filesystem traversal order、cache path、timestamp or platform separator. Local stale tokens SHALL never participate transitively in `ProjectionKey`, `MaterializationKey` or `RenderKey`.

#### Scenario: Native and Web hash the same project

- GIVEN both hosts receive identical canonical URIs and file bytes in different iteration orders
- WHEN they compute project and render identities
- THEN every digest MUST match

#### Scenario: Editor version changes without content change

- GIVEN one open document advances only its local version or is reopened under a new incarnation with identical logical path and bytes
- WHEN canonical projection and render identities are recomputed
- THEN `SourceContentKey` and every derived canonical key MUST remain unchanged
- AND old in-flight responses MUST still be rejected by the local stale token

#### Scenario: Resource bytes change without source edit

- GIVEN source and projection remain unchanged
- WHEN acknowledged pack or materialized resource bytes change
- THEN `MaterializationKey` and `RenderKey` MUST change
- AND the existing preview MUST become stale

### Requirement: Position encoding domains are explicit

MMT client positions、UTF-8 byte ranges and Tinymist backend positions SHALL be distinct typed domains. Routed positions SHALL convert through the exact source and virtual-file line indexes used by the request.

#### Scenario: MMT negotiates UTF-8 and Tinymist uses UTF-16

- GIVEN source and projection contain Chinese and an astral Unicode character
- WHEN a request and response cross both services
- THEN the coordinator MUST convert client position to source bytes、projection bytes and backend position explicitly
- AND the returned range MUST round-trip to the authored client range

#### Scenario: Position splits a code point

- GIVEN a position falls inside a UTF-8 sequence or UTF-16 surrogate pair
- WHEN conversion is requested
- THEN conversion MUST fail
- AND MUST NOT clamp to a neighboring boundary

### Requirement: Runtime work is bounded and latest-wins where appropriate

The runtime SHALL bound retained project generations、request queues、preview artifacts and close/replay work. Preview scheduling SHALL be latest-wins per source without blocking language queries.

#### Scenario: Author edits faster than preview rendering

- GIVEN several render requests queue for one source
- WHEN a newer request supersedes pending older requests
- THEN obsolete cancellable work MUST be aborted
- AND only the newest request may become displayed
- AND language completion/hover requests MUST remain independent

### Requirement: Runtime failures have stable user-visible states

Startup、recovering、ready、quiescing、failed and capability-unavailable states SHALL be distinguishable. Global runtime failures SHALL not be represented as fake document syntax diagnostics.

#### Scenario: Worker fails then recovers

- GIVEN the Web editor has open projects
- WHEN the Tinymist Worker fails
- THEN status MUST show recovery and queued project count
- AND in-flight requests MUST fail promptly
- AND ready state MUST return only after latest projects are replayed and primed
