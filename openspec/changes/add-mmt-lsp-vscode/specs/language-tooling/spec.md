# language-tooling 规格增量

## ADDED Requirements

### Requirement: MMT language service is editor independent

MMT language intelligence SHALL be implemented in Rust without depending on VS Code APIs or TypeScript AST interpretation.

#### Scenario: Desktop and Web share parser behavior

- GIVEN Desktop 和 Web 打开相同 MMT source
- WHEN 两端请求 diagnostics、document symbols、folding ranges 或 MMT structural completion
- THEN normalized results MUST be equivalent
- AND both hosts MUST use `mmt_rs` as the parser truth source

### Requirement: LSP positions map safely to UTF-8 byte ranges

MMT language service SHALL negotiate an LSP position encoding and SHALL reject positions that do
not map to valid character boundaries in the current document snapshot.

#### Scenario: Chinese and supplementary characters round-trip

- GIVEN MMT source 包含中文和 UTF-16 surrogate pair 字符
- WHEN LSP position 在 negotiated UTF-16 或 UTF-8 encoding 下转换
- THEN position MUST map to a valid UTF-8 boundary
- AND byte range converted back to LSP MUST preserve the original position

### Requirement: Preview does not block language queries

Preview work SHALL be scheduled independently from language queries and SHALL be associated with
the exact document URI and revision that produced it.

#### Scenario: Editing schedules a preview

- GIVEN host 允许普通编辑触发图片预览
- WHEN didChange creates a new document revision
- THEN host MAY schedule materialize/render for that revision
- AND diagnostics、symbols、completion MUST NOT wait for preview I/O
- AND a preview result for an older revision MUST be discarded

### Requirement: Protocol faults are explicit and preserve the last valid snapshot

Native 和 Web transport SHALL apply the same request、notification 与 bridge decode error contract，
且无效同步通知不得修改最后一个有效文档快照。

#### Scenario: Invalid full-sync change is reported

- GIVEN server negotiated full document sync and holds an open document snapshot
- WHEN client sends a ranged change、zero changes、multiple changes or malformed parameters
- THEN server MUST preserve the previous snapshot
- AND host MUST report the method and reason through `window/logMessage` or an equivalent host log
- AND bridge JSON decode failure MUST retain JSON-RPC parse error code `-32700`

### Requirement: Diagnostics preserve related source locations

MMT diagnostic labels SHALL be exposed as LSP diagnostic related information for the same source URI.

#### Scenario: Duplicate declaration points to the first declaration

- GIVEN an MMT diagnostic has a primary range and a label for an earlier declaration
- WHEN the diagnostic is converted to LSP
- THEN the primary range MUST remain the diagnostic range
- AND the label range and message MUST appear in `relatedInformation`

### Requirement: Live diagnostics come from one complete pure analysis result

For one document snapshot and pack-registry revision, the language service SHALL publish one de-duplicated
live diagnostic set covering syntax、mode、actor、asset、resource marker、deterministic pack resolve/planning
and placeholder-emission static checks. It MUST replace narrower intermediate sets rather than concatenate
syntax or actor diagnostics a second time.

#### Scenario: Installed pack metadata participates in live diagnostics

- GIVEN the service holds an open document and an acknowledged read-only `PackRegistry`
- WHEN live analysis resolves selectors and plans `image-dir` or `image-sequence` resources
- THEN missing、ambiguous or invalid selector/storage metadata MUST be reported on the authored MMT range
- AND analysis MUST NOT fetch a blob、read a platform filesystem、invoke a decoder or run the final renderer
- AND a registry update MUST recompute affected documents without changing their source version

#### Scenario: Language and render paths share authored diagnostics

- GIVEN syntax、semantic、resolve or planning reports an error for one snapshot
- WHEN the host requests both a language projection and a render project
- THEN both paths MUST derive that authored diagnostic from one shared parsed/analysis result
- AND live publication MUST contain it at most once
- AND render-project diagnostics MUST retain source version、projection revision、phase and authored range

### Requirement: Initial completion is MMT structural only

第一阶段 completion SHALL derive from documented MMT syntax and SHALL NOT synthesize Typst or resource
query completion before projection and catalog services exist.

#### Scenario: Author completes a directive or block field

- GIVEN cursor is at a top-level directive、`@mode` value or `@actor` / `@asset` field prefix
- WHEN client requests completion
- THEN server MUST return documented structural candidates with a prefix replacement edit
- AND field-name completion MUST NOT run after the current line's field separator
- AND Desktop、native transcript and Web Worker MUST use the same Rust completion implementation

### Requirement: Web runtime is exercised in a browser

Web extension verification SHALL execute the emitted Worker and WASM in a real browser rather than
relying on TypeScript and bundle success alone.

#### Scenario: Browser Worker handles an LSP transcript

- GIVEN built `browserWorker.js` and hashed WASM assets are served over HTTP
- WHEN Chrome sends initialize、didOpen、diagnostic、symbol、folding、completion and shutdown messages
- THEN the complete transcript MUST succeed without a Node API fallback
- AND the first initialize message MUST NOT be lost while WASM starts

### Requirement: Web runtime teardown has a synchronous safety path

The production Web editor SHALL own Workbench services、model listeners、language clients、Workers、preview,
providers、caches and cancellation controllers through one runtime lifecycle.

#### Scenario: Startup fails or the page runtime is replaced

- GIVEN startup has created only a prefix of runtime resources, or HMR/navigation replaces the page runtime
- WHEN teardown begins
- THEN resources MUST be released in reverse ownership order
- AND listeners MUST be detached and controllers aborted before a stale callback can publish state
- AND Worker termination MUST have a synchronous fallback that does not depend on awaiting an unload Promise
- AND controlled teardown SHOULD attempt graceful LSP shutdown before invoking that fallback

### Requirement: Native binary paths are platform-qualified

Desktop packaging SHALL use platform and architecture qualified binary directories and the Windows
target SHALL use an `.exe` executable name.

#### Scenario: Desktop resolves its bundled server

- GIVEN an extension runs on a supported `process.platform` and `process.arch`
- WHEN no custom `mmt.server.path` is configured
- THEN it MUST resolve `bin/<platform>-<arch>/mmt-lsp[.exe]`
- AND build scripts MUST be runnable through Node rather than requiring Bash

### Requirement: Typst projection is deterministic and performs no platform I/O

Editor language projection SHALL emit syntactically valid Typst through deterministic virtual placeholder paths.
It MAY perform deterministic resource resolve and planning against an already installed in-memory `PackRegistry`,
but SHALL NOT perform platform resource I/O or make emitted language Typst depend on real resource files.

#### Scenario: Registry-aware resource document is projected

- GIVEN an MMT document contains actor avatars or inline resource markers
- AND a validated pack registry is already installed in memory
- WHEN language core builds live diagnostics and the editor Typst projection
- THEN it MAY resolve selectors and validate storage/planning metadata without I/O
- AND it MUST NOT fetch resources、read a platform filesystem、invoke a decoder or run the final renderer
- AND emitted resource calls MUST use the documented virtual placeholder path
- AND the host MUST provide that placeholder as a UTF-8 SVG virtual file before opening the entry
- AND resolve/planning failures MUST be editor diagnostics
- AND actual fetch/decode/layout failures MUST NOT be added to live editor diagnostics

### Requirement: Preview materialization is isolated from language projection

The Web host SHALL isolate any revision-bound render project from the no-I/O editor projection.
It MAY build that render project after a pack registry is installed, but SHALL NOT replace or mutate
the editor projection.

#### Scenario: A remote pack resource is planned and rendered

- GIVEN an acknowledged pack-v3 manifest resolves an avatar or marker to `image-dir` or AVIFS `image-sequence` storage
- WHEN the host requests a render project for the current document revision
- THEN the render project MUST describe the pack namespace、storage source、virtual URI and authored resource range
- AND an image sequence request MUST also preserve storage sha256、frame、frame count、codec/profile and output size
- AND resolve/planning diagnostics MUST be returned with source version、projection revision、phase and authored range
- AND the host MUST derive an HTTPS URL beneath the acknowledged pack base
- AND the host MUST reject unsafe path segments、redirects、unsupported storage/extensions and responses over 20 MiB
- AND it MUST validate sequence hash/profile/frame before or during decode
- AND a stale revision MUST NOT replace the current preview or its diagnostics
- AND fetch、decode and final layout failures MUST remain revision-bound preview/build diagnostics rather than live editor diagnostics

### Requirement: Web workspace edits survive reload

The Web editor SHALL persist text changes to its IndexedDB-backed workspace in source order.

#### Scenario: Reload after editing a story

- GIVEN the author changes the open MMT document
- WHEN persistence completes and the page reloads
- THEN the workspace MUST reopen the latest text
- AND the preview MUST be rebuilt from that persisted text and the acknowledged pack manifest


### Requirement: Projection segments permit only exact identity mapping

Projection segments SHALL continuously cover generated Typst and SHALL classify unsafe generated
regions conservatively.

#### Scenario: Cursor or edit crosses a generated region

- GIVEN projection contains Identity、Synthetic、Escaped and MacroExpansion segments
- WHEN a cursor or TextEdit is mapped from Typst to MMT
- THEN mapping MAY succeed only when the complete range lies in one Identity segment
- AND edits touching Synthetic、Escaped or MacroExpansion MUST be rejected
- AND every Identity segment MUST have equal-length MMT and Typst ranges on valid UTF-8 boundaries

### Requirement: Typst backends are versioned and revision-bound

The coordinator SHALL address native and Web Typst language services through one versioned backend
contract and SHALL reject stale responses before source mapping.

#### Scenario: Document changes while a Typst request is in flight

- GIVEN a Typst request was issued for revision N
- AND the projection store now contains revision N+1 for the same MMT URI
- WHEN the revision N response arrives
- THEN the coordinator MUST discard it
- AND MUST NOT map its ranges or edits into revision N+1

#### Scenario: Unversioned diagnostics are isolated by revision entry URI

- GIVEN source URI `U` has projection session `S` and current revision `N`
- WHEN the coordinator accepts revision `N+1`
- THEN its entry URI MUST be `untitled:/mmt-projection/<hex(U)>/<S>/main-<N+1>.typ`
- AND the coordinator MUST reject non-increasing same-session updates、cross-session deltas and updates from retired sessions
- AND the previous entry MUST stop being addressable as a current projection before responses for `N+1` are mapped
- AND the host MUST retain at most two previous applied file generations before scheduling globally unowned files for revision-checked `didClose` after a bounded 30 second grace
- AND the host MUST prime the newest entry through debounced `textDocument/foldingRange` implicit focus rather than persistent manual focus

#### Scenario: Browser Typst Worker fails after initialization

- GIVEN the Web backend has synchronized one or more virtual projects
- WHEN its Worker raises a runtime error or message deserialization error
- THEN all in-flight requests MUST fail instead of timing out
- AND the client MUST create and initialize a new Worker
- AND it MUST replay the latest version of every still-open virtual project before accepting new requests
- AND a recovery failure MUST be surfaced to the extension host

#### Scenario: Fixed Tinymist artifacts handle virtual documents

- GIVEN Tinymist commit `3d63da4f93c54ddef0c63e1a6237d67aee13f5fe`
- WHEN native stdio and browser Worker transcripts open an `untitled:/mmt-projection/` document
- THEN both MUST complete initialize、completion、hover and shutdown
- AND the Web Worker MUST report backend protocol version `1` and Tinymist version `0.15.2`

### Requirement: Embedded Typst features have Desktop and Web parity

Desktop and Web SHALL route Typst diagnostics、completion、hover and signature help through the same
revision-bound projection contract and Rust mapping implementation.

#### Scenario: Typst language features are requested inside an identity segment

- GIVEN an MMT `@typ` body defines and calls a Typst function
- WHEN Desktop Electron Host and Web Extension Host request completion、hover and signature help
- THEN both MUST return Tinymist-derived results at MMT positions
- AND completion TextEdits and hover ranges MUST be mapped by Rust
- AND a Typst diagnostic in the identity segment MUST be published on the MMT document
- AND a diagnostic spanning one generated wrapper and one authored patch MUST map to that patch
- AND responses for an obsolete projection revision MUST be discarded

#### Scenario: Full projection is evaluated against recovery fixtures

- GIVEN fixtures contain incomplete `@typ`、statement patches、resource overlays and generated wrappers
- WHEN the same fixtures run in Desktop Electron Host and Web Extension Host
- THEN full projection MUST preserve Typst completion after incomplete or expanded regions
- AND resource patch diagnostics MUST map back to the authored patch
- AND a region-preserving implementation SHALL be introduced only when a fixture demonstrates a recovery gap

#### Scenario: Virtual template project starts without host file access

- GIVEN the projection imports the MMT render library
- WHEN the host synchronizes the virtual project to Tinymist
- THEN template source dependencies MUST be opened before the entry file
- AND the editor-only render facade MUST NOT require external Typst packages or binary decorations
- AND all project update fields crossing the Rust/TypeScript boundary MUST use camelCase

### Requirement: Host-loaded pack manifests drive language completion

Desktop and Web hosts SHALL load configured pack-v3 manifests without interpreting their entity、slot、set or
variant semantics, and the shared Rust language service SHALL validate and atomically install them as one
`PackRegistry` snapshot.

#### Scenario: Default BA Kivo manifest becomes available

- GIVEN the default source is `https://mms-pack.xiyihan.cn/ba_kivo/manifest.json`
- WHEN the host receives a successful CORS-capable response and sends a revisioned `mmt/updatePackManifests` request
- THEN Rust MUST parse the original pack-v3 JSON、run `PackRegistry` validation and acknowledge that revision
- AND `preset:` completion MUST use canonical entity IDs and deterministic names from that registry
- AND Desktop and Web MUST return equivalent candidates

#### Scenario: A malformed or unavailable update does not erase a valid catalog

- GIVEN revision N installed a valid pack registry
- WHEN revision N+1 contains malformed JSON、an invalid pack manifest or a failed network response
- THEN revision N MUST remain active
- AND the failure MUST be logged without reparsing open documents or clearing existing completion candidates
- AND newly fetched JSON MUST remain in staging until the matching Rust acknowledgement succeeds
- AND rejection、timeout or transport failure MUST delete staging data and preserve the prior persistent cache

#### Scenario: Completion performs no resource materialization

- GIVEN a valid registry contains avatar paths and AVIFS sticker sequences
- WHEN completion is requested for an actor preset
- THEN the language service MUST read manifest metadata only
- AND it MUST NOT fetch blobs、decode frames or expose pack-relative storage paths

#### Scenario: Inline resource completion follows authored marker context

- GIVEN a document declares script-local assets and the acknowledged registry contains pack assets and sticker variants
- WHEN completion is requested in a bare speaker-relative selector、`[:asset, …:]` or `[:actor-name, …:]`
- THEN bare selectors MUST offer variants from the current statement speaker's preset
- AND `asset` MUST offer script-local assets even before pack synchronization completes
- AND explicit script actor names MUST resolve to their preset before variant completion
- AND candidates MUST use deterministic selector text without fetching or materializing resource bytes

### Requirement: Empty render patches are valid no-ops

An authored empty patch `()` SHALL remain parseable while the author enters parameters and SHALL emit no Typst argument or separator.

#### Scenario: Statement has an empty patch

- GIVEN an MMT statement such as `<() Hello`
- WHEN the language projection and final emitter process it
- THEN the result MUST be equivalent to `< Hello`
- AND emitted Typst MUST remain syntactically valid

### Requirement: MMT façade features do not weaken identity mapping

MMT construct hover、signature help and patch completion SHALL use an explicit public façade contract. A synthetic feature-query anchor MAY address generated Typst context, but MUST NOT be treated as an identity mapping or permit generated-wrapper edits to map into MMT.

#### Scenario: Author requests features on a construct or inside an empty patch

- GIVEN the cursor is on `-`、`<`、`>`、`@reply`、`@bond` or inside an empty patch
- WHEN hover、signature help or completion is requested
- THEN MMT SHALL expose the applicable public façade signature
- AND Typst value-expression completion MAY be delegated to Tinymist
- AND generated wrapper TextEdits、additional edits、rename or formatting edits MUST NOT be projected into MMT

### Requirement: Speaker hover reflects the statement revision

Explicit speaker tokens and history references SHALL resolve through the lowered statement speaker and actor revision rather than by token text alone.

#### Scenario: Actor is patched between statements

- GIVEN aliases refer to one `ActorId` and a later `@actor` block changes its display name or avatar
- WHEN the author hovers an explicit speaker token on either statement
- THEN hover MUST show the `ActorState` revision selected for that statement
- AND it SHOULD include a safe avatar preview when the acknowledged pack metadata exposes a browser-loadable image

#### Scenario: History reference exposes its resolved actor

- GIVEN `_`、`_n`、`~` or `~n` resolves to a prior actor on the same dialogue side
- WHEN the author requests completion or hovers the authored reference
- THEN the language service MUST identify the referenced actor and the revision active at the current statement
- AND completion detail MUST label the resolved display name without rewriting bare `_` or `~` aliases
- AND a future actor revision after the current statement MUST NOT leak into that label

### Requirement: Web preview and workspace expose authored structure

The Web editor SHALL render Typst SVG with user-controlled zoom and SHALL represent its `mmtfs://workspace/` authority as the workspace root without creating a duplicate `/workspace` child path.

#### Scenario: Existing browser workspace starts

- GIVEN IndexedDB contains the historical empty `/workspace` directory entry
- WHEN the editor starts
- THEN it MUST remove that empty compatibility entry
- AND `story.mmt` MUST remain at `/story.mmt`
- AND preview controls MUST support zoom in、zoom out、actual size and fit width without rasterizing the SVG

#### Scenario: Author resizes editor and preview panes

- GIVEN the Web workbench shows editor and preview side by side
- WHEN the author drags the accessible separator or uses its keyboard controls
- THEN the editor and preview widths MUST update without overlapping either pane
- AND double-click or the reset key MUST restore the equal split

#### Scenario: Author collapses auxiliary panes

- GIVEN the file explorer and preview are visible
- WHEN the author activates either accessible collapse control
- THEN that pane MUST be removed from the workbench layout and the editor MUST use the released width
- AND the control MUST remain available to restore the pane
- AND the preview control MUST NOT overlap zoom or fit controls

#### Scenario: Plain body hashes are not default color literals

- GIVEN an MMT text body contains `#123` or another hash-prefixed fragment
- WHEN the editor's default color detector scans the document
- THEN MMT language defaults MUST suppress that detector
- AND dedicated Typst color providers MAY still operate on projected Typst regions

#### Scenario: Statement patches use Typst argument scopes

- GIVEN a statement patch and a Typst façade call contain equivalent named arguments
- WHEN TextMate tokenization highlights both forms
- THEN parameter names、colons、units、nested calls、strings and operators in the patch MUST use the corresponding Typst scopes

#### Scenario: Multi-page SVG remains vector and visually separated

- GIVEN Typst emits more than one `.typst-page` group
- WHEN the Web preview imports the SVG
- THEN consecutive page groups MUST have a visible gap
- AND zoom、actual size and fit width MUST continue to transform the SVG without rasterization

#### Scenario: Browser SVG text can be selected and copied safely

- GIVEN typst.ts emits `.tsel` XHTML inside SVG `foreignObject` nodes
- WHEN the Web preview sanitizes and imports that renderer output
- THEN validated text-only `div` / `span` selection nodes MUST remain selectable and copyable
- AND prefixed XHTML parser artifacts MUST be normalized to real XHTML elements
- AND unexpected selection-subtree elements、attributes or styles MUST be rejected
- AND active SVG content、event handlers and external resource references MUST be removed before import
