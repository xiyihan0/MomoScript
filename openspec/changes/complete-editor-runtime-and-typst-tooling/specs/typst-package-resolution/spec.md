## ADDED Requirements

### Requirement: The host owns Typst package resolution through a versioned callback

Typst package network and filesystem I/O SHALL be performed by an explicit host service. `mmt_rs`、`mmt_lsp` and Tinymist backend evaluation SHALL receive only host-supplied bytes and SHALL NOT fetch arbitrary URLs. Worker and process transports SHALL implement the same versioned logical-package callback carrying request ID、backend generation、complete Typst project snapshot、package identity、optional package-relative path and cancellation/error result.

#### Scenario: Source imports a preview package

- GIVEN authored Typst imports `@preview/example:1.2.3`
- AND the fixed artifact qualified the versioned package callback
- WHEN the backend needs package files
- THEN it MUST request logical package identity from the host
- AND the host MUST derive the registry URL from configuration
- AND source text MUST NOT supply an arbitrary trusted download URL

#### Scenario: Fixed artifact lacks logical package callback

- GIVEN either fixed native or Web artifact cannot issue the versioned callback
- WHEN package implementation reaches its artifact gate
- THEN host-mediated package fetching MUST remain disabled
- AND an artifact upgrade or maintained patch with native/Web transcripts MUST complete first

### Requirement: Package identity is fully versioned and normalized

The first supported public package identity SHALL contain namespace、name and full version. Official preview packages SHALL correspond to the official repository layout `packages/preview/{name}/{version}`.

#### Scenario: Import omits version

- GIVEN source imports a preview package without a full version
- WHEN dependency analysis runs
- THEN resolution MUST fail deterministically
- AND MUST NOT select a latest version implicitly

#### Scenario: Manifest identity differs from request

- GIVEN requested package is `@preview/example:1.2.3`
- WHEN the extracted `typst.toml` names another package or version
- THEN staging MUST fail
- AND no active cache generation may change

### Requirement: Registry downloads are bounded and integrity-aware

Registry responses SHALL enforce HTTPS、status、redirect policy、content type、compressed size and cancellation. Declared distribution size and SHA-256 SHALL be verified when available.

#### Scenario: Registry redirects outside allowlist

- GIVEN a configured registry responds with a redirect to an unapproved host
- WHEN the package is fetched
- THEN the download MUST be rejected before consuming the target body

#### Scenario: Download exceeds compressed limit

- GIVEN a response body exceeds the configured compressed byte limit
- WHEN it streams into staging
- THEN the request MUST be aborted
- AND partial staging bytes MUST be removed

#### Scenario: Digest mismatches

- GIVEN the distribution index declares SHA-256 D
- WHEN downloaded bytes hash to another value
- THEN extraction MUST NOT begin
- AND the previous valid package generation MUST remain active

### Requirement: Package archives are extracted safely

Package extraction SHALL reject absolute or parent paths、NUL、links、devices、unknown entry types、duplicate canonical paths、case-fold collisions and files outside the package root. It SHALL bound file count、per-file bytes and total expanded bytes.

#### Scenario: Archive contains traversal entry

- GIVEN an archive entry is `../../workspace/main.mmt`
- WHEN paths are normalized
- THEN the package MUST be rejected
- AND no workspace or cache file outside staging may be written

#### Scenario: Expansion exceeds limit

- GIVEN compressed bytes fit the download limit
- WHEN expanded entries exceed total expanded byte limit
- THEN extraction MUST stop and delete staging

#### Scenario: Duplicate path uses alternate separators

- GIVEN two entries normalize to the same canonical package path
- WHEN validation runs
- THEN the package MUST be rejected rather than applying last-write-wins

### Requirement: Package manifest paths remain inside the package root

After archive extraction, `typst.toml` identity and every path-bearing manifest field SHALL be normalized and validated against the immutable package root. The entrypoint SHALL name an existing regular file inside that root.

#### Scenario: Manifest entrypoint escapes package root

- GIVEN a valid archive contains `typst.toml` with an absolute or parent-traversing entrypoint
- WHEN manifest validation runs
- THEN activation MUST fail
- AND no workspace、other package or host file may be exposed

#### Scenario: Manifest entrypoint is missing or not a file

- GIVEN manifest identity matches the request
- AND its normalized entrypoint does not name an existing regular file
- WHEN validation runs
- THEN activation MUST fail while preserving the previous generation

### Requirement: Package activation is immutable and atomic

A validated package SHALL be activated as a new immutable cache generation. Failure SHALL preserve the last valid generation and readers SHALL never observe partial extraction.

#### Scenario: Editor requests package during activation

- GIVEN generation G is active and G+1 is staging
- WHEN another project requests the package
- THEN it MUST read G until G+1 is atomically committed
- AND MUST never read staging files

### Requirement: Package files are read-only dependencies

Active package files SHALL be exposed under an internal digest-bound read-only URI and injected as explicit project dependencies. They SHALL not become ordinary workspace files implicitly.

#### Scenario: Rename targets package source

- GIVEN Tinymist rename includes a package file edit
- WHEN the workspace edit is validated
- THEN the complete rename MUST fail as `ReadOnlyTarget`

#### Scenario: User navigates to package definition

- GIVEN definition target is in an active package generation
- WHEN navigation opens it
- THEN the exact package bytes MUST be shown read-only
- AND the URI MUST identify the package generation digest

### Requirement: Package requests coalesce and cancel safely

Concurrent requests for the same immutable package identity and registry generation SHALL share one fetch/extraction job. The job SHALL cancel when no active dependent project remains.

#### Scenario: Two projects request one uncached package

- GIVEN projects A and B request the same package concurrently
- WHEN resolution starts
- THEN at most one network/extraction job MUST run
- AND both projects MUST receive the same activated generation

#### Scenario: One of two dependents closes

- GIVEN A and B share an in-flight job
- WHEN A closes
- THEN the job MUST continue for B
- AND A's closed snapshot MUST NOT receive a diagnostic or resync result

### Requirement: Offline package state is deterministic

A cached valid package SHALL resolve without network. An uncached package while offline SHALL produce a revision-bound dependency diagnostic and SHALL not become an MMT syntax diagnostic.

#### Scenario: Cached package is used offline

- GIVEN a validated active generation exists
- AND the network is unavailable
- WHEN a project imports the exact package
- THEN resolution MUST use cached bytes
- AND MUST NOT attempt a network request

#### Scenario: Uncached package is needed offline

- GIVEN no valid generation exists
- WHEN the package is required while offline
- THEN preview/build diagnostics MUST identify the package
- AND MUST carry an authored range only when one import site is uniquely attributable
- AND otherwise MUST be document-level with dependency-chain information
- AND language syntax analysis MUST remain available

### Requirement: Package cache participates in shared storage policy

Web package generations SHALL be registered as reclaimable bytes with the shared origin storage coordinator. Package eviction SHALL not remove protected workspace/history bytes.

#### Scenario: Storage coordinator evicts package cache

- GIVEN a package generation is reclaimable and no render/export pin requires it
- WHEN it is evicted
- THEN dependent project/render identities MUST be invalidated
- AND authored workspace files MUST remain unchanged
- AND later resolution MAY refetch the package

### Requirement: Package and font generations affect render identity

The exact package generations and font-set digest supplied to a project SHALL participate in project or runtime artifact identity.

#### Scenario: Font bytes change without source change

- GIVEN source and package identities remain unchanged
- WHEN the supplied font set changes
- THEN the next `RenderKey` MUST differ
- AND the existing preview MUST be marked stale
