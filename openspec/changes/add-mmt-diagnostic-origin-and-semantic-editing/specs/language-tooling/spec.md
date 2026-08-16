## ADDED Requirements

### Requirement: Renderer diagnostics preserve source identity and precision

The fixed preview renderer SHALL expose successful compile warnings and ordinary compile/layout failures as strictly validated URI-keyed LSP diagnostic records. Entry diagnostics SHALL map to the current MMT snapshot as exact, coarse, or unmapped; non-entry diagnostics SHALL preserve their original project URI and range.

#### Scenario: Identity diagnostic maps exactly to authored MMT

- GIVEN a renderer diagnostic range lies completely inside one current projection Identity segment
- WHEN the host maps the entry diagnostic for the matching source version, revision, projection key, source content, project digest, snapshot token, and backend generation
- THEN it MUST publish the diagnostic on the authored `.mmt` URI at the exact corresponding range
- AND the result MUST retain severity, message, code, data, tags, and mapped related information

#### Scenario: Generated wrapper converges to one authored parent

- GIVEN every source-map chunk covered by a renderer diagnostic follows generated parents to the same authored `TextBody` range
- AND exact Identity mapping does not apply
- WHEN the host maps that diagnostic
- THEN it MAY publish one coarse diagnostic at that authored range
- AND the result MUST be distinguishable from exact Identity precision

#### Scenario: Cross-parent diagnostic is unmapped

- GIVEN a renderer diagnostic range covers chunks whose generated-parent chains reach different authored ranges or no authored range
- WHEN diagnostic mapping runs
- THEN that item MUST be unmapped
- AND the mapper MUST NOT choose the range start or one overlapping parent as representative

#### Scenario: Point diagnostic uses its containing chunk

- GIVEN a zero-length renderer diagnostic is on a valid source-map boundary
- WHEN authored-parent mapping runs
- THEN it MUST apply the established containing-chunk boundary rule
- AND it MUST fail closed when the point is ambiguous or outside mapped generated source

#### Scenario: Dependency diagnostic preserves dependency location

- GIVEN a renderer diagnostic or related-information location targets a non-entry workspace, package, or generated project URI
- WHEN the current batch is published
- THEN its URI and range MUST be preserved
- AND it MUST NOT be relabeled as authored MMT

#### Scenario: One unmapped item does not discard mapped peers

- GIVEN one batch contains exact, coarse, dependency, ambiguous, and malformed diagnostic items
- WHEN `mmt/mapTypstDiagnostics` maps entry items
- THEN its result MUST have the same length and order as its input
- AND an independently invalid item MUST be represented by `null`
- AND valid exact or coarse peers MUST remain available

#### Scenario: Stale diagnostic batch publishes nothing

- GIVEN any response identity no longer matches source version, revision, source content, project digest, projection key, snapshot token, or backend generation
- WHEN renderer diagnostic mapping or publication completes
- THEN the entire batch MUST be rejected
- AND no authored, dependency, or generated Problems entry from that batch may be published

### Requirement: Diagnostic fallback is never edit authority

Authored-parent diagnostic fallback SHALL be used only to place read-only diagnostics. It SHALL NOT relax the current Identity-only contract for projected mapping or semantic edits.

#### Scenario: Coarse marker cannot authorize an edit

- GIVEN a Synthetic, Escaped, or MacroExpansion segment has a unique authored parent and receives a coarse diagnostic
- WHEN rename, formatting, code action, `ProjectionIndex::typst_to_mmt`, `map_text_edit`, or `mmt/validateProjectedEdit` evaluates that segment
- THEN the operation MUST remain rejected
- AND no fallback range may be reused as an editable range

### Requirement: Compile failure is a renderer result rather than an infrastructure fault

Ordinary compile/layout failure SHALL return an identity-bound `compileFailed` response with structured diagnostics, no generation, and no staged artifact. Transport, session, digest, frame, protocol, converter, and infrastructure faults SHALL remain JSON-RPC errors.

#### Scenario: Failed compile preserves committed preview and generation

- GIVEN generation N is committed
- WHEN the next identity-valid render returns `compileFailed`
- THEN no staged artifact SHALL be created
- AND no generation SHALL be consumed or advanced
- AND the last committed SVG MUST remain visible and be marked stale
- AND the Layout diagnostics MUST be published by their actual target URIs

#### Scenario: Corrected source reuses committed base

- GIVEN a compile failure occurred after committed generation N
- WHEN corrected source renders successfully
- THEN the renderer MUST use N as the committed base
- AND the successful response MUST commit the next valid generation
- AND prior Layout diagnostics MUST be cleared
- AND the preview MUST no longer be marked stale

#### Scenario: Successful build reports warnings

- GIVEN Typst produces a document and warning or informational diagnostics
- WHEN the renderer returns `ready`
- THEN its response MUST include deterministically sorted diagnostic records
- AND those records MUST pass the same URI mapping, validation, identity, and publication path as compile-failure records
- AND they MUST NOT prevent the valid preview from committing

#### Scenario: Native and Web responses are equivalent

- GIVEN the native process and WASM Worker render the same virtual project and negotiated position encoding
- WHEN compilation succeeds or fails
- THEN normalized response discriminants, identity fields, diagnostic records, ordering, and generation behavior MUST be equivalent
- AND neither path may parse human-readable diagnostic strings to recover ranges

### Requirement: Preview Problems retain source ownership and actual targets

Preview/build diagnostics SHALL be owned by the MMT source URI while replacement and clearing are grouped by each actual target URI. The Problems UI SHALL prefer an otherwise identical preview/build item over the language item and restore the language item after preview clearing.

#### Scenario: Authored and dependency diagnostics publish together

- GIVEN one current build returns an authored entry error and a package dependency error
- WHEN the host publishes the batch
- THEN the entry error MUST target authored `.mmt`
- AND the dependency error MUST target its retained read-only `mmt-package:` or `mmt-projection:` document
- AND clearing or replacing that source owner's build MUST update both targets without clearing another owner's diagnostics

#### Scenario: Project error without source span stays in status

- GIVEN an identity-valid project failure has no source URI and range
- WHEN the host surfaces it
- THEN the preview status MAY describe the failure
- AND the Problems publisher MUST NOT invent a `(0,0)` authored marker

#### Scenario: Preview item shadows duplicate language item

- GIVEN language and preview channels produce the same target URI, range, severity, and message
- WHEN preview diagnostics are active
- THEN the Problems UI MUST contain only the preview/build item for that key
- AND clearing preview diagnostics MUST reveal the still-current language item

### Requirement: Semantic navigation uses snapshot-local resolved identities

MMT Definition and References SHALL use semantic occurrences recorded during lowering in the immutable document analysis. They SHALL NOT find symbols by searching source text.

#### Scenario: Actor aliases share navigation identity

- GIVEN one ActorId has a primary authored name and one or more `also-as` aliases
- WHEN Definition or References is requested on any explicit alias, reopen, speaker, history marker, or resolved actor resource occurrence
- THEN References MUST aggregate by ActorId and honor `includeDeclaration`
- AND an explicit alias reference's Definition MUST target that alias binding
- AND a history marker's Definition MUST target the actor's primary authored binding

#### Scenario: Actor-name rename preserves binding identity

- GIVEN two authored names resolve to the same ActorId
- WHEN Rename is prepared or executed on one name binding
- THEN only occurrences carrying that `ActorName { actor, name }` binding key may be edited
- AND the other alias and `_` or `~` history markers MUST remain unchanged

#### Scenario: Omitted and builtin speakers have no semantic occurrence

- GIVEN a statement uses an omitted speaker or a builtin speaker
- WHEN the semantic index is built
- THEN an omitted speaker MUST create no occurrence
- AND a builtin speaker MUST not enter actor navigation or rename identity

#### Scenario: Headless or Pack actor remains read-only

- GIVEN an explicit reference resolves to a Pack-provided or headless-lazy actor without an authored binding
- WHEN Definition, References, or Rename is requested
- THEN the explicit token MAY participate in read-only references
- AND Definition MUST return null when no authored binding exists
- AND Prepare Rename and Rename MUST return null

#### Scenario: Script and Pack assets remain distinct

- GIVEN a resource selector resolves to a declared script asset in one case and a Pack asset in another
- WHEN semantic occurrences are built
- THEN the script asset declaration and exactly reserializable references MUST share one AssetId identity and rename binding
- AND the Pack asset MAY be navigable read-only but MUST NOT be renameable

#### Scenario: Smallest exact occurrence wins

- GIVEN semantic occurrence ranges overlap at a requested offset
- WHEN `symbol_at` selects an occurrence
- THEN it MUST select the unique smallest exact containing range
- AND tied ambiguity MUST return no symbol

### Requirement: Native rename is strict, atomic, and versioned

MMT Prepare Rename and Rename SHALL operate only on an exact editable actor-name or script-asset binding in an error-free current snapshot. A candidate SHALL be fully reserialized, applied in memory, and accepted only after complete pure reanalysis preserves the semantic contract.

#### Scenario: Prepare Rename returns authored syntax

- GIVEN the cursor is on a renameable actor-name or script-asset binding occurrence
- AND the current snapshot contains no Error diagnostic
- WHEN Prepare Rename is requested
- THEN it MUST return the exact authored occurrence range and logical-name placeholder
- AND Pack, builtin, positional, history, unresolved, ambiguous, omitted, or incompletely serializable targets MUST return null

#### Scenario: Actor rename round-trips every speaker

- GIVEN an actor-name binding has declaration and raw explicit speaker occurrences
- WHEN a new name is proposed
- THEN declaration encoding MUST use the declaration parser's round-trip encoder
- AND every raw speaker replacement MUST reparse to the same Explicit marker and actor identity
- AND one failing occurrence MUST reject the whole rename

#### Scenario: Asset rename preserves selector form

- GIVEN a script asset is referenced by exactly reserializable resource arguments
- WHEN it is renamed to a `valid_asset_name`
- THEN every resource argument MUST retain its original selector form
- AND collision with another asset or an unresolved replacement MUST reject the whole rename

#### Scenario: Reanalysis proves semantic stability

- GIVEN all candidate replacements can be serialized
- WHEN the candidate document is analyzed
- THEN it MUST have zero Error diagnostics
- AND target definition/reference counts and roles MUST be unchanged
- AND actor speaker/history/resource resolution MUST retain ActorId identity
- AND asset source/selector changes MUST be limited to the expected AssetId name replacement
- AND every unrelated semantic key MUST remain unchanged

#### Scenario: Rename returns one current-version edit

- GIVEN candidate reanalysis succeeds for the current open document version V
- WHEN Rename returns
- THEN it MUST return one `TextDocumentEdit` for that document with version V
- AND it MUST NOT send a private apply notification, return partial edits, or reuse projected-edit validation

#### Scenario: UTF-8 and UTF-16 preserve Unicode ranges

- GIVEN authored names and nearby text contain CJK and supplementary-plane characters
- WHEN Definition, References, Prepare Rename, or Rename runs under negotiated UTF-8 or UTF-16 position encoding
- THEN every LSP position MUST correspond to the same exact UTF-8 semantic occurrence
- AND invalid character boundaries MUST be rejected

### Requirement: One semantic route owns MMT and projected Typst operations

Definition, References, Prepare Rename, and Rename for an MMT document SHALL be routed by one current-snapshot decision to `native`, `projected`, or `none`. Native and projected providers SHALL NOT compete through registration order.

#### Scenario: Native token never falls through

- GIVEN a cursor is in an actor, asset, speaker, or resource native token zone, including an unresolved native token
- WHEN the route is requested
- THEN `mmt/semanticRoute` MUST return `native`
- AND middleware MUST call the MMT language-client continuation only
- AND a native null or error MUST NOT fall through to Tinymist

#### Scenario: Embedded Typst identity uses projected provider

- GIVEN a cursor is outside every native token zone and lies in a current AuthoredIdentity projection segment
- WHEN Definition, References, Prepare Rename, or Rename is requested
- THEN the route MUST return `projected`
- AND reads MUST use the revision-bound projected read-location mapper
- AND rename MUST use `ProjectedEditAdapter` plus `mmt/validateProjectedEdit`

#### Scenario: Generated or stale position has no provider

- GIVEN a cursor maps to Synthetic, Escaped, MacroExpansion, stale, or ambiguous projection state
- WHEN a semantic operation is requested
- THEN the route MUST return `none`
- AND middleware MUST return no result without invoking native or projected semantic providers

#### Scenario: Native operations survive without Tinymist

- GIVEN no Tinymist backend is connected
- WHEN a native actor or script-asset operation is requested
- THEN the native language service MUST still answer
- AND a projected route MUST fail closed

#### Scenario: Typst documents remain Typst-owned

- GIVEN the active document is authored `.typ`
- WHEN a semantic operation is requested
- THEN MMT middleware MUST NOT call the MMT continuation
- AND the standalone Typst provider MAY answer only when its backend is connected

#### Scenario: Desktop and Web share provider precedence

- GIVEN Desktop Extension Host, Web Extension Host, and standalone Workbench open the same MMT snapshot
- WHEN native actor/asset and embedded Typst semantic operations are requested
- THEN all hosts MUST make the same native/projected/none routing decision
- AND projected backend connect/dispose MUST install and clear the same late-bound dispatcher
- AND provider registration order MUST NOT change the result
