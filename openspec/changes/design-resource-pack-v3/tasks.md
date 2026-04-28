## 1. 定义 pack-v3 manifest

- [x] 1.1 明确 manifest 需要统一承载 pack 元信息、实体定义、资源贡献、slot、variant 与 storage backend
- [x] 1.2 明确 base pack 定义实体，extension pack 默认通过 `contributions` patch 既有实体
- [x] 1.3 明确 `avatar` 与 `sticker` 的第一版 slot 语义
- [x] 1.4 明确 `ordinal` 支撑 `#n` selector，且不能依赖文件系统顺序

## 2. 定义 WebM 帧包存储草案

- [x] 2.1 将 WebM 作为可选 `video-frames` storage backend，而不是逻辑资源语义
- [x] 2.2 明确 variant 通过 `source.storage` 与 `source.frame` 指向 WebM 中的帧
- [x] 2.3 记录 alpha、codec、hash、frame_count、random_access 等必要元数据
- [x] 2.4 明确进入 Typst 前需要 materialize 为静态图片 cache

## 3. 后续实现准备

- [ ] 3.1 编写 pack-v2 到 pack-v3 manifest 的迁移工具草案
- [ ] 3.2 实测 WebM 编码 profile 在体积、透明度、抽帧速度和画质上的 tradeoff
- [ ] 3.3 设计 resolver 返回的 `ResolvedResource` 数据结构
- [ ] 3.4 设计 CLI / NoneBot / Web-WASM 共用的 materializer 接口
- [ ] 3.5 增加 pack-v3 manifest schema 校验与示例资源包
