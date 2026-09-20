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

### Requirement: Surface-specific checks supplement the Rust core safety net

Python DSL、legacy JSON renderer 与 NoneBot 历史表面只在被明确修改时验证；编辑器、WASM、Tinymist 或 Web runtime 发生变化时 SHALL 运行对应 npm project 的聚焦检查。表面检查不得替代 Rust DSL v2 core 回归。

#### Scenario: Changing a retained legacy surface

- GIVEN 一项改动明确触及 Python 或 NoneBot 历史表面
- WHEN 准备该改动的验证
- THEN 作者 SHALL 运行该表面的聚焦检查
- AND 该检查 MUST NOT 被描述为 Rust DSL v2 的主线回归信号

#### Scenario: Changing a production editor surface

- GIVEN 一项改动触及 `mmt_lsp` transport、Desktop/Web extension、生产 Web editor、Tinymist backend 或 browser materializer
- WHEN 准备该改动的验证
- THEN 作者 SHALL 在受影响的 npm project 中运行对应 transcript、browser、Extension Host 或 build 检查
- AND change spec MUST 明确记录 ABI、runtime 和平台特定的验收边界

### Requirement: Tinymist executable source and release provenance are independently pinned

Tinymist 的可执行源码与官方发布 provenance SHALL 使用 `third_party/tinymist/pin.json` 的 `mmt-tinymist-pin.v2` 合同分开管理。`source.repository` SHALL 为 `https://github.com/xiyihan0/tinymist.git`，`source.revision` SHALL 为完整、不可变的 Git commit；`upstream.repository`、`upstream.revision` 与 `upstream.version` 只记录官方 base/release provenance，并与受信 universal VSIX metadata 一起用于认证官方发布输入。Pin MUST NOT 包含 patch 列表，产品仓库 MUST NOT 保存或应用 Tinymist source patch，也 MUST NOT 以 submodule 代替 source pin。

#### Scenario: Preparing an executable source checkout

- GIVEN `pin.json` names one fork repository and a 40-character lowercase full `source.revision`
- WHEN native 或 Web artifact producer starts
- THEN `TINYMIST_SRC` MUST name a direct checkout whose `HEAD` exactly equals `source.revision`
- AND the checkout MUST have no tracked source dirt before build、promotion、repin or qualification
- AND the producer MUST fail closed rather than apply a patch、switch to `upstream.revision` or build another branch tip
- AND branch `mmt/0.15.8` SHALL carry the maintained history but MUST NOT replace the full commit as build identity

#### Scenario: Changing maintained Tinymist source

- GIVEN MomoScript needs a renderer、protocol、package-host change or an upstream sync
- WHEN the Tinymist source owner prepares that change
- THEN the owner MUST create and push ordinary commits in the `xiyihan0/tinymist` fork and move the product source pin to the resulting full commit
- AND an upstream sync MUST remain an explicit source-owner commit or merge in that fork
- AND pushing source MUST NOT imply product qualification、vendor refresh、runtime publication or a completed release

### Requirement: One producer owns Tinymist build, qualification and repin

`editors/vscode/scripts/build-tinymist-artifacts.mjs` SHALL be the only product-side Tinymist artifact producer. Its supported modes SHALL be `build-promote`、`promote`、`repin` and `qualify`; no capture/apply/verify patch workflow SHALL remain.

#### Scenario: Promoting or repinning artifacts

- GIVEN `TINYMIST_SRC` is the clean exact `source.revision` checkout
- WHEN the owner runs `build-promote`
- THEN the command MUST build native/Web outputs with the pinned toolchain and stamp their derived artifact identities
- WHEN the owner runs `promote`
- THEN the command MUST reuse only existing outputs from the same exact checkout and stamp their derived identities without rebuilding
- WHEN the owner runs `repin`
- THEN `TINYMIST_VSIX` MUST name the universal VSIX authenticated by the official release metadata
- AND repin MUST run the owning qualification gates before atomically accepting canonical pin、evidence、generated admission policy、native fixture and vendored Web/grammar updates
- AND source fork bytes MUST NOT substitute for official VSIX grammar/license provenance

#### Scenario: Producing CI qualification evidence

- GIVEN `TINYMIST_QUALIFICATION_DIR` names a new output directory
- WHEN the owner runs `qualify`
- THEN it MUST emit an atomic qualification bundle for the artifacts built from the exact source pin
- AND it MUST restore canonical evidence、generated modules and pre-existing candidate output on success or failure
- AND consumers MUST authenticate the bundle against the corresponding artifacts rather than trust a build-local checksum alone

#### Scenario: Publication remains a separate authority

- GIVEN build、qualification or repin succeeds
- WHEN no separately authorized runtime publication command has completed its public verification
- THEN no CDN object or site release MAY be claimed as published
- AND product qualification、vendor refresh、same-origin delivery preparation and remote publication MUST remain distinct ownership steps
