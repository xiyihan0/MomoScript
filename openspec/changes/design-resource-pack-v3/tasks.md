## 1. 定义 pack-v3 manifest

- [x] 1.1 明确 manifest 需要统一承载 pack 元信息、实体定义、资源贡献、slot、set、variant 与 storage backend
- [x] 1.2 明确 base pack 定义实体，extension pack 默认通过 `contributions` patch 既有实体
- [x] 1.3 明确 `avatar` 与 `sticker` 的第一版 slot 语义
- [x] 1.4 明确 `ordinal` 支撑 `#n` selector，且不能依赖文件系统顺序
- [x] 1.5 明确 `sticker` 这类成组资源需要 `set` 层，且 `#n` 在 set 内解析

## 2. 定义压缩序列存储草案

- [x] 2.1 将 AVIFS sequence 作为推荐的 `image-sequence` storage backend，而不是逻辑资源语义
- [x] 2.2 明确 variant 通过 set storage 与 `frame` 指向 sequence 中的帧
- [x] 2.3 记录 alpha、codec、hash、frame_count、random_access 等必要元数据
- [x] 2.4 明确进入 Typst 前需要 materialize 为静态图片 cache
- [x] 2.5 明确 compressed sequence 推荐按 sticker set 拆分，variant 可继承 set storage
- [x] 2.6 记录当前推荐 AVIFS 编码 profile：`aom`、`qcolor=80`、`qalpha=80`、`yuv=420`、`keyframe_interval=30`

## 3. 后续实现准备

- [x] 3.1 补充 Kivo API 结构笔记，作为重建主资源包的数据源参考
- [x] 3.2 编写 Kivo 数据到 pack-v3 manifest 的构建流程草案
- [x] 3.3 实测 AVIFS 编码 profile 在体积、透明度、抽帧速度和画质上的 tradeoff
- [x] 3.4 设计 resolver 返回的 `ResolvedResource` 数据结构
- [x] 3.5 设计 CLI / NoneBot / Web-WASM 共用的 materializer 接口草案
- [ ] 3.6 增加 pack-v3 manifest schema 校验与示例资源包
- [x] 3.7 补充浏览器侧 AVIF WASM 解码组件构建草案
