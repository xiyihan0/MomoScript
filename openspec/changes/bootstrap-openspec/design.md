## Overview

这次 bootstrap 是刻意手写且保持最小化的。目标不是逆向梳理出仓库现有全部行为，而是在这个已有代码基础上，让 OpenSpec 能立刻开始发挥作用。

## Key Decisions

### 只预置最有价值的 capability

这里先定义一小组围绕 DSL 编译、渲染、验证和变更管理的 capability。它们正好对应仓库当前最清晰的边界，也足以为后续工作提供稳定锚点。

前 3 个 capability 以仓库基础 spec 的形式预置；`change-management` 则同时作为本次 bootstrap change 下的正式 delta 记录下来，方便后续变更直接沿用流程。

### 保留现有 agent 配置

这次 bootstrap 不依赖 `openspec init` 或 `openspec update`，因为仓库已经存在本地 agent 指引文件，而且工作树里也有进行中的变更。手工初始化可以避免覆盖这些文件，同时依旧采用 OpenSpec 的目录组织方式。

### 把项目真实验证路径写进来

OpenSpec 在这个仓库里最有价值的地方，是能反映项目真实使用的验证习惯。因此 bootstrap 明确围绕 `uv`、`tools/dsl_refactor_check.py`、`tools/mmt_pipeline.py` 和 `web/` 构建验证，而不是泛泛地写成通用测试说明。

## Tradeoffs

- 初始 spec 刻意写得偏宽，后续随着新功能落地还需要继续细化。
- Slash command 的自动接入这次没有一并 bootstrap；如果以后需要，仓库可以再补官方 CLI 集成。
