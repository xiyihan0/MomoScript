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

当前尚未封口的合同包括：

- live diagnostics 仍只发布 syntax 与 actor 子集；mode、asset、resource、pack resolve/planning 和
  emitter diagnostics 已由不同 core 路径计算，但尚未统一为单一、无重复的 revision-bound 结果；
- render project 尚未返回 resolve/planning diagnostics，Web fetch/decode/layout failure 也尚未形成
  独立的 revision-bound preview diagnostic 合同；
- snapshot 与 projection 对同一文本重复 parse，并重复构建 position index；
- 生产 Web runtime 虽提供异步 dispose API，但启动失败、HMR 与 unload 尚无统一 owner；unload 不等待
  Promise，不能保证异步 shutdown 后的 Worker terminate 执行；
- Web 依赖标准 `didChange` 的同时以相同 version 调用 `mmt/updateDocument` 获取 projection；当前依靠
  `version <= current.version` 拒绝实现幂等，后续只能改 client projection 获取链，不能放宽版本保护。

这些缺口作为新的未完成里程碑记录，不追溯修改已经验收的前九组任务。

# Impact

- Rust：`mmt_lsp/`
- 编辑器：`editors/vscode/`
- 依赖：`mmt_rs` 仍是唯一 DSL parser/semantic truth source
- 研究依据：`redesign-dsl-syntax-v2/tinymist-typst-lsp-integration-research.md`
