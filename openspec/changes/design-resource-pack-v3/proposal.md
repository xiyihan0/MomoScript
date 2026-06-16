## Why

现有 pack-v2 把 pack 元信息、人物映射、头像路径、表情 tags 分散在多个文件里。它能服务当前渲染流程，但不适合下一版资源路径、贡献命名空间、`#n` 编号 selector、以及浏览器/WASM 场景下的轻量资源加载。

同时，表情包图片序列占用体积很大。实测将同一 sticker set 的静态图片序列转换为 AVIFS image sequence 后，可以在保留透明通道与可接受画质的前提下显著降低资源包分发体积。当前草案优先采用 AVIFS，而不是浏览器侧视频解码管线。

## What Changes

- 提出 pack-v3 manifest 草案，把“逻辑资源索引”和“物理存储格式”分层。
- 将人物实体、资源贡献、slot、set、variant、tags、description、`#n` 顺序统一收进 manifest。
- 允许资源条目指向普通图片文件，也允许指向 AVIFS sequence 中的某一帧。
- 明确 AVIFS sequence 只是压缩存储格式，进入 Typst 前必须解析为 Typst 可消费的静态图片资源。
- 记录 Kivo Wiki 数据抓取、pack-v3 manifest 组装、AVIFS 编码 profile、以及浏览器侧 AVIF WASM 解码组件的构建策略。

## Impact

- Formal spec delta：`rendering-pipeline`
- 相关设计：DSL v2 的统一资源路径、`sticker` slot、贡献命名空间、`#n` ordinal selector
- 影响代码：资源包加载器、资源 resolver、Typst 渲染准备阶段、Kivo Wiki 到 pack-v3 构建工具、AVIFS 编码工具、浏览器/WASM materializer
