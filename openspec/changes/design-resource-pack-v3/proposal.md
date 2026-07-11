## Why

现有 pack-v2 把 pack 元信息、人物映射、头像路径和表情 tags 分散在多个文件里，无法为 Rust DSL v2 的统一资源路径、贡献命名空间、set-scoped `#n` selector 和确定性解析提供单一权威索引。

表情图片序列同时占用较大分发体积。pack-v3 将 AVIFS image sequence 建模为可选物理 storage backend；DSL、semantic IR 和 Typst façade 只观察逻辑资源及 materialized 静态图片，不依赖具体 decoder 或历史 Web 产品。

## What Changes

- 定义 pack-v3 manifest，把逻辑资源索引和物理存储格式分层。
- 将人物实体、资源贡献、slot、set、variant、tags、description 与 ordinal 统一收进 manifest。
- 允许资源条目指向普通图片文件，或指向 `image-sequence` storage 中的明确 frame。
- 要求 compressed sequence 在进入 Typst 前 materialize 为受控静态图片。
- 提供 Kivo Wiki 构建器和 AVIFS 编码 profile；浏览器 AVIF decoder 笔记保留为后续迁移参考，但不属于当前 parser 实现范围。

## Implementation Status

已实现：

- `mmt_rs::pack` 中的 manifest model、validation、registry、character preset catalog、avatar/sticker/asset deterministic resolution
- unsafe path、缺失 storage、无效 image-sequence metadata、ordinal/default-set/contribution ambiguity 检查
- `ResolvedResource` / `PackStorageSource`、actor avatar 与 inline marker resolution
- 平台无关 `ResourceMaterializer` 接口和 range-preserving materialize diagnostics
- `tools/build_kivo_pack_v3.py` 的 Kivo fetch、manifest/report、资源下载和可选 AVIFS 编码流程
- 从真实 Kivo pack 结构提炼的 base/extension fixture，以及 strict pipeline 到 Typst 0.15 的无网络编译测试
- `ProjectMaterializer` 的 `image-dir` 复制与 AVIFS image-sequence 抽帧；后者使用受控 `avifdec + dav1d`、容器 SHA-256/尺寸校验、原子 PNG 输出和内容寻址 cache
- 透明 AVIFS fixture 的 alpha 保留/cache 回归，以及真实 ba_kivo pack 的 avatar + sticker → Typst PDF smoke

尚未完成：

- 仓库内可重复使用的 machine-readable manifest schema
- direct libavif FFI backend；当前 native 子进程 backend 已可用，并保持相同 materializer/cache 合同

## Impact

- Formal spec delta：`rendering-pipeline`
- 相关设计：DSL v2 统一资源路径、`avatar` / `sticker` slot、contribution namespace 与 set-scoped ordinal
- 主实现：`mmt_rs/src/{pack,resolve,materialize,pipeline}.rs`、`tools/build_kivo_pack_v3.py`
- 本阶段非目标：Web editor 迁移、browser Worker、browser-only AVIF WASM decoder 或 UI 预热策略
