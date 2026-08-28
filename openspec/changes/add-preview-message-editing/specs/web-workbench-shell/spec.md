## ADDED Requirements

### Requirement: Preview Composer offers a pointer-anchored message editor

The production Web Workbench SHALL show **“编辑消息…”** only for a current target carrying the server-provided `statementText` capability. Choosing it SHALL open a compact pointer-anchored single-line Monaco editor with integrated parse-mode controls and the existing Composer request/apply lifecycle.

#### Scenario: Action appears from any semantic region of the chat statement

- GIVEN bubble、avatar、display-name or exact text hit-testing maps to the same current chat statement
- AND `mmt/previewComposerTarget` includes `statementText`
- WHEN the native context menu opens at the original pointer
- THEN it MUST include exact label “编辑消息…”
- AND choosing it MUST open the pointer-adjacent message editor prefilled with `statementText.current`
- AND the client MUST NOT read visible SVG/DOM text as current value or authorization

#### Scenario: Action appears for narration without chat actions

- GIVEN a narration semantic region maps to a current narration statement
- AND `mmt/previewComposerTarget` includes `statementText` but omits `continued` and actor capabilities
- WHEN the native context menu opens
- THEN it MUST include exact label “编辑消息…”
- AND it MUST NOT include continued、display-name or avatar actions
- AND the same pointer-anchored message editor and Composer apply lifecycle MUST be used

#### Scenario: Builtin right-side bubble exposes message editing

- GIVEN a right-side bubble、avatar-space or exact glyph maps to an authored builtin-speaker statement
- AND `mmt/previewComposerTarget` includes `statementText` without actor properties
- WHEN the native context menu opens
- THEN it MUST include “编辑消息…”
- AND it MUST NOT include a separate “解析模式” submenu、display-name or avatar actions
- AND the editor opened by “编辑消息…” MUST expose all five modes

#### Scenario: Integrated mode choices reflect server state

- GIVEN `statementText.mode` is `inherit`、`textMacro`、`textRaw`、`typstMacro` or `typstRaw`
- WHEN the message editor opens
- THEN it MUST show radio choices for inherit、`t`、`rt`、`T` and `rT`
- AND exactly the authored mode MUST be selected
- AND the inherit choice MUST display `statementText.inheritedMode`
- AND switching a choice MUST NOT edit source or send a request before submission

#### Scenario: Editor provides bounded lexical highlighting

- GIVEN the author selects or inherits TextMacro
- WHEN the fragment is displayed
- THEN MMT inline macro syntax MUST receive lexical highlighting
- GIVEN the author selects or inherits TypstMacro or TypstRaw
- THEN Typst syntax MUST receive lexical highlighting
- GIVEN the effective mode is TextRaw
- THEN the fragment MUST use plain-text tokenization
- AND every fragment language id MUST remain private from MMT/Tinymist workspace LSP routing
- AND completion、hover、diagnostic decoration and semantic highlighting MUST remain disabled

#### Scenario: Author submits text and mode together

- GIVEN the message editor contains a valid nonempty single-line value and one selected mode
- WHEN the author presses Enter outside IME composition
- THEN the client MUST send exactly one `{ kind: setStatementBody, value, mode }` command through `mmt/composerEdit`
- AND MUST NOT send separate text/mode commands or build MMT source/TextEdit in TypeScript
- AND an accepted result MUST pass the current identity/version gate and `vscode.workspace.applyEdit` exactly once
- AND normal Local History、didChange analysis and preview rerender MUST own persistence and presentation

#### Scenario: Input is invalid, cancelled or unchanged

- GIVEN the message editor is open with the current content and authored mode
- WHEN value is empty、contains CR/LF、exceeds the UTF-8 limit or Enter occurs during IME composition
- THEN the editor MUST remain open and MUST NOT send a request
- WHEN the author presses Escape or submits both unchanged content and unchanged mode
- THEN the operation MUST close without an `mmt/composerEdit` request
- AND MUST NOT attempt apply、create history or trigger a retry

#### Scenario: Target has no message capability

- GIVEN the context is reply、bond、multiline/errorful、generated or package content
- OR the server otherwise omits `statementText`
- WHEN the context menu opens
- THEN “编辑消息…” MUST be absent
- AND available navigation、continued、display-name or avatar actions MUST retain their existing behavior

### Requirement: Message editor and apply remain bound to current Composer freshness

The message editor、request and apply authority SHALL belong to one current Composer operation and SHALL never retarget after document or PreviewArtifact changes.

#### Scenario: Source or preview changes while editor is open

- GIVEN the message editor is open for TextDocument version V and one PreviewArtifact identity
- WHEN document version、artifact identity、runtime owner or operation identity changes
- THEN the editor MUST close
- AND no command from that stale editor may be sent or applied
- AND the existing stale notification path MAY report the cancellation once

#### Scenario: Server rejects the candidate

- GIVEN `setStatementBody` returns stale、targetChanged、invalidValue、documentHasErrors or candidateInvalid
- WHEN the client parses the strict result
- THEN it MUST show the existing single MomoScript warning path
- AND MUST NOT retry、fall back to navigation、normalize the value or apply client-generated source

#### Scenario: Workspace apply fails

- GIVEN a valid server edit passes parsing but the final version gate fails or `workspace.applyEdit` returns false
- WHEN the operation completes
- THEN source and preview MUST remain unchanged
- AND the client MUST show the existing stale/apply-failed notification exactly once
- AND MUST NOT retry against a newer document
