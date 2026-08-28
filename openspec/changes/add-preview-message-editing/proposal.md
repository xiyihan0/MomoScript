## Why

Preview Composer 已能从当前预览语义区域生成版本化的 `continued`、人物显示名与头像编辑，但修改消息正文仍要求作者跳回 `.mmt` 源码。正文是预览中最直接、最常见的编辑对象；它也必须沿用现有 revision-bound Rust Composer 权限链，不能让 SVG/DOM 文本或 TypeScript 获得源码授权与拼接职责。

## What Changes

- 为唯一映射到当前 left/right chat statement 或 narration statement 的单行文本正文增加 `statementText` Composer capability；descriptor 返回 exact `current`、本条 authored `mode`、resolved mode 与 inherited mode，但不暴露 URI、AST 节点、正文 range 或内部身份。
- 增加结构化 `setStatementText { value }` 与 `setStatementTextMode { value: inherit | textMacro | textRaw }` 命令。Rust 独占源码授权与编辑：正文命令替换已授权 body 内容，模式命令最小改写/生成本条 fenced body 前缀；两者均完整重分析候选。
- 将 InputBox/DSL 正文边界固定为 1–65536 UTF-8 bytes 的非空单行文本；不 trim、不转义重写、不换行归一化。模式切换只覆盖本条消息的继承、`t` 与 `rt`，不修改文件级 `@mode`，不提供本条 `T`/`rT`。
- 扩展 native stdio、WASM 与 TypeScript exact-key 合同；输出仍只有一个携带当前版本的 `TextDocumentEdit`，服务端不 apply，客户端不 retry。
- 在现有 pointer-anchored context menu 中对 capability 增加 **“编辑消息…”** 与 **“解析模式”** 单选子菜单。当前 authored mode 被选中；继承项显示 inherited mode，Typst inheritance 下禁用；提交继续通过同一 Composer freshness、WorkspaceEdit、Local History 与预览重渲染链。

## Affected Capabilities

- `language-tooling`：增加严格消息正文 capability、结构化正文命令、最小 source edit 与候选语义证明。
- `web-workbench-shell`：增加预览消息编辑入口、InputBox 生命周期及无请求 no-op/cancel 行为。

## Non-Goals

- 不编辑 reply、bond、builtin、unresolved、ambiguous、生成 Typst、package 内容、multiline body 或 Typst-resolved body。
- 不增加富文本、多行输入、inline resource picker、DOM 文本 fallback、TypeScript 源码序列化、文件级 `@mode` 编辑、本条 `T`/`rT` 选项或第二份文档状态。
- 不改变已完成的人物头像 Composer、图库、picker 或其 OpenSpec。
- 不增加兼容别名、宽松字段、服务端 apply、自动 retry 或 stale retarget。
