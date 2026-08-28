## ADDED Requirements

### Requirement: Composer exposes only an authorized single-line message body

The language service SHALL expose `statementText` when one current preview origin uniquely resolves to a left/right chat or narration statement with an editable single-line body. Message text authority SHALL be independent from actor authority, and the descriptor SHALL contain exact `current` content、authored `mode`、`resolvedMode` and `inheritedMode`.

#### Scenario: Current chat message is editable

- GIVEN a current MMT PreviewArtifact point maps uniquely to one left/right statement
- AND its body resolves as TextMacro、TextRaw、TypstMacro or TypstRaw
- AND the authored body is nonempty、single-line and at most 65536 UTF-8 bytes
- WHEN the host requests `mmt/previewComposerTarget`
- THEN `properties.statementText.current` MUST equal the exact authored body content without fence syntax
- AND the descriptor MUST NOT expose URI、body range、statement ordinal、ActorId、AST node or rendered DOM text
- AND `mode` MUST be one of `inherit | textMacro | textRaw | typstMacro | typstRaw`
- AND `resolvedMode` and `inheritedMode` MUST be one of `textMacro | textRaw | typstMacro | typstRaw`

#### Scenario: Builtin right-side message remains editable

- GIVEN a current preview bubble maps to an authored right-side statement using a builtin speaker
- WHEN the host requests `mmt/previewComposerTarget`
- THEN `statementText` MUST be present
- AND actor display-name and avatar properties MUST remain absent
- AND right-clicking bubble、avatar-space or exact text MAY use the same statement capability

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

- GIVEN the point belongs to reply、bond、generated or package content
- OR the body is multiline、empty、overlong or errorful
- WHEN Composer target properties are resolved
- THEN `statementText` MUST be absent or the strict target MUST be unavailable
- AND navigation or existing non-message capabilities MAY remain available
- AND the service MUST NOT infer current text from SVG、DOM、glyphs or navigation fallback

### Requirement: Statement body commands are atomic, structured and strictly bounded

`mmt/composerEdit` SHALL accept only `setStatementBody` with exact `value` and `mode` fields. `mode` SHALL be one of `inherit | textMacro | textRaw | typstMacro | typstRaw`. All source authorization、serialization and TextEdit generation SHALL remain in Rust.

#### Scenario: Valid message body is replaced without changing mode

- GIVEN target range identifies the exact current authorized statement at document version V
- AND value is a different nonempty single-line string of at most 65536 UTF-8 bytes
- AND submitted mode equals the current authored mode
- WHEN `setStatementBody` executes
- THEN Rust MUST replace only `StatementSyntax.body.range`
- AND MUST preserve the existing plain/fenced representation、fence length、sigil、speaker marker、statement patch arguments and whitespace、line endings and every other source byte
- AND the service MUST return exactly one TextDocumentEdit carrying version V and exactly one TextEdit
- AND MUST NOT return `WorkspaceEdit.changes` or mutate the server snapshot

#### Scenario: Text and mode change atomically

- GIVEN an authorized body has current content and authored mode
- WHEN `setStatementBody` submits different content and a different local mode
- THEN Rust MUST return one contiguous TextEdit containing the final content and mode representation
- AND the client MUST NOT issue an intermediate body or mode request
- AND one accepted command MUST produce one document version advance and one history entry

#### Scenario: Plain inherited body becomes an explicit local mode

- GIVEN an authorized plain single-line body
- WHEN `setStatementBody` selects `textMacro`、`textRaw`、`typstMacro` or `typstRaw`
- THEN Rust MUST replace only the body range with the matching `t"""value"""`、`rt"""value"""`、`T"""value"""` or `rT"""value"""`
- AND statement marker、patch parameters and every unrelated byte MUST remain unchanged

#### Scenario: Fenced body changes content or mode

- GIVEN an authorized fenced body with at least three quote bytes
- WHEN submitted mode differs from the authored mode
- THEN Rust MUST replace one range from the existing mode prefix through the closing fence
- AND MUST preserve the existing fence length while writing the submitted content and new prefix
- AND selecting `inherit` MUST produce an unprefixed fenced body without editing file-level `@mode`

#### Scenario: Inherit resolves to any file mode

- GIVEN `inheritedMode` is TextMacro、TextRaw、TypstMacro or TypstRaw
- WHEN `setStatementBody.mode` is `inherit`
- THEN the candidate resolved mode MUST equal that inherited mode
- AND the command MUST NOT edit `@mode` or return a partial edit

#### Scenario: Unicode and escape bytes remain authored bytes

- GIVEN submitted value contains Unicode、quotes or backslashes that do not make the final representation or DSL semantics invalid
- WHEN Rust creates the edit
- THEN the final body content MUST equal the submitted UTF-8 string exactly
- AND neither transport nor TypeScript may trim、normalize or escape-rewrite it

#### Scenario: Wire payload is invalid

- GIVEN value is empty、contains CR or LF、exceeds 65536 UTF-8 bytes
- OR mode is unknown、either required field is absent、an extra field is present or an old command name is used
- WHEN native stdio or WASM parses the command
- THEN it MUST reject invalid params before source editing
- AND MUST NOT coerce、alias or default either field

#### Scenario: Submitted transaction is already current

- GIVEN value byte-equals the authorized current body
- AND mode equals the authorized authored mode
- WHEN the core receives `setStatementBody`
- THEN it MUST return `invalidValue`
- AND MUST NOT create a TextEdit or history entry

#### Scenario: Target or version is stale

- GIVEN the TextDocument version differs from the current snapshot
- OR target range no longer identifies the exact authorized statement/body
- WHEN the command executes
- THEN it MUST return `staleDocument` or `targetChanged`
- AND MUST NOT retarget、retry or apply a partial edit

### Requirement: Message candidate analysis permits only the target body transition

The core SHALL fully reanalyze the in-memory candidate with the same current catalog/PackRegistry and SHALL prove that only the authorized target body changed.

#### Scenario: Candidate preserves unrelated semantics

- GIVEN a valid single-line replacement parses and analyzes without errors
- WHEN before and after analyses are compared
- THEN statement count、kind、speaker marker and patch args MUST remain equal
- AND every non-target statement body source/mode MUST remain equal
- AND actor models、speaker identities/revisions、document config、assets、non-target resource markers、resolutions and failures MUST remain equal
- AND when mode is unchanged, target resource semantics MUST retain the stricter equality gate
- AND when mode changes, only target-local inline resource interpretation MAY change
- AND the target candidate body、authored mode and resolved mode MUST equal the submitted transaction

#### Scenario: Candidate introduces invalid or different DSL semantics

- GIVEN final parsing creates a syntax/Typst/resource error、changes statement shape or changes disallowed resource identity
- WHEN candidate validation runs
- THEN the service MUST return `candidateInvalid`
- AND MUST return no partial edit
