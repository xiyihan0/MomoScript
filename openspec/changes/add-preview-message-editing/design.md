## Context

现有 Preview Composer 先将当前 PreviewArtifact 中的 renderer point 定位到 generated Typst，再通过 projection origin ancestry 和当前 `AnalyzedDocument` 解析唯一 statement。Host 收到严格 target descriptor 后显示原生 Workbench 菜单；结构化命令由 `mmt/previewComposerTarget` 返回的当前版本与 statement range 绑定，经 Rust `compose_edit[_with_pack]` 生成纯 WorkspaceEdit，并由客户端 freshness gate 应用。

消息正文编辑必须留在这条链中。SVG label、DOM 文本、可见 glyph 和 pointer 只负责定位；它们既不是当前正文的事实源，也不是写权限。`.mmt` 的 `StatementSyntax.body` 与当前分析快照共同构成授权证据；left/right chat 还必须证明解析后的 speaker/actor，narration 则保持无 actor 语义。

## Goals / Non-Goals

### Goals

- 只为一个当前、唯一、可往返的单行 left/right chat 或 narration 文本正文暴露正文与本条解析模式。
- 由 Rust 最小替换 body 内容或本条 fenced mode 前缀，并证明所有非目标语义不变。
- native/WASM/TypeScript 使用一套 strict allowlist；旧版本、旧 PreviewArtifact、无效值和错误候选 fail closed。
- 复用 pointer-anchored `contextInput` 与原生 radio submenu；取消和相同值在客户端不发请求。
- 保持一份当前版本 `TextDocumentEdit`、正常 Local History 与 didChange→analysis→preview 生命周期。

### Non-Goals

- 多行正文、Typst-resolved 正文、富文本或 inline resource picker。
- reply、bond、builtin/unresolved/ambiguous speaker、generated/package 内容。
- 文件级 `@mode` 编辑或本条 `T`/`rT` 选择。
- 从 SVG、DOM、rendered text 或 TypeScript 构造 `.mmt`。
- 新 apply 协议、server-side mutation、retry、兼容别名或第二份 runtime/document 状态。

## Decisions

### 1. Capability 是可选 `statementText` descriptor

`ComposerTarget.statement_text` 为 `{ current, mode, resolved_mode, inherited_mode }`。Wire 精确序列化为 `statementText: { current, mode, resolvedMode, inheritedMode }`：authored mode 只允许 `inherit | textMacro | textRaw`，resolved/inherited mode 只允许 `textMacro | textRaw | typstMacro | typstRaw`。Descriptor 不传 body range、statement ordinal、URI、speaker id、ActorId 或 AST 数据；现有 `target.range` 仍是唯一命令 target。

Capability 仅在以下证据同时成立时出现：

1. projection origin 唯一落在一个 left/right chat 或 narration statement；
2. 当前分析无错误；left/right statement speaker 唯一且解析到非 builtin `ScriptActor`，narration 保持无 speaker/actor；
3. body 的 resolved mode 是 `TextMacro` 或 `TextRaw`；
4. body content 非空、无 CR/LF、长度不超过 65536 UTF-8 bytes，且 plain 或 fenced body source 可由当前 `BodySyntax` 精确往返；
5. authored mode、resolved mode 与 inherited mode 均来自同一分析快照。

多行 continuation、Typst-resolved body 和 builtin target 可以保留既有 continued/navigation 行为，但不获得 `statementText`。单行 `t"""..."""`/`rt"""..."""` 可获得 capability；`current` 是 fence 内正文而非 fence 字节。Narration target 只暴露 `statementText`，不暴露不适用的 `continued` 或 actor capability。

### 2. 命令是 `setStatementText { value }`

所有端只接受这一名称，不提供别名。Rust core 枚举为 `ComposerCommand::SetStatementText(String)`。值必须是 1–65536 UTF-8 bytes、无 `\r`/`\n`；值不 trim、不 Unicode normalize、不 quote/unquote、不解释 DOM 文本。与当前 body source 完全相同返回 `InvalidValue`，避免冗余 edit；产品 UI 更早抑制该请求。

Native/WASM serde command 使用 `deny_unknown_fields`。`rawSource`、range、URI、node id、alternate text keys 或其他未知字段均为 invalid params。TypeScript target parser 对 `statementText` 四个字段运行 exact-key 与枚举 allowlist 校验，并使用同一长度/单行边界。

### 3. Rust 仅替换现有 BodySyntax range

Core 重新以当前 `target.range` 找到 exact statement ordinal，并重新检查 body capability；left/right chat 还重新检查 actor，narration 不要求或合成 actor。它验证 `source[body.range]` 与分析快照中的 `body.source` 完全一致，然后返回：

- `range = statement.body.range`
- `new_text = requested value`

因此 speaker marker、statement patch 参数及其空白、statement sigil、body 前的缩进、文件 CRLF/LF 和全部其他字节天然保持。Rust 不对正文进行转义或拼装整条 statement；不在 TypeScript 生成 TextEdit。

### 4. Candidate gate 允许且只允许目标正文变化

应用内存 edit 后使用与当前文档相同的 PackRegistry/catalog 完整重分析。候选必须：

- 无 syntax、directive、actor、asset、非目标 resource-marker/resolution 或 Typst overlay error；
- statement 数量、kind、speaker marker 与 patch raw args 全部相同；
- 非目标 statement 的 body source/mode 全部相同；
- document config、assets、非目标 resource markers/resolutions/failures 保持相同；
- actor model、speaker identity 和 revision 全部相同；
- 目标候选仍满足单行文本 capability；正文命令保持目标 mode/resource 语义，模式命令只允许目标 body mode 及其 target-local inline resource 解释随 `t`/`rt` 改变。

这意味着会改变 DSL shape、inline resource identity 或其他语义的正文输入返回 `CandidateInvalid`，不返回部分 edit。目标正文的普通 Unicode、引号、反斜杠等字节在不触发额外 DSL 语义时原样保留。

### 5. UI 复用现有 transient contextInput

`PreviewComposerContextMenuSelection` 增加 `{ kind: "messageText" }`，菜单仅在 `statementText` 存在时添加精确标签 **“编辑消息…”**。选择后以 `current` 预填现有 pointer-anchored InputBox；空输入由既有 required-message 机制保持打开，Escape 返回 undefined，相同值直接结束。有效新值发送：

```json
{"kind":"setStatementText","value":"..."}
```

InputBox、menu、request、apply 全部属于当前 `ComposerOperation.transient`/cancellation 生命周期。document version、PreviewArtifact identity、runtime owner 或显式 invalidate 会关闭输入并阻止请求/apply。返回 edit 继续通过 `parseComposerEditResult`、当前 document/version gate、`vscode.workspace.applyEdit`；Local History 与重渲染由现有 didChange 链负责。

### 6. 本条模式命令只编辑 fence

`setStatementTextMode` 只接受 `inherit | textMacro | textRaw`。对 fenced body，Rust 只替换 `"""` 前的 authored prefix；对 plain inherited body，切换到 `t`/`rt` 时将同一正文包装为单行 fenced body。切回 inherit 保留 fence 并删除 prefix，即 `"""..."""`，避免重排正文。

`inherit` 只有在 inherited mode 为 `TextMacro` 或 `TextRaw` 时有效；若文件级 `@mode` 是 `T`/`rT`，客户端禁用继承项，Rust 仍以 `InvalidValue` fail closed。本命令不修改 `@mode`，也不提供本条 Typst 模式。包含无法安全包装的 `"""` 内容返回 `CandidateInvalid`。

UI 在 **“解析模式”** 子菜单中显示三个 radio 项：`继承（当前：…）`、`文本宏（t）`、`原始文本（rt）`。`checked` 表示 authored mode，而继承项文案展示 inherited mode；选择当前项不发送请求。

## Failure Mapping

- 空、CR/LF、超长或同值：`invalidValue`（UI 的空值/同值不发送）。
- exact statement/body capability 变化：`targetChanged`。
- 当前分析错误：`documentHasErrors`。
- 候选分析错误或语义漂移：`candidateInvalid`。
- 文档版本不一致：`staleDocument`。

客户端沿用现有 stale、rejected、apply-failed 通知；不重试、不导航 fallback、不 retarget。

## Risks / Trade-offs

- InputBox 仍只编辑单行正文；fence 与模式前缀通过独立结构化命令管理，避免用户手工编辑语法边界。
- `t`/`rt` 的语义差异可能改变目标正文内部的 inline resource 解释；candidate gate 只豁免该目标范围，任何非目标语义漂移仍拒绝。
- 65536-byte 上限是 transport 与单行产品表面的防御边界，不改变 DSL 文件整体大小。

## Migration Plan

这是严格 additive wire variant/capability，无旧调用方迁移与持久数据迁移。所有 native/WASM/TS exhaustive unions 同步 cut over；不存在 deprecated alias。若 capability 不存在，旧 continued/display-name/avatar/navigation 菜单行为不变。
