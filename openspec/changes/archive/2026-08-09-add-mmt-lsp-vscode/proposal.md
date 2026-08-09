# Why

创建本 change 时，Rust DSL v2 已提供可恢复 AST、UTF-8 range 和版本化 analysis JSON，但作者缺少标准
编辑器诊断、结构导航和 Desktop/Web 共用的语言服务；旧 React Web 编辑器也不应继续承载第二套 DSL 语义。

# What Changes

- 新增编辑器无关的 MMT language service，维护版本化文档快照并复用 `mmt_rs` AST。
- 新增 native stdio MMT LSP，以及可编译到 WASM 的 request/notification bridge。
- 新增 VS Code Desktop/Web 双入口、TextMate grammar 和 browser Worker。
- 第一阶段实现 diagnostics、document symbols、folding ranges、MMT structural completion 和 UTF-16 position 映射。
- 增加 no-I/O full Typst projection 与保守的双向 `ProjectionSegment`，为 Tinymist sidecar 提供边界。
- 允许文档变化异步调度图片 preview/materialize，但语言查询不得等待预览完成，旧 revision 结果必须丢弃。
- 将 Monaco/VS Code Workbench 设为生产 Web 入口，持久化工作区，并通过独立 render project 注入 pack-v3 真实头像。
- Tinymist projection/backend 作为后续里程碑，不在第一切片直接链接 `tinymist-query`。


# Implementation Status

已实现的主线包括共享 Rust language service、native/WASM transport、Desktop/Web extension、固定
Tinymist 0.15.2 backend、revision-scoped Typst projection、pack-aware completion、Monaco/VS Code
Workbench 生产 Web 入口、IndexedDB workspace，以及 `image-dir` / AVIFS `image-sequence` 浏览器预览。

诊断与运行时收口合同现已实现：

- live diagnostics 统一发布 syntax、mode、actor、asset、resource、pack resolve/planning 与
  placeholder Typst-check 结果，并按 authored range 与诊断身份去重；
- language projection 与 render project 共享同一份 analyzed document 和位置索引；render project
  返回 source-version/revision-bound resolve/planning diagnostics；
- Web 将 fetch、AVIFS decode 与 render/layout failure 分阶段建模为 revision-bound preview/build
  diagnostics，并拒绝旧 revision 的失败或成功覆盖当前预览；
- 生产 Web runtime 由统一 owner 管理逆序 rollback、graceful dispose、HMR 与 unload Worker terminate；
- Web 仅通过标准 `didChange` 推进文档快照，移除了 `mmt/updateDocument` 双路同步，同时保留
  `version <= current.version` 的无重建拒绝。

上述合同均由 Rust service/backend、Worker transcript、Node 聚焦回归与生产浏览器端到端流程覆盖。

# Impact

- Rust：`mmt_lsp/`
- 编辑器：`editors/vscode/`
- 依赖：`mmt_rs` 仍是唯一 DSL parser/semantic truth source
- 研究依据：`redesign-dsl-syntax-v2/tinymist-typst-lsp-integration-research.md`
