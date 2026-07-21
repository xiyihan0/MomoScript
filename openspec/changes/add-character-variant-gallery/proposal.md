# Why

生产 Web 编辑器写 MMT 脚本时，人物与差分的选择依赖作者记忆或外部查 kivo.wiki：

- 线上 `ba_kivo` pack 有 328 个实体，`@actor` preset 名称（`ba::佳代子`）只能靠补全碰运气；
- `[:name,#n:]` 差分引用使用 set 内序号，例如佳代子的 7 个差分是 `ordinal: 1..7`，不看到图片无法知道 `#3` 是哪张表情；
- 差分帧存储在 AVIFS 序列里（`storage.kind = "image-sequence"`），浏览器外没有直接预览手段。

编辑器已经具备全部底层能力：pack manifest 缓存（`IndexedDbPackCache`）、AVIFS 解码 Worker（`decodeAvifSequence`）、侧边栏 custom view 模式（本地历史）。缺的是面向作者的浏览与插入 UI。

# What Changes

- 在侧边栏新增 custom view `momoscript.characterGallery`（角色图鉴）：实体网格（头像 + `display_name`）+ 按 `names` 子串搜索。
- 点进实体后展示 sticker set 切换与差分网格，每格标注 `#ordinal`，缩略图由 AVIFS 抽帧生成。
- 新增命令 `mmt.gallery.insertSticker`：点击差分在活动 mmt 编辑器光标处插入实体限定的 `[:name,#n:]` 片段。
- 将 `decodeAvifSequence` 从 `main.ts` 提取为共享模块，preview 与 gallery 复用同一 AVIFS 解码路径。
- 明确图片管线性能合同：实体网格分页/懒加载、AVIFS 整文件有界缓存、解码队列限流且随视图隐藏中止。

# Scope

唯一实施面是 `editors/vscode-web/` 的生产 Web 编辑器：

1. gallery 视图与实体/差分两级浏览；
2. AVIFS 抽帧缩略图管线（共享解码模块、缓存、限流）；
3. `[:name,#n:]` 插入命令与 e2e 合同；
4. fixture manifest 增加一个带差分 set 的实体和双帧 AVIFS fixture。

# Non-Goals

- 不实现实体/pack 的编辑、上传、删除或 pack 构建功能；gallery 是只读浏览。
- 不插入 `@actor`/`preset:` 声明，不做 speaker 上下文推断（裸 `#n` 只在有明确 speaker 的 message 中合法，v1 一律插入实体限定形式）。
- 不播放 AVIFS 动画；差分序列 fps=1，只抽静态帧。
- 不要求 pack manifest 提供 `thumbnails` 段；未来构建器输出 thumbnails 时可作为加速路径接入，但 gallery 必须能在无 thumbnails 的 pack 上工作。
- 不改动 LSP、pack schema、resolver 或预览渲染路径。
- 不做差分对比、放大查看、多选批量插入。

# Impact

- 生产 Web：新增 `editors/vscode-web/src/characterGalleryUi.ts`、`src/avifSequence.ts`（提取）；修改 `main.ts`（视图注册、命令接线）、`style.css`。
- 数据：只读消费 active pack manifest；不新增持久化 store，缩略图缓存为页面内存 LRU。
- 安全：pack 图片 URL 继续按 `packResourceUrl` 的同源 + pack root 前缀约束解析，不信任 manifest 中的任意绝对 URL。
- 既有合同：`ViewsService` + 原生 `SplitView` shell 拓扑不变，新视图复用 `registerCustomView` 既有扩展点（与本地历史同模式）。
- e2e：`e2e/fixtures/manifest.json` 增加一个 sticker set；新增双帧 AVIFS fixture；新增 gallery 场景测试。
