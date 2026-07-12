# Project Context

## Summary

MomoScript 是一个面向 Momotalk / MoeTalk 风格视觉叙事的 DSL 与渲染工具链。当前主要开发主线是 `mmt_rs/` 中的 Rust DSL v2 language core，以及与其直接配套的 Typst v2 façade、pack-v3 资源模型和 native project-export CLI。NoneBot 已接入 Rust v2 主链；Python DSL、legacy JSON renderer 和旧 Web 编辑器属于历史实现。

## Primary Areas

- `mmt_rs/`：Rust DSL v2 parser、syntax AST、semantic lowering、pack/resolver、materializer 协调、Typst emitter、source map 与 diagnostics
- `typst_sandbox/mmt_render/`：DSL v2 Typst façade、主题和渲染 smoke；旧 JSON renderer 仅作迁移参考
- `openspec/changes/redesign-dsl-syntax-v2/`：当前 Rust DSL v2 主线的语言、parser/core 和 Typst 模板规格增量
- `openspec/changes/design-resource-pack-v3/`：当前 pack-v3 manifest、resolver、materialization 与资源构建规格增量
- `mmt_nonebot_plugin/`：通过 `mmt-compile`、pack-v3、AVIFS materializer 和 Typst project runner 接入 Rust v2
- `mmt_lsp/`：共享 Rust language service、native stdio LSP 和 WebAssembly bridge
- `editors/vscode/`：VS Code Desktop/Web language client、browser Worker 和语言配置

历史区域：

- `mmt_core/`、`tools/mmt_pipeline.py`：legacy Python DSL 和 JSON/PDF 管线，不作为 Rust v2 的规范实现
- `web/`：现有 React 编辑器与旧 WASM 集成；新的 VS Code 集成位于 `editors/vscode/`，不在此目录延续第二套语言逻辑

## Constraints

- Rust DSL v2 的语法、语义、资源解析和 Typst emission MUST 由 `mmt_rs` 单一实现，禁止在 Python 或模板层建立第二套语义。
- syntax parsing、semantic lowering、resource resolution、materialization 与 emission MUST 保持分层，diagnostic MUST 保留原始 phase 和 UTF-8 byte range。
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
- MMT LSP：`cargo test --manifest-path mmt_lsp/Cargo.toml`；VS Code Desktop/Web：`cd editors/vscode && npm run build && npm run test:worker && npm run test:web`
- NoneBot 变更运行 `uv run python -m unittest discover -s mmt_nonebot_plugin/tests -v`；Python golden、legacy pipeline 和 Web 检查只在明确修改对应历史表面时运行

## Spec Map

- `openspec/specs/dsl-syntax/spec.md`：已实现 Python v1 语法的 legacy baseline；Rust v2 主线以 active change delta 为准，归档时将替换该 baseline
- `openspec/specs/dsl-compilation/spec.md`：Rust v2 确定性、strict/permissive pipeline 与诊断要求
- `openspec/specs/rendering-pipeline/spec.md`：Typst 沙箱、资源安全与 pack 驱动行为
- `openspec/specs/tooling-and-verification/spec.md`：Rust v2 默认验证与端到端验收路径
- `openspec/specs/change-management/spec.md`：OpenSpec 变更管理要求

## Active Mainline Map

- `openspec/changes/redesign-dsl-syntax-v2/`：当前 Rust DSL v2 主线；包含 `@actor`、`@asset`、正文模式、`[:...:]`、parser/core、source map 与 Typst façade
- `openspec/changes/redesign-dsl-syntax-v2/rust-parser-architecture.md`：已实现 parser、pipeline、CLI、source map 与 Typst diagnostic 架构的主说明
- `openspec/changes/redesign-dsl-syntax-v2/tinymist-typst-lsp-integration-research.md`：后续 MMT language service、VS Code Desktop/Web 和 Tinymist sidecar 的研究结论；不是已批准实施 spec
- `openspec/changes/redesign-dsl-syntax-v2/typst-template-library.md`：v2 Typst façade 和连续消息配置设计
- `openspec/changes/redesign-dsl-syntax-v2/specs/`：Rust v2 active spec delta；在主线验收后归档到 `openspec/specs/`
- `openspec/changes/design-resource-pack-v3/`：pack-v3 manifest、Kivo builder、AVIFS storage 与平台无关 materializer 设计
- `openspec/changes/add-mmt-lsp-vscode/`：共享 language service、native/WASM transport、VS Code Desktop/Web 与后续 Tinymist sidecar

## Non-Goals

- 新 VS Code Web extension 不承诺旧 React 编辑器的 `compile_text_*_wasm` ABI 兼容；旧 `web/` 迁移需单独设计和验收。
- 不要求 Rust v2 兼容 Python v1 的全部历史语法；兼容行为必须由 active spec 显式选择。
- 不以 Python golden 或 legacy JSON 输出等价作为 Rust v2 正确性的定义。
- OpenSpec 不替代行为测试、Typst 编译验证或代码评审。
- OpenSpec 不把每个无行为变化的小修改升级为重量级流程。
