## Why

MomoScript 已具备稳定的 Rust DSL v2、版本化 Composer WorkspaceEdit、lossless Composer document projection、Pack 人物与头像选择、Local History、revision-bound 预览、浏览器持久化、PWA 离线启动与导出。`mmt.guiComposer` 已接入唯一 TextDocument、原生 Workbench editor、共享真实 SVG、精确已有正文编辑和 native history；这些是已实现的 SVG-first 架构。

本未归档 change 的下一轮拟在该架构上收敛产品交互，而不重做 renderer：Typst/Tinymist 的真实 SVG 继续是已写消息的最终排版与点击编辑画布，连续新增消息改由持久可见的紧凑底部 Composer 完成，顶栏和上下文操作改为分组良好的 icon-first chrome。该布局**尚未实现**。既有 lossless partition、opaque 降级、Rust 源码授权和版本校验不能为此放宽；`.mmt` TextDocument 仍是唯一 authored state，不新增可变卡片文档、客户端 AST 或 TypeScript MMT 序列化。

## What Changes

- 保留完整、有序、无重叠、无空洞的 Message/Narration/Opaque 字节分区及 snapshot-local identity。Core 保留 exact source slice；Opaque wire 继续只发送 range、有界 `sourcePreview`/`sourceTruncated`/`summary`。当前 comment-looking 行仍是带诊断的 `recoverableError`，不是新 comment syntax。
- 删除卡片主列表，不保留另一个卡片/画布切换模式。HTML 继续承担 caret/selection、IME 临时输入、Picker/Sheet 和源码入口，并在计划中的下一轮承担底部新消息 Composer、紧凑工具组与上下文菜单；SVG 文本、头像、名字、气泡和旁白标签继续接现有语义操作。Typst、不可逆宏生成文字和其他 opaque 内容使用明确源码入口，不猜测正文替换范围。
- 已有正文仍直接在 SVG 中精确编辑；新增消息则在底部先形成 transient draft，发送时才针对最新 snapshot 调用 Rust `insertStatement`。结构删除/属性只在选择上下文中出现，批量排列进入独立模式；不在画布上永久展示 inspector、逐条复选框或完整 insert/delete/up/down 工具条。
- 同轮交付有方向的跨 Message/Narration 文本选区、复制、删除和替换。写入按源码顺序归一化，复制每段语义正文并以一个 LF 分隔。替换保留第一条 envelope，正文为首条未选前缀 + replacement + 末条未选后缀，并删除后续被选 statement nodes；只可跨 `Opaque.blank`，其原始字节保留。其他 opaque、不同 resolved body mode 显式 `unsupportedStructure`；影响未选节点继承语义的候选 `candidateInvalid`，不截断、不隐式修补。
- 扩展既有 `mmt/composerEdit`，新增 strict `textSelection`/`replaceTextSelection`、LF-normalized UTF-16 语义端点、`textEditing` 能力、候选计算的 `TextEdit` result/digest/selectionAfter；增加只读 `mmt/composerTextSelection` 与 identity-bound `mmt/composerTextProjection`。Native stdio、WASM 和 TypeScript exact-key producer/consumer 同步迁移，不新增 mutation request 或兼容别名。
- Rust parser 独占 unfenced implicit body boundary：下一顶层节点或 EOF 前 maximal trailing whitespace-only physical lines 是保留在源码中的 separator，由 projection 从 gaps 表示为 `Opaque.blank`，Composer 不再 trim/split 正文。Rust 继续独占 UTF-16/grapheme/EOL 转换、正文序列化、候选 reparse/analyze 和 versioned TextDocumentEdit；GUI 需要末尾语义 LF 时 serializer 使用 fence 并 reparse 证明。Fenced body 的末尾 LF/引号、CRLF、空正文和 final EOL 必须可逆；不插入隐藏 sentinel，不用模板 padding 或 compiler/runtime workaround 掩盖边界错误。
- 保留原生 `mmt.guiComposer` 与 `{version:1,uri}` serializer，将同一个 PreviewWebviewHost renderer runtime 的 `IOverlayWebview` 挂入 GUI 的 SVG 容器；源码侧原生 `mmt.previewHost` 只作为同一 overlay 的另一挂载位置。一个 overlay、一个 active document、原 publication/ACK/resync/session-generation 和 export owners 不变。
- 先沿现有 live-document/frame-readiness/glyph 路径做真实几何 characterization，再决定是否启用 Tinymist fork source 中的 renderer 实现分支。命中 offset、glyph-advance caret（误差不超过 1 CSS px）、逐行 selection rectangles、重复文本与缩放/重排必须精确；中点/平均字宽或仅出现 cursor 不算通过。仅实测证明不足才加入 `hitTestText`、`locateCaret`、`locateRange` 三 action，并走 full source SHA pin、clean checkout、受管 build/promote/repin 与独立 runtime publication。
- `ComposerRuntime` 的文本子会话串行执行已接受输入，以新 snapshot/digest/exact statementRange 恢复光标，不复用旧 nodeKey。IME update 只显示临时 HTML，end 提交一次；冲突/失败保留可复制未提交内容。文本编辑使用同一个 Monaco model 的 `pushEditOperations` 和原生 undo/redo，不建立第二份文档或 history stack。
- 保持桌面源码默认、`max-width: 550px` page-lifetime 首次 GUI 默认与 320px 最小验收。真实浏览器验证软键盘、44px targets、触控选区、生命周期、History、保存/reload、PDF exact export 和离线闭环；真实 OS 中文 IME 的手动验证不能用合成事件冒充。
- 计划中的桌面/移动 chrome 使用纤细文档/状态顶栏与 undo、redo、export、more 图标；底部第一行是当前角色头像、默认单行并自动增长的输入、image/send 图标，下方为紧凑工具组和水平角色 tray。Tray 自动保留所有已选择角色（包括发送前选择），保持已有位置稳定，提供 Teacher/Sensei quick-switch affordance；完整角色库按需打开，不成为永久侧栏，也没有用户维护的 favorites。该 shortcut 不自行授权显式 `__Sensei` 或客户端序列化；当前 Builtin speaker 限制下的提交映射必须在实施前由 Rust capability 合同解决。
- 未发送 draft 在编辑已有 SVG 消息时必须保留，但在成功发送前不进入 canonical source、native undo/redo、save、History、render 或 export。URI-only serializer 不保存它；跨关闭/reload 的持久策略、真实移动软键盘、精确 icon 顺序和窄屏 tray 微布局仍是实施前待验证细节，本文不声称已经部署。

## Affected Capabilities

- `gui-composer`（新增）：已交付 SVG 主创作架构、字符与跨正文编辑、IME/native history、精确几何、显式结构操作和 opaque 源码出口；下一轮计划增加 icon-first 顶/底 chrome、底部连续新增、上下文编辑、自动角色 tray 与独立 bulk arrange mode。
- `language-tooling`：保留完整字节分区、snapshot-local identity 和结构命令；增加严格文本选区/read/projection/edit 合同、fenced parser 消歧与候选证明。
- `web-workbench-shell`：保留原生 editor、URI-only serializer、ViewsService/SplitView 和唯一 runtime；将现有预览改为 GUI/source 共用的可重挂载 overlay，接同一 native model/history 与 PWA 生命周期。
- 依赖但不替换：Pack/角色图鉴、IndexedDB workspace、Local History、History/Pack/Preview/Export/PWA 主链。几何实测不合格才扩展已管理的 Tinymist renderer 协议与 runtime 制品，不新增 owner 或渲染后端。

## Non-Goals

- 不新增 JSON/card 持久化格式、第二份 IndexedDB 文档、客户端 AST cache 或由 GUI 自行序列化 MMT。
- 不迁移到旧 `web/` React 编辑器，不新建第二个 Web/App UI 代码库，不迁移 ViewsService shell 到 WorkspaceService。
- 不表单化 reply、bond、任意 directive 或任意 Typst AST；不将不可逆渲染文本猜成可编辑正文。这些内容无损保留并进入已有源码编辑器。
- 不实现实时协作、云同步、插件市场、Git 工作流、AI 自动创作或新的渲染后端；不引入 Tylina 代码、sidecar 或另一个 typst.ts fork。
- 不以拖拽作为唯一结构排序方式，不跨 opaque barrier 移动节点，不建立隐式“注释随节点移动”启发式。跨消息正文文本选区属于既有已实现范围，不等价于任意结构节点多选；计划中的 bulk arrange mode 也不得用视觉选择绕过 server capability。
- 不扩展 DSL comment 或内建 speaker 语法；`comment` wire 类别和显式 `__Sensei` 选择均留待独立语法变更。
- 不在本 change 封装原生 App；PWA 移动闭环稳定后，原生容器可另行提供文件、分享、深链和系统权限能力。