## Why

MomoScript 已经包含多个相互关联的模块和一套相对固定的验证习惯，但这些上下文此前分散在 README、AGENTS 说明和贡献者记忆里。先建立一层轻量的 OpenSpec 基线，能让后续 AI 辅助开发更容易做范围界定、评审和验证，同时又不把流程变得过重。

## What Changes

- 在 `openspec/project.md` 中补充仓库级 OpenSpec 上下文
- 预置一组围绕 DSL 编译、渲染与验证的基础 capability spec
- 通过 `change-management` capability 把后续 OpenSpec 使用方式明确下来
- 说明后续 MomoScript 变更应如何使用 OpenSpec 产物
- 在 README 里加入 OpenSpec 入口，方便贡献者快速发现

## Impact

- Formal spec delta：`change-management`
- 预置基础文档：`dsl-compilation`、`rendering-pipeline`、`tooling-and-verification`
- 影响代码：无
- 影响文档：仓库入门与规划流程
