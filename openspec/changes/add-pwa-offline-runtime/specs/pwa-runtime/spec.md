# pwa-runtime 规格增量

## ADDED Requirements

### Requirement: The production Web editor is progressively installable

The production Web editor SHALL publish a valid Web App Manifest and install metadata without making browser installation a prerequisite for normal Web use.

#### Scenario: Chromium evaluates installability

- GIVEN the editor is served from HTTPS or a loopback development origin
- WHEN Chromium reads the document and manifest
- THEN the document MUST link the manifest
- AND the manifest MUST provide stable `id`、`name` or `short_name`、`start_url`、`scope`、standalone display and 192/512 icons
- AND at least one 512 icon MUST declare a maskable purpose with a verified safe zone

#### Scenario: Browser has no custom install prompt API

- GIVEN `beforeinstallprompt` is unavailable as on iOS、Safari or Firefox Desktop
- WHEN the author uses the editor
- THEN all ordinary Web and supported offline capabilities MUST remain usable
- AND the UI MAY show platform-specific install instructions
- BUT it MUST NOT simulate a native browser install prompt or describe Firefox Desktop as manifest-installable

### Requirement: Browser installation and offline readiness are distinct states

The UI SHALL represent app-window installation separately from the verified active offline shell revision.

#### Scenario: Author installs before downloading the offline runtime

- GIVEN the browser installs MomoScript from its manifest
- AND no complete shell revision is active in Cache Storage
- WHEN the app launches without a network
- THEN recovery UI MUST state that the app is installed but offline runtime is not installed
- AND it MUST NOT label the editor offline-ready

#### Scenario: Author enables offline use without installing an app icon

- GIVEN a normal browser tab completes and verifies a shell revision
- WHEN the browser remains in ordinary display mode
- THEN the editor MUST report the shell revision as offline-ready
- AND browser installation MUST remain optional

### Requirement: Every shell revision has one complete artifact manifest

A shell build SHALL bind local assets、remote runtime selections and compatibility metadata into one deterministic build identity.

#### Scenario: Build generates the shell manifest

- GIVEN Vite emits Workbench、Workers、extensions、fonts and bundled WASM
- AND runtime catalog declares Tinymist and Typst compiler candidates
- WHEN PWA build completes
- THEN `pwa-shell-manifest.json` MUST enumerate exact request URL、SHA-256、decoded size、MIME and role for every required artifact
- AND `buildId` MUST change when any URL、hash、size、schema or compatibility version changes
- AND the manifest MUST include `index.html`、MMT LSP、Tinymist、Typst compiler/renderer and required Webview bootstrap assets

#### Scenario: Build output contains source maps or unrelated files

- GIVEN dist contains a source map、test artifact、workspace file、pack asset or legacy duplicate
- WHEN shell inventory is generated
- THEN that file MUST NOT enter the shell manifest merely because it exists under dist
- AND required assets over the audited size limit MUST fail the build rather than disappear silently

#### Scenario: Runtime source URL changes

- GIVEN preview or Tinymist client selects a different runtime artifact
- WHEN the application builds
- THEN page runtime and shell manifest MUST import the same artifact catalog
- AND a second hardcoded URL/hash source MUST NOT remain

### Requirement: The root Service Worker has a bounded bootstrap

Initial Service Worker installation SHALL NOT download the full shell before origin storage reservation and explicit author intent.

#### Scenario: Root worker installs for the first time

- GIVEN no previous root worker or shell cache exists
- WHEN `/sw.js` installs
- THEN it MAY install only a fixed-size bootstrap/recovery response and registry schema
- AND it MUST become capable of online pass-through without downloading fonts、large WASM or packs
- AND complete shell staging MUST wait for the author to enable offline use

### Requirement: Service Worker routing is exact and conservative

The root worker SHALL serve only active/retained manifest entries and SHALL never turn asset failures into HTML success.

#### Scenario: Offline document navigation has an active shell

- GIVEN an active verified shell revision exists
- WHEN a same-origin application document navigation occurs offline
- THEN the worker MUST return that revision's cached `index.html`
- AND subsequent exact shell requests MUST come from the same buildId or an explicitly retained client revision

#### Scenario: Offline navigation has no active shell

- GIVEN only the bounded bootstrap exists
- WHEN document navigation occurs offline
- THEN the worker MUST return an offline-runtime-not-installed recovery response
- AND it MUST NOT return a partially cached Workbench

#### Scenario: Missing WASM or worker URL is requested

- GIVEN the request is not an exact active/retained shell or pack entry
- WHEN network returns 404 or is unavailable
- THEN the request MUST preserve the failure
- AND navigation fallback MUST NOT return `index.html` for `.wasm`、script、style、font、worker、manifest、pack、API or WebDAV paths

### Requirement: Full offline shell installation is explicit and verified

A complete shell SHALL be staged only after an origin reservation and SHALL become active only after every selected artifact verifies.

#### Scenario: Author enables offline use

- GIVEN the current build has no active offline shell
- WHEN the author selects “启用离线使用”
- THEN the UI MUST show expected transfer/persistent bytes、protected bytes、reclaimable bytes、margin and proposed cleanup
- AND download MUST start only after the author accepts and a durable reservation succeeds
- AND all artifacts MUST stage under the new buildId without replacing current state

#### Scenario: Staging succeeds

- GIVEN every selected local and remote response has downloaded
- WHEN verification runs
- THEN status、CORS、redirect、MIME、size and SHA-256 MUST match the manifest
- AND selected WASM decoded bytes MUST pass `WebAssembly.validate`
- AND cache membership MUST exactly match required entries
- AND only then MAY the registry mark the revision active/offline-ready

#### Scenario: Staging fails or is cancelled

- GIVEN an active shell A exists and shell B is staging
- WHEN quota、network、cancel、hash、MIME、redirect or WASM validation fails
- THEN B staging data and reservation MUST be discarded or left resumable only with verified per-entry state
- AND A、workspace/history and active offline packs MUST remain unchanged

### Requirement: Origin storage has one coordinator

Shell、pack、workspace/history and any future persistent materialization cache SHALL use one origin-wide inventory and reservation protocol.

#### Scenario: Shell installer plans staging

- GIVEN Cache Storage、IndexedDB and optional OPFS share the origin quota
- WHEN a shell installer requests space
- THEN it MUST obtain workspace protected/reclaimable inventory and current reservations from `OriginStorageCoordinator`
- AND it MUST reserve decoded peak bytes、metadata、write margin and workspace growth reserve
- AND it MUST NOT make an independent decision from `navigator.storage.estimate()`

#### Scenario: Pack and shell staging race

- GIVEN a pack installation and shell update are requested concurrently
- WHEN both would individually fit but their combined peak would not
- THEN durable reservations MUST serialize or reject one operation
- AND neither operation MAY oversubscribe the same estimated free bytes

#### Scenario: Browser reports an approximate quota

- GIVEN `navigator.storage.estimate()` is padded、stale or lacks per-subsystem detail
- WHEN reservation is evaluated
- THEN tracked subsystem bytes and conservative decoded response sizes MUST also participate
- AND each write batch MUST update actual progress
- AND a later `QuotaExceededError` MUST abort only the owning staging operation

### Requirement: Workspace safety dominates reproducible offline caches

PWA and pack operations SHALL preserve workspace current bytes、protected history and recovery state under origin pressure.

#### Scenario: A two-revision shell update competes with workspace history

- GIVEN the origin contains workspace current files、pinned history、a pending journal、active shell A and a proposed shell B staging payload
- WHEN B plus required margin does not fit without touching workspace protected bytes
- THEN shell staging MUST be rejected before downloading B
- AND A MUST remain active
- AND no workspace current file、pinned head/checkpoint、journal、sync baseline or unreconciled durable head MAY be evicted
- AND the UI MUST report which protected and reclaimable categories determine the result

#### Scenario: Reproducible cache cleanup can satisfy a reservation

- GIVEN failed staging、orphan materialization bytes、inactive previous packs or a healthy previous shell are reclaimable
- WHEN the coordinator constructs a cleanup plan
- THEN it MUST use that ordered reproducible set before considering user-installed active packs
- AND removal of an active offline pack MUST require explicit author confirmation
- AND PWA/pack code MUST NOT invoke Local History GC to make room for a download

#### Scenario: Workspace uses a local directory backend

- GIVEN current authored files live outside origin storage through File System Access
- WHEN the coordinator accounts protected bytes
- THEN directory file bytes MUST NOT be invented as origin usage
- BUT IndexedDB history、journal、handle metadata and sync safety data MUST remain protected origin inventory

### Requirement: Workspace blocked and degraded states gate PWA operations

PWA staging and activation SHALL honor the storage states defined by `add-workspace-storage-history-sync`.

#### Scenario: Workspace history is unreconciled

- GIVEN workspace status is `history-degraded + unreconciled` after an external disk observation could not be persisted
- WHEN shell or pack staging is requested
- THEN the request MUST be blocked
- AND it MUST NOT consume additional origin storage
- AND after workspace recovery the installer MUST obtain a new inventory/reservation rather than reuse the old estimate

#### Scenario: Workspace has an unsafe journal or migration state

- GIVEN migration is failed/in-progress、journal is pending/conflict or quota/history is blocked
- WHEN update activation is requested
- THEN activation MUST remain waiting
- AND the UI MUST identify the workspace prerequisite instead of forcing reload

### Requirement: Persistent-storage requests are origin-wide and honest

Persistence status SHALL be requested centrally and represented as an origin property rather than a guarantee for one cache.

#### Scenario: Author enables offline support

- GIVEN the browser exposes `navigator.storage.persisted()` and `persist()`
- WHEN the author explicitly enables offline support or protects a browser workspace
- THEN `OriginStorageCoordinator` MAY request persistence
- AND the grant or denial MUST be shown for the whole origin
- AND denial MUST retain functionality while labeling storage best-effort

#### Scenario: Browser grants persistent storage

- GIVEN `persist()` resolves true
- WHEN the UI describes storage safety
- THEN it MAY state that the browser has granted persistent origin storage
- BUT it MUST NOT call Cache Storage a backup or claim protection from explicit user deletion

### Requirement: Updates are prompted and staged before restart

A waiting Service Worker SHALL never activate or reload clients automatically.

#### Scenario: New worker reaches waiting

- GIVEN shell A is active and build B worker is waiting
- WHEN the page receives the update signal
- THEN it MUST show B's size and storage plan
- AND B MUST not download full artifacts until the author requests download and reservation succeeds
- AND declining the update MUST leave A completely usable

#### Scenario: Update finishes staging

- GIVEN B is complete and verified
- WHEN the UI reports restart-ready
- THEN B MUST remain waiting until an eligible writer client requests activation
- AND neither `skipWaiting()` nor reload MAY happen merely because staging completed

### Requirement: Update activation waits for a safe runtime boundary

The writer client SHALL quiesce durable workspace state and runtime activity before asking the waiting worker to activate.

#### Scenario: Author accepts restart

- GIVEN B is restart-ready and the page holds the workspace writer lease
- WHEN `prepareForReload()` succeeds
- THEN all document persistence queues and Local History edit groups MUST be flushed
- AND pending materialization MUST be aborted or awaited at its declared safe boundary
- AND recovery metadata MUST be durable
- AND only then MAY the page send `ACTIVATE(B)`

#### Scenario: Flush or recovery state is unsafe

- GIVEN a write queue fails、journal is pending/conflict、external history is unreconciled or migration is incomplete
- WHEN the author requests restart
- THEN the current page and shell A MUST continue running
- AND B MUST remain staged/waiting
- AND update UI MUST expose the exact blocker

#### Scenario: Waiting worker activates

- GIVEN safe activation was authorized
- WHEN B calls `skipWaiting()` and reaches activated
- THEN the accepting page MUST perform at most one guarded reload
- AND correctness MUST NOT depend on awaiting `beforeunload`
- AND the worker MUST NOT automatically call `clients.claim()`

### Requirement: Multiple clients do not receive a forced mixed update

Open tabs SHALL keep a coherent shell revision until each client reaches its own safe navigation boundary.

#### Scenario: Writer accepts update while another tab is open

- GIVEN the writer tab runs A and a read-only tab also reports A
- WHEN the writer activates B
- THEN the read-only tab MUST NOT be forcibly reloaded
- AND exact A asset requests MUST remain satisfiable from retained cache
- AND previous A MUST not be deleted until client enumeration/handshake proves no live client needs it

#### Scenario: A non-writer tab attempts activation

- GIVEN another page owns the workspace writer lease
- WHEN the read-only tab invokes update restart
- THEN it MUST be denied or redirected to the writer client
- AND it MUST NOT call `skipWaiting()` independently

### Requirement: New shell revisions pass probation before cleanup

A newly active revision SHALL prove end-to-end runtime health before the prior shell is reclaimable.

#### Scenario: First boot of B succeeds

- GIVEN B is active and A is previous
- WHEN B opens Workbench/workspace、starts MMT LSP and Tinymist、runs a minimal Typst compiler/renderer smoke and loads Webview bootstrap without network/previous fallback
- THEN the client MUST report `SHELL_HEALTHY(B)`
- AND A MAY be reclaimed only after no old client requires it

#### Scenario: First boot of B fails

- GIVEN B cannot complete its probation checks
- WHEN recovery UI starts
- THEN it MUST offer asset-pointer rollback to complete previous A when available
- AND it MUST NOT delete or recreate workspace IndexedDB as part of repair
- AND it MUST state that asset rollback does not downgrade the already activated worker binary

#### Scenario: Registry and Cache Storage disagree after a crash

- GIVEN complete staging lacks a pointer、a pointer names missing cache or active cache is incomplete
- WHEN startup reconciliation runs
- THEN it MUST resolve to one complete buildId、a complete previous revision or bounded recovery UI
- AND it MUST NOT compose a shell from entries belonging to different revisions

### Requirement: Root and Webview Service Workers coexist by tested scope

The root PWA worker SHALL preserve the VS Code Webview worker's scope、bootstrap and revision coherence.

#### Scenario: Offline preview opens a Webview

- GIVEN root shell revision A includes the Webview worker/bootstrap artifacts
- WHEN the editor opens the preview completely offline
- THEN the Webview worker MUST register under its intended scope
- AND every bootstrap asset MUST resolve from A
- AND the root navigation fallback MUST NOT intercept worker protocol requests as HTML

#### Scenario: Coexistence prototype fails

- GIVEN root and Webview worker scope/update behavior cannot preserve one revision
- WHEN the Phase 0 browser test completes
- THEN production MUST NOT advertise offline-ready
- AND implementation MUST resolve the scope/protocol conflict rather than disabling Webview validation

### Requirement: Offline packs use a complete distribution index

A pack SHALL be installable offline only when distribution metadata enumerates exact immutable responses and binds them to the semantic manifest.

#### Scenario: Builder publishes an installation index

- GIVEN a pack-v3 semantic manifest contains image-dir and/or image-sequence storage
- WHEN distribution artifacts are built
- THEN `installation-index.json` MUST identify namespace、semantic manifest SHA-256、revision、total decoded bytes and ordered entries
- AND every entry MUST contain exact request URL、SHA-256、decoded size、MIME and role
- AND total bytes MUST be recomputed from actual published files

#### Scenario: Semantic manifest and installation index diverge

- GIVEN the semantic manifest hash differs from the installation index binding
- WHEN Pack Manager plans installation
- THEN installation MUST fail before asset download
- AND an older active verified pack revision MUST remain usable

### Requirement: Pack installation is explicit、revisioned and repairable

Offline pack bytes SHALL use staging/active/previous lifecycle independent of the application shell.

#### Scenario: Author installs a pack

- GIVEN no offline revision of pack P is active
- WHEN the author confirms its origin storage plan
- THEN each response MUST download to P's staging cache and verify status/CORS/redirect/MIME/size/hash
- AND active state MUST switch only after every required entry verifies
- AND cancellation or failure MUST preserve all existing active shell/workspace/pack state

#### Scenario: Interrupted pack installation resumes

- GIVEN some staging entries have already passed hash verification
- WHEN installation resumes after reload
- THEN verified exact entries MAY be reused
- AND incomplete/unverified bodies MUST be downloaded again
- AND progress MUST be based on verified bytes rather than request count

#### Scenario: New pack revision is damaged after activation

- GIVEN previous revision P1 remains and P2 cannot satisfy a verified preview request
- WHEN Pack Manager repairs the installation
- THEN it MAY roll back to complete P1 or redownload P2
- AND it MUST NOT return a response from a different pack/revision as a silent fallback

### Requirement: Offline resource failure remains a preview diagnostic

Missing or damaged offline pack resources SHALL not change MMT language semantics or live diagnostic ownership.

#### Scenario: Offline story references an uninstalled avatar

- GIVEN shell is offline-ready but the required pack/entry is not installed
- WHEN preview materialization requests the avatar
- THEN the editor MUST emit a revision-bound preview/build diagnostic describing the missing offline resource
- AND syntax、semantic resolution based on the acknowledged manifest and no-I/O projection MUST remain available
- AND network failure MUST NOT be represented as an empty pack manifest

### Requirement: Cross-origin cached artifacts are inspectable and immutable

Remote runtime and pack artifacts SHALL be cached only from allowlisted、verifiable CORS responses.

#### Scenario: Runtime response is redirected or opaque

- GIVEN a runtime catalog requests an exact HTTPS URL
- WHEN fetch returns an opaque response or redirects outside its declared origin/root
- THEN staging MUST reject the response
- AND it MUST NOT enter Cache Storage

#### Scenario: CDN serves encoded WASM

- GIVEN the selected runtime response uses `Content-Encoding` and `Vary: Accept-Encoding`
- WHEN the worker validates and caches it
- THEN SHA-256/size/WASM validation MUST apply to decoded bytes declared by the catalog
- AND the cached response MUST preserve browser-managed body/header semantics
- AND an identity fallback MAY be selected only as a separately declared、reserved and verified artifact

### Requirement: Deployment responses preserve PWA update and asset semantics

Every production deployment target SHALL satisfy the same cache、MIME、CORS and fallback assertions.

#### Scenario: Browser checks for a new shell

- GIVEN `/index.html`、`/sw.js`、manifest and shell manifest are stable URLs
- WHEN the browser/CDN serves them
- THEN they MUST revalidate or use an equivalent no-cache policy
- AND `/sw.js` MUST NOT be immutable、rewritten to HTML or transparently transformed

#### Scenario: Browser requests a content-hashed asset

- GIVEN the asset filename includes its reliable content hash
- WHEN the deployment serves it
- THEN it SHOULD use one-year immutable caching
- AND WASM、module/worker JS、fonts、manifest and SVG MUST have correct MIME

#### Scenario: Unknown asset path is requested

- GIVEN an unknown `.wasm`、worker、pack、manifest or API URL
- WHEN no resource exists
- THEN the deployment MUST return its real 404/5xx
- AND SPA navigation fallback MUST NOT return status 200 HTML

### Requirement: Offline and eviction recovery are explicit

The PWA SHALL detect missing/damaged origin state and SHALL never present best-effort browser storage as permanent user backup.

#### Scenario: Browser evicts origin data

- GIVEN shell、pack Cache Storage and workspace IndexedDB previously existed
- WHEN browser storage pressure evicts the origin
- THEN startup MUST detect missing registry/cache/workspace state
- AND shell/pack UI MUST offer reinstallation when online
- AND workspace UI MUST offer only recovery sources that actually exist, such as File System Access、WebDAV or prior export
- AND it MUST NOT infer that an empty database means the author never had files

#### Scenario: Storage remains best-effort

- GIVEN persistence is unsupported or denied
- WHEN offline-ready state is displayed
- THEN UI MUST include eviction risk and current usage
- AND iOS copy MUST NOT promise permanent offline resources
