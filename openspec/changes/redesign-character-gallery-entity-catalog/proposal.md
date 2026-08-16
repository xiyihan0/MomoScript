## Why

现有角色图鉴只消费 pack manifest 中为 resolver 服务的 `display_name`/`names[]`，因此无法展示已发布 `mmt-pack-entity-catalog.v1` 中的国服中文名、搜索别名、学校/关系和换装关系；方形实体网格也不适合窄侧栏，差分缩略图过小且用户看不到当前插入目标。

Entity Catalog 已由 `design-resource-pack-v3` 定义并随 active/release manifest 同目录发布，但 Workbench 尚未消费。展示层需要接入该可选元数据，同时严格保持 manifest 是解析、资源路径和插入 key 的唯一事实源。

## What Changes

- Workbench 对每个已接受的 manifest 读取同目录 `entity-catalog.json`，严格校验 schema、namespace、version 与 manifest SHA-256；复用现有 URL-keyed IndexedDB pack cache。
- Catalog 缺失、损坏、陈旧或绑定不匹配时，只让对应 Pack 回退到 manifest-only 图鉴，不影响 LSP、resolver、preview、export 或其他 Pack。
- 角色主列表改为横向元数据行；国服 `zh-CN` 名称优先，搜索覆盖 Catalog 全部语言名称/aliases/affiliation；筛选改为类似资料站的默认展开分组表单，低基数条件使用切换按钮，高基数 Pack/学校/关系使用带标签选择框。
- 角色详情改为默认双列大差分图，显示学校/关系、其他装扮跳转、数据来源和明确的插入目标。
- 非 MMT 编辑器仍可浏览，但差分按钮禁用；插入命令本身继续执行权限检查，插入文本保持不变。
- 保留现有 AVIFS 解码/LRU/abort、分页、缩放、ViewsService shell 和单一 `galleryPacks` 状态源。

## Impact

- Formal spec delta：`character-gallery`
- 依赖：`design-resource-pack-v3` 的 `mmt-pack-entity-catalog.v1` schema 与发布绑定合同；`add-pack-release-catalog` 的同目录 active/release 发布布局
- 主实现：`editors/vscode-web/src/galleryEntityCatalog.ts`、`galleryPack.ts`、`characterGalleryUi.ts`、`style.css`、`main.ts`
- 验证：严格 parser/loader Node 合同测试、Playwright 角色图鉴回归、TypeScript check、Workbench build
- 不影响：`editors/vscode/src/packSync.ts` public contract、Desktop extension、Rust PackRegistry、MMT LSP、materializer、Typst projection/render/export

## Non-Goals

- 不实现 `packs.json` discovery 或新增 Pack catalog 设置。
- 不改变 manifest schema、resolver names、speaker matching、资源路径或插入 selector。
- 不在运行时请求 Kivo API，不从 Catalog 读取图片或资源 URL。
- v1 不合并 alternate skin entity，只提供交叉导航。
