## ADDED Requirements

### Requirement: Desktop and Web share normalized editor semantics

Desktop and Web SHALL use the same logical workspace/source identity、canonical project content digests、project state machine、capability normalization、feature routing、position conversion、Rust mapping、package policy、preview request identity and diagnostic phase mapping. Host URI schemes、document-incarnation nonces and editor-local version counters SHALL remain local stale-check metadata rather than cross-host digest inputs.

#### Scenario: Same fixture runs on both hosts

- GIVEN identical logical workspace paths、MMT/Typst bytes、package bytes、runtime artifacts and capability manifests
- WHEN the fixture runs through Desktop and Web
- THEN semantic language results、mapped ranges、accepted/rejected edits、normalized render-key components and diagnostic phases MUST match
- AND `file:` versus `mmtfs:` presentation URIs or local version counters MUST NOT fail parity

### Requirement: Platform adapters do not redefine policy

Worker/process、browser/native network、IndexedDB/native cache and webview/standalone presentation MAY differ. Adapters SHALL not grant different source semantics or arbitrary I/O.

#### Scenario: Desktop has native filesystem access

- GIVEN Desktop can access host paths
- WHEN an embedded MMT projection requests a dependency
- THEN the same explicit workspace/package policy as Web MUST apply
- AND Tinymist MUST NOT read an arbitrary host path merely because Desktop can

### Requirement: Core-required capabilities require artifact convergence

A provider SHALL be core-required only when both fixed artifacts advertise compatible options and shared method transcripts pass. A generic language client route or Tyraria behavior SHALL not substitute for artifact evidence.

#### Scenario: Native advertises provider and Web does not

- GIVEN native advertises references but Web does not
- WHEN parity classification runs
- THEN references MUST NOT be declared core-required
- AND shared UI MUST hide or mark the host-optional difference
- AND project documentation MUST not claim Desktop/Web parity for references

### Requirement: Capability evidence is reproducible

Capability manifests SHALL include protocol/backend version、artifact digest、position encoding、provider options and dynamic registrations. CI or the documented build shall regenerate and compare them.

#### Scenario: Backend artifact changes

- GIVEN the Worker WASM digest changes
- WHEN the extension is built
- THEN capability qualification MUST rerun
- AND incompatible provider or option changes MUST fail the parity gate

### Requirement: Shared fixtures cover protocol and real hosts

Verification SHALL include shared Rust/native/WASM protocol fixtures、native process and browser Worker transcripts、Desktop Extension Host、VS Code Web Extension Host and production standalone Web interaction tests.

#### Scenario: Unit mapping passes but Web host registration fails

- GIVEN Rust and Worker protocol fixtures pass
- WHEN the Web Extension Host does not register or invoke the provider
- THEN the capability MUST remain incomplete

#### Scenario: Extension hosts pass but standalone Web fails

- GIVEN Desktop/Web extension fixtures pass
- WHEN production Workbench fails persistence、preview or package interaction
- THEN the production capability MUST remain incomplete

### Requirement: Every enabled provider has positive and negative evidence

An enabled provider SHALL have a successful observable-contract fixture and at least one plausible stale、unsafe、cancelled、unsupported or malformed scenario.

#### Scenario: Rename is enabled

- GIVEN rename is claimed complete
- THEN fixtures MUST include a successful current Identity rename
- AND a mixed Identity/Synthetic rejection
- AND a document-version race rejection
- AND a backend restart/cancellation case

### Requirement: Unicode and encoding fixtures span every position-bearing family

Chinese、combining characters and astral Unicode SHALL be exercised for requests、locations、ranges、edits、diagnostics、symbols、selection ranges and preview navigation as applicable.

#### Scenario: Astral character precedes an edit

- GIVEN the client and backend use different position encodings
- WHEN rename or formatting returns a range after an astral character
- THEN Desktop and Web MUST map the same authored bytes
- AND neither may split the surrogate pair

### Requirement: Failure categories remain distinct across hosts

Capability unavailable、invalid position、stale source、stale projection、unsafe edit、read-only target、package offline、package invalid、resource failure、render failure and runtime recovery SHALL remain distinct result/status categories.

#### Scenario: Package is unavailable offline

- GIVEN syntax and MMT semantic analysis succeed
- WHEN a required uncached package cannot be fetched
- THEN both hosts MUST report a dependency preview/build diagnostic
- AND MUST NOT report an MMT syntax error

### Requirement: Optional host differences are visible and non-breaking

A host-optional provider MAY be exposed only on a supporting host. The command surface and status SHALL avoid deterministic failure on unsupported hosts.

#### Scenario: Optional inlay hints exist only on Desktop

- GIVEN Desktop advertises qualified inlay hints and Web does not
- WHEN the same workspace opens
- THEN authored semantics and files MUST remain identical
- AND Web MUST not register a failing hint provider
- AND settings/status MUST permit the difference to be diagnosed

### Requirement: Cutover removes superseded state paths

After all hosts use the shared coordinator and router, duplicated Worker/process project state、related Web maps and feature-specific lifecycle code SHALL be removed rather than retained as compatibility shims.

#### Scenario: Migration is complete

- GIVEN baseline and new capability fixtures pass through the shared runtime
- WHEN cleanup executes
- THEN no second project revision owner or same-version document synchronization path may remain
- AND behavior tests MUST continue to pass after deletion
