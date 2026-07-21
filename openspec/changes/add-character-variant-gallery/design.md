# add-character-variant-gallery 设计

## 视图与导航

新增 `registerCustomView({ id: "momoscript.characterGallery", name: "角色图鉴", location: Sidebar, canMoveView: false })`，与 `momoscript.localHistory` 同模式。视图内部两级：

1. **实体级**：搜索框 + 实体网格。网格单元为头像（avatar slot 的 default item）+ `display_name`。搜索对 `names[]` 与 `display_name` 做子串过滤，大小写不敏感，即时生效。
2. **差分级**：选中实体后进入。顶部为返回按钮、实体名、set 选择器（`sticker.sets` 的 `display_name`，多 set 时可见）；下方为差分网格，每格标注 `#ordinal`。

导航状态只保存在视图实例内（选中实体、选中 set、搜索词），不持久化；视图重新渲染时从实体级开始。

## 数据来源

- manifest：读取 packSync 的 active manifest（`IndexedDbPackCache` ACTIVE 记录 + 当前配置的 manifest URL），与 MomoScript 项目视图共用同一份数据；manifest 更新或 URL 变更时视图整体刷新。gallery 不自行发起 pack 版本协商。
- 实体列表：`manifest.entities`，按 `display_name` 排序。
- 实体头像：`entity.slots.avatar.items[entity.slots.avatar.default]`，经其 `storage` 指向的 `image-dir` backend 拼出 `packRoot + base + path`。
- 差分元数据：`entity.slots.sticker.sets`，变体为 `variants[{ id, ordinal, frame }]`，`#n` 取 `ordinal`。

pack 未配置、未加载或无 sticker 实体时，视图显示对应空态并引导到 MomoScript 项目视图配置 manifest；不把空 pack 渲染成错误。

## 图片管线

```
实体头像:  image-dir backend → PNG URL → <img loading="lazy">
差分缩略图: image-sequence backend → AVIFS blob(每 set 一次) → decodeAvifSequence(frame) → PNG bytes → Blob URL
```

- **共享解码模块**：把 `main.ts` 的 `decodeAvifSequence` 与 `AvifWorkerResponse` 提取到 `src/avifSequence.ts`；preview 的资源 materialize 路径与 gallery 共用。worker 协议、sha256 校验、frame 边界检查不变。
- **URL 安全**：所有 pack 资源 URL 必须满足 `packResourceUrl` 的既有约束——HTTPS、与 pack root 同源、路径在 pack root 前缀内；`storage.path`/`base` 只做拼接不做语义信任。
- **AVIFS blob 缓存**：按 `storage` key 缓存整个 AVIFS 字节（manifest 自带 sha256），内存 LRU 上限 5 个 set；解码不同 frame 不重复下载。
- **缩略图缓存**：按 `entity/set/ordinal` 缓存 `Blob` object URL，LRU 上限 256，逐出时 `revokeObjectURL`。
- **限流与中止**：解码队列并发 2；实体切换、set 切换、搜索过滤、视图隐藏（`onDidChangeVisibility` 或 render dispose）时 `AbortController` 中止全部在途解码与 fetch。

## 性能预算

- 实体级首屏只渲染前 48 个网格单元，其余用 `IntersectionObserver` 分页挂载；头像 `<img loading="lazy">`，浏览器自行限流。
- 差分级打开一个实体才开始下载对应 AVIFS；单 set 字节约 1–3 MiB（与预览一致），5-set LRU 上限约 15 MiB 内存。
- 视图隐藏时不持有解码中的 worker 与未完成的 fetch。

## 插入合同

命令 `mmt.gallery.insertSticker(entityName: string, ordinal: number)`：

1. 活动编辑器必须是 `mmtfs` scheme 的 mmt 文档，否则警告“请先打开一个 MMT 文档”；
2. 在光标/选区处插入 `[:entityName,#ordinal:]`（实体限定形式在任何语句位置都合法；裸 `#n` 依赖 speaker 上下文，v1 不生成）；
3. 插入后保持编辑器焦点，不移动视图。

差分网格单元点击即调用该命令；右键不提供额外面目（v1）。

## 编辑器右键入口与 speaker 解析

命令 `mmt.gallery.insertStickerAtCursor`（菜单“插入角色表情差分”，`editor/context`，限 `mmtfs` + mmt 文档）：

1. 从光标所在行解析 message speaker（`>`/`<` 前缀 + 冒号）；
2. 解析顺序：实体 key/names 精确匹配 → 文档内 `@actor` 块的 `preset: <ns>::<entity>` 映射；
3. 命中则经 `galleryRevealed` 事件跳到该实体差分级，未命中或行内无 speaker 则跳到图鉴主界面；事件驱动对已渲染视图即时生效，未渲染视图经 pending 状态在首次渲染时消费。

speaker 解析是启发式（行模式 + `@actor` 文本扫描），不依赖 LSP 语义；v1 可接受。

## 显示与缩放

- 显示名 `galleryDisplayLabel`：优先 names 中已有括号形式（`艾米(武装)`），否则下划线形式推导（`星野_泳装` → `星野（泳装）`），否则精确匹配 `display_name`，最后回退 `names[0]`（兼容当前 pack 中联动角色被截断的 display_name，如 `未来` → `初音未来`）。
- Ctrl+滚轮缩放图鉴网格：0.5×–3.0×、步进 0.1，CSS 变量驱动列宽/图像/字号，持久化 `localStorage`；`preventDefault` 拦截浏览器缩放。
- 滚动容器使用 VS Code 主题变量（`--vscode-scrollbarSlider-*`）细滑块样式。

## 错误与降级

- AVIFS 下载/解码失败：该 set 网格显示错误占位与重试按钮，不影响其他实体。
- 头像 404：占位图标（实体名首字），不阻断插入流程（差分浏览不依赖头像）。
- manifest 解析失败：视图显示错误条并保留上一次有效数据（若有）。

## 测试

- fixture：`e2e/fixtures/manifest.json` 的 `晴_露营` 实体增加一个 sticker set（2 个变体），新增双帧 AVIFS fixture（用现有构建工具链生成，≤ 50 KB），fixture 路由按 storage path 提供字节。
- e2e 场景（editor.spec 风格）：
  1. 打开角色图鉴 → 实体网格出现 `晴_露营`；搜索过滤生效；
  2. 进入实体 → 两个差分格标注 `#1`/`#2`，缩略图 `<img>` 解码成功（`naturalWidth > 0`）；
  3. 点击 `#2` → 活动编辑器光标处插入 `[:晴_露营,#2:]`；
  4. 非 mmt 编辑器（intro.typ）下点击 → 警告且不改动文档。
- 缓存合同由实现内单元式断言（LRU 上限、revoke 调用）覆盖，不做浏览器级配额测试。

## 与既有 change 的关系

- `design-resource-pack-v3`：gallery 消费其 manifest schema（entities/slots/sets/storage），不扩展 schema；未来 `thumbnails` 段可作为缩略图加速路径，但不是依赖。
- `add-pwa-offline-runtime`：gallery 图片不进 shell precache；pack 字节缓存沿用页面内存策略，离线可用性由 pack installation 语义另行决定，v1 不声明离线合同。
- `web-workbench-shell` spec：shell 拓扑不变，仅新增一个 custom view，符合 ViewsService 扩展点既有用法。
