# Project Context

## Summary

MomoScript 是一个面向 Momotalk / MoeTalk 风格视觉叙事的 DSL 与渲染工具链。当前主要开发主线是 `mmt_rs/` 中的 Rust DSL v2 language core，以及与其直接配套的 Typst v2 façade、pack-v3 资源模型和 native project-export CLI。NoneBot 已接入 Rust v2 主链；Python DSL、legacy JSON renderer 和旧 Web 编辑器属于历史实现。

## Primary Areas

- `mmt_rs/`：Rust DSL v2 parser、syntax AST、semantic lowering、pack/resolver、materializer 协调、Typst emitter、source map 与 diagnostics
- `typst_sandbox/mmt_render/`：DSL v2 Typst façade、主题和渲染 smoke；旧 JSON renderer 仅作迁移参考
- `openspec/changes/redesign-dsl-syntax-v2/`：当前 Rust DSL v2 主线的语言、parser/core 和 Typst 模板规格增量
- `openspec/changes/design-resource-pack-v3/`：当前 pack-v3 manifest、resolver、materialization 与资源构建规格增量
- `openspec/changes/add-typst-theme-api/`：当前 Typst façade 文档、版本化 theme schema、preset、patch、位置配置与 reset 规格增量
- `mmt_nonebot_plugin/`：通过 `mmt-compile`、pack-v3、AVIFS materializer 和 Typst project runner 接入 Rust v2
- `mmt_lsp/`：共享 Rust language service、native stdio LSP 和 WebAssembly bridge
- `editors/vscode/`：VS Code Desktop/Web language client、browser Worker 和语言配置
- `editors/vscode-web/`：当前生产 Web 编辑器；使用 Monaco/VS Code Workbench、MMT/Tinymist Worker、IndexedDB workspace 与 typst.ts preview

历史区域：

- `mmt_core/`、`tools/mmt_pipeline.py`：legacy Python DSL 和 JSON/PDF 管线，不作为 Rust v2 的规范实现
- `web/`：已废弃的 React 编辑器与旧 WASM 集成；浏览器产品主线位于 `editors/vscode-web/`，不在旧目录延续第二套语言逻辑

## Constraints

- Rust DSL v2 的语法、语义、资源解析和 Typst emission MUST 由 `mmt_rs` 单一实现，禁止在 Python 或模板层建立第二套语义。
- syntax parsing、semantic lowering、resource resolution、materialization 与 emission MUST 保持分层，diagnostic MUST 保留原始 phase 和 UTF-8 byte range。
- 编辑器 live analysis MAY 使用已加载的只读 `PackRegistry` 执行 deterministic resolve 与 resource planning；MUST NOT 因普通语言查询触发文件、网络、decoder 或最终 renderer I/O。
- language projection MUST 使用 placeholder emission；实际 fetch/decode/layout failure 属于 revision-bound preview/build diagnostics，不得污染更新后的编辑快照。
- 严格编译路径在 syntax、semantic 或 resolve error 后 MUST 在触发平台 I/O 前短路。
- Typst 执行必须保持在带内存、超时和受控 root 的沙箱中。
- 资源路径必须相对 pack 或受控 cache 解析，不能直接信任 DSL 中的任意文件系统路径。
- pack-v3 ordinal 必须来自 manifest 显式顺序，不能依赖目录遍历顺序。
- Python 历史工具仍由 `uv` 管理，但不得作为 Rust v2 默认验证或设计约束。

## Change Guidance

- 对跨模块变更、DSL 行为变更、渲染行为变更、公开工作流变更，优先补 spec。
- 纯拼写修正或无行为变化的小型重构，可以不走完整 OpenSpec 流程。
- 只要变更影响 DSL 语义、渲染结果或资源解析，就应同时更新相关 spec 和验证计划。

## Verification Defaults

- Rust core：`cargo test --manifest-path mmt_rs/Cargo.toml`
- Rust API/fixture：使用 `mmt_rs/tests/` 中的公开 API 合同测试，并为行为变化增加聚焦测试
- Typst v2 façade 目标命令：`cd typst_sandbox/mmt_render && typst compile tests/v2-smoke.typ /tmp/mmt-v2-smoke.pdf --root ..`；模板引用的两张 WebP 已跟踪，clean checkout 应满足该检查
- Rust v2 完整交付目标：合法 fixture 必须通过 `compile_text_strict` 完成 parse、semantic、resolve、materialize 与 emit，并将生成的 Typst 交给 Typst 0.15 编译
- MMT LSP：`cargo test --manifest-path mmt_lsp/Cargo.toml`；VS Code Desktop/Web extension：`cd editors/vscode && npm run build && npm run test:worker && npm run test:web`
- 生产 Web editor：`cd editors/vscode-web && npm run check && npm run test:resource-cache && npm run test:language-projection && npm run test:e2e`；涉及 AVIFS 时另运行 `npm run test:avifs-worker`
- NoneBot 变更运行 `uv run python -m unittest discover -s mmt_nonebot_plugin/tests -v`；Python golden 与 legacy pipeline 只在明确修改对应历史表面时运行

## Spec Map

- `openspec/specs/dsl-syntax/spec.md`：已实现 Python v1 语法的 legacy baseline；Rust v2 主线以 active change delta 为准，归档时将替换该 baseline
- `openspec/specs/dsl-compilation/spec.md`：Rust v2 确定性、strict/permissive pipeline 与诊断要求
- `openspec/specs/rendering-pipeline/spec.md`：Typst 沙箱、资源安全与 pack 驱动行为
- `openspec/specs/tooling-and-verification/spec.md`：Rust v2 默认验证与端到端验收路径
- `openspec/specs/change-management/spec.md`：OpenSpec 变更管理要求

## Active Mainline Map

- `openspec/changes/redesign-dsl-syntax-v2/`：当前 Rust DSL v2 主线；包含 `@actor`、`@asset`、正文模式、`[:...:]`、parser/core、source map 与 Typst façade
- `openspec/changes/redesign-dsl-syntax-v2/rust-parser-architecture.md`：已实现 parser、pipeline、CLI、source map 与 Typst diagnostic 架构的主说明
- `openspec/changes/redesign-dsl-syntax-v2/tinymist-typst-lsp-integration-research.md`：MMT language service 与 Tinymist 的历史研究输入；已批准实施合同以 `add-mmt-lsp-vscode` 为准
- `openspec/changes/redesign-dsl-syntax-v2/typst-template-library.md`：v2 Typst façade 和连续消息配置设计
- `openspec/changes/add-typst-theme-api/`：区分当前可调用 API 与拟议主题扩展，并定义 `mmt-theme.v1` 的实施合同
- `openspec/changes/redesign-dsl-syntax-v2/specs/`：Rust v2 active spec delta；在主线验收后归档到 `openspec/specs/`
- `openspec/changes/design-resource-pack-v3/`：pack-v3 manifest、Kivo builder、AVIFS storage 与平台无关 materializer 设计
- `openspec/changes/add-mmt-lsp-vscode/`：共享 language service、native/WASM transport、Desktop/Web、Tinymist backend、生产 Web runtime，以及尚待封口的 diagnostics/lifecycle 合同
- `openspec/changes/add-workspace-storage-history-sync/`：生产 Web 工作区 identity/backend、Local History、File System Access、崩溃恢复与 WebDAV 手动同步合同
- `openspec/changes/add-pwa-offline-runtime/`：生产 Web 可安装应用、显式离线 shell/pack、prompt update、origin-wide quota 与驱逐恢复合同
- `openspec/changes/add-character-variant-gallery/`：生产 Web 角色图鉴（实体/差分浏览、AVIFS 抽帧缩略图与 `[:name,#n:]` 插入）草案
- `openspec/changes/complete-editor-runtime-and-typst-tooling/`：在 `add-mmt-lsp-vscode` diagnostics/runtime closure 之后，统一编辑器运行时与 Typst project state，增加能力实测门、保守投影语言功能、host-mediated package resolution、revision-bound preview navigation 和 exact-snapshot export；不重复 workspace/PWA 合同

## Non-Goals

- 新 VS Code Web extension 不承诺旧 React 编辑器的 `compile_text_*_wasm` ABI 兼容；旧 `web/` 迁移需单独设计和验收。
- 不要求 Rust v2 兼容 Python v1 的全部历史语法；兼容行为必须由 active spec 显式选择。
- 不以 Python golden 或 legacy JSON 输出等价作为 Rust v2 正确性的定义。
- OpenSpec 不替代行为测试、Typst 编译验证或代码评审。
- OpenSpec 不把每个无行为变化的小修改升级为重量级流程。
