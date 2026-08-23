## ADDED Requirements

### Requirement: Preview contextual editing resolves a current semantic node

Preview contextual editing SHALL identify one current MMT syntax/semantic node from the retained renderer location and projection origin ancestry. It SHALL NOT treat an authored-parent navigation/diagnostic fallback or raw backend range as general edit authority.

#### Scenario: Generated chat wrapper identifies its owning statement

- GIVEN a committed MMT preview point resolves to a generated `mmt.chat-left` or `mmt.chat-right` location
- AND the current projection origin ancestry has one nearest left/right statement owner
- WHEN the host requests `mmt/previewComposerTarget` with the complete render/projection identity
- THEN the service MUST prove that owner range exactly matches one `StatementSyntax` in the current document snapshot
- AND MUST return the current document URI/version、statement range and allowlisted property descriptors
- AND the response MUST NOT expose a mutable AST object or general Typst→MMT edit mapping

#### Scenario: Fallback cannot become a Composer target

- GIVEN preview navigation can only produce authored fallback、raw workspace Typst fallback、generated projection、package、stale or ambiguous origin evidence
- WHEN contextual editing requests a target
- THEN the service MUST return an explicit unavailable reason
- AND `ProjectionIndex::typst_to_mmt`、`map_text_edit`、Rename、Formatting、Code Action and projected-edit validation MUST remain unchanged

#### Scenario: Preview identity becomes stale

- GIVEN a target request carries source version、revision、sourceContent、projectDigest or projectionKey from an older preview
- WHEN a newer source/projection identity is current
- THEN the request MUST return `stalePreview`
- AND MUST NOT fall forward to a nearby statement or current revision

### Requirement: Composer mutations are pure, strict, atomic, and versioned

`mmt/composerEdit` SHALL re-resolve an allowlisted target and command against one current error-free MMT snapshot, construct candidate source, and fully reanalyze it before returning an edit. The service SHALL remain pure.

#### Scenario: Valid Composer command returns one versioned edit

- GIVEN a Composer command is valid for document version V and candidate reanalysis succeeds
- WHEN the service returns the mutation
- THEN the result MUST contain exactly one `TextDocumentEdit` for that URI with version V
- AND `WorkspaceEdit.changes` MUST be absent
- AND the service MUST NOT mutate its snapshot、apply the edit、send a private apply notification or return a partial edit

#### Scenario: Client applies a returned edit

- GIVEN the client receives a valid versioned WorkspaceEdit
- WHEN the open TextDocument still has the returned version
- THEN the client MAY call `vscode.workspace.applyEdit`
- AND ordinary didChange、workspace persistence、history、diagnostics and preview scheduling MUST own the result
- WHEN the version changed or application returns false
- THEN the client MUST report failure without retrying the command against newer text

#### Scenario: Candidate changes unrelated semantics

- GIVEN a source edit parses but changes target identity、speaker history、asset/resource resolution or unrelated semantic keys outside the command contract
- WHEN full pure reanalysis compares the candidate
- THEN the service MUST return `candidateInvalid`
- AND MUST return no edit

### Requirement: Statement continued editing preserves unrelated source

The first statement property command SHALL expose only `continued = auto | true | false` for left/right chat statements and SHALL structurally edit the top-level statement patch.

#### Scenario: Continued is inserted or updated

- GIVEN an error-free left/right statement has no `continued` argument or one unique valid argument
- WHEN the command sets `continued` to `true` or `false`
- THEN the service MUST insert or replace only that named argument
- AND every other patch argument、speaker、body、inline resource、spacing and spelling MUST retain its authored bytes

#### Scenario: Continued returns to automatic behavior

- GIVEN a statement patch contains one valid `continued` argument
- WHEN the command sets `continued` to `auto`
- THEN that argument MUST be removed
- AND the complete patch enclosure MUST be removed only when no other argument remains

#### Scenario: Continued patch is unsafe to rewrite

- GIVEN the patch has duplicate、malformed、nested-ambiguous or otherwise non-round-trippable `continued` syntax
- WHEN the command executes
- THEN it MUST be rejected rather than normalized or replaced by string splitting

### Requirement: Actor display-name editing creates an explicit revision from the target

The first actor presentation command SHALL implement “从本条起修改人物显示名” by using existing canonical `@actor` and `display-name` semantics. It SHALL NOT rename actor references or synthesize a one-bubble override.

#### Scenario: Display name changes from the selected statement

- GIVEN a selected left/right statement resolves to a non-builtin ActorId with one serializable actor name
- WHEN the command supplies a non-empty display string
- THEN the service MUST insert an `@actor <name>` block with a round-tripped `display-name` immediately before that statement
- OR minimally update/insert `display-name` in an immediately adjacent same-ActorId block whose revision begins at that statement
- AND statements before the target MUST retain their prior actor presentation
- AND the target MUST resolve to the same ActorId with the requested display name
- AND Pack preset、actor reference names、speaker history and resources MUST remain unchanged

#### Scenario: Display name contains quoting or Unicode

- GIVEN the requested display string contains CJK、supplementary characters、quotes or backslashes
- WHEN the service serializes the field
- THEN it MUST use the declaration literal parser/encoder and negotiated UTF-8/UTF-16 range conversion
- AND candidate parsing MUST recover exactly the requested scalar value

#### Scenario: Actor cannot accept a display revision

- GIVEN the statement resolves to a builtin、unresolved、ambiguous actor or has no unambiguous serializable actor name
- WHEN the command is requested
- THEN target capabilities MUST omit display-name editing or the edit MUST return `actorUnavailable`
- AND the service MUST NOT guess from rendered text or Catalog aliases

#### Scenario: One-bubble nickname remains unavailable

- GIVEN an author wants only one message bubble to show a different name
- WHEN the first contextual-editing contract is active
- THEN the UI MUST NOT simulate that behavior with a hidden actor revision and restore block
- AND a statement-local nickname requires a separate DSL and template specification
