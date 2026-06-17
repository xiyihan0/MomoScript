## Why

当前 MomoScript 的 DSL 已经能承载实际创作，但随着 Typst 模式、查询占位、人物配置、局部样式覆盖等能力叠加，语法边界开始变得模糊。尤其是在准备重写渲染管线、改为直接生成 Typst 文档的背景下，旧语法里的若干历史设计需要重新分层。

这次 change 的目标不是立刻实现全部重构，而是先明确下一版 DSL 的核心方向，让后续 parser / compiler / emitter 重写有稳定锚点。

## What Changes

- 为 DSL 下一版建立更清晰的语义分层：
  - 核心 DSL 负责叙事结构
  - `[:...:]` 负责确定性资源引用
  - `[:...:](...)` 负责资源节点渲染参数
  - `@typ` 负责高权限 Typst 注入
- 引入“节点头部局部 patch”作为局部渲染参数覆盖机制
- 暂缓自然语言查询，不让确定性资源解析失败时进入语义 fallback
- 重新设计人物与资源配置语法，倾向使用聚合声明，并在需要时提供统一短行简写
- 明确 `@char` 使用不可变 template、工作区 mutable instance 与显式 handle 引用模型
- 明确正文模式 `t` / `T` / `rt` / `rT`，并将 `[:...:]` 定义为 MMT overlay inline macro
- Typst 正文优先通过 `typst-syntax` 做语法检查与可替换区间识别，不在第一版 fork Typst 语法
- 收敛值层命名空间、短行参数、字面量和字符串规则
- 明确废弃候选语法，例如 `(target)[expr]`

## Impact

- Formal spec delta: `dsl-syntax`
- 相关实现参考：`mmt_core/dsl_parser.py`、`mmt_core/dsl_compiler.py`
- 受影响范围：DSL parser、compiler、Typst emitter、文档、示例
- 影响代码：暂未实现，本 change 目前用于收敛设计
