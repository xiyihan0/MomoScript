## Context

现有 Preview Composer 先将当前 PreviewArtifact 中的 renderer point 定位到 generated Typst，再通过 projection origin ancestry 和当前 `AnalyzedDocument` 解析唯一 statement。Host 收到严格 target descriptor 后显示原生 Workbench 菜单；结构化命令由 `mmt/previewComposerTarget` 返回的当前版本与 statement range 绑定，经 Rust `compose_edit[_with_pack]` 生成纯 WorkspaceEdit，并由客户端 freshness gate 应用。

消息正文编辑必须留在这条链中。SVG label、DOM 文本、可见 glyph 和 pointer 只负责定位；它们既不是当前正文的事实源，也不是写权限。`.mmt` 的 `StatementSyntax.body` 与当前分析快照共同构成授权证据。正文与模式编辑不依赖 actor；actor 专属显示名/头像能力仍独立要求解析后的 actor。

## Goals / Non-Goals

### Goals

- 只为一个当前、唯一、可往返的单行 left/right chat 或 narration 文本正文暴露正文与本条解析模式。
- 由 Rust 在一个命令中原子序列化正文和本条模式，并证明所有非目标语义不变。
- native/WASM/TypeScript 使用一套 strict allowlist；旧版本、旧 PreviewArtifact、无效值和错误候选 fail closed。
- 使用 pointer-anchored 单行 Monaco 上下文编辑器，在同一 transient 中提供五模式选择与词法高亮；取消或正文/模式均相同不发请求。
- 保持一个当前版本 `TextDocumentEdit`、一个 Local History 记录及一次 didChange→analysis→preview 生命周期。

### Non-Goals

- 多行正文、富文本、inline resource picker、fragment LSP/诊断/补全或 semantic token。
- reply、bond、generated/package 内容；分析错误仍 fail closed。
- 文件级 `@mode` 编辑。
- 从 SVG、DOM、rendered text 或 TypeScript 构造 `.mmt`。
- 新 apply 协议、server-side mutation、retry、兼容别名或第二份 runtime/document 状态。

## Decisions

### 1. Capability 是可选 `statementText` descriptor

`ComposerTarget.statement_text` 为 `{ current, mode, resolved_mode, inherited_mode }`。Wire 精确序列化为 `statementText: { current, mode, resolvedMode, inheritedMode }`：authored mode 允许 `inherit | textMacro | textRaw | typstMacro | typstRaw`，resolved/inherited mode 允许 `textMacro | textRaw | typstMacro | typstRaw`。Descriptor 不传 body range、statement ordinal、URI、speaker id、ActorId 或 AST 数据；现有 `target.range` 仍是唯一命令 target。

Capability 仅在以下证据同时成立时出现：

1. projection origin 唯一落在一个 left/right chat 或 narration statement；
2. 当前分析无错误；正文授权不要求 actor，因此 builtin right-side message 同样可获得 capability；
3. body resolved mode 是 `TextMacro`、`TextRaw`、`TypstMacro` 或 `TypstRaw`；
4. body content 非空、无 CR/LF、长度不超过 65536 UTF-8 bytes，且 plain 或 fenced body source 可由当前 `BodySyntax` 精确往返；
5. authored mode、resolved mode 与 inherited mode 均来自同一分析快照。

多行 continuation 保留既有 continued/navigation 行为但不获得 `statementText`。单行 `t"""..."""`、`rt"""..."""`、`T"""..."""` 与 `rT"""..."""` 均可获得 capability；`current` 是 fence 内正文而非 fence 字节。Narration target 只暴露 `statementText`，不暴露不适用的 `continued` 或 actor capability。

### 2. 命令是原子 `setStatementBody { value, mode }`

所有端只接受这一名称，不提供别名。Rust core 枚举为 `ComposerCommand::SetStatementBody { value, mode }`。`value` 必须是 1–65536 UTF-8 bytes、无 `\r`/`\n`；`mode` 必须是 `inherit | textMacro | textRaw | typstMacro | typstRaw`。值不 trim、不 Unicode normalize、不 quote/unquote、不解释 DOM 文本。正文和 authored mode 均与当前 capability 相同返回 `InvalidValue`，产品 UI 更早抑制该请求。

Native/WASM serde command 使用 `deny_unknown_fields`。缺少 `value`/`mode`、旧 `setStatementText`/`setStatementTextMode`、`rawSource`、range、URI、node id 或其他未知字段均为 invalid params。TypeScript target parser 对 `statementText` 四个字段运行 exact-key 与枚举 allowlist 校验，并使用同一长度/单行边界。

### 3. Rust 生成一个正文与模式 TextEdit

Core 重新以当前 `target.range` 找到 exact statement ordinal，并重新检查 body capability。若 authored mode 不变，只替换 `StatementSyntax.body.range`，保留 plain/fenced representation 及 fence 长度。若 mode 改变：

- 对 fenced body，替换从当前 mode prefix 开始到 closing fence 结束的一个连续 range，保留原 fence 长度，并写入新 prefix、submitted value 与 closing fence；
- 对 plain inherited body，使用匹配新 mode 的 `t`、`rt`、`T` 或 `rT` prefix 和 `"""..."""` 包装 submitted value；
- 切换到 inherit 写为 `"""value"""`，不修改文件级 `@mode`。

包含无法安全包装的 fence 内容或在目标模式下无效的正文由候选分析返回 `CandidateInvalid`。每次成功只返回一个 `ComposerSourceEdit`，因此一次提交不会产生两个 WorkspaceEdit、两个历史记录或中间版本竞态。speaker marker、statement patch 参数及其空白、statement sigil、文件行尾和全部其他字节保持不变；TypeScript 不生成 MMT source 或 TextEdit。

### 4. Candidate gate 允许且只允许目标正文事务

应用内存 edit 后使用与当前文档相同的 PackRegistry/catalog 完整重分析。候选必须：

- 无 syntax、directive、actor、asset、非目标 resource-marker/resolution 或 Typst overlay error；
- statement 数量、kind、speaker marker 与 patch raw args 全部相同；
- 非目标 statement 的 body source/mode 全部相同；
- document config、assets、非目标 resource markers/resolutions/failures 保持相同；
- actor model、speaker identity 和 revision 全部相同；
- 目标候选正文和 authored/resolved mode 精确等于提交值；mode 改变时只允许目标范围内的 resource 解释随模式改变。

正文 mode 不变时保持此前更严格的 resource 语义相等门槛；mode 改变时只豁免目标 body 的本地 resource 解释。任何非目标语义漂移、DSL shape 变化或无效目标正文均返回 `CandidateInvalid`，不返回部分 edit。

### 5. UI 使用单行 Monaco transient

`PreviewComposerContextMenuSelection` 只增加 `{ kind: "messageText" }`；菜单仅在 `statementText` 存在时显示 **“编辑消息…”**，不再提供外层“解析模式”子菜单。选择后打开原 pointer-anchored 紧凑 Monaco editor：

- 内容预填 `current`；
- editor 内 radio 显示继承（带 inherited mode）、`t`、`rt`、`T`、`rT`，并以 authored `mode` 选中；
- `t` 与继承到 TextMacro 使用 MMT inline macro 词法高亮，`T`/`rT` 与继承到 Typst 使用 Typst 词法高亮，Raw Text 使用纯文本；
- fragment 使用私有 language id，禁用 completion、hover、diagnostic decoration 与 semantic highlighting，不注册为 `mmtfs` workspace 文档，也不进入 MMT/Tinymist LSP；
- Enter 在非 IME composition 状态下提交，Escape 取消；CR/LF、空值及超长值留在 editor 中显示校验。

有效提交只发送：

```json
{"kind":"setStatementBody","value":"...","mode":"typstMacro"}
```

只有正文和 mode 都与 descriptor 相同时才无请求结束。editor、menu、request、apply 全部属于当前 `ComposerOperation.transient`/cancellation 生命周期；document version、PreviewArtifact identity、runtime owner 或显式 invalidate 会关闭 editor 并阻止请求/apply。返回 edit 继续通过 strict result parser、当前 document/version gate 和 `vscode.workspace.applyEdit`；Local History 与重渲染由既有 didChange 链负责。

### 6. 继承和五模式是同一提交字段

`inherit` 对四种 inherited mode 均有效；UI 文案展示 inherited mode，但提交仍只发送 authored mode 枚举，不编辑 `@mode`。选择模式只改变 editor 的词法 tokenizer 和 pending transaction；在 Enter 前不发送请求、不修改 source、不创建历史记录。正文和模式同时变化时仍只有一个 `setStatementBody` 命令。

## Failure Mapping

- 空、CR/LF、超长或正文/模式均同值：`invalidValue`（UI 的无效值或完整 no-op 不发送）。
- exact statement/body capability 变化：`targetChanged`。
- 当前分析错误：`documentHasErrors`。
- 候选分析错误或语义漂移：`candidateInvalid`。
- 文档版本不一致：`staleDocument`。

客户端沿用现有 stale、rejected、apply-failed 通知；不重试、不导航 fallback、不 retarget。

## Risks / Trade-offs

- 单行 Monaco editor 只提供 fragment 词法高亮；不接入项目文档、语言服务器或语义功能，避免临时正文获得 workspace 生命周期和误导性诊断。
- `t`/`rt`/`T`/`rT` 的语义差异可能改变目标正文内部的 inline resource 解释；candidate gate 只豁免 mode 改变时的目标范围，任何非目标语义漂移仍拒绝。
- 65536-byte 上限是 transport 与单行产品表面的防御边界，不改变 DSL 文件整体大小。

## Migration Plan

这是 wire clean cutover，无持久数据迁移。所有 native/WASM/TS exhaustive unions 与调用方同步改为 `setStatementBody`；旧 `setStatementText`/`setStatementTextMode` 不作为 deprecated alias 保留。若 capability 不存在，既有 continued/display-name/avatar/navigation 菜单行为不变。
