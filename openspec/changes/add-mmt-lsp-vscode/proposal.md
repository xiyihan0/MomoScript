# Why

Rust DSL v2 已提供可恢复 AST、UTF-8 range 和版本化 analysis JSON，但作者仍缺少标准编辑器诊断、
结构导航和 Desktop/Web 共用的语言服务。现有 React Web 编辑器不应继续承载第二套 DSL 语义。

# What Changes

- 新增编辑器无关的 MMT language service，维护版本化文档快照并复用 `mmt_rs` AST。
- 新增 native stdio MMT LSP，以及可编译到 WASM 的 request/notification bridge。
- 新增 VS Code Desktop/Web 双入口、TextMate grammar 和 browser Worker。
- 第一阶段实现 diagnostics、document symbols、folding ranges、MMT structural completion 和 UTF-16 position 映射。
- 增加 no-I/O full Typst projection 与保守的双向 `ProjectionSegment`，为 Tinymist sidecar 提供边界。
- 允许文档变化异步调度图片 preview/materialize，但语言查询不得等待预览完成，旧 revision 结果必须丢弃。
- Tinymist projection/backend 作为后续里程碑，不在第一切片直接链接 `tinymist-query`。

# Impact

- Rust：`mmt_lsp/`
- 编辑器：`editors/vscode/`
- 依赖：`mmt_rs` 仍是唯一 DSL parser/semantic truth source
- 研究依据：`redesign-dsl-syntax-v2/tinymist-typst-lsp-integration-research.md`
