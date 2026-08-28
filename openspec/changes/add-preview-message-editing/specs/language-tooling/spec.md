## ADDED Requirements

### Requirement: Composer exposes only an authorized single-line message body

The language service SHALL expose `statementText` only when one current preview origin uniquely resolves to a left/right chat statement with a uniquely resolved non-builtin actor, or to a narration statement, and the target has an editable single-line text body. The descriptor SHALL contain exact `current` content、authored `mode`、`resolvedMode` and `inheritedMode`.

#### Scenario: Current chat message is editable

- GIVEN a current MMT PreviewArtifact point maps uniquely to one left/right statement
- AND its speaker resolves uniquely to a non-builtin ScriptActor
- AND its resolved body mode is TextMacro or TextRaw
- AND the authored body is nonempty、single-line and at most 65536 UTF-8 bytes
- WHEN the host requests `mmt/previewComposerTarget`
- THEN `properties.statementText.current` MUST equal the exact authored body content without fence syntax
- AND the descriptor MUST NOT expose URI、body range、statement ordinal、ActorId、AST node or rendered DOM text
- AND `mode` MUST be one of `inherit | textMacro | textRaw`
- AND `resolvedMode` and `inheritedMode` MUST be one of `textMacro | textRaw | typstMacro | typstRaw`

#### Scenario: Current narration is editable

- GIVEN a current MMT PreviewArtifact point maps uniquely to one narration statement
- AND its resolved body mode is TextMacro or TextRaw
- AND the authored body is nonempty、single-line and at most 65536 UTF-8 bytes
- WHEN the host requests `mmt/previewComposerTarget`
- THEN `properties.statementText.current` MUST equal the exact authored narration body
- AND `continued`、actor display-name and actor avatar properties MUST be absent

#### Scenario: Current fenced text body is editable

- GIVEN a current chat or narration statement uses single-line `t"""..."""` or `rt"""..."""`
- WHEN the host requests `mmt/previewComposerTarget`
- THEN `statementText.current` MUST contain only the authored fence content
- AND authored、resolved and inherited mode fields MUST describe the same analysis snapshot

#### Scenario: Region does not authorize message editing

- GIVEN the point belongs to reply、bond、builtin、unresolved、ambiguous、generated or package content
- OR the body is multiline、Typst-resolved、empty、overlong or errorful
- WHEN Composer target properties are resolved
- THEN `statementText` MUST be absent or the strict target MUST be unavailable
- AND navigation or existing non-message capabilities MAY remain available
- AND the service MUST NOT infer current text from SVG、DOM、glyphs or navigation fallback

### Requirement: Statement text commands are structured and strictly bounded

`mmt/composerEdit` SHALL accept `setStatementText` with exactly one `value` field. All source authorization and TextEdit generation SHALL remain in Rust.

#### Scenario: Valid message body is replaced

- GIVEN target range identifies the exact current authorized statement at document version V
- AND value is a different nonempty single-line string of at most 65536 UTF-8 bytes
- WHEN `setStatementText` executes
- THEN Rust MUST replace only `StatementSyntax.body.range`
- AND MUST preserve sigil、speaker marker、statement patch arguments and whitespace、body indentation、line endings and every other source byte
- AND the service MUST return exactly one TextDocumentEdit carrying version V
- AND MUST NOT return `WorkspaceEdit.changes` or mutate the server snapshot

#### Scenario: Unicode and escape bytes remain authored bytes

- GIVEN the requested value contains Unicode、quotes or backslashes that do not introduce invalid or different DSL resource semantics
- WHEN Rust creates the edit
- THEN `newText` MUST equal the submitted UTF-8 string exactly
- AND neither transport nor TypeScript may trim、normalize、quote or escape-rewrite it

#### Scenario: Wire payload is invalid

- GIVEN value is empty、contains CR or LF、exceeds 65536 UTF-8 bytes or uses an alternate/unknown field
- WHEN native stdio or WASM parses the command
- THEN it MUST reject the request as invalid params before source editing
- AND MUST return no edit

#### Scenario: Submitted value is already current

- GIVEN value byte-equals the authorized current body
- WHEN the core receives `setStatementText`
- THEN it MUST return `invalidValue`
- AND MUST NOT create a TextEdit or history entry

#### Scenario: Target or version is stale

- GIVEN the TextDocument version differs from the current snapshot
- OR target range no longer identifies the exact authorized statement/body
- WHEN the command executes
- THEN it MUST return `staleDocument` or `targetChanged`
- AND MUST NOT retarget、retry or apply a partial edit

### Requirement: Statement parse-mode commands are local and structured

`mmt/composerEdit` SHALL accept `setStatementTextMode` with exactly one `value` selected from `inherit | textMacro | textRaw`. Rust SHALL own all source serialization and candidate validation.

#### Scenario: Plain inherited body becomes local text mode

- GIVEN an authorized plain single-line body in inherited text mode
- WHEN `setStatementTextMode` selects `textMacro` or `textRaw`
- THEN Rust MUST replace only the body range with `t"""current"""` or `rt"""current"""`
- AND current content、statement marker、patch parameters and every unrelated byte MUST remain unchanged

#### Scenario: Fenced body mode changes minimally

- GIVEN an authorized `t"""current"""` or `rt"""current"""` body
- WHEN another local text mode is selected
- THEN Rust MUST replace only the existing fence prefix
- AND selecting `inherit` MUST produce `"""current"""`

#### Scenario: Inherit would resolve to Typst

- GIVEN the statement's inherited mode is TypstMacro or TypstRaw
- WHEN `setStatementTextMode` selects `inherit`
- THEN the command MUST return `invalidValue`
- AND MUST NOT edit `@mode`、select local `T`/`rT` or return a partial edit

#### Scenario: Mode wire payload is invalid

- GIVEN the mode is unknown or the command contains an extra field
- WHEN native stdio or WASM parses `setStatementTextMode`
- THEN it MUST reject invalid params before source editing
- AND MUST NOT coerce、alias or default the mode

### Requirement: Message candidate analysis permits only the target body transition

The core SHALL fully reanalyze the in-memory candidate with the same current catalog/PackRegistry and SHALL prove that only the authorized target body changed.

#### Scenario: Candidate preserves unrelated semantics

- GIVEN a valid single-line replacement parses and analyzes without errors
- WHEN before and after analyses are compared
- THEN statement count、kind、speaker marker、patch args and body mode MUST remain equal
- AND every non-target statement body MUST remain equal
- AND actor models、speaker identities/revisions、document config、assets、resource markers、resource resolutions and failures MUST remain equal
- AND for a mode command, only the target body mode and target-local inline resource interpretation MAY change
- AND every non-target resource marker、resolution and failure MUST remain equal
- AND the target candidate body MUST equal the requested value and remain an editable single-line text body

#### Scenario: Candidate introduces invalid or different DSL semantics

- GIVEN replacement parsing creates a syntax/Typst/resource error、changes statement shape or changes inline resource identity
- WHEN candidate validation runs
- THEN the service MUST return `candidateInvalid`
- AND MUST return no partial edit
