# change-management 规格

## Purpose

定义 MomoScript 如何使用 OpenSpec 来规划和评审较大的行为变更。

## Requirements

### Requirement: Substantial changes start from a change folder

仓库对于非琐碎行为变更，SHALL 在实现之前或至少与实现同步，在 `openspec/changes/<change-id>/` 下留下记录。

#### Scenario: Planning a DSL or rendering change

- GIVEN 一项影响 DSL 语义、渲染行为、公开工作流或多个模块的提议变更
- WHEN 工作开始时
- THEN 创建一个包含范围和验证说明的 change 目录

### Requirement: Changes identify affected capabilities

每个 OpenSpec change 都 SHALL 指向它修改或依赖的 capability spec。

#### Scenario: Preparing a proposal

- GIVEN 一份新的 change proposal
- WHEN 编写 proposal 时
- THEN 其中明确列出受影响的 capability spec
- AND 用可评审的语言说明预期行为影响

### Requirement: Changes define verification up front

每个 OpenSpec change 都 SHALL 包含足以支撑实现信心的验证路径。

#### Scenario: Preparing implementation tasks

- GIVEN 一项会影响代码的 change
- WHEN 创建或更新 `tasks.md` 时
- THEN 任务中包含相关回归、流水线或表面特定检查
- AND 评审者可以明确看出该变更应如何验证
