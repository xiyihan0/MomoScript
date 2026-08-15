## Why

预览反向导航目前把渲染 glyph 的 `span_offset` 无条件加到 Typst syntax node 的起点。对直接 markup `Text` / `MathText`，该偏移表示节点内的 UTF-8 字节位置；对 `#text("...")` 生成的 `FuncCall`、直接字符串 `Str` 和其他运行时内容，它只是渲染字符串内的偏移，不能解释为源码节点内偏移。结果是点击 MMT 正文时可能落到生成 Typst 的 `text(` 标识符或字符串转义中间，而不是稳定的源码位置。

官方 `typst-ide::jump_from_click_in_frame` 已定义保守语义：只有 `Text` / `MathText` 使用 glyph offset，其他节点回退到 syntax node 起点。通用字符串字符 provenance 若要精确，需要让 Typst 在 `ast::Str → Value::Str → TextElem → Glyph` 全链路传播运行时文本到源码范围的映射，并处理转义、拼接、切片和变换；这不是 MomoScript 应在 emitter 或 Workbench 中复制的轻量逻辑。

本 change 先记录待决策方案和验收边界，不表示已经批准实现。目标是在合适时间点以 Typst IDE 的节点级 fallback 作为 correctness baseline，并为 MMT text mode 定义显式、只读、不可用于编辑的 authored-line fallback。

## What Changes

- Tinymist 预览点击定位候选语义与 `typst-ide` 对齐：`Text` / `MathText` 保留字符级位置；`FuncCall`、`Str` 和其他节点返回节点起点。
- MMT 投影导航候选语义增加只读 parent-origin fallback：当点击位置落在 `#text(...)` 等 Synthetic generated wrapper 时，沿 emitter origin parent 找到所属 `OriginKind::TextBody`，回到 authored MMT 行或正文范围起点。
- 该 fallback 不放宽 `ProjectionIndex::typst_to_mmt`、`map_text_edit`、rename、formatting 或任何 Identity-only 编辑合同。
- 明确 standalone/authored Typst 的精度边界：直接 `Text` / `MathText` 仍字符级精确；函数、字符串或 show-rule 生成的文字退回对应 syntax node 起点。
- 决策时必须选择现有 Workbench `refineRenderTextLocation` 的去留：删除它以获得单一保守语义，或把它降为显式 best-effort 且不得伪装成 Identity mapping。
- 增加 ASCII、CJK、转义字符串、MMT text mode、standalone Typst 和 stale revision 的合同测试。

## Goals

- 非 `Text` glyph 永不使用无语义保证的 `span_offset` 计算源码位置。
- MMT 预览点击至少稳定回到所属 authored text-mode 行，不误开或误编辑生成 Typst。
- 直接 Typst `Text` / `MathText` 的现有字符级定位不回退。
- 精确映射、只读 fallback 和 generated projection 在协议与 UI 中可区分。
- 不为此实现 Typst 字符串 provenance 系统或手写与 `Str → Content` 完全等价的 serializer。

## Non-Goals

- 不保证 `#text("...")`、`#"..."`、字符串拼接或 show-rule 生成文本的字符级反向定位。
- 不改变 MMT 正文渲染结果、Typst emission 或 DSL 语义。
- 不允许 Synthetic、Escaped 或 MacroExpansion 区域参与反向编辑。
- 不在 Workbench 中反解任意 Typst 字符串表达式。
- 不在本 change 未获批准时修改固定 Tinymist artifact 或生产协议。

## Implementation Status

**Deferred / decision required.** 当前只保存调查结论、候选合同、风险和验证计划。开始实现前必须完成 `tasks.md` 的决策门，确认 fallback 目标位置、协议表示和 `refineRenderTextLocation` 去留。

## Impact

- Affected stable capability spec: `openspec/specs/language-tooling/spec.md`
- Related active change: `openspec/changes/complete-editor-runtime-and-typst-tooling/` 的 revision-bound preview navigation
- Candidate Tinymist patch: `third_party/tinymist/patches/0002-mmt-preview-renderer.patch`
- Candidate Rust mapping: `mmt_rs/src/emit.rs`、`mmt_rs/src/projection.rs`、`mmt_lsp/src/typst_backend.rs`
- Candidate Workbench path: `editors/vscode-web/src/preview.ts`、`previewInteraction.ts`、`main.ts`
- Artifact rebuild boundary: fixed Tinymist native/WASM artifacts and their pinned digests
