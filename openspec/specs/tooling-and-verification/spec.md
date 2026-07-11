# tooling-and-verification 规格

## Purpose

定义 Rust DSL v2、Typst façade 和 pack-v3 主线用于建立实现信心的验证工作流。Python、NoneBot 与 Web 历史表面不构成默认验证范围。

## Requirements

### Requirement: Rust behavior tests are the default safety net

系统对于 Rust DSL v2 parser、semantic lowering、resource resolution、materialization coordination、Typst emission 和 diagnostics 的改动，SHALL 将聚焦 Rust 行为测试作为主要回归信号。

#### Scenario: Changing Rust language-core behavior

- GIVEN 一项影响 Rust DSL v2 语法、语义、资源解析或 emission 的改动
- WHEN 作者为评审准备该改动
- THEN `cargo test --manifest-path mmt_rs/Cargo.toml` MUST pass
- AND 新测试 MUST 防守可观察合同、边界、失败阶段或 source range，而不是检查实现文本

#### Scenario: Public API remains covered

- GIVEN `mmt_rs` 的公开 parser、analysis 或 compilation API 发生变化
- WHEN 验证该变化
- THEN `mmt_rs/tests/` SHALL 包含对应的外部调用合同测试
- AND 内部单元测试不能替代公开 API 覆盖

### Requirement: Strict compilation verifies the full language-core pipeline

系统 SHALL 使用 `compile_text_strict` 作为合法输入的 build/CLI 合同，并验证 syntax、semantic、resolve、materialize 与 emit 阶段的组合行为。

#### Scenario: Valid fixture crosses every core stage

- GIVEN 一份合法 Rust DSL v2 fixture、确定的 pack registry 和受控 materializer
- WHEN 执行 `compile_text_strict`
- THEN compilation SHALL include syntax document、lowering results、resource resolution、materialization、emitted Typst、source map 与 diagnostics
- AND 相同输入和资源上下文 MUST produce deterministic semantic and emitted results

#### Scenario: Invalid input stops before platform I/O

- GIVEN syntax、semantic 或 resolve 阶段产生 error diagnostic
- WHEN 执行 strict compilation
- THEN compilation MUST fail before invalid resources trigger materializer I/O
- AND diagnostic MUST retain its original phase and MMT source range

### Requirement: Generated Typst is compiled by the supported Typst version

Rust DSL v2 的端到端验收 SHALL 将 emitter 生成的真实 Typst 交给受支持的 Typst 0.15 工具链，而不是只验证手写 façade smoke 或字符串形状。

#### Scenario: Verifying emitted Typst end to end

- GIVEN 一份覆盖 actor、resource marker、materialization 和核心内容节点的合法 fixture
- WHEN Rust strict pipeline 生成 Typst
- THEN generated Typst MUST compile successfully with Typst 0.15 and the tracked v2 template library
- AND fixture MUST NOT require network access or user-specific assets

#### Scenario: Mapping a Typst compilation error

- GIVEN generated Typst 中由 MMT body、node patch、resource patch 或 `@typ` chunk 引入错误
- WHEN Typst 返回 compile diagnostic
- THEN the diagnostic SHOULD map through the emitted source map to the most specific MMT origin
- AND zero-length generated ranges MUST remain queryable

### Requirement: Typst façade has an independent smoke check

模板库 SHALL 保留一个不依赖 language core 的最小 smoke，用于隔离 façade 自身的 Typst 语法和视觉组件装配错误。

#### Scenario: Compiling the façade smoke

- GIVEN `typst_sandbox/mmt_render/tests/v2-smoke.typ`
- WHEN 执行 `typst compile tests/v2-smoke.typ /tmp/mmt-v2-smoke.pdf --root ..`
- THEN public façade、template、theme 和核心内容组件 MUST compile
- AND 该 smoke MUST NOT 被当作 Rust emitter 端到端验证的替代品

### Requirement: Legacy surfaces are validated only when intentionally changed

Python DSL、legacy JSON renderer、NoneBot 与 Web 不属于 Rust DSL v2 默认完成条件。

#### Scenario: Changing a retained legacy surface

- GIVEN 一项改动明确触及 Python 或 NoneBot 历史表面
- WHEN 准备该改动的验证
- THEN 作者 SHALL 运行该表面的聚焦检查
- AND 该检查 MUST NOT 被描述为 Rust DSL v2 的主线回归信号

#### Scenario: Deferred Web surface

- GIVEN 当前 Rust parser 阶段未修改 `web/`
- WHEN Rust DSL v2 或 pack-v3 发生变化
- THEN Web build、浏览器 WASM compatibility 和 Web materializer MUST NOT 成为该变化的验收条件
- AND 后续 Web 迁移 MUST 通过独立变更重新定义对应 ABI 与验证范围
