## Why

Python v1 DSL 已能承载实际创作，但 Typst 模式、查询占位、人物配置和局部样式覆盖把解析、语义、资源 I/O 与 JSON 渲染耦合在一起。项目当前以 Rust DSL v2 作为主要开发主线，通过直接生成 Typst、显式 semantic IR 和 pack-v3 资源解析替代该历史结构。

这次 change 已从设计收敛进入 active implementation。核心 parser、lowering、resolver、materializer 协调、emitter、source map 和 diagnostics 已在 `mmt_rs` 落地；剩余工作集中于第一版合同封口、真实 Typst 编译验收、native CLI/build 入口和 spec 归档。

## What Changes

- 为 DSL 下一版建立更清晰的语义分层：
  - 核心 DSL 负责叙事结构
  - `[:...:]` 负责确定性资源引用
  - `[:...:](...)` 负责资源节点渲染参数
  - `@typ` 负责高权限 Typst 注入
- 引入“节点头部局部 patch”作为局部渲染参数覆盖机制
- 暂缓自然语言查询，不让确定性资源解析失败时进入语义 fallback
- 重新设计人物与资源配置语法，倾向使用聚合声明，并在需要时提供统一短行简写
- 将人物配置收束为作者侧的 `@actor` 模型：资源包 character preset 提供初值，脚本 actor 保存随时间演进的状态，角色名称用于确定性引用
- 明确正文模式 `t` / `T` / `rt` / `rT`，并将 `[:...:]` 定义为 MMT overlay inline macro
- Typst 正文优先通过 `typst-syntax` 做语法检查与可替换区间识别，不在第一版 fork Typst 语法
- 收敛值层命名空间、短行参数、字面量和字符串规则
- 明确废弃候选语法，例如 `(target)[expr]`

## Implementation Status

已实现并有 Rust 行为测试覆盖：

- UTF-8 byte-range syntax AST、generic directive blocks、错误恢复、fence、continuation、reply/bond、patch 与 `@typ`
- `t` / `T` / `rt` / `rT` mode resolution，以及仅在 Typst markup AST 区域展开 overlay marker
- character preset、script actor、actor revision、按边 speaker history、`_n` / `~n` 与 builtin speaker
- `@asset` block/short form、声明字面量/list、确定性 `[:...:]` lowering
- pack-v3 registry/validation、sticker/avatar/asset resolution、受控 materializer interface
- façade emitter、chunk-level source map、generated Typst syntax precheck、strict/permissive compilation pipeline
- 版本化 `mmt.syntax.v2` analysis JSON surface；WASM export 仅是纯分析宿主接口，不等同于本阶段迁移 Web 产品
- 最小 base/extension pack-v3 fixture，以及 `compile_text_strict` 生成 Typst 后交给 Typst 0.15 的无网络编译测试
- `mmt-compile` native CLI，可从 stdin/文件读取 MMT、输出结构化诊断，并导出 Typst CLI 可直接编译的自包含项目
- 真实 Typst 0.15 eval diagnostic 的 generated line/column → byte range → MMT `@typ` origin 回射测试

尚未完成：

- 实现内部 Typst `World` backend，并把 compile/eval/layout diagnostics 全面接入 `EmittedTypst` source map
- 用 direct libavif FFI backend 替换当前已可用的受控 `avifdec + dav1d` 子进程，同时保持 image-sequence 内容寻址缓存合同
- 封口第一版剩余 façade/continuation 决策，并把 active delta 归档到正式 capability specs

## Impact

- Formal spec delta：`dsl-syntax`、`dsl-parser-architecture`、`typst-template-library`
- 主实现：`mmt_rs/src/{parser,inline,semantic,pack,resolve,materialize,emit,pipeline,analysis}.rs`
- 模板实现：`typst_sandbox/mmt_render/{lib,template,chat,special,resource,config}.typ`
- 历史参考：`mmt_core/` 与 legacy JSON renderer；它们不定义 Rust v2 正确性
- 本阶段非目标：迁移 `web/`、维持旧 `compile_text_*_wasm` JSON ABI、完整兼容 Python v1 语法
