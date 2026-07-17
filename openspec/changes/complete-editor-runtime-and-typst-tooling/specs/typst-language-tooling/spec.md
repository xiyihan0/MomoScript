## ADDED Requirements

### Requirement: Typst providers are enabled from observed capabilities

The editor SHALL capture and normalize complete initialize results from the fixed native and Web Tinymist artifacts. It SHALL NOT claim or register an optional provider solely because a generic language client could route it.

#### Scenario: Capability is proposed but not advertised

- GIVEN definition、references or formatting is listed as a desired feature
- AND one fixed artifact does not advertise the provider
- WHEN the capability matrix is generated
- THEN the feature MUST NOT be marked core-required or complete
- AND the implementation MUST either qualify a new fixed artifact or classify the feature as host-optional/unavailable

#### Scenario: Backend dynamically registers a provider

- GIVEN the backend sends `client/registerCapability` after initialize
- WHEN the runtime accepts the registration
- THEN the capability registry MUST record it for that backend generation
- AND requests MUST stop when the registration is removed or the generation ends

### Requirement: Baseline Typst features migrate without regression

Diagnostics、completion、hover、signature help and semantic tokens SHALL retain their current standalone and safely projected behavior while moving to the shared router.

#### Scenario: MMT and Typst both have a completion result

- GIVEN the cursor is in an MMT construct for which `mmt_lsp` returns completion
- WHEN completion is requested
- THEN the MMT-native result MUST win
- AND the host MUST NOT issue a speculative Tinymist request

#### Scenario: Completion falls back inside authored Typst

- GIVEN MMT has no definitive completion and the cursor maps to current projected Identity content
- WHEN Tinymist returns completion items
- THEN items and edits MUST be mapped through Rust against the request revision
- AND stale or unsafe items MUST NOT be published

### Requirement: Qualified standalone Typst providers use the shared router

For a standalone `.typ` document, each explicitly enumerated provider present in the checked capability manifest and backed by passing method transcripts SHALL route directly to the active Typst project with cancellation、complete-project-snapshot checks、backend-generation checks and explicit position encoding. Other advertised providers SHALL remain classified but unavailable until implemented and qualified.

#### Scenario: Standalone rename completes

- GIVEN both fixed artifacts qualified rename and the document version is V
- WHEN the user renames a symbol
- THEN the backend workspace edit MUST be decoded against V
- AND only writable current workspace files may be edited
- AND standard document changes MUST advance the resulting snapshots

#### Scenario: Provider is absent on active host

- GIVEN code lens is absent from the active artifact capability manifest
- WHEN a `.typ` file opens
- THEN the editor MUST NOT register a code-lens route that deterministically fails
- AND the capability matrix/status MAY explain the intentional absence

### Requirement: Projected read results classify every target

Projected definitions、references、highlights、selection ranges、links、symbols、colors、hints and lenses SHALL classify each result as authored MMT、workspace Typst、package file、generated projection or stale/unknown before publication.

#### Scenario: Definition points to authored MMT

- GIVEN a backend definition location lies wholly in a current Identity segment
- WHEN it is mapped
- THEN navigation MUST open the authored MMT URI and range

#### Scenario: Definition points to generated wrapper

- GIVEN a definition points to Synthetic generated Typst in a retained generation
- WHEN navigation is requested
- THEN the editor MAY open that exact generation as a read-only virtual document
- AND MUST NOT represent the generated range as authored MMT

#### Scenario: Package reference target is returned

- GIVEN a reference target lies in an active immutable package
- WHEN the result is shown
- THEN it MUST use a read-only package URI tied to the package digest
- AND editing commands MUST be disabled for that target

### Requirement: Partial read-result mapping is method-specific

A list-style read feature MAY omit individually stale or unmappable results only when doing so preserves the method's semantics. Edit-producing features SHALL never use partial mapping.

#### Scenario: References contain one stale generated location

- GIVEN references contains current authored locations and one unavailable old projection location
- WHEN mapping runs
- THEN current safe references MAY be returned
- AND the stale item MUST be omitted
- AND debug state MUST record why it was omitted without leaking source content

### Requirement: Payload-bearing providers use the same safety transaction

Color presentations、inlay hints、code lenses、document links and future provider results containing edits、commands or URIs SHALL validate those fields against the current project/projection snapshot、writable-target policy、Identity mapping and command allowlist before publication or execution.

#### Scenario: Inlay hint carries an unsafe command

- GIVEN an otherwise mappable projected inlay hint carries an unknown or host-I/O command
- WHEN payload validation runs
- THEN the command MUST NOT be published or executed
- AND the item MAY remain only when the protocol declares it semantically complete without the command

#### Scenario: Color presentation edits generated content

- GIVEN a projected color presentation contains an edit outside its current Identity segment
- WHEN payload validation runs
- THEN the complete presentation MUST be rejected

### Requirement: Selection ranges stop at unsafe ancestors

Nested selection ranges SHALL map from inner to outer and stop before the first range that crosses a segment boundary、generated region or stale generation.

#### Scenario: Outer selection includes generated wrapper

- GIVEN the innermost selection lies in Identity content
- AND its parent includes Synthetic content
- WHEN selection range is requested
- THEN the Identity child MUST be returned
- AND the unsafe parent and all ancestors MUST be omitted

### Requirement: Projected edits are atomic and Identity-only

Rename、formatting and code-action workspace edits SHALL be validated as one transaction. Every projection text edit SHALL lie wholly in one current Identity segment and target a writable authored document. Multi-document application SHALL remain disabled until `WorkspaceCoordinator` provides journaled preimages、all-target commit and rollback proven under partial-failure fixtures.

#### Scenario: Rename touches authored and generated code

- GIVEN one rename edit maps to authored Identity content
- AND another edit touches Synthetic content
- WHEN the transaction is validated
- THEN the entire rename MUST be rejected as `UnsafeEdit`
- AND no authored file may change

#### Scenario: Document changes before edit application

- GIVEN a valid workspace edit was produced for document version V
- AND one target document advances to V+1
- WHEN application begins
- THEN the entire edit MUST be rejected as stale
- AND MUST NOT be remapped against V+1

#### Scenario: Atomic coordinator is not available

- GIVEN a valid projected edit targets more than one writable document
- AND journaled atomic apply/rollback has not qualified
- WHEN application is requested
- THEN the entire edit MUST be rejected as capability unavailable
- AND no document may change

### Requirement: Embedded formatting is range-limited

Tinymist SHALL NOT format a full MMT document. Embedded Typst range formatting MAY run only when the requested range and every returned edit remain within the same current Identity segment.

#### Scenario: Formatter rewrites outside selected Identity segment

- GIVEN the selected range lies in an `@typ` Identity segment
- WHEN the formatter returns an edit extending into a generated wrapper
- THEN the full formatting result MUST be rejected

#### Scenario: Format on save is enabled for Typst

- GIVEN standalone `.typ` format-on-save is enabled
- WHEN an `.mmt` document is saved
- THEN the editor MUST NOT delegate the complete MMT document to Tinymist

### Requirement: Command-bearing code actions are constrained

A projected code action command SHALL run only when it is explicitly allowlisted、belongs to the current backend generation and does not request shell、network、clipboard or arbitrary filesystem access.

#### Scenario: Code action contains a safe edit and unknown command

- GIVEN all text edits map safely
- AND the action also carries an unknown backend command
- WHEN validation runs
- THEN the action MUST be rejected or published without the command only if the backend declares the edit semantically complete by itself
- AND the command MUST NOT execute

### Requirement: Workspace symbols preserve authored semantics

When qualified, workspace symbol results SHALL merge MMT and Typst indexes by canonical URI/range/kind/name, hide generated projection-only symbols and deduplicate authored mappings.

#### Scenario: Same function appears in projection and authored MMT index

- GIVEN Tinymist returns a projected symbol that maps to an MMT symbol already returned by `mmt_lsp`
- WHEN workspace results merge
- THEN one authored result MUST be shown
- AND the generated projection URI MUST remain hidden
