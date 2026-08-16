## Context

Standalone Workbench 以 `mmt.resourcePacks.manifestUrls` 直接配置 manifest。`synchronizePackSources` 负责 HTTPS/ETag/cache/LSP acceptance，`projectGalleryPack` 再把同一 manifest 投影给角色图鉴。Desktop extension 共享 manifest sync，但没有 gallery。

Publisher 将 active Catalog 写到 `<pack>/entity-catalog.json`，release Catalog 写到 `<pack>/releases/<manifest-digest>/entity-catalog.json`。Catalog 自身以 namespace、version 与 manifest 原始字节 SHA-256 绑定确定版本。

## Decisions

### Catalog 按 manifest 同目录发现

对每个已接受 source 使用 `new URL("entity-catalog.json", source.manifestUrl)`。不用 `pack.base_url`：release manifest 的资源 base_url 指向共享资产根，若据此发现 Catalog 会把 release manifest 错配到 active Catalog。

本变更不读取 `packs.json`。直接 manifest 配置没有可信的 `entity_catalog_digest` 输入；当前以 HTTPS、禁止 redirect、同源推导和 Catalog 的 manifest digest 绑定建立边界。未来实现 Pack Catalog discovery 时可叠加 Catalog 字节 digest。

### Workbench-only 严格边界

新增 `galleryEntityCatalog.ts`，手写 mirror `mmt-pack-entity-catalog.v1` 的 allowlist parser；未知字段、非法 locale/taxonomy key、重复集合、悬空引用和错误 `alternate_skin` 都拒绝整个 Catalog。Catalog entity 必须存在于同一 manifest，taxonomy 引用必须存在于 Catalog，alternate-skin 目标必须存在于同一 manifest。

Catalog 不加入 `PackManifestSource` 或 LSP wire。`main.ts` 在 manifest 已被 LSP 接受后为 gallery 并发加载可选 Catalog，最终仍一次性更新 `galleryPacks`。

### 验证后缓存，按 Pack 降级

复用 `IndexedDbPackCache` 的现有 URL-keyed active/staging/meta stores，不新增 object store。200 响应必须先 parse/bind，再 stage/promote/更新 ETag；304、网络/HTTP/validation failure 可读取 active cache，但缓存也必须重新绑定当前 manifest。没有有效 Catalog 时返回 manifest-only `GalleryPack`，不使 manifest sync 失败。

### 展示投影与解析语义分离

`projectGalleryPack(source, catalog?)` 只把 Catalog 投影为 display label、search terms、affiliation、alternate-skin links 和 provenance。主显示名优先 `names.display["zh-CN"]`，否则调用现有 manifest `galleryDisplayLabel`。其他 locale 只参与搜索和 title。

entity key、manifest `names[]`、sticker set、ordinal、storage 与 resource URL 不变。speaker resolve 和插入只使用这些 resolver-safe manifest 字段。

### 窄侧栏信息架构

列表使用 native `ul/li/button` 横向行：avatar、中文名、可用的学校/主要关系、差分总数。搜索独占一行并以 NFKC/大小写无关方式匹配 Catalog 全部语言名称与 aliases；折叠式 filter 始终提供基础/换装和差分数量筛选，Pack/学校/关系仅在数据可用时出现。单 Pack 且无 affiliation 时不重复显示 namespace。首批仍不超过 48 项，头像继续 lazy-load。Catalog provenance 放在紧凑 disclosure 中，外链仅由用户点击且只允许 HTTPS。

详情保存稳定 `{namespace, entityKey}`，而不是旧对象引用。顶部显示返回、名称、affiliation、set、其他装扮和插入目标；差分使用 native list/button 默认双列大图。极窄侧栏或高 zoom 可退为一列。

活动编辑器为 `mmtfs` + `mmt` 时显示相对路径与行列；否则显示“仅浏览”并原生禁用 variant button。命令执行时再次校验，防止竞态/直接调用。

### 缩放与可访问性

保留 Ctrl+滚轮、0.5×–3.0×、0.1 步长与 `mmt-gallery-zoom` localStorage；增加可见的减小/百分比/增大按钮，复用同一 `setZoom`。不再把 `role=listitem` 写在 button 上；使用真实 `ul/li` 和 button keyboard semantics，保留 focus-visible、img alt 和 disabled 状态。

## Risks and Mitigations

- **active manifest/Catalog 发布瞬间错位**：新响应绑定失败时尝试仍绑定当前 manifest 的 validated cache，否则 manifest fallback。
- **Catalog 元数据污染 resolver**：raw Catalog 不暴露给 UI 命令，不修改 `PackManifestSource`，插入断言锁定原字符串。
- **多 Pack taxonomy id 冲突**：filter option 由 Pack namespace + taxonomy id 定位；UI label 可相同但 value 不混淆。
- **大 Catalog 阻塞 UI**：每个 Pack 只 parse 一次，source 并发加载，UI 使用预计算 search terms 和 48 项分页。
- **侧栏过窄**：filter wrap、ellipsis、唯一 body scroll；差分 grid 响应式退为一列，不产生横向滚动。

## Verification

- `openspec validate redesign-character-gallery-entity-catalog --strict`
- strict parser/loader Node contract：schema、binding、URL、ETag/cache/fallback
- TypeScript `npm run check`
- Playwright：横向行、国服标签、alias/filter、双列大图、keyboard、MMT target/insert、非 MMT disabled、Catalog fallback、无 Kivo request、240/320 px 侧栏
- 完整 local E2E 与 production build
