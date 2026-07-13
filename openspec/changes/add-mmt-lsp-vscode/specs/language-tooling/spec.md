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

### Requirement: Native binary paths are platform-qualified

Desktop packaging SHALL use platform and architecture qualified binary directories and the Windows
target SHALL use an `.exe` executable name.

#### Scenario: Desktop resolves its bundled server

- GIVEN an extension runs on a supported `process.platform` and `process.arch`
- WHEN no custom `mmt.server.path` is configured
- THEN it MUST resolve `bin/<platform>-<arch>/mmt-lsp[.exe]`
- AND build scripts MUST be runnable through Node rather than requiring Bash

### Requirement: Typst projection is deterministic and performs no platform I/O

Editor projection SHALL stop before resource resolution/materialization and SHALL emit syntactically
valid Typst using deterministic virtual placeholder paths.

#### Scenario: Resource-bearing document is projected

- GIVEN an MMT document contains actor avatars or inline resource markers
- WHEN language core builds an editor Typst projection
- THEN it MUST NOT invoke a resource materializer、decoder、network or filesystem lookup
- AND emitted resource calls MUST use the documented virtual placeholder path
- AND the host MUST provide that placeholder as a UTF-8 SVG virtual file before opening the entry
- AND materialization failures MUST NOT be added to editor diagnostics

### Requirement: Preview materialization is isolated from language projection

The Web host SHALL isolate any revision-bound render project from the no-I/O editor projection.
It MAY build that render project after a pack registry is installed, but SHALL NOT replace or mutate
the editor projection.

#### Scenario: A character avatar is rendered from a remote pack

- GIVEN an acknowledged pack-v3 manifest resolves an actor avatar to `image-dir` storage
- WHEN the host requests a render project for the current document revision
- THEN the render project MUST describe the pack namespace, storage base, image basename and virtual URI
- AND the host MUST derive an HTTPS URL beneath the acknowledged pack base
- AND the host MUST reject unsafe path segments, redirects, unsupported image extensions and responses over 20 MiB
- AND a stale revision MUST NOT replace the current preview
- AND download/materialization failures MUST remain preview failures rather than editor diagnostics

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
