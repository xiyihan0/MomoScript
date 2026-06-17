# Project Context

## Summary

MomoScript 是一个面向 Momotalk / MoeTalk 风格视觉叙事的 DSL 与渲染工具链。这个仓库同时包含 Python 编写的 DSL 解析器与编译器、基于 Typst 的渲染流水线、NoneBot 集成，以及使用 wasm 和浏览器侧 Typst 渲染的 Web 编辑器。

## Primary Areas

- `mmt_core/`：DSL 解析、编译、路径解析、沙箱集成
- `typst_sandbox/`：Typst 模板、资源包、渲染素材
- `mmt_nonebot_plugin/`：NoneBot 插件集成
- `tools/`：流水线脚本与 golden-file 验证工具
- `web/`：Vite + React 编辑器与 wasm 集成

## Constraints

- Python 相关工作统一由 `uv` 管理，不要引入临时的环境管理方式。
- parser / compiler / renderer 的主要回归信号来自 golden-file，不以标准 `pytest` 作为项目默认路径。
- Typst 执行必须保持在带内存和超时限制的沙箱中。
- 资源访问必须继续做安全约束，不能直接信任用户输入的任意文件路径。
- 新工具优先放在 `tools/`，不要继续污染仓库根目录。
- 当前的平铺式目录是项目刻意保留的约束，不要引入 `src/` 重构。

## Change Guidance

- 对跨模块变更、DSL 行为变更、渲染行为变更、公开工作流变更，优先补 spec。
- 纯拼写修正或无行为变化的小型重构，可以不走完整 OpenSpec 流程。
- 只要变更影响 DSL 语义、渲染结果或资源解析，就应同时更新相关 spec 和验证计划。

## Verification Defaults

- 工作区准备：`uv sync`
- Golden 回归：`uv run tools/dsl_refactor_check.py`
- 流水线抽样验证：`uv run tools/mmt_pipeline.py examples/example_t.mmt.txt`
- Bot 入口基本检查：`uv run bot.py`
- Web 构建检查：`cd web && npm install && npm run build`

## Spec Map

- `openspec/specs/dsl-syntax/spec.md`：当前实现中的行级语法、指令、说话人标记与内联表达式
- `openspec/specs/dsl-compilation/spec.md`：从编写到解析、再到编译的稳定性与兼容性要求
- `openspec/specs/rendering-pipeline/spec.md`：Typst 渲染、资源安全与 pack 驱动行为
- `openspec/specs/tooling-and-verification/spec.md`：仓库内的验证路径与变更信心来源
- `openspec/specs/change-management/spec.md`：这个仓库如何使用 OpenSpec 管理变更

## Active Draft Map

- `openspec/changes/redesign-dsl-syntax-v2/`：下一版 DSL 语法、`@char` instance 模型、`[:...:]` 资源标记、`@typ`、正文模式、Rust parser / source map 架构草案
- `openspec/changes/redesign-dsl-syntax-v2/rust-parser-architecture.md`：Rust language core、Syntax AST / Semantic IR、Typst 0.15 diagnostic probe、emitted chunk source map
- `openspec/changes/redesign-dsl-syntax-v2/specs/dsl-parser-architecture/spec.md`：parser/source-map 实现侧 capability 草案；尚未归档到 `openspec/specs/`
- `openspec/changes/design-resource-pack-v3/`：pack-v3 manifest、Kivo Wiki 构建器、AVIFS storage 与浏览器解码草案

## Non-Goals

- 这套 spec 不是对当前全部行为的自动生成全量参考。
- OpenSpec 在这里不能替代代码评审，也不能替代 golden-file 验证。
- OpenSpec 不应该把每一个小改动都变成重量级流程。
