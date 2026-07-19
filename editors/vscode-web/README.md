# MomoScript VS Code Web Workbench

本目录是独立运行的浏览器编辑器，不是普通 Monaco 页面。它组合了 VS Code Workbench、Web Extension Host、MMT LSP WASM Worker、Tinymist WASM Worker、Typst compiler/renderer、IndexedDB workspace 和浏览器端资源 materializer。

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
- MMT LSP 与 Tinymist 独立 Worker；
- revision-bound Typst projection、preview artifact 和预览交互；
- workspace 图片、pack-v3 图片及 AVIFS materialization；
- embedded Typst grammar、completion、hover 和 diagnostics；
- 可取消的实时渲染与受限内存资源缓存；
- Web App Manifest、安装 metadata，以及 production build 生成并注册的根 `/sw.js`；
- production shell/local assets 与选定 pinned runtime 的 Service Worker precache，以及经过 workspace/runtime quiesce 后才激活 waiting worker 的提示式更新。

当前仍不具备：

- `add-pwa-offline-runtime` 规划的显式、逐项校验并可回滚的 offline shell installer；
- 完整资源包离线安装、持久 pack asset cache、pack 原子升级/回滚和空间管理；
- offline-ready、browser-installed、staging、probation 等完整状态面板；
- 多 shell revision 的 client handshake、probation 和回滚；
- sash 大小的 reload 持久化；
- Monaco `WorkspaceService` 对完整 Workbench shell/layout 的接管。

`IndexedDbPackCache` 当前只持久化 manifest/ETag；`BoundedStringCache` 是页面内 32 MiB 内存 LRU，不能视为离线资源缓存。当前 `/sw.js` 的 install-time precache 也不等同于 active PWA spec 中显式 reservation、artifact verification、probation 与 rollback 均完成的 offline shell。

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
VS Code TextDocument / mmtfs workspace
  -> MMT LSP revision snapshot
  -> Typst projection session/revision
  -> workspace/pack resource materialization
  -> accepted render artifact
  -> displayed preview revision
```

| 状态 | 权威来源 |
|---|---|
| Part 实例、当前 View container、Part 可见性 | Monaco VS Code Views Service / Part API；Part attachment disposable 进入产品 runtime owner |
| Sidebar/main、Editor/Panel 几何与 sash | `createLayout` 创建的两个原生 `SplitView` |
| 当前 authored 文档内容 | VS Code `TextDocument` |
| authored 文档持久字节 | `mmtfs` workspace provider/coordinator |
| 产品 startup、work admission、quiesce、dispose | 单一 `EditorRuntimeController` 及其单一 `RuntimeOwner` |
| projection/materialization、已接受 preview revision/artifact | `EditorRuntimeController` 拥有的 typed stores / `PreviewArtifactStore` |
| 已显示 preview DOM 与 viewport interaction | runtime-owned `TypstPreviewController`，只绑定已接受 artifact identity |
| PWA registration、waiting worker 与 activation/reload | `registerPwaUpdateLifecycle`；安全重启仅通过 adapter 调用同一个 runtime |
| MMT 分析 | MMT LSP versioned snapshot |
| Typst 虚拟项目 | projection session + revision |
| Pack manifest URL 选择、用户配置 | VS Code configuration service |
| Pack manifest 持久副本/ETag | IndexedDB cache（仅持久缓存） |
| 已接受的 Pack 语义与 revision | MMT LSP monotonic `pack_revision` / `PackRegistry` |

UI class、label 和 control 可以镜像权威状态，不能建立第二套 boolean、document buffer、revision map、artifact selection、persistence queue 或 disposal graph。

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

- workspace-file contract 只接受 basename；
- relevant 文件变化使 materialization 失效；
- apply render project 前重新读取受支持图片；
- 对单文件和总读取量设硬上限；
- workspace-file 不能进入 pack URL/fetch 分支。

**回归测试**

覆盖新建、覆盖、删除、reload，以及“文档不变、图片变化”的场景。

### 10. 任意 workspace 路径或无限读取

**症状**

- 用户输入 `../`、子目录或反斜杠路径后读取工作区外文件；
- 大图片使浏览器内存暴涨；
- Base64 转换造成额外内存放大。

**根因**

把 DSL 路径直接传给 filesystem，或在读取后才做限制。

**正确模式**

- 仅允许安全 basename；
- 拒绝 `.`, `..`, `/`, `\\` 和子目录；
- 读取前后都检查单文件和总字节数；
- Base64 资源只进入有上限的内存 LRU；
- 完整 pack 不能转为常驻 Base64 string。

**回归测试**

对危险路径、超大单文件、超大总量和合法 basename 分别测试。

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
npm run build
npm run test:e2e
```

UI 改动还要浏览器实际操作和视觉检查，但不能用截图替代 E2E。

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

### Files And Resources

- [ ] workspace path 只接受安全 basename
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
