## Why

MomoScript 已具备稳定的 Rust DSL v2、版本化 Composer WorkspaceEdit、lossless Composer document projection、Pack 人物与头像选择、Local History、revision-bound 预览、浏览器持久化、PWA 离线启动与导出。`mmt.guiComposer` 已接入唯一 TextDocument 与原生 Workbench editor，但卡片主界面仍要求作者在表单正文与真实排版之间切换，不能在排版页面上连续创作。

本未归档 change 改为 SVG-first WYSIWYG：Typst/Tinymist 的真实 SVG 是主创作画布，在可精确映射的 Message/Narration 正文上提供字符光标、拖选、连续输入、多行、IME、跨消息复制/删除/替换和同一原生撤销栈。既有 lossless partition、opaque 降级、Rust 源码授权和版本校验不能为此放宽；`.mmt` TextDocument 仍是唯一 authored state，不新增可变卡片文档、客户端 AST 或 TypeScript MMT 序列化。

## What Changes

- 保留完整、有序、无重叠、无空洞的 Message/Narration/Opaque 字节分区及 snapshot-local identity。Core 保留 exact source slice；Opaque wire 继续只发送 range、有界 `sourcePreview`/`sourceTruncated`/`summary`。当前 comment-looking 行仍是带诊断的 `recoverableError`，不是新 comment syntax。
- 删除卡片主列表，不保留另一个卡片/画布切换模式。HTML 只承担 caret/selection、IME 临时输入、toolbar、Picker/Sheet 与源码入口；SVG 文本、头像、名字、气泡和旁白标签接现有语义操作。Typst、不可逆宏生成文字和其他 opaque 内容使用明确源码入口，不猜测正文替换范围。
- 直接正文编辑仅覆盖 resolved mode 为 `textMacro` 或 `textRaw` 且可唯一映射的 Message/Narration。Enter 与 Shift+Enter 都插入正文 LF；折叠光标在正文首尾时 Backspace/Delete 不隐式合并节点。结构插入、删除、移动、speaker/mode/avatar/name/continued 继续现有显式控件与语义命令。
- 同轮交付有方向的跨 Message/Narration 文本选区、复制、删除和替换。写入按源码顺序归一化，复制每段语义正文并以一个 LF 分隔。替换保留第一条 envelope，正文为首条未选前缀 + replacement + 末条未选后缀，并删除后续被选 statement nodes；只可跨 `Opaque.blank`，其原始字节保留。其他 opaque、不同 resolved body mode 显式 `unsupportedStructure`；影响未选节点继承语义的候选 `candidateInvalid`，不截断、不隐式修补。
- 扩展既有 `mmt/composerEdit`，新增 strict `textSelection`/`replaceTextSelection`、LF-normalized UTF-16 语义端点、`textEditing` 能力、候选计算的 `TextEdit` result/digest/selectionAfter；增加只读 `mmt/composerTextSelection` 与 identity-bound `mmt/composerTextProjection`。Native stdio、WASM 和 TypeScript exact-key producer/consumer 同步迁移，不新增 mutation request 或兼容别名。
- Rust 独占 UTF-16/grapheme/EOL 转换、正文序列化、候选 reparse/analyze 和 versioned TextDocumentEdit。保留旧 `setStatementBody` 输入合同；空值、多行和跨节点走新命令。修正 fenced body 精确切片，并规定长度至少为 N 的 closing quote run 使用最后 N 个引号作 delimiter。正文末尾 LF/引号、CRLF、空正文和 final EOL 必须可逆；不插入隐藏 sentinel，不自动删除空消息。
- 保留原生 `mmt.guiComposer` 与 `{version:1,uri}` serializer，将同一个 PreviewWebviewHost renderer runtime 的 `IOverlayWebview` 挂入 GUI 的 SVG 容器；源码侧原生 `mmt.previewHost` 只作为同一 overlay 的另一挂载位置。一个 overlay、一个 active document、原 publication/ACK/resync/session-generation 和 export owners 不变。
- 先沿现有 live-document/frame-readiness/glyph 路径做真实几何 characterization，再决定是否启用现有 Tinymist renderer 补丁分支。命中 offset、glyph-advance caret（误差不超过 1 CSS px）、逐行 selection rectangles、重复文本与缩放/重排必须精确；中点/平均字宽或仅出现 cursor 不算通过。仅实测证明不足才加入 `hitTestText`、`locateCaret`、`locateRange` 三 action，并走受管 build/promote/repin/runtime publication。
- `ComposerRuntime` 的文本子会话串行执行已接受输入，以新 snapshot/digest/exact statementRange 恢复光标，不复用旧 nodeKey。IME update 只显示临时 HTML，end 提交一次；冲突/失败保留可复制未提交内容。文本编辑使用同一个 Monaco model 的 `pushEditOperations` 和原生 undo/redo，不建立第二份文档或 history stack。
- 保持桌面源码默认、`max-width: 550px` page-lifetime 首次 GUI 默认与 320px 最小验收。真实浏览器验证软键盘、44px targets、触控选区、生命周期、History、保存/reload、PDF exact export 和离线闭环；真实 OS 中文 IME 的手动验证不能用合成事件冒充。

## Affected Capabilities

- `gui-composer`（新增）：SVG 主创作表面、字符与跨正文编辑、IME/native history、精确几何、显式结构操作、opaque 源码出口及移动完整创作闭环。
- `language-tooling`：保留完整字节分区、snapshot-local identity 和结构命令；增加严格文本选区/read/projection/edit 合同、fenced parser 消歧与候选证明。
- `web-workbench-shell`：保留原生 editor、URI-only serializer、ViewsService/SplitView 和唯一 runtime；将现有预览改为 GUI/source 共用的可重挂载 overlay，接同一 native model/history 与 PWA 生命周期。
- 依赖但不替换：Pack/角色图鉴、IndexedDB workspace、Local History、History/Pack/Preview/Export/PWA 主链。几何实测不合格才扩展已管理的 Tinymist renderer 协议与 runtime 制品，不新增 owner 或渲染后端。

## Non-Goals

- 不新增 JSON/card 持久化格式、第二份 IndexedDB 文档、客户端 AST cache 或由 GUI 自行序列化 MMT。
- 不迁移到旧 `web/` React 编辑器，不新建第二个 Web/App UI 代码库，不迁移 ViewsService shell 到 WorkspaceService。
- 不表单化 reply、bond、任意 directive 或任意 Typst AST；不将不可逆渲染文本猜成可编辑正文。这些内容无损保留并进入已有源码编辑器。
- 不实现实时协作、云同步、插件市场、Git 工作流、AI 自动创作或新的渲染后端；不引入 Tylina 代码、sidecar 或另一个 typst.ts fork。
- 不以拖拽作为唯一结构排序方式，不跨 opaque barrier 移动节点，不建立隐式“注释随节点移动”启发式。跨消息正文文本选区属于本轮必需范围，不等价于任意结构节点多选。
- 不扩展 DSL comment 或内建 speaker 语法；`comment` wire 类别和显式 `__Sensei` 选择均留待独立语法变更。
- 不在本 change 封装原生 App；PWA 移动闭环稳定后，原生容器可另行提供文件、分享、深链和系统权限能力。