## Why

MomoScript 的生产 Web Workbench 已具备 revision-bound MMT→Typst preview、preview-to-source navigation、严格 projection identity、Rust 原生语义 Rename、版本化 WorkspaceEdit、本地历史与 latest-wins 重渲染。预览目前仍是只读结果表面：作者看到某个气泡后，必须先跳回源码，再理解 statement patch 或 `@actor` revision 才能修改显示行为。

下一步应把预览扩展为受控的 GUI 命令入口，但不能让 SVG/DOM、navigation fallback 或 TypeScript 重新解释 MMT 语义。第一阶段只打通一个可复用的垂直切片：右键当前 MMT 消息气泡，编辑该 statement 的 `continued` 三态，或从该 statement 起修改已解析 actor 的 `display-name`。所有修改仍由共享 Rust language service 针对当前文档快照生成版本化 WorkspaceEdit，客户端负责应用。

## What Changes

- 增加 revision-bound preview→Composer target 解析：renderer point 先解析为当前 generated location，再由 projection origin ancestry 与当前 MMT syntax/semantic snapshot 共同证明唯一 statement target。
- 增加纯 `mmt/composerEdit` request：接收当前版本、已验证 statement target 与结构化命令，返回包含当前版本 `TextDocumentEdit` 的 WorkspaceEdit 或显式拒绝；服务端不修改文档、不发送私有 apply notification。
- 第一版命令固定为：
  - `setStatementContinued`：`auto | true | false`，最小更新、插入或移除 statement patch 中的 `continued` 参数；
  - `setActorDisplayNameFromStatement`：从选中 statement 起创建 actor revision，或在仅作用于该起点的相邻 actor block 中最小更新 `display-name`。
- Web preview 在无文本选择的右键操作上请求 Composer target；interactive MMT SVG 使用 exporter 生成的确定性不透明 label，将气泡、头像、显示名、reply 与 bond 的视觉区域绑定到同一当前渲染目标，Webview 只在同 token 内吸附到文本位置并继续仅向 host 发送规范化坐标。Workbench 在点击位置旁通过原生右键菜单展示“连续消息”“从本条起修改显示名”“转到源码”；不可编辑但可导航的 narration 等 authored 内容仍展示“转到源码”。显示名使用点击位置旁的 Workbench context view 与原生 InputBox，而不是顶部 Quick Input。UI 不缓存属性或把 label 当作编辑权限。
- Composer candidate 必须在内存中完整重分析；语法/语义错误、旧版本、旧 preview identity、builtin/unresolved/ambiguous actor、非 MMT/生成/package target 或不唯一 origin 一律拒绝。
- native stdio 与 WASM bridge 共享同一 Rust request 和序列化合同；首个产品 UI 只接入生产 Web Workbench，Desktop 可在后续复用该协议。

## Affected Capabilities

- `language-tooling`：新增 preview semantic targeting、纯结构化 Composer edit、版本/重分析/映射安全合同。
- `web-workbench-shell`：新增右键入口、点击位置旁的原生 Workbench 菜单、单一 TextDocument/preview owner 与生命周期要求。
- 依赖但不修改：Rust v2 `dsl-syntax` 的 statement patch、actor revision、`display-name` 既有语义；`define-preview-navigation-fallback` 的只读 fallback 边界；`add-mmt-diagnostic-origin-and-semantic-editing` 的版本化纯 WorkspaceEdit 合同。

## Non-Goals

- 不实现当前气泡独有的昵称覆盖；该行为需要新的 statement-local DSL/模板合同。
- 不实现格式刷、多选批量编辑、拖拽排序、正文富文本编辑或完整 GUI Composer。
- 不编辑任意 Typst patch 字符串，不为 `fill`、`inset`、`radius`、`tip` 提前建立无类型表单。
- 不把 authored-parent navigation/diagnostic fallback 升级为 TextEdit 授权，不放宽 `ProjectionIndex::typst_to_mmt` 或 projected-edit Identity-only 规则。
- 不改变 `.mmt` 文本、本地历史、preview artifact 或 React/DOM state 的事实源归属。
- 不在本 change 实现移动端产品页面；移动端将以 PWA 优先的 GUI + 源码混合表面另行设计，Composer 仅指可复用的内部语义 target/command 合同，之后再由同一 Web bundle 封装 App。
- 不同时重新设计角色列表或筛选表单。
