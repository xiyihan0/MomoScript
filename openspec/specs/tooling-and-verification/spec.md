# tooling-and-verification 规格

## Purpose

定义本仓库中用于建立 DSL、渲染、集成和编辑器改动信心的工作流。

## Requirements

### Requirement: Golden-file regression as the default safety net

系统对于 parser、compiler 和 renderer 相关改动，SHALL 将仓库内的 golden-file 工作流作为主要回归信号。

#### Scenario: Changing pipeline behavior

- GIVEN 一项影响解析、编译或渲染行为的改动
- WHEN 作者为评审准备这项改动时
- THEN `tools/dsl_refactor_check.py` 被纳入验证步骤
- AND 任何有意为之的输出变化都被显式审查

### Requirement: End-to-end pipeline verification

系统 SHALL 提供一条命令行路径，用于在单次流程中验证从文本到渲染的整体行为。

#### Scenario: Verifying a script end to end

- GIVEN 仓库中的示例脚本或一个聚焦的复现用例
- WHEN 执行 `tools/mmt_pipeline.py`
- THEN 该流程会联合覆盖 parse、compile、resolve 与 render 阶段

### Requirement: Surface-specific validation

系统在验证变更时，SHALL 以变更实际影响到的表面为准，而不是只依赖无关检查。

#### Scenario: Updating the web editor

- GIVEN 一项位于 `web/` 下的改动
- WHEN 准备验证步骤时
- THEN 其中包含 web build 或等价的编辑器侧验证
- AND 不能把仅有 Python 验证视为充分条件

#### Scenario: Updating NoneBot integration

- GIVEN 一项位于 `mmt_nonebot_plugin/` 或 bot 入口流程上的改动
- WHEN 准备验证步骤时
- THEN 在相关情况下，除了核心流水线检查外，还要补 bot 或插件层面的基本检查
