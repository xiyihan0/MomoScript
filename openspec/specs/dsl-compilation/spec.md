# dsl-compilation 规格

## Purpose

定义 Rust DSL v2 源文本如何经由分阶段 language core 转换为确定的语义结果、materialization 请求和带 source map 的 Typst 输出。

## Requirements

### Requirement: Deterministic DSL compilation

系统在相同项目版本和相同资源上下文下，SHALL 将同一份合法 MMT 输入编译成相同的语义结果。

#### Scenario: Stable compilation for a valid script

- GIVEN 一份合法的 `.mmt.txt` 脚本
- AND 相同的 pack 元数据和编译器版本
- WHEN 流水线对该脚本执行多次编译
- THEN 语义编译结果在多次运行之间保持一致

#### Scenario: Stable emitted Typst for a valid script

- GIVEN 相同的合法 DSL v2 源文本、pack registry、materializer 输出和 emit options
- WHEN `compile_text_strict` 重复编译该脚本
- THEN emitted Typst 与 source-map entries MUST remain stable
- AND 结果不能依赖文件系统遍历顺序、hash map iteration order 或隐藏的本地配置

### Requirement: Useful failure reporting

系统对于非法 DSL v2 输入，SHALL 保留 syntax、semantic、resolve、materialize 或 Typst phase，并给出对应原始 MMT UTF-8 byte range。

#### Scenario: Strict compilation rejects errors by phase

- GIVEN 一份在任一 language-core 阶段包含错误的脚本
- WHEN `compile_text_strict` 执行
- THEN compilation MUST return failure with the accumulated diagnostics for that phase
- AND syntax、semantic 或 resolve error MUST stop before materializer I/O

#### Scenario: Permissive compilation preserves recoverable output

- GIVEN parser 为 IDE/analysis 场景恢复了 malformed node
- WHEN `compile_text` 执行
- THEN compilation MAY preserve partial AST、lowering and placeholder output
- AND error node and diagnostic range MUST remain visible
- AND permissive output MUST NOT be treated as a successful build artifact

### Requirement: Backward-aware language evolution

系统对于 DSL 行为变更，SHALL 把它视为显式兼容性决策，而不是悄悄发生的偶然漂移。Rust DSL v2 不以 Python v1 输出等价为默认兼容目标。

#### Scenario: Changing DSL semantics

- GIVEN 一项会修改 Rust parser、semantic lowering、resource resolution 或 emission 行为的提议变更
- WHEN 该变更被规划并实现
- THEN 对应 active OpenSpec requirement/scenario 和 implementation task MUST be updated
- AND 聚焦 Rust behavior tests MUST make the intended contract observable
- AND 如果变更影响生成文档，generated Typst MUST be compiled by the supported Typst version

#### Scenario: Selecting legacy compatibility

- GIVEN Python v1 存在某项历史语法或行为
- WHEN Rust DSL v2 决定保留该行为
- THEN compatibility MUST be named explicitly in the active v2 spec
- AND 未被明确选择的 legacy behavior MUST NOT constrain the Rust implementation
