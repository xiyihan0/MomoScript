# MomoScript 的 OpenSpec 说明

这个仓库把 OpenSpec 当作“轻量规划层”，主要用于非琐碎变更的需求对齐、设计记录、实施状态和验证约束。当前主要开发主线是 Rust DSL v2；Python DSL 属于 legacy 实现，Web 暂不纳入本阶段 parser 工作。

建议从这里开始：

1. 先读 `openspec/project.md`，确认当前主线、历史区域和默认验证方式。
2. 再读 `openspec/specs/` 下已归档的 capability spec；若能力正在变更，以对应 active change 的 spec delta 为主线合同。
3. Rust DSL v2 当前从 `openspec/changes/redesign-dsl-syntax-v2/` 开始，pack-v3 从 `openspec/changes/design-resource-pack-v3/` 开始。
4. 新的非琐碎行为变更应在实现前或与实现同步创建 `openspec/changes/<change-id>/`。

推荐的变更目录内容：

- `proposal.md`：说明动机、范围、当前实施状态与明确 non-goals
- `design.md`：记录已经决定的架构、取舍和仍未决定的问题；不要把已实现合同长期写成“候选”
- `tasks.md`：分别跟踪设计、实现和验证；勾选必须对应可观察证据
- `specs/<capability>/spec.md`：记录本次变更对应的 requirement/scenario delta

本仓库当前常用验证方式：

- Rust core：`cargo test --manifest-path mmt_rs/Cargo.toml`
- Typst v2 façade：`cd typst_sandbox/mmt_render && typst compile tests/v2-smoke.typ /tmp/mmt-v2-smoke.pdf --root ..`；fixture 所需的 `mmt_options.webp` 与 `mmt_favor.webp` 已跟踪，命令用于验证当前 façade、配置状态和真实图片内容
- Rust v2 行为变化：增加聚焦 Rust 测试，并验证 `compile_text_strict` 的完整阶段结果
- Rust v2 主线验收：将 emitter 生成的 Typst 交给 Typst 0.15 编译，覆盖真实 source-map/diagnostic 边界
- Python legacy、NoneBot 和 Web 命令只在明确修改对应表面时运行；`web/` 暂不属于当前 Rust parser 的默认验证目标

这里的 OpenSpec 采用渐进式维护方式。active change 可以先承载主线 delta，但必须准确记录实施状态；能力稳定并完成端到端验收后，应把 delta 归档到 `openspec/specs/`，避免正式规格长期停留在旧实现。
