## Context

生产 Web Workbench 已将当前 authored state 固定在一个 VS Code `TextDocument` 与 `mmtfs` workspace 中。Rust language service 拥有 parser、recoverable syntax、semantic analysis、Pack resolve、Composer target/command 与版本化 WorkspaceEdit；Web 侧拥有单一 `EditorRuntimeController`、PreviewArtifactStore、Local History、PWA 持久化和导出。Preview Composer 的 continued、display-name、avatar 和 statement body/mode 命令已经证明：GUI 只传产品 intent，Rust 才能授权并序列化源码。

文档级 GUI 比预览右键编辑多一个风险：它必须枚举、插入、删除和移动节点。Parser AST range 并不天然覆盖节点之间的注释、空白、错误恢复片段或未知语法。如果 GUI 只投影“认识的卡片”，结构操作仍可能错误吞掉邻近注释、把 directive 留在错误位置，或在移动后悄悄改变继承语义。因此 lossless partition 必须先于 insert/delete/move 成为核心合同。

## Goals / Non-Goals

### Goals

- 让 Rust 为一个当前 `.mmt` 快照生成完整、有序、无重叠、无空洞的 Composer document projection。
- 保持 `.mmt` TextDocument 为唯一可变事实源；projection、card state 和 preview 都是版本化派生物。
- 只通过 Rust 结构化命令执行插入、删除、移动和说话人修改，并在返回一个版本化 WorkspaceEdit 前完整重分析候选。
- 建立不依赖 Workbench DOM、指针或移动布局的 `ComposerRuntime`，由桌面与移动适配器共享。
- 第一版覆盖普通对话创作闭环，同时对不支持语法提供可见、无损、可导航的 opaque 降级。

### Non-Goals

- 将 Rust AST、ActorId、内部 resource plan 或可变 parser node 暴露给 UI。
- 让 TypeScript 根据 projection range 拼接、删除或移动源码。
- 自动推断注释属于前卡还是后卡，或跨 directive/error/unknown barrier 重排。
- 第一版支持全部 DSL、任意 visual property 表单、多选/批量编辑或拖拽专属交互。
- 创建第二个 runtime owner、workspace provider、history store、preview store 或持久化 schema。

## Decisions

### 1. Composer document projection 是完整源码分区

Rust core 增加 surface-independent `ComposerDocumentProjection`。对非空源码，节点按 UTF-8 `TextRange` 严格递增，并满足：

```text
nodes[0].range.start == 0
nodes[i].range.end == nodes[i + 1].range.start
nodes[last].range.end == source.len
concat(source[node.range] for node in nodes) == source
```

所有 range 边界必须是 UTF-8 char boundary；CRLF 两个字节不得被拆到不同节点。空文件返回一个显式 empty-document snapshot，wire 上允许 `nodes = []`，但仍以 source digest 证明该快照只对应空字节。

Core 节点至少分为：

```text
Message     已识别的 left/right chat statement 产品描述
Narration   已识别的 narration statement 产品描述
Opaque      当前 GUI 不直接编辑的精确源码片段
```

`Opaque` 使用 allowlisted category：`blank`、`comment`、`directive`、`recoverableError`、`unsupported`。`comment` 是未来 parser 真正识别 comment 后的保留 wire 类别；当前 Rust v2 没有独立 comment syntax，顶层 `// ...` 必须保持 parser `Error`、投影为 `recoverableError` 并保留诊断。未知 category 不由客户端宽松映射。Core 保留每个节点的 exact source slice 以验证 round-trip；wire 不复制任意大的 opaque 全文，只返回精确 range、`sourcePreview`、`sourceTruncated` 和 `summary`。

`sourcePreview` 最多 4096 UTF-8 bytes，并只在字符边界截断；`summary` 最多 160 个 Unicode scalar。导航高级源码时，宿主必须从当前 TextDocument 的已验证 range 读取真实内容，不能把 preview 当作可保存 buffer。

投影使用当前 TextDocument URI/version 与 `sourceDigest = canonical_bytes_digest("mmt-composer-document-v1", &[source.as_bytes()])`。Wire digest 固定为 64 个小写十六进制 SHA-256 字符；TypeScript 必须以同一 length-prefixed canonical framing 对当前 `document.getText()` 重算并比较，而非只验证格式。节点 `nodeKey` 使用独立 domain `mmt-composer-node-v1`，framed fields 依次为 sourceDigest、节点 kind、byte range start/end；它只在当前 snapshot 内有效，不跨 version 恢复，也不替代 target range。

### 2. Trivia ownership 采用保守、可证明规则

节点 partition 在 parser ranges 之上增加 physical-line 分配：

- 原始字节扫描必须记录每行 `content_end` 与完整 LF/CRLF `line_end`；parser range 自身不拥有 terminator。
- 每个 parser node 扩展到其最后物理行的完整 terminator。Chat/Narration 分别成为 Message/Narration；`Blank` 成为 `Opaque.blank`；directive line/block 成为 `Opaque.directive`；Reply、Bond 和当前 GUI 未建模的合法节点成为 `Opaque.unsupported`；`Error` 以及 directive 内的恢复错误成为 `Opaque.recoverableError`。
- Parser 未消费 gap、BOM、文件前后残余字节必须成为 `Opaque.unsupported`，不能丢弃。
- 每条物理 blank line 保持独立 node identity；UI 可以视觉压缩连续 blank，但 runtime partition 不合并。
- 当前 comment-looking 行不做客户端或 projection 启发式分类；它继续是 `recoverableError`。未来 parser 产生真正 comment node 后才启用保留的 `comment` 类别。
- 最后一行没有 terminator 时，节点精确结束于 `source.len`；所有 UTF-8 boundary 与 CRLF indivisibility 必须在 core projection 中验证。

因此第一版删除 Message/Narration 时只操作该节点拥有的 range，不隐式携带前后的 blank/directive/error/unsupported 节点。`moveNode` 同样不携带 opaque 节点，但必须按下述 delimiter reconciliation 重新分配 movable run 内的行尾。将来若产品需要“注释随卡片移动”，必须先有真正 parser syntax，再以显式节点组合/用户选择命令设计，不能加入隐藏启发式。

### 3. Wire projection 只暴露产品描述和严格能力

Language service 增加纯请求 `mmt/composerDocument`：

```ts
interface ComposerDocumentParams {
  textDocument: { uri: string; version: number };
}

type ComposerDocumentResult =
  | {
      kind: "Snapshot";
      textDocument: { uri: string; version: number };
      sourceDigest: string;
      nodes: readonly ComposerDocumentNode[];
      scriptActorChoices: readonly ScriptActorChoice[];
    }
  | { kind: "Rejected"; reason: "staleDocument" | "documentUnavailable" };
```

每个 node 使用 exact-key discriminated union，包含 snapshot-local `nodeKey` 与 LSP `range`。Message/Narration 分开暴露只读产品描述与 mutation capabilities；错误文档仍完整显示卡片，但 capability 可以全部为空。每个 move capability 直接携带 server 授权的目标 boundary；每个 insert capability 直接携带 boundary、允许的 statement kind、side、mode 和 speaker source，UI 不从相邻位置、标签或 Pack 顺序推断权限。

文档级 `scriptActorChoices` 返回 server 认可的显式 reference、display name、primary name、preset id 和当前头像描述。Pack speaker choices 来自现有严格验证的 Gallery Pack catalog；两者提交时统一为 `{ kind: "actor", reference }`。Builtin speaker 只读，不进入 picker。

Opaque wire 只暴露 allowlisted category、有界 `sourcePreview`/`sourceTruncated`/`summary` 与 `canOpenSource: true`。客户端必须验证 exact keys、字符串和数组上限、document identity/version、canonical digest、node key 唯一、range 有序相邻、首尾覆盖、`offsetAt`/`positionAt` 可逆和当前 TextDocument 完整长度。任一失败丢弃整个 snapshot，不能跳过节点、宽松归一化或从 raw MMT/preview DOM 补卡片。

### 4. 结构命令保持统一 envelope、版本化和 Rust 独占序列化

既有 `mmt/composerEdit` property command wire 原样保留；结构命令不增加别名或 sibling request。结构 params 使用以下严格联合：

```ts
type NodeKind = "message" | "narration" | "opaque";
interface NodeRef { nodeKey: string; nodeKind: NodeKind; range: Range }
interface NodeTarget { kind: "node"; node: NodeRef }
interface BoundaryTarget { kind: "boundary"; before: NodeRef | null; after: NodeRef | null }
type SpeakerChoice = { kind: "actor"; reference: string };
type NewStatement =
  | {
      kind: "message";
      side: "left" | "right";
      speaker: SpeakerChoice;
      body: { value: string; mode: StatementTextMode };
      continued: "auto" | "true" | "false";
    }
  | {
      kind: "narration";
      body: { value: string; mode: StatementTextMode };
    };
type StructureCommand =
  | { kind: "insertStatement"; statement: NewStatement }
  | { kind: "deleteNode" }
  | { kind: "moveNode"; anchor: BoundaryTarget }
  | { kind: "setStatementSpeaker"; speaker: SpeakerChoice };
interface StructureEditParams {
  textDocument: { uri: string; version: number };
  sourceDigest: string;
  target: NodeTarget | BoundaryTarget;
  command: StructureCommand;
}
```

Server 对每层对象执行 exact-key、enum、字符串长度与现有 body 最大字节数验证。`insertStatement` 必须配 BoundaryTarget；其他结构命令必须配 NodeTarget。空文档唯一边界为 `{ before: null, after: null }`；开头/结尾边界分别只有 `after`/`before`；内部 boundary 的 `before`/`after` 必须是严格相邻节点。Payload 不含 raw replacement text、任意 byte offset、客户端 TextEdit 或 AST 数据。

Rust 对每个命令执行：

1. 重新加载 URI/version/digest 对应的当前 snapshot；
2. 重新构造 partition，并验证 target/anchor exact match；
3. 检查 operation capability；
4. 由 Rust 生成 canonical source candidate；
5. 使用当前 PackRegistry 完整 parse/analyze candidate；
6. 证明 partition、目标产品语义和全部非目标语义符合该命令允许的变化；
7. 返回恰好一个带当前 version 的 single-document WorkspaceEdit，服务端不 apply、不 retry。

首版 `moveNode` 只允许跨越连续 Message/Narration 节点；target 与 anchor 之间出现任何 opaque 节点时，projection 必须将对应 move capability 设为 false，直接请求返回 `unsupportedStructure`。这避免跨 actor/directive、comment、error 或 unknown barrier 后继承语义漂移。

移动不能简单剪切包含行尾的 target range。Rust 必须对包含 target 与 anchor 的最小连续 movable run 执行 delimiter reconciliation：

1. 确认 run 内所有已存在的行分隔符均为同一种 `E`（LF 或 CRLF）；混合 LF/CRLF 的 run 不暴露 move capability，直接请求返回 `unsupportedStructure`。
2. 记录 run 是否结束于 EOF，以及原 run/file 末尾是否含一个完整 `E`。只有位于 EOF 的 run 最后节点可以没有 terminator；非 EOF run 的最后节点必须以 `E` 与后续 opaque/其他节点分隔。
3. 从每个 terminated movable node 暂时剥离一个完整 `E`，得到不含行尾的 logical payload；不得拆分 CRLF。
4. 按请求重排 logical payload，用 `E` 连接相邻 payload。
5. 当 run 后仍有源码节点，或 run 位于 EOF 且原文件以 `E` 结束时，在重排结果末尾追加一个 `E`；原文件无 final EOL 时，重排结果也必须无 final EOL。
6. 返回一个覆盖该最小 run range 的 TextEdit；除 payload 顺序与按本规则重新归属的分隔符外，所有 statement bytes、opaque bytes 与 EOL style 必须保持。

因此 `A\nB` 中无 EOL 的 `B` 移到首位得到 `B\nA`，`A` 移到末位同样得到 `B\nA`；`A\r\nB` 的对应结果必须是 `B\r\nA`。若原文是 `A\nB\n`，任一交换结果必须保留 final EOL 为 `B\nA\n`。这些是 source construction 合同，不得依赖 candidate parser 偶然报错来阻止粘连。

`deleteNode` 只删除目标 owned range，不删除相邻 Opaque；若删除会使候选非法或改变后续继承/resource 产品语义则拒绝。`insertStatement` 只在 capability 携带的合法 boundary 插入 Rust canonical statement；Message 明确携带 side、Pack/脚本角色 reference、body/mode/continued，Narration 只携带 body/mode。`setStatementSpeaker` 只接受 capability 明确授权的 Message 和 Pack/脚本角色；已有 Builtin speaker 的正文仍可编辑，但不暴露 speaker capability。Choice 不能重新解析或不能精确序列化时返回 `speakerUnavailable`。

### 5. GUI 对不支持内容使用只读高级块

`ComposerRuntime` 将 Snapshot 节点一对一映射为 immutable view state：

- Message/Narration 渲染为可编辑卡片；具体按钮只来自 server capability。
- Opaque 渲染为“高级源码内容”块，显示 category 与有界只读摘要；允许定位到同一 TextDocument range。
- Opaque 节点不能被 GUI 删除、移动或隐式折叠出结构命令；隐藏视觉详情不能等价于从 projection 中删除。
- recoverable error 节点显示错误状态和源码入口；其他无关卡片仍可浏览，但 structure command 是否可用由 server snapshot capability 决定。

GUI selection、展开状态、搜索和移动端 sheet 属于 page-lifetime presentation state；不得持有可独立保存的 card document。每次 WorkspaceEdit 后丢弃旧 snapshot，等待同一 TextDocument 的新 version projection。UI 不乐观修改 authored card 内容；可显示 pending 状态，但最终内容来自新 snapshot。

### 6. 一个 ComposerRuntime 服务原生桌面和移动 presentation

新增纯 `ComposerRuntime`/controller，输入只包含：

- 当前 immutable ComposerDocument Snapshot；
- 现有 Pack/avatar catalog；
- 发送 Composer request、apply versioned WorkspaceEdit、导航源码、打开预览/历史/导出的 ports；
- runtime/document/artifact/cancellation identity。

它不导入 Workbench context-view、pointer、DOM 或移动布局模块。桌面 inspector 与移动 full-screen/sheet presentation 共享 command payload、freshness gate 和 one-shot apply。Gallery Pack 变化只刷新 picker choices；document、Pack 或 runtime identity 变化必须使打开中的 captured operation stale/cancel。

GUI 主表面通过固定的 ViewsService override 公开 API `SimpleEditorPane`、`SimpleEditorInput`、`registerEditorPane`、`registerEditor`、`registerEditorSerializer` 注册为 `mmt.guiComposer`。`ComposerEditorInput` 仅持有 resource URI 并使用 singleton capability；serializer 只保存版本化 `{uri}` envelope，恢复时重新打开唯一 TextDocument 并请求 projection。实施 UI 前必须用实际浏览器 characterization 证明 `vscode.openWith`、GUI/源码切换、单 TextDocument/Monaco model 与 serializer reload；失败不得退回 Sidebar、overlay 或 Webview。

现有 ViewsService + nested SplitView shell 保持不变。GUI surface、subscriptions、controller、media query 和 transient sheets 由同一 `EditorRuntimeController` 获取和逆序释放。当前 TextDocument、mmtfs persistence、Local History、PreviewArtifactStore、Pack catalog、notification service 和 export owner 均不改变。

### 7. 第一版产品闭环和默认入口保持窄而完整

第一版 GUI 支持：

- 打开/创建现有 workspace 中的 `.mmt`/`.mmt.txt` 文档；
- 浏览 Message、Narration 与 opaque 高级块；
- 编辑正文/模式、continued、display-name、avatar，并复用现有 picker/controller；
- 使用 Pack 实体或脚本角色插入消息和修改说话人；Builtin speaker 只读；
- 插入、删除、按钮式上移/下移可移动卡片，不实现拖拽；
- 切换实时预览、查看错误、定位高级源码；
- 使用现有保存、Local History 和 exact-snapshot export；
- 重新加载、离线启动和后台恢复后从持久化 TextDocument 重建 projection。

桌面默认仍打开源码。一个 `.mmt` 文档在每个 page lifecycle/`documentIncarnation` 内首次打开或恢复时，只有 `matchMedia("(max-width: 550px)")` 命中才自动切到 GUI；用户显式切回源码后，该生命周期不再次强制打开 GUI。新 URI 或新 incarnation 重新应用该规则。移动 GUI 打开时可经现有 Part API 收起 Sidebar，但不得取得 shell geometry ownership。

320 CSS px 是必须通过的最小产品验证宽度；550px 是默认表面和移动布局切换点，不是最低支持宽度。移动端必须使用 safe-area inset、`visualViewport` 软键盘可见布局和至少 44 CSS px 的主要触摸目标；card list 是 GUI 的唯一纵向滚动容器，页面/editor pane 不横向滚动。Preview 在移动端使用当前/单一 editor column，保持既有 preview viewport 为唯一 scroll owner。

## Failure Mapping

- URI/version/digest 不匹配：`staleDocument`。
- nodeKey/range/kind/boundary 不再 exact match：`targetChanged`。
- payload unknown/malformed/overlong 或 target-command 组合错误：JSON-RPC invalid params。
- 跨 opaque barrier、opaque target、mixed EOL 或首版不支持结构：`unsupportedStructure`。
- 当前文档或候选含阻止该操作的错误：`documentHasErrors` / `candidateInvalid`。
- Pack/脚本 speaker reference 不再可解析或不可精确序列化：`speakerUnavailable`；avatar 继续使用 `avatarUnavailable`。
- apply 前 version、document incarnation、runtime generation 或 captured catalog identity drift：客户端 stale/cancel，不 retry、不 retarget。

所有失败通过现有 MomoScript notification/status 路径呈现，不增加第二套错误队列。

## Risks / Trade-offs

- **Comment-looking 行不会获得伪造语义**：当前 parser 仍把它诊断为 Error，GUI 以 `recoverableError` 可见且无损展示；只有未来真实 parser comment node 才能使用保留的 `comment` 类别或讨论随卡片移动。
- **不能跨 opaque barrier 移动**：限制自由排序，但避免跨 directive/revision 后隐式改变语义。后续只有在显式组合/语义保持合同成立时扩展。
- **Projection wire 不含 exact opaque 全文**：core 仍以借用/切片保留完整 source 证明 partition；wire 只复制有界 preview/summary，源码入口从当前 TextDocument range 取真实内容。
- **Node key 不跨版本稳定**：UI 必须在每次 edit 后重选新 snapshot；这避免持久 node ID 与文本事实源漂移。
- **GUI 覆盖率有限**：高级作者仍进入源码；opaque 降级保证有限覆盖不会造成数据损失。

## Migration Plan

1. 先修正并 strict-validate 本 change，固定 native editor、comment/error、bounded opaque、canonical digest、统一 edit envelope 和 capability 合同。
2. 落 Rust lossless partition 与 round-trip fixtures，不增加 structure command。
3. 增加 strict native/WASM `mmt/composerDocument`，客户端只读显示 projection 并验证完整覆盖与 digest parity。
4. 逐个加入 insert/delete/move/set-speaker 命令与 candidate proof；每个命令通过 core、LSP、WASM 合同。
5. 建立纯 ComposerRuntime 与 Web controller tests。
6. 先用实际浏览器 characterization 证明 21.6.0 public native editor API，再接入 `mmt.guiComposer`、URI-only serializer 和 550px 首次默认。
7. 完成桌面、551px、550px、320px、保存/历史/离线/导出 E2E 后交付；源码编辑保持高级入口。

无持久数据 schema 迁移：已有 `.mmt` 文档和 IndexedDB workspace 原样使用。