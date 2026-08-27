## Context

现有 Preview Composer 先将当前 PreviewArtifact 中的 renderer point 定位到 generated Typst，再通过 projection origin ancestry 和当前 `AnalyzedDocument` 解析唯一 left/right statement。Host 收到严格 target descriptor 后显示原生 Workbench 菜单；结构化命令由 `mmt/previewComposerTarget` 返回的当前版本与 statement range 绑定，经 Rust `compose_edit[_with_pack]` 生成纯 WorkspaceEdit，并由客户端 freshness gate 应用。

消息正文编辑必须留在这条链中。SVG label、DOM 文本、可见 glyph 和 pointer 只负责定位；它们既不是当前正文的事实源，也不是写权限。`.mmt` 的 `StatementSyntax.body`、解析后的 speaker/actor 与当前分析快照共同构成授权证据。

## Goals / Non-Goals

### Goals

- 只为一个当前、唯一、可往返的单行 chat 文本正文暴露当前值。
- 由 Rust 最小替换 body range，并证明除该正文外的语法和语义不变。
- native/WASM/TypeScript 使用一套 strict allowlist；旧版本、旧 PreviewArtifact、无效值和错误候选 fail closed。
- 复用 pointer-anchored `contextInput`，取消和相同值在客户端不发请求。
- 保持一份当前版本 `TextDocumentEdit`、正常 Local History 与 didChange→analysis→preview 生命周期。

### Non-Goals

- 多行/fenced/Typst body、富文本或 inline resource 编辑。
- narration、reply、bond、builtin/unresolved/ambiguous speaker、generated/package 内容。
- 从 SVG、DOM、rendered text 或 TypeScript 构造 `.mmt`。
- 新 apply 协议、server-side mutation、retry、兼容别名或第二份 runtime/document 状态。

## Decisions

### 1. Capability 是可选 `statementText.current`

`ComposerTarget` 增加 `statement_text: Option<String>`，wire 只序列化为 `statementText: { current }`。不传 body range、statement ordinal、URI、speaker id、ActorId、mode 或 AST 数据；现有 `target.range` 已是唯一命令 target。

Capability 仅在以下证据同时成立时出现：

1. projection origin 唯一落在一个 left/right statement；
2. 当前分析无错误，statement speaker 唯一且解析到非 builtin `ScriptActor`；
3. body 的 resolved mode 是 `TextMacro` 或 `TextRaw`；
4. body source 非空、无 CR/LF、长度不超过 65536 UTF-8 bytes，且 source length 与 body range 一致。

多行 continuation、fenced body、Typst body 和 builtin target 可以保留既有 continued/navigation 行为，但不获得 `statementText`。

### 2. 命令是 `setStatementText { value }`

所有端只接受这一名称，不提供别名。Rust core 枚举为 `ComposerCommand::SetStatementText(String)`。值必须是 1–65536 UTF-8 bytes、无 `\r`/`\n`；值不 trim、不 Unicode normalize、不 quote/unquote、不解释 DOM 文本。与当前 body source 完全相同返回 `InvalidValue`，避免冗余 edit；产品 UI 更早抑制该请求。

Native/WASM serde command 使用 `deny_unknown_fields`。`rawSource`、range、URI、node id、alternate text keys 或其他未知字段均为 invalid params。TypeScript target parser 对 `statementText` 与 `{ current }` 运行 exact-key 校验，并使用同一长度/单行边界。

### 3. Rust 仅替换现有 BodySyntax range

Core 重新以当前 `target.range` 找到 exact statement ordinal，并重新检查 actor 与 body capability。它验证 `source[body.range]` 与分析快照中的 `body.source` 完全一致，然后返回：

- `range = statement.body.range`
- `new_text = requested value`

因此 speaker marker、statement patch 参数及其空白、statement sigil、body 前的缩进、文件 CRLF/LF 和全部其他字节天然保持。Rust 不对正文进行转义或拼装整条 statement；不在 TypeScript 生成 TextEdit。

### 4. Candidate gate 允许且只允许目标正文变化

应用内存 edit 后使用与当前文档相同的 PackRegistry/catalog 完整重分析。候选必须：

- 无 syntax、directive、mode、actor、asset、resource-marker、resolution 或 Typst overlay error；
- statement 数量、kind、speaker marker、patch raw args 与 body mode 全部相同；
- 非目标 statement body source 全部相同，目标 body source 精确等于请求值；
- document config、body modes、assets、resource markers、inline/avatar resolution 与 resource failures 保持相同；
- actor model、speaker identity 和 revision 全部相同；
- 目标候选仍满足单行文本 capability。

这意味着会改变 DSL shape、inline resource identity 或其他语义的正文输入返回 `CandidateInvalid`，不返回部分 edit。目标正文的普通 Unicode、引号、反斜杠等字节在不触发额外 DSL 语义时原样保留。

### 5. UI 复用现有 transient contextInput

`PreviewComposerContextMenuSelection` 增加 `{ kind: "messageText" }`，菜单仅在 `statementText` 存在时添加精确标签 **“编辑消息…”**。选择后以 `current` 预填现有 pointer-anchored InputBox；空输入由既有 required-message 机制保持打开，Escape 返回 undefined，相同值直接结束。有效新值发送：

```json
{"kind":"setStatementText","value":"..."}
```

InputBox、menu、request、apply 全部属于当前 `ComposerOperation.transient`/cancellation 生命周期。document version、PreviewArtifact identity、runtime owner 或显式 invalidate 会关闭输入并阻止请求/apply。返回 edit 继续通过 `parseComposerEditResult`、当前 document/version gate、`vscode.workspace.applyEdit`；Local History 与重渲染由现有 didChange 链负责。

## Failure Mapping

- 空、CR/LF、超长或同值：`invalidValue`（UI 的空值/同值不发送）。
- exact statement/body capability 变化：`targetChanged`。
- 当前分析错误：`documentHasErrors`。
- 候选分析错误或语义漂移：`candidateInvalid`。
- 文档版本不一致：`staleDocument`。

客户端沿用现有 stale、rejected、apply-failed 通知；不重试、不导航 fallback、不 retarget。

## Risks / Trade-offs

- 第一阶段故意不允许 multiline/fenced/Typst body；InputBox 是单行控件，放宽会造成不可逆的展示/编辑不对称。
- TextMacro 中引入或改变 inline resource 的输入会被候选稳定性 gate 拒绝；未来若需要资源化正文编辑，应新增结构化命令而不是放宽本命令。
- 65536-byte 上限是 transport 与单行产品表面的防御边界，不改变 DSL 文件整体大小。

## Migration Plan

这是严格 additive wire variant/capability，无旧调用方迁移与持久数据迁移。所有 native/WASM/TS exhaustive unions 同步 cut over；不存在 deprecated alias。若 capability 不存在，旧 continued/display-name/avatar/navigation 菜单行为不变。
