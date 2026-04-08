# MomoScript 的 OpenSpec 说明

这个仓库把 OpenSpec 当作“轻量规划层”，主要用于非琐碎变更的需求对齐、设计记录和验证约束。

建议从这里开始：

1. 先读 `openspec/project.md`，了解仓库背景、约束和默认验证方式。
2. 再读 `openspec/specs/` 下对应能力的 spec。
3. 在实现较大的行为变更前，先在 `openspec/changes/<change-id>/` 下创建变更目录。

推荐的变更目录内容：

- `proposal.md`：说明为什么做、范围是什么
- `design.md`：当架构、取舍或实现路径值得记录时填写
- `tasks.md`：列出实现与验证清单
- `specs/<capability>/spec.md`：记录本次变更对应的 spec delta

本仓库常用验证方式：

- 用 `uv sync` 准备 Python 工作区
- 用 `uv run tools/dsl_refactor_check.py` 做 golden-file 回归检查
- 当变更影响流水线行为时，用 `uv run tools/mmt_pipeline.py <script.mmt.txt>` 做端到端检查
- 修改 `web/` 时，在其中运行 `npm install && npm run build`

这里的 OpenSpec 采用渐进式维护方式。不要一开始就试图把整个代码库全部规格化，而是在功能演进时逐步补充和修订。
