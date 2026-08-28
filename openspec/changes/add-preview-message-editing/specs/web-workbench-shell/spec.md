## ADDED Requirements

### Requirement: Preview Composer offers pointer-anchored message editing

The production Web Workbench SHALL show **“编辑消息…”** only for a current target carrying the server-provided `statementText` capability. It SHALL reuse the existing native pointer-anchored context InputBox and existing Composer request/apply lifecycle.

#### Scenario: Action appears from any semantic region of the chat statement

- GIVEN bubble、avatar、display-name or exact text hit-testing maps to the same current chat statement
- AND `mmt/previewComposerTarget` includes `statementText`
- WHEN the native context menu opens at the original pointer
- THEN it MUST include exact label “编辑消息…”
- AND choosing it MUST open the existing pointer-adjacent InputBox
- AND the InputBox MUST be prefilled with `statementText.current`
- AND the client MUST NOT read visible SVG/DOM text as current value or authorization

#### Scenario: Action appears for narration without chat actions

- GIVEN a narration semantic region maps to a current narration statement
- AND `mmt/previewComposerTarget` includes `statementText` but omits `continued` and actor capabilities
- WHEN the native context menu opens at the original pointer
- THEN it MUST include exact label “编辑消息…”
- AND it MUST NOT include continued、display-name or avatar actions
- AND the same pointer-adjacent InputBox and Composer apply lifecycle MUST be used

#### Scenario: Author submits a different message

- GIVEN the InputBox contains a different nonempty value
- WHEN the author presses Enter
- THEN the client MUST send exactly one `{ kind: setStatementText, value }` command through `mmt/composerEdit`
- AND MUST NOT build MMT source or a TextEdit in TypeScript
- AND an accepted result MUST pass the current identity/version gate and `vscode.workspace.applyEdit` exactly once
- AND normal Local History、didChange analysis and preview rerender MUST own persistence and presentation

#### Scenario: Input is cancelled or unchanged

- GIVEN the message InputBox is open with the current value
- WHEN the author presses Escape or accepts the unchanged value
- THEN the operation MUST close without an `mmt/composerEdit` request
- AND MUST NOT attempt apply、create history or trigger a retry

#### Scenario: Target has no message capability

- GIVEN the context is reply、bond、builtin、unresolved、ambiguous、multiline/non-text、generated or package content
- OR the server otherwise omits `statementText`
- WHEN the context menu opens
- THEN “编辑消息…” MUST be absent
- AND available navigation、continued、display-name or avatar actions MUST retain their existing behavior

### Requirement: Preview Composer offers a local parse-mode radio submenu

For every target carrying `statementText`, the native context menu SHALL include **“解析模式”** with authored-mode radio state from the server descriptor. TypeScript SHALL send only a structured mode command and SHALL NOT serialize MMT source.

#### Scenario: Text mode choices reflect server state

- GIVEN `statementText.mode` is `inherit`、`textMacro` or `textRaw`
- WHEN the context menu opens
- THEN “解析模式” MUST contain “继承（当前：…）”、“文本宏（t）” and “原始文本（rt）”
- AND exactly the authored mode MUST be checked
- AND the inherited mode label MUST come from `statementText.inheritedMode`
- AND no local `T` or `rT` choice may appear

#### Scenario: Author selects a different local mode

- GIVEN the author selects a non-current enabled mode
- WHEN the menu closes
- THEN the client MUST send exactly one `{ kind: setStatementTextMode, value }` through `mmt/composerEdit`
- AND the accepted versioned WorkspaceEdit MUST use the existing freshness/apply lifecycle

#### Scenario: Inherit would select Typst

- GIVEN `statementText.inheritedMode` is `typstMacro` or `typstRaw`
- WHEN the parse-mode submenu opens
- THEN the inherit item MUST show that current inherited mode and MUST be disabled
- AND explicit `textMacro` and `textRaw` MUST remain available

#### Scenario: Current mode is selected

- GIVEN one parse-mode radio item is already checked
- WHEN the author selects that same item
- THEN no `mmt/composerEdit` request or WorkspaceEdit apply may occur

### Requirement: Message input and apply remain bound to current Composer freshness

The message InputBox、request and apply authority SHALL belong to one current Composer operation and SHALL never retarget after document or PreviewArtifact changes.

#### Scenario: Source or preview changes while input is open

- GIVEN the message InputBox is open for TextDocument version V and one PreviewArtifact identity
- WHEN document version、artifact identity、runtime owner or operation identity changes
- THEN the InputBox MUST close
- AND no command from that stale input may be sent or applied
- AND the existing stale notification path MAY report the cancellation once

#### Scenario: Server rejects the candidate

- GIVEN `setStatementText` returns stale、targetChanged、invalidValue、documentHasErrors or candidateInvalid
- WHEN the client parses the strict result
- THEN it MUST show the existing single MomoScript warning path
- AND MUST NOT retry、fall back to navigation、normalize the value or apply client-generated source

#### Scenario: Workspace apply fails

- GIVEN a valid server edit passes parsing but the final version gate fails or `workspace.applyEdit` returns false
- WHEN the operation completes
- THEN source and preview MUST remain unchanged
- AND the client MUST show the existing stale/apply-failed notification exactly once
- AND MUST NOT retry against a newer document
