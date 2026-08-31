## Why

MomoScript 已具备稳定的 Rust DSL v2、版本化 Composer WorkspaceEdit、Pack 人物与头像选择、Local History、revision-bound 预览、浏览器持久化、PWA 离线启动与导出。当前生产表面仍以源码编辑器为中心；普通创作者尤其在手机上，需要理解 statement、directive、正文模式和 actor revision，才能完成持续创作。

Preview Composer 已证明 GUI intent 可以通过结构化命令进入同一 Rust 授权、候选重分析和 TextDocument apply 主链。下一步应建立不暴露源码概念的卡片式创作表面，但不能因此新增第二种文档格式、第二份可变卡片文档或由 TypeScript 拼接 MMT。结构编辑开始前还必须先证明整个源码能被投影成完整、无重叠、无空洞的字节分区；否则注释、空行、directive、recoverable error 或未知语法仍可能在卡片移动和删除时被误带或遗留。

## What Changes

- 增加 surface-independent、版本化的 Composer document projection。Rust 将当前 `.mmt` 快照投影成有序的 message、narration 与 opaque 节点；节点范围完整覆盖 `[0, source.len)`，按原始字节拼接必须精确还原源码。当前 parser 不识别独立 comment syntax，因此 `// ...` 等 comment-looking 行仍是 `recoverableError`；`comment` 仅作为未来 parser 支持后的 wire 保留类别。
- Opaque core 节点保留 exact source slice 以证明完整分区；wire 只发送精确 range、最多 4096 UTF-8 bytes 的 `sourcePreview`、`sourceTruncated` 与最多 160 个 Unicode scalar 的 `summary`。打开高级源码时必须从当前 TextDocument range 读取真实内容。
- 增加纯结构化、版本化的 `insertStatement`、`deleteNode`、`moveNode` 与 `setStatementSpeaker` Composer 命令。Rust 独占 target/boundary 校验、MMT 序列化、候选重分析与单一 WorkspaceEdit 生成；TypeScript 不构造源码或 TextEdit。插入和说话人修改首版只接受 Pack 实体或脚本角色，不能显式序列化的内建 `__Sensei` 只读保留。
- 首版 move 只跨越连续可移动 message/narration 节点，不跨 opaque barrier。Rust 必须协调移动前后的行分隔符：保持 movable run 的 LF/CRLF 风格与文件末尾是否含 EOL，防止无 EOL 的末节点移到中间后粘连，也防止含 EOL 节点移到 EOF 后改变尾部格式。混合 EOL run 显式不支持。删除只删除目标可移动节点拥有的字节；插入锚点只能位于投影节点边界。任何 stale identity、错误候选或无法保持语义的结构操作显式拒绝。
- 增加纯 `ComposerRuntime` 产品控制器，消费不可变 projection snapshot、Pack catalog 与现有 Composer commands。桌面和移动 presentation 共享该控制器、同一 TextDocument、同一 apply/history/preview/export 主链。
- 在当前 `editors/vscode-web` PWA 中以原生 Workbench `SimpleEditorPane`/`SimpleEditorInput` 注册 `mmt.guiComposer` editor。Input 只持有资源 URI；源码仍由唯一 TextDocument/Monaco model 持有。桌面首次打开仍默认源码；每个页面生命周期内，视口 `max-width: 550px` 的文档首次打开/恢复自动切到 GUI，用户显式切回源码后不再强制跳回。
- GUI 提供对话/旁白卡片、插入/删除/按钮式移动、人物与资源选择、正文/模式/continued/display-name/avatar 编辑、实时预览、保存、历史和导出。unsupported/opaque 节点只读显示，并提供定位到源码的入口。
- 为 320px 最小产品视口、软键盘、安全区、触摸目标、离线恢复和后台持久化增加浏览器合同；首版不依赖拖拽完成结构操作。

## Affected Capabilities

- `gui-composer`（新增）：定义普通创作者的卡片投影、结构编辑、无损降级、桌面/移动表面与完整创作闭环。
- `language-tooling`：增加完整字节分区的 Composer document projection、snapshot-local target identity 和纯结构化结构命令。
- `web-workbench-shell`：将 GUI 表面接入现有 ViewsService/SplitView shell、唯一 EditorRuntimeController、TextDocument、PreviewArtifactStore 与 PWA 生命周期，不建立平行 owner。
- 依赖但不修改：现有 Preview Composer 命令、Pack/角色图鉴只读 catalog、IndexedDB workspace、Local History、PWA offline、preview/export 合同。
- `web-workbench-shell` 同时固定原生 editor 注册、URI-only input/serializer、桌面源码默认、`max-width: 550px` 首次移动默认与 320px 最小验证边界。

## Non-Goals

- 不新增 JSON/card 持久化格式、第二份 IndexedDB 文档、客户端 AST cache 或由 GUI 自行序列化 MMT。
- 不迁移到旧 `web/` React 编辑器，不新建第二个 Web/App UI 代码库，不迁移 ViewsService shell 到 WorkspaceService。
- 首版不表单化 reply、bond、任意 directive、Typst patch 或全部 DSL；这些内容作为 opaque 高级节点无损保留，并可进入源码编辑。
- 不实现实时协作、云同步、插件市场、Git 工作流、AI 自动创作或新的渲染后端。
- 不以拖拽作为唯一排序方式，不在首版实现多选、跨 opaque barrier 移动、任意节点组合或隐式“注释随卡片移动”启发式。
- 不扩展 DSL comment 或内建 speaker 语法；`comment` wire 类别和显式 `__Sensei` 选择均留待独立语法变更。
- 不在本 change 封装原生 App；PWA 移动闭环稳定后，原生容器可另行提供文件、分享、深链和系统权限能力。