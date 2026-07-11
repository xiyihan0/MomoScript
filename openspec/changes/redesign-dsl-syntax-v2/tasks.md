## 1. 语言与架构合同

- [x] 1.1 明确核心 DSL、`[:...:]`、节点 patch 与 `@typ` 的职责边界
- [x] 1.2 明确 Syntax AST / Semantic IR 分层、UTF-8 byte range 与 recoverable error node
- [x] 1.3 明确 character preset、script actor、actor revision、actor name 与 builtin speaker 模型
- [x] 1.4 明确 `t` / `T` / `rt` / `rT`、`@mode` 与 Typst AST overlay 策略
- [x] 1.5 明确 pack-v3 entity、contribution、slot、set、variant、ordinal 与 materializer 边界
- [x] 1.6 明确 direct Typst façade emission、chunk-level source map 与 strict/permissive pipeline

## 2. Syntax parser 与 analysis surface

- [x] 2.1 实现 statement、generic directive line/block、reply、bond、blank 与 error syntax nodes
- [x] 2.2 实现 continuation、缩进控制、任意长度 fence、头部 patch 和 `@typ` raw block
- [x] 2.3 实现 `[:...:]`、render patch、quoted/escaped args、ordinal 与 declaration literal/list parsing
- [x] 2.4 保留每个节点、body part、patch、field 和 diagnostic 的 UTF-8 source range
- [x] 2.5 提供 `parse_text` / `parse_document` 公开 API 和版本化 `mmt.syntax.v2` JSON analysis surface
- [x] 2.6 提供纯文本 `analyze_text_wasm` export；该 portability surface 本阶段不承担 Web 产品迁移或旧 ABI 兼容

## 3. Semantic lowering

- [x] 3.1 实现文件局部 mode resolution，并让显式 fenced mode 覆盖继承值
- [x] 3.2 实现 preset lookup、actor 创建/打开、name conflict、revision 与 statement snapshot
- [x] 3.3 实现按边 current/history/unique index、`_n` / `~n` 与可配置 builtin fallback
- [x] 3.4 实现 `@asset` block 和 short form 到统一 `ScriptAsset` IR 的 lowering
- [x] 3.5 实现 marker subject/resource-space/full-path normalization 与确定性失败
- [x] 3.6 使用 Typst 0.15 syntax tree 限定 `T` mode overlay 展开区域并验证 patch args

## 4. Pack、resolve 与 materialization

- [x] 4.1 实现 pack-v3 manifest model、registry validation 与 `CharacterPresetCatalog`
- [x] 4.2 实现 entity/contribution/default set/name/ordinal 的确定性 sticker 与 avatar resolution
- [x] 4.3 拒绝 unsafe pack path、缺失 storage、无效 image-sequence metadata 与歧义 selector
- [x] 4.4 实现 script asset、pack asset、actor avatar 和 marker resource resolution
- [x] 4.5 实现平台无关 `ResourceMaterializer` interface 与 range-preserving materialize diagnostics
- [x] 4.6 增加通过 `PackRegistry` validation 的最小 pack-v3 fixture，覆盖 base、contribution、default/non-default set 与 sequence frame

## 5. Typst emission 与模板

- [x] 5.1 实现 chat、narration、reply、bond、sticker、avatar 与 `@typ` façade emission
- [x] 5.2 实现 actor revision presentation、avatar materialization binding 与 automatic continuation key
- [x] 5.3 实现 node/resource patch origin、generated wrapper parent 和 zero-length source-map lookup
- [x] 5.4 对完整 generated source 执行 `typst-syntax` 0.15 precheck 并回映射 diagnostic
- [x] 5.5 实现无 import 副作用的 `lib.typ` façade、template/theme/config 与 v2 smoke source
- [x] 5.6 跟踪 `special.typ` 使用的 `mmt_options.webp` 与 `mmt_favor.webp`，并验证 v2 façade smoke 可在指定 project root 下自包含编译
- [ ] 5.7 固化哪些节点打断 automatic continuation，并写入 formal scenario
- [ ] 5.8 明确 v2 第一版 template 管理的 page/header/raw 样式；image-only sticker 与 advanced API 可 deferred

## 6. 主线交付与验收

- [x] 6.1 为 parser、inline、semantic、pack、resolve、materialize、emit、pipeline 和公开 API 建立 Rust 行为测试
- [x] 6.2 验证 strict pipeline 在 syntax/semantic/resolve error 后不触发 materializer I/O
- [x] 6.3 建立无网络 Rust v2 fixture：`compile_text_strict` → generated Typst → Typst 0.15 compile
- [ ] 6.4 将真实 Typst compile/layout diagnostic 通过 `EmittedTypst` source map 映射回 MMT origin
- [x] 6.5 提供以 `compile_text_strict` 为核心、支持 stdin/文件输入、JSON diagnostics 与自包含 Typst project 导出的 `mmt-compile` native CLI
- [x] 6.6 固化 `@asset` canonical block 和 v2 第一版 short form；两者共享 `ScriptAsset` lowering 与 validation
- [ ] 6.7 将稳定 delta 归档到 `openspec/specs/`，并把 Python v1 规格保留为明确 legacy reference 或移入 archive
- [ ] 6.8 明确标注 Python/JSON legacy 验证入口与 Rust v2 默认命令的适用范围，避免混用验收信号
- [x] 6.9 为 text/Typst body、`@typ`、statement patch、reply/bond、resource marker/wrapper/patch 与 zero-length lookup 建立 emitter source-map 回射测试
- [ ] 6.10 定义共享 generated source、source map、模板和物化资源的 compilation bundle
- [x] 6.11 实现自包含 Typst CLI project exporter，并以普通资源、透明 AVIFS fixture 和真实 ba_kivo pack 验证导出项目可由 Typst 0.15 编译
- [ ] 6.12 实现 Typst 0.15 library `World` backend，并验证它与 project exporter 使用相同 compilation bundle
