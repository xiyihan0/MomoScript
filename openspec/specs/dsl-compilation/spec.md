# dsl-compilation 规格

## Purpose

定义 MomoScript 源文本如何被转换成稳定的编译结果，以供渲染和下游集成使用。

## Requirements

### Requirement: Deterministic DSL compilation

系统在相同项目版本和相同资源上下文下，SHALL 将同一份合法 MMT 输入编译成相同的语义结果。

#### Scenario: Stable compilation for a valid script

- GIVEN 一份合法的 `.mmt.txt` 脚本
- AND 相同的 pack 元数据和编译器版本
- WHEN 流水线对该脚本执行多次编译
- THEN 语义编译结果在多次运行之间保持一致

### Requirement: Useful failure reporting

系统对于非法 DSL 输入，SHALL 给出有助于作者定位失败构造或失败阶段的诊断信息。

#### Scenario: Invalid statement is rejected

- GIVEN 一份包含非法 DSL 语法或不支持结构的脚本
- WHEN 解析或编译执行时
- THEN 命令显式失败
- AND 失败信息指出问题构造或处理阶段

### Requirement: Backward-aware language evolution

系统对于 DSL 行为变更，SHALL 把它视为显式兼容性决策，而不是悄悄发生的偶然漂移。

#### Scenario: Changing DSL semantics

- GIVEN 一项会修改解析或编译行为的提议变更
- WHEN 该变更被规划并实现时
- THEN 对应受影响的 OpenSpec 能力文档被更新
- AND 使用 golden-file 流程验证其预期影响
