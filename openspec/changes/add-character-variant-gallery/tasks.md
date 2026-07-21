# Tasks

## 1. 共享解码与数据入口

- [x] 1.1 将 `main.ts` 的 `decodeAvifSequence`/`AvifWorkerResponse` 提取到 `src/avifSequence.ts`，preview materialize 路径改为从该模块导入，行为与 worker 协议不变
  - 实施中修复两个共享路径既有缺陷：`completeFramesOnly: true` 导致非关键帧必败（改为 `false`）；worker transfer 会 neuter 调用方 buffer（解码前复制）
- [x] 1.2 定义 gallery 的 pack 数据入口：active manifest 读取、实体列表投影（avatar item、sticker sets、ordinal/frame）、pack root URL 拼接与 sanitize（`src/galleryPack.ts`）
- [x] 1.3 实现 AVIFS blob LRU（≤5 set）与缩略图 Blob URL LRU（≤256，逐出 revoke），含并发 2 的解码队列与 `AbortController` 中止

## 2. 角色图鉴视图

- [x] 2.1 新增 `src/characterGalleryUi.ts` 并在 `main.ts` 注册 `momoscript.characterGallery` 视图（图标、Sidebar、`canMoveView: false`）
- [x] 2.2 实现实体级：搜索框、48 首屏 + `IntersectionObserver` 分页、头像懒加载、display_name 排序、空 pack/无实体空态
- [x] 2.3 实现差分级：返回导航、set 选择器、`#ordinal` 网格、抽帧缩略图、失败占位与重试
- [x] 2.4 实现视图隐藏/导航时中止在途解码与 fetch，补齐 `style.css` 样式

## 3. 插入命令

- [x] 3.1 注册 `mmt.gallery.insertSticker(entityName, ordinal)`：mmt 编辑器校验、光标/选区插入 `[:name,#n:]`、保持编辑器焦点
- [x] 3.2 差分格点击接入命令；非 mmt 编辑器显示警告且不改动文档
  - 注意：当前 workbench 布局不渲染通知 toast（既有平台缺口，历史视图/PWA 更新提示同样不可见），警告通过 `showWarningMessage` 发出；行为合同以不修改文档为准

## 4. 验证

- [x] 4.1 fixture manifest 为 `透明测试` 增加 2 变体 sticker set，复用 `mmt_rs` 的 alpha-sequence.avifs（205 KB）并接入 e2e 路由
- [x] 4.2 新增 e2e：实体列表/搜索 → 差分网格与缩略图解码 → 点击插入 → 非 mmt 编辑器不修改文档（local 用 fixture，remote 打真实 pack）
- [x] 4.3 `npm run check`、`npm run build`、editor 全量 e2e（local/chrome/remote，12 项）与 PWA 离线回归通过
  - 注：e2e 中搜索输入通过 evaluate 赋值 + 派发 input 事件驱动；remote 项目在 pack 同步完成窗口内 Playwright 键盘输入会被 workbench 焦点恢复抢走（fill/pressSequentially 均无法到达 input），属测试机制规避，不影响真实使用

## 5. 交互增强与资源包数据修正（2026-07-21 追加）

- [x] 5.1 图鉴滚动容器改用 VS Code 主题变量细滑块样式（含本地历史列表）
- [x] 5.2 Ctrl+滚轮缩放（0.5×–3.0×，CSS 变量驱动，localStorage 持久化）
- [x] 5.3 `galleryDisplayLabel`：括号形式优先 → 下划线推导 → 精确匹配 → `names[0]` 回退（兼容联动角色被截断的 display_name）
- [x] 5.4 编辑器右键“插入角色表情差分”：行内 speaker → 实体精确匹配 → `@actor` preset 映射；命中跳差分级，否则跳图鉴主界面（`galleryRevealed` 事件驱动 + 未渲染视图 pending 消费）
- [x] 5.5 非默认 set 插入携带 set id：`[:entity,set/#n:]`；default set 省略（修复妃咲幼儿园差分落回 default 的缺陷）
- [x] 5.6 构建器：`白子*恐怖` 等 alter 名称归一化为 `白子_恐怖`（key/存储路径）+ `白子（恐怖）`（names/display），`*` 等 URL 不安全字符统一替换；联动角色 `display_name` 改为全名（初音未来/御坂美琴/食蜂操祈/佐天泪子）；默认排除 `(CBT)`/`（CBT）` 标记实体（6 个），`--exclude-entity-marker` 可调
- [x] 5.7 资源包全量重建并发布：322 实体，`2026.07.21`；白子_恐怖头像与差分 CDN 200 可达；浏览器验收白子（恐怖）10 差分全解码、初音未来全名显示、CBT 实体不再出现
- [x] 5.8 e2e：多 set 插入断言（kindergarten）、右键差分入口双路径、菜单激活固定键序（shadow DOM 内焦点断言不可靠，只断言可见性与结果）；大测试路由补 AVIFS fixture
