## 1. Manifest 与解析合同

- [x] 1.1 定义 pack metadata、entity、contribution、avatar/sticker slots、set、variant、asset 与 storage model
- [x] 1.2 明确 base entity 与 contribution-scoped 扩展资源，禁止按加载顺序静默覆盖
- [x] 1.3 明确 set-scoped ordinal、default set 和 `#n` 不依赖文件系统顺序
- [x] 1.4 明确普通图片与 image-sequence storage、set storage inheritance 和 0-based frame
- [x] 1.5 明确 pack-relative path、受控 cache 与 DSL 不可选择输出路径的安全边界

## 2. Rust registry、resolver 与 materializer 协调

- [x] 2.1 实现 manifest deserialize、registry validation 与 `CharacterPresetCatalog`
- [x] 2.2 实现 entity/name、contribution、set/default、variant handle/ordinal 和 pack asset 解析
- [x] 2.3 拒绝 unsafe path、缺失 storage、无效 entity names 和不完整 image-sequence metadata
- [x] 2.4 实现带 pack namespace、storage id、path、frame 和 marker origin 的 `ResolvedResource`
- [x] 2.5 实现 actor avatar、script asset、pack asset 与 inline sticker 的统一 resolve 流程
- [x] 2.6 实现平台无关 `ResourceMaterializer` interface 和 materialize phase diagnostics

## 3. Kivo 构建与压缩研究

- [x] 3.1 记录 Kivo API 结构、entity/name/skin/gallery 映射和可审计 build report
- [x] 3.2 实现 `tools/build_kivo_pack_v3.py` 的 fetch、筛选、下载、resume/dry-run 与 manifest/report 输出
- [x] 3.3 实现可选 AVIFS 编码、profile 参数、canvas guard 和失败报告
- [x] 3.4 实测 AVIFS 在体积、透明度、抽帧速度与画质上的 tradeoff
- [x] 3.5 保留 browser AVIF decoder 调研为后续迁移参考；不把 Web/WASM 实现列为当前 parser 主线任务

## 4. 剩余实施与验收

- [ ] 4.1 定义机器可校验的 pack-v3 manifest schema，并与 Rust model 字段保持一致
- [x] 4.2 增加最小 fixture pack：base entity、extension contribution、avatar、default/non-default sticker set、ordinal 和 sequence frame
- [ ] 4.3 为 schema invalid、path traversal、missing storage、ambiguous contribution 和 missing default set 增加 fixture-level failure cases
- [x] 4.4 实现基于 `libavif + dav1d` 的受控 `avifdec -c dav1d --index` native image-sequence materializer，输出并校验受控 PNG
- [x] 4.5 实现包含 storage sha256、frame、decoder profile、output format/size 的内容寻址 cache，并在解码前校验容器 SHA-256
- [x] 4.6 用 fixture 验证 resolve → materialize → Rust emit → Typst 0.15 compile
- [ ] 4.7 用 builder 生成一个小型可审计样例并同时通过 schema 与 `PackRegistry` validation
- [ ] 4.8 完成验收后把稳定 rendering-pipeline delta 归档到 `openspec/specs/`
- [ ] 4.9 在不改变 materializer/cache 合同的前提下，用 direct libavif FFI backend 替换 native `avifdec` 子进程
