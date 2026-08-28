## Why

Preview Composer 已能从当前预览语义区域生成版本化的 `continued`、人物显示名与头像编辑，但修改消息正文仍要求作者跳回 `.mmt` 源码。正文是预览中最直接、最常见的编辑对象；它也必须沿用现有 revision-bound Rust Composer 权限链，不能让 SVG/DOM 文本或 TypeScript 获得源码授权与拼接职责。

## What Changes

- 为唯一映射到当前 left/right chat statement 或 narration statement 的单行正文增加 `statementText` Composer capability；正文授权独立于 actor capability，因此 builtin right-side message 同样可编辑。Descriptor 返回 exact `current`、本条 authored `mode`、resolved mode 与 inherited mode，但不暴露 URI、AST 节点、正文 range 或内部身份。
- 增加唯一结构化命令 `setStatementBody { value, mode: inherit | textMacro | textRaw | typstMacro | typstRaw }`。Rust 独占源码授权与编辑：正文和本条模式在一个候选、一个 `TextEdit`、一个历史记录中原子提交，完整重分析后才返回。
- 将单行编辑器/DSL 正文边界固定为 1–65536 UTF-8 bytes 的非空内容；不 trim、不转义重写、不换行归一化。模式覆盖本条继承、`t`、`rt`、`T` 与 `rT`，不修改文件级 `@mode`。
- 扩展 native stdio、WASM 与 TypeScript exact-key 合同；输出仍只有一个携带当前版本的 `TextDocumentEdit`，服务端不 apply，客户端不 retry；旧正文/模式命令不保留别名。
- **“编辑消息…”** 打开 pointer-anchored 单行 Monaco 上下文编辑器：编辑器内集成五模式 radio、TextMacro/Typst 词法高亮与纯文本 Raw 模式；外层 context menu 不再提供独立“解析模式”子菜单。提交继续通过同一 Composer freshness、WorkspaceEdit、Local History 与预览重渲染链。

## Affected Capabilities

- `language-tooling`：增加严格消息正文 capability、原子正文/模式命令、单一 source edit 与候选语义证明。
- `web-workbench-shell`：增加预览消息上下文编辑器、内置模式切换、词法高亮及无请求 no-op/cancel 行为。

## Non-Goals

- 不编辑 reply、bond、生成 Typst、package 内容、multiline body 或分析错误内容；actor 专属显示名/头像能力仍不授予 builtin、unresolved 或 ambiguous speaker。
- 不增加多行输入、inline resource picker、fragment LSP/诊断/补全/semantic token、DOM 文本 fallback、TypeScript 源码序列化、文件级 `@mode` 编辑或第二份文档状态。
- 不改变已完成的人物头像 Composer、图库、picker 或其 OpenSpec。
- 不增加兼容别名、宽松字段、服务端 apply、自动 retry 或 stale retarget。
