## Why

Preview Composer 已能从当前预览语义区域生成版本化的 `continued`、人物显示名与头像编辑，但修改消息正文仍要求作者跳回 `.mmt` 源码。正文是预览中最直接、最常见的编辑对象；它也必须沿用现有 revision-bound Rust Composer 权限链，不能让 SVG/DOM 文本或 TypeScript 获得源码授权与拼接职责。

## What Changes

- 为唯一映射到当前 left/right chat statement、且说话人是唯一已解析非 builtin actor 的单行文本正文增加最小 `statementText.current` Composer capability；不暴露 URI、AST 节点、正文 range 或内部身份。
- 增加结构化 `setStatementText { value }` 命令。Rust 仅替换已授权 statement 的 `BodySyntax` 文本范围，保留 marker、patch 参数、缩进、换行风格与全部其余字节，并完整重分析候选以证明目标正文之外的语法、actor、speaker 与资源语义稳定。
- 将 InputBox/DSL 边界固定为 1–65536 UTF-8 bytes 的非空单行文本；不 trim、不转义重写、不换行归一化。空值、CR/LF、超长值、与当前值相同、错误候选及失去 capability 的 target 均不产生编辑。
- 扩展 native stdio、WASM 与 TypeScript exact-key 合同；输出仍只有一个携带当前版本的 `TextDocumentEdit`，服务端不 apply，客户端不 retry。
- 在现有 pointer-anchored context menu 中仅对 capability 存在的 target 增加精确文案 **“编辑消息…”**，复用现有 `contextInput` 预填当前正文。取消或未变化不请求；提交继续通过 `mmt/composerEdit`、freshness gate、`vscode.workspace.applyEdit`、Local History 和预览重渲染。

## Affected Capabilities

- `language-tooling`：增加严格消息正文 capability、结构化正文命令、最小 source edit 与候选语义证明。
- `web-workbench-shell`：增加预览消息编辑入口、InputBox 生命周期及无请求 no-op/cancel 行为。

## Non-Goals

- 不编辑 narration、reply、bond、builtin、unresolved、ambiguous、生成 Typst、package 内容、fenced/multiline body 或 Typst body。
- 不增加富文本、多行输入、inline resource picker、DOM 文本 fallback、TypeScript 源码序列化或第二份文档状态。
- 不改变已完成的人物头像 Composer、图库、picker 或其 OpenSpec。
- 不增加兼容别名、宽松字段、服务端 apply、自动 retry 或 stale retarget。
