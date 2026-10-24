# MomoScript VS Code Web Workbench

本目录是独立运行的浏览器编辑器，不是普通 Monaco 页面。它组合了 VS Code Workbench、Web Extension Host、MMT LSP WASM Worker、Tinymist WASM Worker、Typst compiler/renderer、IndexedDB workspace 和浏览器端资源 materializer。

编辑器跨包架构、运行形态与验证入口见 [编辑器系统指南](../README.md)。

本文是维护 runbook：记录已验证的开发流程和高风险故障模式。shell 拓扑、所有权、生命周期和迁移门槛的规范性合同是：

- [`openspec/specs/web-workbench-shell/spec.md`](../../openspec/specs/web-workbench-shell/spec.md)

相关能力继续由各自 OpenSpec capability 负责，本 README 不复制其易变实现细节。维护时按 capability ID 查阅当前稳定规格或 active change：

- `editor-runtime-coordination`：单一产品 runtime、project/revision 与 dispose 合同；
- `language-tooling`：MMT/Tinymist 编辑器能力；
- `pwa-runtime`：PWA 目标合同与当前实施证据。

## Current Behavior

当前实现已经具备：

- 原生 VS Code Activity Bar、Explorer、Sidebar、Editor、Panel 和 Status Bar parts；
- 通过 `registerCustomView` 注册的 MomoScript 原生 View；
- IndexedDB workspace 和文档持久化；
- 本地历史 Activity View：按文件/工作区分页浏览、50 MiB / 30 天保留、named Checkpoint、文本 Diff/恢复、删除前检查与二进制导出/整文件恢复；
- 原生 `mmt.guiComposer` Editor Pane：新作品默认进入 SVG 聊天创作；聊天、可直接编辑的排版预览与原生源码共享同一份 MMT、撤销历史和资源。恢复的源码工作区不会因手机宽度被强制改成 GUI；
- 单个 retained `IOverlayWebview`：活动的聊天、排版或源码旁预览声明挂载位置，共享 renderer session、artifact store 与 webview context；只有获得 Rust Composer 授权的 MMT 可以编辑，普通 Typst、生成物与包资源保持原来源权限；
- MMT LSP 与 Tinymist 独立 Worker；
- revision-bound Typst projection、preview artifact、精确文字几何和预览交互；
- workspace 图片、pack-v3 图片及 AVIFS materialization；
- embedded Typst grammar、completion、hover 和 diagnostics；
- 可取消的实时渲染与受限内存资源缓存；
- Web App Manifest、安装 metadata，以及 production build 生成并注册的根 `/sw.js`；
- content-addressed、同源的 Tinymist/Typst compiler/MainFont Brotli 制品、随 bundle 固定的解码器 Worker 与 Service Worker precache；客户端运行时不再请求外部 WASM/font CDN；

当前仍不具备：

- `add-pwa-offline-runtime` 规划的显式、逐项校验并可回滚的 offline shell installer；
- 完整资源包离线安装、持久 pack asset cache、pack 原子升级/回滚和空间管理；
- offline-ready、browser-installed、staging、probation 等完整状态面板；
- 多 shell revision 的 client handshake、probation 和回滚；
- sash 大小的 reload 持久化；
- Monaco `WorkspaceService` 对完整 Workbench shell/layout 的接管。

`IndexedDbPackCache` 当前只持久化 manifest/ETag；`BoundedStringCache` 是页面内 32 MiB 内存 LRU，不能视为离线资源缓存。当前 `/sw.js` 的 install-time precache 也不等同于 active PWA spec 中显式 reservation、artifact verification、probation 与 rollback 均完成的 offline shell。

`npm run dev` / `npm run build` 的 lifecycle 会运行 `scripts/prepare-runtime-artifacts.mjs`：从 `runtimeArtifacts.ts` 的 build-only source catalog 取得固定 Brotli 对象，逐项校验压缩 SHA-256/长度、解压 SHA-256/长度后写入被忽略的 `public/runtime/`。浏览器只请求 content-addressed `*.brotli.bin` 同源路径；该后缀故意不以 `.br` 结尾，防止静态服务器误加 `Content-Encoding: br`。`test:runtime-delivery` 覆盖 catalog、生成文件、解码器 pin 与协议 allowlist。

### GUI 连续创作与局部编辑

新建作品只填写作品名，自动生成不覆盖已有文件的 `.mmt` 名称。进入聊天或排版时，原生导航、标签栏和文件路径临时收起；返回源码恢复原状态，不改持久化偏好。Workbench 主题作用于界面控件；聊天 SVG 使用自己的浅色对话皮肤，排版成品不随界面主题改变。

| 模式 | 用途与入口 |
|---|---|
| 聊天创作 | 默认写作界面；可读尺度的 SVG 画布、底部固定输入、最近角色与按需角色库，不显示纸张和缩放工具条 |
| 排版预览 | 检查真实成品、页码、缩放与 Fit width；仍可在 SVG 正文中编辑 |
| 源码 | 原生 Monaco、工作区、诊断及高级能力；桌面可与单个 SVG 分屏，手机全屏切换 |

- 在角色库按人物、形态、表情逐级选择；只有一种可选项时直接前进。本作和最近角色优先，仍可按多语言姓名、别名、学校或组织搜索。Kivo 条目 ID 标识形态，人物归组使用已验证的 `alternate_skin` 关系；缺少或无效 Catalog 时保留可辨认的独立条目，不按名字猜归属。
- 底部输入用于下一条消息；Enter 发送，Shift+Enter 换行。发送成功只清空正文，人物与表情保留；“老师”仅在 Rust 插入能力允许时可用。显式“在此插入”显示相邻内容，使用“返回末尾”退出；边界失效时保留草稿，要求重新选择。
- 点击 SVG 正文原位编辑，不把旧气泡复制到底部草稿。双击选择词，三击选择整段；选中文字后可使用原生剪切、复制、粘贴、删除和全选。选中整条内容后优先提供编辑、插入、移动和删除。
- “更多”打开说话人、头像、左右、显示名及高级属性。名字与头像明确从本条起影响后续该角色；老师不能改为左侧，跨不透明屏障的移动由 Rust 禁用。宽度至少 960px 时，属性使用分配空间的侧栏，旁边的 SVG 可阅读、滚动，关闭属性后继续原位编辑；窄桌面和手机仍使用互斥模态面板。局部编辑器中 Enter 换行、Ctrl/Cmd+Enter 应用、Escape 取消。
- “+ 添加”提供消息、旁白、图片和角色差分。新本地图片只接收解码成功且不超过 8 MiB 的 PNG/JPEG，写入作品目录下的 `assets/<uuid>`，再由 Rust 原子生成资源声明和消息；原生源码画廊仍支持原来的行内／选区插入。
- 作品名菜单保留新建、打开、保存、撤销/重做、本地历史和高级工作区；“下载源文件”下载当前 MMT，与“导出作品”分开。没有恢复中的作品时，首次进入现有 `story` 聊天创作，不展示 Typst 源码。
- 切换模式等待正在合成的输入法文字和已接受编辑排空，不自动发送草稿或保存。未发送草稿按文档保留在内存，不写入 MMT、历史或导出，也不承诺刷新后恢复。
- 手机源码中的“打开预览”对工作区 MMT 使用同一个排版模式全屏切换，不让文件树挤占产品画布。自动打开预览的偏好不会夺走显式或恢复的手机源码页面；桌面原有分屏与普通 Typst 的只读预览权限不变。
- 被拒绝的输入留在“未提交文字恢复”。即使当前快照暂时不可用，仍可查看、复制或丢弃；重新在 SVG 选择目标并明确确认后才能重试。确认仅绑定本次准备的具体目标，已关闭确认框的延迟事件不能消费另一个目标；重试失败不清空恢复文字，也不自动转投其他消息。
- 手机辅助面板互斥，支持关闭、Escape 和焦点恢复；320px、390px 与软键盘收缩视口的自动化不等于真实移动设备或系统输入法验收。

### 功能迁移清单

| 原有能力 | 当前入口 |
|---|---|
| 文件树、搜索、诊断、原生设置、工作区 | 源码模式；作品菜单“高级工作区” |
| 保存、本地历史、撤销／重做 | 作品菜单及原生快捷键；保存状态仍来自实际文档／文件写入 |
| 人物、形态、表情、跨人物换头像 | 角色库与消息属性；不改原实体／差分引用 |
| 连续输入、旁白、图片、差分 | 聊天底栏与“+ 添加” |
| 原位正文、跨消息选择、剪贴板 | 聊天与排版中的同一个 SVG 输入会话 |
| 插入、移动、删除 | 选中内容后的就近操作 |
| 说话人、头像、显示名、左右、连续消息、正文模式 | “更多”属性与高级区域 |
| Source Lens、不透明块、复杂 Typst、自定义角色／资源 | “局部源码”及源码模式；不伪造 GUI 自定义头像写入 |
| 缩放、Fit width、页导航 | 排版预览；聊天固定阅读尺度 |
| 标题、作者、页眉、时间 | 排版设置中的现有文档设置流程 |
| 页面尺寸、字体资源 | 排版设置中的只读产物／已加载资源信息；不是新增页宽或字体配置 |
| PDF、PNG、JPG、SVG | 顶栏“导出作品”；原生“高级：导出已接受排版快照”保留明确的快照语义 |
| 当前规范源码下载 | 作品菜单／原生命令“下载源文件”；不保存工作区、不包含未发送草稿 |
| 普通 Typst、生成视图、包资源 | 原有预览与源码导航权限；不能因此取得 MMT 编辑授权 |

### 导出成品

点击“导出作品”会排空已接受编辑，自动进入排版并等待 output 制品；不自动发送底栏草稿，也不隐式保存。PDF 默认导出整份文档；已有有效 `mmt.export.defaultFormat` 偏好仍可覆盖初始格式。PNG／JPG／SVG 明确选择一页，栅格图显示真实 2× 像素尺寸，JPG 使用白底与 0.92 质量。选择格式不改写持久化设置。

生成、等待、取消、失败和完成使用同一个导出状态机；完成状态在下载交付成功后显示实际文件名和页范围。旧排版只能通过明确的快照选项导出，聊天制品不能冒充成品。正在合成的输入先完成事务；高级快照导出仍可明确排除尚未提交的输入。排版设置显示的“已加载字体资源”不是逐字统计的本文使用字体清单。


## Architecture Boundaries

### Embedded Workbench model

当前 Monaco wrapper 使用 `viewsConfig.$type: "ViewsService"`，不是 `WorkspaceService`：

1. `createLayout` 创建固定拓扑：root 下是 `body`、Status、product Preview；`body` 内是 Activity 与 `primary`；`primary` 内是 Sidebar 与 `main`；`main` 内是 Editor 与 Panel；
2. Activity 位于 shell body 左侧，Sidebar/main 由原生水平 `SplitView` 分隔；
3. main 内部再用原生垂直 `SplitView` 分隔 Editor/Panel；
4. `viewsInitFunc` 用 `attachPart` 把 Activity Bar、Sidebar、Editor、Panel Part 交给各 host，Status Bar 由 `renderStatusBarPart` 挂载；每个 attachment/renderer disposable 都必须注册给同一个 runtime owner；
5. Views Service 是 Part 实例、容器选择和可见性的权威；两个 `SplitView` 是对应 host 几何和原生 sash 的权威；
6. CSS 只负责外层固定区域和视觉样式，不能拥有 Sidebar/Panel 尺寸或可见性，也不能增加手写 sash。

当前 sash 尺寸只存在于本次页面生命周期；reload 会重新使用 `createLayout` 的初始尺寸。不要把文档持久化或 Part 可见性行为误写成 sash-size 持久化。

### State owners

```text
VS Code TextDocument / mmtfs workspace / native model history
  -> MMT LSP revision snapshot
  -> Rust mmt/composerDocument + text selection/projection/edit authorization
  -> one ComposerRuntime + ComposerTextSession for the active authored surface
  -> native mmt.guiComposer / authorized MMT preview mount
  -> Rust output or temporary chat render preset / projection identity
  -> workspace/pack resource materialization
  -> accepted render artifact + exact renderer geometry
  -> one retained overlay claimed by the active native mount
```

| 状态 | 权威来源 |
|---|---|
| Part 实例、当前 View container、Part 可见性 | Monaco VS Code Views Service / Part API；Part attachment disposable 进入产品 runtime owner |
| Sidebar/main、Editor/Panel 几何与 sash | `createLayout` 创建的两个原生 `SplitView` |
| 当前 authored 文档内容与原生 undo/redo | 同一个 VS Code `TextDocument` / `IModelService` model；`ComposerDocumentOwner` 持有原生 model reference，避免关闭源码 Pane 后模型失效；正文 edit 只把 Rust 返回的 versioned edits 交给 `pushEditOperations`，以 `pushStackElement` 建立原生 undo group，不建立 GUI 历史栈 |
| GUI 正文、selection 与编辑授权 | Rust `mmt/composerDocument` 的 `textEditing`、`mmt/composerTextSelection`、`mmt/composerTextProjection` 和 `mmt/composerEdit`/`replaceTextSelection`；endpoint 是 LF-normalized semantic body 的 UTF-16 offset，`ComposerTextSession` 只串行化 intent 与保存 presentation bookmark |
| GUI property/structure 编辑授权 | 同一 VS Code `TextDocument` + Rust snapshot/capability；`ComposerRuntime` 编排 freshness/cancellation，UI 不缓存第二份源码或拼 DSL |
| GUI text recovery | `ComposerTextSession` 在 stale/conflict、apply failure、composition cancel/失焦或关闭边界保留未提交文字；恢复内容本身不带修改权限，只有重新选择目标并确认后，才能通过当前身份绑定的同一 FIFO 请求 Rust 授权重试 |
| GUI tab 恢复与首屏顺序 | `ComposerEditorInputSerializer` 只持久化 `{version: 1, uri}`；先等待 native editor groups `whenRestored`，保留原生源码/分屏恢复，无恢复输入时进入已有 `story` 聊天作品；从当前 `TextDocument` 和 Rust snapshot 重建，不持久化 selection、旧 node key 或 IME 草稿 |
| authored 文档持久字节 | `mmtfs` workspace provider/coordinator |
| IndexedDB 历史 revision/head/snapshot、SHA-256 blob、保留与 Checkpoint | workspace backend/coordinator；Local History View 仅按游标读取和发命令 |
| 产品 startup、work admission、quiesce、dispose | 单一 `EditorRuntimeController` 及其单一 `RuntimeOwner` |
| projection/materialization、已接受 preview revision/artifact | `EditorRuntimeController` 拥有的 typed stores / `PreviewArtifactStore` |
| Preview webview 与 native mount | 一个 runtime-owned `PreviewWebviewHost` / retained `IOverlayWebview`；活动聊天、可编辑 MMT 排版或只读资源预览是 claimant，旧 claimant 的 release 不得释放新 claimant，只有产品 runtime dispose 销毁 overlay |
| GUI caret/selection geometry | `ComposerTextGeometry` 将 committed renderer 的 `hitTestText`/`locateCaret`/`locateRange` 与 Rust projection round trip 绑定到 source/version/digest/renderKey/session/generation；unmapped/ambiguous 即 unavailable，不回退到 statement midpoint 或平均字宽 |
| PWA registration、waiting worker 与 activation/reload | `registerPwaUpdateLifecycle`；安全重启只通过 adapter 调用同一个 runtime，且 durable flush 包含文档、workspace coordinator 与 `IStorageService` |
| MMT 分析 | MMT LSP versioned snapshot |
| Typst 虚拟项目 | projection session + revision |
| Pack manifest URL 选择、用户配置 | VS Code configuration service |
| Pack manifest 持久副本/ETag | IndexedDB cache（仅持久缓存） |
| 已接受的 Pack 语义与 revision | MMT LSP monotonic `pack_revision` / `PackRegistry` |

UI class、label 和 control 可以镜像权威状态，不能建立第二套 boolean、document buffer、revision map、artifact selection、persistence queue 或 disposal graph。

首次 preview surface 同步等待初始 Pack 同步尝试结束，包括经校验的 empty-registry fallback；两条路径都失败时沿既有通知报告错误，仍允许画布挂载，不建立另一套重试或恢复 owner。GUI open/pin 完成后 flush 同一个 `IStorageService`；safe restart 在 quiesce 的 durable-flush 阶段、activation/reload 前执行同样的 flush。Native editor groups 恢复完成后才决定 workspace/intro fallback，避免覆盖已恢复的 GUI。聊天宽度与 output 使用独立投影/制品身份，视口按 URI 和呈现隔离；语言投影的单调 revision 域不能被同版本的临时渲染内容覆盖。

画布已打开后，其当前项目的已诊断编译失败属于预览错误，不把已初始化的语言服务或整个启动器标成失败。保留真实失败画面、作品和未提交输入，允许进入源码修复或新建作品；取消、过期请求与其他初始化异常仍走原错误边界。失败画面的输入捕获可保留恢复文字，但没有当前渲染授权就不能写入正文。


### Why this is not WorkspaceService

`WorkspaceService` 会接管完整 Workbench shell/layout 行为；当前产品只需要固定 host 加 attached Parts，因此保留 `ViewsService` + nested `SplitView`。当需求依赖完整 Workbench region、跨完整 shell 的 layout command，或 sash/layout reload 恢复时，必须先提交独立 OpenSpec migration proposal，并一次性移除被替代的 SplitView geometry owner，不能让两套 layout 同步。

即使未来采用 `WorkspaceService`，它也只替换 shell/layout ownership；MomoScript 的 document persistence、projection/preview state、Worker、quiesce 和 dispose 仍由 `EditorRuntimeController` / `RuntimeOwner` 负责。

## Pitfall Runbook

### 1. 仿造 Workbench 控件

**症状**

- MomoScript Sidebar 与 Explorer/Tinymist 风格明显不同；
- 主题、焦点、hover、toolbar 和键盘行为不一致；
- Activity 项使用自定义 `button`/`aria-pressed`，而原生项是 `tab`/`aria-selected`；
- CSS 折叠状态与 Workbench 内部状态分离。

**根因**

使用手写 Activity Bar 和 Sidebar sibling 模仿 VS Code，而不是使用 Workbench Views Service。

**正确模式**

- 用 `attachPart` 挂载 `Parts.ACTIVITYBAR_PART`、`Parts.SIDEBAR_PART`、`Parts.EDITOR_PART` 和 `Parts.PANEL_PART`；
- 用 `registerCustomView` 注册 MomoScript View；
- 使用 VS Code theme variables，不硬编码一套相似颜色；
- 如果需求属于 Activity Bar、Sidebar、Panel、Explorer 或 Settings，优先找原生 service/view API。

**回归测试**

- Activity Bar 中 Explorer/MomoScript 的 role 为 `tab`；
- MomoScript View 的原生 heading、输入框和 actions 可见；
- 切换后实际内容改变，而不只是自定义 class 改变。

### 2. 在 `api.start()` 前访问 Workbench Part

**症状**

- `Part not found`；
- 启动时偶发失败；
- visibility listener 无法注册。

**根因**

`attachPart` 由 `viewsConfig.$type: "ViewsService"` 的初始化回调完成；`isPartVisibile`、`onPartVisibilityChange` 等 API 在 `api.start()` 前没有可用 Part。

**正确模式**

```ts
await api.start();

const visible = isPartVisibile(Parts.SIDEBAR_PART);
layout.setSidebarVisible(visible);
root.classList.toggle("sidebar-collapsed", !visible);

const registration = onPartVisibilityChange(
  Parts.SIDEBAR_PART,
  visible => {
    layout.setSidebarVisible(visible);
    root.classList.toggle("sidebar-collapsed", !visible);
  }
);
```

先把当前 Part 状态同步给 owning `SplitView`，再注册后续事件。仅切 class 或仅注册不会回放初始状态的 listener 都不够。Panel 遵守同一规则。

**回归测试**

- 首次加载时 Sidebar Part 状态与水平 `SplitView` host 一致；
- Views Service 报告 Sidebar 隐藏时不留下空白栏；
- Panel 的初始隐藏和后续 Output toggle 都同步到垂直 `SplitView`；
- 启动日志中没有 `Part not found`。

### 3. 把 CSS 或 DOM 当成布局 owner

**症状**

- Sidebar/Panel 看似折叠但仍占用 sash 空间或仍可聚焦；
- `isPartVisibile` 与页面视觉状态矛盾；
- resize 后 Part host 和内容尺寸分离；
- 后续 Activity 切换出现空白 View；
- 出现原生 sash 之外的第二个拖动手柄。

**根因**

直接改 class、width/height 或 DOM，而没有通过 Views Service 改 Part 状态并由 owning `SplitView` 更新 geometry。

**正确模式**

- 当前已选中的 Activity tab 再次点击时，阻止会销毁/隐藏当前 View descriptor 的原生路径，只调用 `setPartVisibility(Parts.SIDEBAR_PART, nextVisible)`；
- 未选中的 Activity tab 继续交给原生 Views Service 切换容器；
- `onPartVisibilityChange` 把 Sidebar/Panel 状态镜像到对应 `SplitView.setViewVisible`；
- resize 只由两个原生 `SplitView` 和其 sash 处理；
- class 只作样式/诊断镜像，不参与布局决策。

**回归测试**

- Explorer 点击一次折叠，同一 Explorer 再点一次恢复；
- 隐藏的 Sidebar/Panel 不占 geometry，恢复后真实内容仍存在；
- 原生 sash 可调整 Sidebar 与 Panel，resize 后 Part 内容随 host layout；
- reload 后文档继续持久，但测试不得宣称 sash 尺寸被恢复；
- 再折叠并切换 MomoScript 时 Sidebar 展开且设置内容存在。

### 4. 错误处理原生 Explorer descriptor

**症状**

Sidebar 标题显示 Explorer，但正文变成：

```text
Drag a view here to display.
```

**根因**

自定义点击逻辑触发了原生容器关闭/重开，却没有保留 Files Explorer view descriptor。仅恢复外层宽度或标题无法修复内容。

**正确模式**

- 当前选中 tab 的“折叠”只切换 Part visibility；
- 不注销、不移动、不重建 Explorer View；
- Explorer/MomoScript 的真正切换交给原生 Views Service。

**回归测试**

必须断言：

```ts
await expect(page.getByRole("tree", { name: "Files Explorer" })).toBeVisible();
```

只断言 Explorer 标题、Activity 图标或 CSS class 都不够。

### 5. 沿用手写控件的 Playwright locator

**症状**

- `getByRole("button", { name: "Explorer" })` 找不到控件；
- 模糊名称同时匹配 Explorer、Refresh Explorer、Collapse Folders in Explorer；
- 测试仍断言 `aria-pressed`，原生控件实际使用 `aria-selected`。

**根因**

UI 已切换为原生 Workbench，但 E2E 沿用了手写 DOM 的可访问语义。

**正确模式**

先读取 accessibility tree，再按原生语义定位：

```ts
const explorer = page.getByRole("tab", { name: /^Explorer/ });
const mms = page.getByRole("tab", { name: "MomoScript", exact: true });
await expect(explorer).toHaveAttribute("aria-selected", "true");
```

**回归测试**

E2E 同时覆盖：折叠、恢复、视图切换、真实 View 内容，以及 reload 后的文档/Part 行为；不得从 reload 成功推断 sash-size 持久化。

### 6. Worker 在 WASM boot 前接收 LSP initialize

**症状**

- 首次启动偶发卡死；
- LanguageClient 已发送 `initialize`，Worker 尚未准备；
- 页面只显示编辑器但没有 diagnostics/completion。

**根因**

在 WASM 初始化完成前安装/启动 JSON-RPC transport。

**正确模式**

```text
host -> mmt/boot { wasmUri }
worker -> mmt/workerReady
host -> LanguageClient.start()
```

启动必须有超时和明确的 `mmt/workerFailed`。MMT Worker 与 Tinymist Worker保持独立故障域。

**回归测试**

- 真实浏览器 Worker transcript 覆盖 boot、initialize、request、shutdown；
- 首个 initialize 不会早于 ready；
- Worker 错误会向宿主暴露，不会静默降级。

### 7. 旧 projection 覆盖新预览

**症状**

快速编辑后预览回退到旧内容；较慢的旧资源下载最终覆盖最新 render。

**根因**

异步任务按完成顺序 apply，没有检查 source/session/revision。

**正确模式**

每个异步阶段都检查：

- source URI；
- projection session；
- revision；
- retired session；
- AbortSignal。

禁止“最后完成者获胜”。只允许“最新仍有效 revision 获胜”。

**回归测试**

- 连续提交两个 revision，让旧任务更慢；
- 断言最终 preview revision 是新版本；
- 取消任务完成后不能更新 preview。

### 8. 把 language projection 当 render project

**症状**

- Tinymist 被迫读取真实图片或宿主临时路径；
- 资源下载失败导致 completion/hover 失效；
- source map 与实际分析文本不稳定。

**根因**

语言分析和真实渲染共用同一个输出产物。

**正确模式**

- language projection 使用稳定 placeholder emission 和双向 source map；
- render project 才执行资源下载、AVIFS 解码、workspace 文件注入；
- parser/lowering/resolve 可以共享，平台 I/O 不共享。

**回归测试**

- 无网络、无图片时 Tinymist completion/hover 仍可工作；
- render fixture 继续使用真实 materialized 资源；
- 两者 source/revision contract 一致。

### 9. Workspace 图片只在首次 projection 时枚举

**症状**

- 新建图片后预览不刷新；
- 覆盖同名图片仍显示旧内容；
- reload 后文档恢复，但图片丢失；
- 文档不变时文件变化没有触发 render。

**根因**

资源列表被当作 projection 创建时的静态快照，且只监听文档变化。

**正确模式**

- workspace-file contract 接受经逐段校验的源文件相对路径，保留原安全 basename 用法；
- relevant 文件变化使 materialization 失效；
- apply render project 前重新读取受支持图片；
- 对单文件和总读取量设硬上限；
- workspace-file 不能进入 pack URL/fetch 分支。

**回归测试**

覆盖新建、覆盖、删除、reload，以及“文档不变、图片变化”的场景。

### 10. 任意 workspace 路径或无限读取

**症状**

- 未校验的 `../`、绝对路径或反斜杠路径导致工作区外文件读取；
- 大图片使浏览器内存暴涨；
- Base64 转换造成额外内存放大。

**根因**

把 DSL 路径直接传给 filesystem，或在读取后才做限制。

**正确模式**

- 仅允许安全 basename 或正斜杠分隔的安全相对段；
- 拒绝绝对路径、空段、`.`、`..`、反斜杠、控制字符和冒号；原生读取仍验证 canonical path／根目录／symlink containment；
- 读取前后都检查单文件和总字节数；
- Base64 资源只进入有上限的内存 LRU；
- 完整 pack 不能转为常驻 Base64 string。

**回归测试**

对危险路径、超大单文件、超大总量、合法 basename／嵌套路径，以及已引用图片与机会缓存预算竞争分别测试。

### 11. UTF-8 byte range 直接当 LSP position

**症状**

中文、emoji 或 surrogate pair 后的 diagnostics、completion、TextEdit 偏移。

**根因**

Rust 使用 UTF-8 byte range，VS Code 默认使用 UTF-16 position；转换没有统一经过 `LineIndex`。

**正确模式**

- snapshot、projection 和 diagnostics 共享同一 position index；
- 拒绝落在 UTF-8 codepoint 或 UTF-16 surrogate pair 中间的位置；
- source map 双向转换都走同一实现。

**回归测试**

fixture 必须包含中文、emoji、组合字符和多行编辑。

### 12. Embedded Typst 只有颜色，没有完整语言边界

**症状**

- 部分 Typst 区域有高亮但无 completion/hover；
- fenced body、inline Typst 或 patch 参数的 scope 不一致；
- 测试截图看起来正确，但 token scope 错误。

**根因**

TextMate pattern、`embeddedLanguages`、Typst grammar 注册和 LSP projection 只完成了一部分。

**正确模式**

同时维护：

- MMT grammar embedded scope；
- `embeddedLanguages` 映射；
- Typst grammar；
- projection source map；
- Tinymist request/response 映射。

**回归测试**

语法测试断言 token scope；宿主测试断言 Tinymist detail，不仅检查可能来自 word suggestion 的 label。

### 13. 字体已进入 bundle，但 Typst 没有使用

**症状**

Network 中能看到字体文件，渲染结果仍回退；数学公式与正文风格不一致。

**根因**

混淆了三个独立步骤：bundle、font resolver 注册、模板字体选择。数学字体还可能走独立路径。

**正确模式**

分别确认：

1. 字体文件进入 bundle；
2. Typst runtime 注册字体；
3. 模板按正确 family 名称选择；
4. math font 单独验证。

**回归测试**

渲染包含拉丁正文、中文和数学公式的真实 fixture，并检查可见输出。

### 14. SVG 直接插入 DOM

**症状**

外部或渲染 SVG 可携带 script、事件处理器或危险 URL。

**根因**

把 Typst/外部资源输出视为可信 HTML。

**正确模式**

插入前 sanitize，至少拒绝：

- `<script>`；
- inline event handler；
- `javascript:` URL；
- 不可信外部引用；
- 可逃逸 foreign content。

**回归测试**

使用真实恶意 SVG 输入验证危险节点/属性被移除，而不是检查 sanitizer 函数是否存在。

### 15. 结构性编辑后继续使用旧行号

**症状**

- `createLayout` 初始化被插入 preview callback；
- `sidebar` 声明被替换成引用未定义变量的表达式；
- TypeScript 仍可能在局部阶段暂时通过，但函数生命周期已损坏。

**根因**

文件经过 edit 后继续使用旧 snapshot/行号，或只看局部 diff，没有回读完整函数。

**正确模式**

1. 每次 edit 后回读受影响完整函数；
2. 后续 edit 使用最新 snapshot tag；
3. 大结构变化替换整个 syntactic block；
4. edit 返回位置异常时立即停止；
5. 先 `npm run check`，再进行浏览器验证。

**回归测试**

这里的“测试”是强制工作流：结构编辑后立即 typecheck，并在最终 E2E 中实际启动页面。

### 16. 截图代替行为证明

**症状**

截图中图标、标题和 Sidebar 都正常，但：

- Explorer tree 已丢失；
- native Part 仍逻辑可见；
- reload 后文件未恢复；
- 旧 revision 覆盖新 preview。

**根因**

视觉检查只能证明像素结果，不能证明状态机和持久化。

**正确模式**

- UI 风格使用浏览器截图和视觉检查；
- 行为使用 Playwright；
- Worker/LSP 使用 transcript/host test；
- projection/resource 使用 Rust/TypeScript unit test；
- reload/persistence 使用真实 E2E。

Renderer differential 使用真实合成的 400×620 `.viewport`，在足够大的 native pane 内居中，按相同 marker 对齐并只滚动 viewport。截图前逐层验证嵌套 iframe、祖先裁剪和遮挡，截图后检查 PNG 尺寸；不能把超出 webview 的全页截图、源码缩略图或相邻面板算进像素预算。保留原有 0.0005 像素比例、64 最大通道差和 0.01 平均通道差门槛。

**回归测试**

每个行为必须断言用户可观察结果，例如 Files Explorer tree、preview revision、workspace 文件内容，而不是只断言 class/title。

### 17. 误判根 PWA 生命周期或建立第二个 runtime owner

**症状**

- 文档仍称“尚未实现 PWA”，但 production build 已输出 manifest 和 `/sw.js`；
- waiting worker 在文档队列、journal 或 materialization 未安全收束前激活/重载；
- 根 PWA worker 与 VS Code Webview iframe worker 产生首载、离线或混合版本冲突；
- PWA adapter 自己终止 Worker、释放 subscription，和产品 runtime disposal 竞争。

**根因**

没有区分三个 owner：根 Service Worker 的 registration/activation、Webview worker scope，以及 `EditorRuntimeController` 的产品资源生命周期。

**当前正确模式**

- production、非 E2E 页面通过 `registerPwaUpdateLifecycle` 注册根 `/sw.js`；build 会 precache production shell/local assets 与选定 pinned runtime；
- waiting worker 只在用户接受后进入 safe restart；
- `PwaSafeRestartQuiesceAdapter` 检查 writer/workspace 状态，flush durable queues，abort/drain runtime work，写 recovery metadata，并调用同一个 `EditorRuntimeController.quiesce()`；
- adapter 不拥有 runtime disposal；HMR、unload、startup rollback 仍统一进入 controller / `RuntimeOwner`；
- 根 worker 和构建生成的 Webview worker 是不同 scope/用途，修改 routing、cache 或 update 时必须一起验证；
- 当前 precache/update 基线不能被描述成 active PWA spec 规划的显式 verified shell installer、probation、rollback 或 offline pack manager。

**回归测试**

- production-like 环境验证 manifest、根 `/sw.js` registration/scope 和完全离线 cold start；
- 验证 waiting update 的拒绝、接受、single reload，以及 writer/journal/flush blocker 会保留当前页面；
- 验证根 worker 与 Webview iframe worker 的首次加载和更新；
- 验证 HMR/unload/PWA quiesce 仍只有一个 `EditorRuntimeController`/`RuntimeOwner` disposal graph；
- 验证旧 JS、新 WASM 或旧 Webview worker 的混合版本不会被静默当成健康状态。

### 18. GUI Composer 建立第二份源码、重判正文边界、renderer 或近似文字几何

**症状**

- GUI 与源码 tab 的 URI/version 不一致，或 reload 后正文来自持久 JSON；
- 每个 GUI/preview pane 创建自己的 webview、renderer 或 artifact store，切换文档后旧 SVG 仍能编辑新文档；
- 正文 hit-test 使用 statement midpoint、DOM 全页文本搜索或平均字宽，比例字体、连字、重复文本和重排后光标漂移；
- stale intent 被重定向到相似节点，或 Opaque/Error/Typst body 得到可写光标；
- 自定义 GUI undo 栈与源码/Local History 分叉，失败或 composition 草稿静默丢失；
- 单行 unfenced 消息因节点间空白 separator 被当作正文尾部 LF 而多出一行气泡高度，随后又尝试用模板 padding、Composer trim 或 compiler runtime 特判掩盖。

**根因**

把 GUI 当作独立文档编辑器或把 preview mount 当成 renderer owner，绕过 Rust selection/edit authority、committed renderer identity 和原生 model history；或者让 Composer/模板/renderer 重判本应由 parser 唯一决定的正文边界。

**当前正确模式**

- `mmt.guiComposer` 是原生 Editor Pane；serializer 只存 URI，`ComposerRuntime` 从 `mmt/composerDocument` 重建，并以 URI、document incarnation、version、epoch、catalog epoch 和 digest 拒绝 stale 操作；
- SVG 是唯一 GUI 主创作表面；[`PreviewWebviewHost`](./src/previewWebviewHost.ts) 创建一个 retained `IOverlayWebview`，活动 GUI 与 [`mmt.previewHost`](./src/previewHostPane.ts) 通过 `attachSurface`/`releaseSurface`/`layoutSurface` 轮流 claim，同一产品 runtime 才拥有 renderer/session/store；
- 同一 URI 的预览 reveal 通过原生 `IEditorService` 找到已有 input/group 并激活；只有尚未打开时才创建 side group，不能依赖显式 `SIDE_GROUP` 自动执行 Singleton 查找；
- 完整 SVG 发布或新的 webview `ready` 会重置 consumer，宿主必须同步丢弃 renderer session/generation 基线；随后只通过既有一次 full resync 建立新基线。单纯 detach/reattach 同一个 retained consumer 不清空基线；
- 字符与跨正文修改经过 Rust `composerTextSelection`/`composerTextProjection` 和 `replaceTextSelection`，返回 exact UTF-16 semantic endpoints 与一个 versioned workspace edit；离散正文、插入和局部源码使用相应 Rust Composer 命令。UI 不搜索相同正文、不拼 DSL、不预测 post-edit node；
- unfenced implicit Message/Narration 在下一顶层节点或 EOF 前的 maximal trailing whitespace-only physical lines 由 parser 排除在 `BodySyntax`/statement range 外；内部空白行若后续仍有普通 continuation text 则保留在正文，非空行尾随空白保持 exact；
- projection 只把 parser range 之间保留在源码中的 separator gaps 逐物理行映射为 exact `Opaque.blank`，不再 trim/split parser body。Fenced body 内前导/尾部语义空白与 LF/CRLF 保持 exact；GUI 要保留末尾语义 LF 时由 Rust serializer 选 fence 并 reparse 证明；
- formatting separator 不生成 message empty-line anchor 或额外气泡行，也不以模板 padding 或 compiler/runtime workaround 补偿；真实 semantic LF 的 measured layout anchor 与空正文 label-bound caret 合同保持不变；
- [`ComposerTextSession`](./src/composerTextSession.ts) FIFO 提交输入；普通连续 typing 在 750 ms 边界内共享 native undo group，换行、paste/cut、IME、导航、结构操作和焦点切换关闭边界；undo/redo 操作同一个 Monaco model，并按 alternative version 恢复 presentation bookmark；
- stale/conflict/apply failure 或未提交 composition 进入 recovery UI，只允许复制/丢弃，不能自动应用到别的 message；
- [`ComposerTextGeometry`](./src/composerTextGeometry.ts) 只接受 committed source/version/digest/renderKey/session/generation，并要求 renderer caret/range 与 Rust authored projection 可逆；unmapped 或 ambiguous 时 blocked，不使用平均字宽或 statement midpoint；
- Fit width/page 和适配态 resize 复用视口中心的页面锚点，先补偿滚动再上报；切换文档时，显式保存的页面点优先于上一个文档的中心；
- viewport 报告必须携带已提交的 `renderKey`，宿主仅在它匹配当前 artifact 时更新该文档的保存视口；换文档期间的临时几何或迟到报告不能覆盖另一份文档的阅读位置；
- 选中框、文字选区和 caret 的纯视觉层放在 `.page` 内，随原生画布滚动，不靠下一帧的 fixed overlay 追赶；textarea、IME 和触摸 handles 仍由稳定的 body 层持有；
- renderer 在既有缓冲覆盖内复用 SVG，冷首帧保持 1 屏 padding，后续以 1 屏 guard 触发既有 5 屏 overscan，最多 8 个 page buffers；文字选择层的变换与边界仅在真实 SVG patch 后重建索引，滚动不重复遍历矩阵或拆挂未变化的选区视觉层；
- 字符编辑对 Opaque、recoverable error、不可逆 Typst body 和未知 wire 值 fail closed；局部源码编辑只使用当前 Rust `replaceSource` capability 和完整 node identity。550px 默认规则按 document incarnation 记录，显式“更多操作 → 高级源码”切换不会 bounce，551px 仍以源码为默认。

**回归测试**

`test:composer-edit`、`test:composer-document`、`test:composer-runtime`、`test:preview-webview-protocol`、`test:preview-renderer-session` 和 `test:e2e:gui-composer`（包含 `gui-text-context.spec.ts`）。浏览器 journey 应操作真实 SVG glyph，断言 semantic selection、authored bytes、native undo/recovery、ClipboardEvent 与 geometry，而不只检查 overlay 元素存在。

Parser/core 与 CLI visual regression 应覆盖连续 statement 后接 separator blank：第二条 semantic body 不含尾部 LF、separator bytes 仍逐行投影为 `Opaque.blank`，而“内部空白后继续正文”和 fenced 末尾语义 LF 两个对照仍分别保留正文与空行 caret geometry。

`preview-interaction.spec.ts` 还覆盖同一 URI 重复 reveal 的 tab/viewport 保留、不同 URI 的预览区分，以及关闭后重开并继续缩放。

### 19. Native restoration、Pack 与 preview 首屏顺序竞争

**症状**

- reload 后恢复的 GUI/source tab 被 intro 覆盖；
- 恢复的 GUI 已挂载但 preview 永久空白，或使用 Pack registry 初始化前生成的 projection；
- iframe 继承原生 Part 的测量占位尺寸，SVG 已生成但迟迟没有 `visual-ready`；
- pin/open 看似成功，重载或安全更新后却丢失；
- safe restart 在 storage/editor state 尚未 flush 时激活 waiting worker。

**当前正确模式**

原生 Editor Part 挂载后须立即接收 shell 已分配的真实尺寸，后续尺寸继续由既有 SplitView layout 回调传播，不能只等 ResizeObserver。GUI/preview mount 镜像原生 `setVisible`；retained overlay 随同一个 Part 的 layout 更新，不以测量占位尺寸或隐藏 Pane 抢占画布。

1. `api.start()` 后取得 native services；初始 Pack 同步先 settle（失败路径也必须让 language server 接受 validated empty-registry fallback），之后才置 `previewSourcesReady` 并允许 `syncPreviewSurface`；
2. 等待 `IEditorGroupsService.whenRestored` 后再判断 native groups 是否已经恢复 editor；
3. 只有 native groups 没有恢复 editor 时才尝试恢复 workspace active document，二者都没有时才打开 intro；
4. `mmt.composer.open` 完成 `openWith`、pin 与移动端 Part 调整后 flush `IStorageService`；
5. safe restart 先暂停输入、保存 GUI dirty document、等待 persistence queues，再 flush `IStorageService` 和 workspace coordinator，之后才 drain/quiesce。

这一顺序是 source restoration 的组成部分；不要用 timeout、重复 open 或 eager preview sync 修补竞态。

## Recommended Development Flow

### 1. 确认改动所属层

```text
DSL 语义/资源解析       -> mmt_rs
LSP snapshot/projection -> mmt_lsp
Desktop/Web 扩展行为    -> editors/vscode
Standalone Workbench    -> editors/vscode-web
Typst 视觉输出          -> typst_sandbox/mmt_render
Pack 构建/manifest      -> tools + pack-v3
```

跨层改动先定义 URI、revision、range、resource kind、错误语义和所有权，再写实现。

### 2. 建立最小 reproduction

示例：

- 输入 `[:` 后光标落错；
- 新建 workspace 图片后 preview revision 不变；
- Explorer 重复点击后 tree 消失；
- reload 后默认内容覆盖用户文档；
- 中文位置的 Tinymist completion 映射错误。

不要用增加 sleep、重试或空 fallback 掩盖 reproduction。

### 3. 从 source of truth 修复

1. 找到权威状态；
2. 修复生成/转换源头；
3. 删除 UI/host 补偿分支；
4. 让所有调用方使用同一 contract；
5. 覆盖旧 session、旧 revision、取消和失败路径。

### 4. 小步修改并立即回读

- 精确定位目标；
- 修改一个完整结构；
- 回读完整函数；
- 运行最近的 typecheck/unit test；
- 再进行下一步。

不要连续叠加未经回读的 line edit。

### 5. 分层验证

#### Rust Core

```bash
cargo test --manifest-path mmt_rs/Cargo.toml --all-targets
```

#### LSP

```bash
cargo test --manifest-path mmt_lsp/Cargo.toml
```

#### VS Code Extension

```bash
cd editors/vscode
npm run check
npm run test:grammar
npm run test:worker
```

需要真实宿主时：

```bash
npm run test:web
npm run test:desktop
```

#### Standalone Web

```bash
cd editors/vscode-web
npm run check
npm run test:composer-edit
npm run test:composer-document
npm run test:composer-runtime
npm run test:composer-image-import
npm run test:workspace-mirror
npm run test:exact-export
npm run test:preview-webview-protocol
npm run test:preview-renderer-session
npm run build
npm run test:e2e:gui-composer
npm run test:e2e:pwa-offline
```

GUI E2E 必须在真实 renderer SVG 上完成字符/跨消息选择、输入、原生 undo/recovery、精确 caret/range geometry、reload、source/GUI/preview mount 切换和窄视口 journey。自动 IME 覆盖只派发 synthetic composition/input 事件；soft-keyboard 覆盖只缩小 viewport。CI/当前自动环境不提供物理中文 OS 输入法或真实移动软件键盘，这两项必须报告为未验证，除非另有人工设备记录。UI 改动仍需实际浏览器操作和视觉检查，但不能用截图替代行为断言。

### 6. E2E 编写顺序

1. 等待明确 readiness marker；
2. 读取 accessibility tree；
3. 用原生 role/name/state 定位；
4. 执行真实用户操作；
5. 断言真实内容；
6. reload；
7. 断言持久化结果；
8. revision 异步变化使用 `expect.poll`；
9. 保留 screenshot、trace、error context。

### 7. 分阶段提交

推荐拆分：

1. Rust core / projection / pack；
2. VS Code Extension / grammar / Worker；
3. Standalone Web / E2E / OpenSpec。

提交前运行：

```bash
git diff --check
```

并确认没有误提交 source maps、临时截图、本地配置或构建缓存。

## Review Checklist

### State And Lifecycle

- [ ] 每个异步结果都有 source/session/revision gate
- [ ] 取消后不会 apply project 或更新 preview
- [ ] reload 不会用默认文档覆盖用户内容
- [ ] configuration change 会回填 UI
- [ ] 每个 editor lifetime 只有一个 `EditorRuntimeController` / `RuntimeOwner`
- [ ] startup rollback、HMR、unload 和 PWA quiesce 都进入同一个 lifecycle
- [ ] PWA adapter 不自行 dispose 产品 Worker/subscription

### Workbench UI

- [ ] `ViewsService` 是 Part/visibility owner，`SplitView` 是 geometry/sash owner
- [ ] 初始 Part visibility 与后续事件都同步到对应 `SplitView`
- [ ] 当前 Activity 项折叠不会销毁 View descriptor
- [ ] 没有 CSS Grid sizing、手写 sash 或第二套 width/height truth
- [ ] 不宣称当前 sash 尺寸可跨 reload 恢复
- [ ] 使用 VS Code theme variables
- [ ] E2E 使用原生 tab/`aria-selected` 语义
- [ ] 断言 Files Explorer tree/设置内容，而不只断言 class 或标题
- [ ] 采用 `WorkspaceService` 前有独立 migration proposal，且不替换产品 runtime disposal
- [ ] GUI 与源码共享一个 URI/TextDocument/model；serializer 不持久化 selection、node key、IME 草稿或源码副本
- [ ] 一个 retained overlay 只由活动 GUI 或只读 `mmt.previewHost` claim；没有 pane-local renderer/store，release 不能误伤新 claimant
- [ ] 正文只消费 Rust exact UTF-16 selection/projection/edit；Opaque/Error/Typst、stale、unmapped/ambiguous fail closed，不用 midpoint/平均字宽
- [ ] 文本 edit 使用原生 model undo/redo 与 alternative-version bookmark；冲突和未提交 composition 可恢复且不 retarget
- [ ] initial preview sync 等待 Pack settle，fallback intro 等待 native group restore；GUI pin/open 与 safe restart 都 flush storage
- [ ] 真实 Chrome SVG journey 覆盖 551px/550px/320px、触达尺寸、Sheet、reload/offline；synthetic IME 与 viewport shrink 不冒充当前不可用的物理输入法/真实软键盘证明

### Files And Resources

- [ ] workspace path 仅接受经逐段校验的安全源文件相对路径，原生读取保留根目录和 symlink containment
- [ ] 单文件和总读取量均有限制
- [ ] workspace-file 与 pack resource 分支明确分离
- [ ] 新建、覆盖、删除、reload 均验证
- [ ] 大二进制没有成为长期 Base64 string cache

### Language Tooling

- [ ] UTF-8/UTF-16 转换覆盖非 ASCII
- [ ] projection 与 diagnostics 共享 snapshot/index
- [ ] Tinymist capability 和版本经过验证
- [ ] completion 不是 word suggestion 误报
- [ ] embedded Typst scope 有 token 测试

### Preview And Security

- [ ] preview 只接受最新 revision
- [ ] SVG 经过 sanitizer
- [ ] 外部资源有 CORS、size、MIME 和失败处理
- [ ] 字体通过真实渲染 fixture 验证

## Guiding Rule

不要为每个故障增加一层补丁。让每层只拥有一种状态、一个明确 contract，以及一套能证明该 contract 的验证。
