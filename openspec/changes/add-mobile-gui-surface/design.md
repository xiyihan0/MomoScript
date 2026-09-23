## Context

生产 Web Workbench 已将当前 authored state 固定在一个 VS Code `TextDocument` 与 `mmtfs` workspace 中。Rust language service 拥有 parser、recoverable syntax、semantic analysis、Pack resolve、Composer target/command、lossless document projection 与版本化 WorkspaceEdit；Web 侧拥有单一 `EditorRuntimeController`、PreviewArtifactStore、Local History、PWA 持久化和导出。原生 `mmt.guiComposer`、共享 Typst/Tinymist SVG overlay、精确正文编辑、IME 和 native history 已经构成已实现的 SVG-first 架构，不是本轮产品布局文档仍待证明的设想。

下一轮是在该架构上更换交互 chrome，而不是新建 renderer 或第二种文档模型：真实 SVG 继续作为已写消息的最终排版画布；持续新增消息改由固定在底部的紧凑输入区承担。以下新增布局和交互决策均为**计划行为，尚未实现**。Lossless partition、字符几何、版本化 Rust 授权和唯一 `.mmt` TextDocument 合同保持不变；导航中点、旧 nodeKey、平均字宽或 DOM textContent 都不能成为编辑权限。

## Goals / Non-Goals

### Goals

- 让 Rust 为一个当前 `.mmt` 快照生成完整、有序、无重叠、无空洞的 Composer document projection。
- 保持 `.mmt` TextDocument 为唯一可变事实源；projection、GUI presentation 和 preview 都是版本化派生物。
- Rust 独占结构/属性/字符命令的权限、序列化和候选证明；一次文本操作只返回一个 versioned TextDocumentEdit，允许为保留 blank bytes 使用多个不重叠 TextEdit。
- 在原生 GUI pane 内共享现有 SVG runtime，提供精确 caret/selection、逐字、多行、空正文、跨消息/旁白替换、IME 和同一 native model undo/redo。
- 保留普通创作全闭环和 opaque 源码出口；同轮交付跨消息选区，不以单字段 demo、卡片模式或近似 caret 缩减范围。

### Non-Goals

- 将 Rust AST、ActorId、内部 resource plan 或可变 parser node 暴露给 UI。
- 让 TypeScript 根据 projection range 拼接、删除或移动源码。
- 自动推断注释属于前节点还是后节点，或跨 directive/error/unknown barrier 重排/文本替换。
- 支持任意 Typst AST 编辑、不可逆宏生成正文、任意结构节点批量操作或拖拽专属结构交互。跨 Message/Narration 正文文本选区不属于此排除范围。
- 创建第二个 runtime owner、workspace provider、history store、preview store 或持久化 schema。

## Decisions

第 1–12 节记录已经实现并验收过的 SVG-first architecture contracts；第 13 节单独记录下一轮尚未实现的产品 chrome。后者复用前者，不重新打开 parser、renderer 或 source-authority 设计。

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

### 2. Parser 独占正文边界，projection 只分配 range 与 gap

Unfenced implicit Message/Narration 的语义正文边界只由 Rust parser 决定：下一顶层节点或 EOF 前 maximal trailing whitespace-only physical lines 不进入 `BodySyntax` 与 statement range；若空白行后仍有普通 continuation text，则空白行仍在正文内。非空正文行的尾随空白保持原字节。Fenced body 不应用这条 separator 规则，fence 内前导/尾部空白、LF/CRLF 和合法空正文全部属于语义正文。

节点 partition 在 parser ranges 与其源文件 gaps 上增加 physical-line 分配，但不再次裁剪正文：

- 原始字节扫描必须记录每行 `content_end` 与完整 LF/CRLF `line_end`；parser range 自身不拥有 terminator。
- 每个 parser node 扩展到其最后物理行的完整 terminator。Chat/Narration 分别成为 Message/Narration；directive line/block 成为 `Opaque.directive`；Reply、Bond 和当前 GUI 未建模的合法节点成为 `Opaque.unsupported`；`Error` 以及 directive 内的恢复错误成为 `Opaque.recoverableError`。
- Parser 排除的每条 separator physical line 从 source gap 逐行成为 exact `Opaque.blank`；Composer core、language service 与客户端都不得对已解析正文另做 trim/split 来制造 blank node。
- Parser 其他未消费 gap、BOM、文件前后残余字节必须成为 `Opaque.unsupported`，不能丢弃。
- 每条 physical separator blank 保持独立 node identity；UI 可以视觉压缩连续 blank，但 runtime partition 不合并。
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

每个 node 使用 exact-key discriminated union，包含 snapshot-local `nodeKey` 与 LSP `range`。Message/Narration 分开暴露只读产品描述与 mutation capabilities；错误文档仍完整保留产品节点和源码入口，但 capability 可以全部为空。每个 move capability 直接携带 server 授权的目标 boundary；每个 insert capability 直接携带 boundary、允许的 statement kind、side、mode 和 speaker source，UI 不从相邻位置、标签或 Pack 顺序推断权限。新增 `textEditing: { text: string } | null`，由 Rust 提供可精确寻址的 LF-normalized 语义正文；null 节点不能成为正文端点。非 null 不绕过当前版本、范围和 mixed-EOL 写入 gate。

文档级 `scriptActorChoices` 返回 server 认可的显式 reference、display name、primary name、preset id 和当前头像描述。Pack speaker choices 来自现有严格验证的 Gallery Pack catalog；两者提交时统一为 `{ kind: "actor", reference }`。Builtin speaker 只读，不进入 picker。

Opaque wire 只暴露 allowlisted category、有界 `sourcePreview`/`sourceTruncated`/`summary` 与 `canOpenSource: true`。客户端必须验证 exact keys、字符串和数组上限、document identity/version、canonical digest、node key 唯一、range 有序相邻、首尾覆盖、`offsetAt`/`positionAt` 可逆和当前 TextDocument 完整长度。任一失败丢弃整个 snapshot，不能跳过节点、宽松归一化或从 raw MMT/preview DOM 合成节点/能力。

### 4. 结构命令保持统一 envelope、版本化和 Rust 独占序列化

既有 `mmt/composerEdit` property command wire 原样保留；结构命令不增加别名或 sibling request。结构 params 使用以下严格联合：

```ts
type NodeKind = "message" | "narration" | "opaque";
interface ComposerNodeRef { nodeKey: string; nodeKind: NodeKind; range: Range }
interface NodeTarget { kind: "node"; node: ComposerNodeRef }
interface BoundaryTarget { kind: "boundary"; before: ComposerNodeRef | null; after: ComposerNodeRef | null }
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

Server 对每层对象执行 exact-key、enum、字符串长度与现有 body 最大字节数验证。`insertStatement` 必须配 BoundaryTarget；其他结构命令必须配 NodeTarget。空文档唯一边界为 `{ before: null, after: null }`；开头/结尾边界分别只有 `after`/`before`；内部 boundary 的 `before`/`after` 必须是严格相邻节点。结构 payload 不含 raw replacement source、任意 byte offset、客户端 TextEdit 或 AST 数据。

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

### 5. 字符与跨正文选区由 Rust 授权

直接正文端点只属于 resolved mode 为 `textMacro` 或 `textRaw`、并可唯一对应原始正文的 Message/Narration。Typst 模式、不可逆宏生成文本、opaque 节点与无法唯一定位的 rendered occurrence 不提供猜测写入。已有 `setStatementBody` 属性输入合同不放宽：它保留非空、单行及原 Typst-mode 属性路径；空值、多行、逐字和跨节点统一使用新文本命令。

以下类型扩展现有 `mmt/composerEdit`；不是第二 mutation method，也不是现有 `Edit` 分支的兼容 alias：

```ts
interface ComposerTextDocument { uri: string; version: number }
interface ComposerTextEndpoint {
  node: ComposerNodeRef;
  offsetUtf16: number; // LF-normalized semantic body, never raw source
}
interface ComposerTextSelection {
  anchor: ComposerTextEndpoint;
  focus: ComposerTextEndpoint;
}
interface ComposerTextEditParams {
  textDocument: ComposerTextDocument;
  sourceDigest: string;
  target: { kind: "textSelection"; selection: ComposerTextSelection };
  command: { kind: "replaceTextSelection"; replacement: string };
}
interface ComposerTextSelectionParams {
  textDocument: ComposerTextDocument;
  sourceDigest: string;
  anchor: Range; // projection-mapped authored MMT range
  focus: Range;
}
type ComposerTextSelectionResult =
  | {
      kind: "Selection";
      textDocument: ComposerTextDocument;
      sourceDigest: string;
      selection: ComposerTextSelection;
      text: string;
    }
  | { kind: "Rejected"; reason: ComposerEditRejectedReason };
interface ComposerTextEditResult {
  kind: "TextEdit";
  edit: ComposerWorkspaceEdit;
  sourceDigestAfter: string;
  selectionAfter: {
    anchor: { statementRange: Range; offsetUtf16: number };
    focus: { statementRange: Range; offsetUtf16: number };
  };
}
```

`replacement` 是用户正文，不是 DSL replacement；CRLF 和 CR 输入先规范为语义 LF。Rust 逐节点执行 UTF-16 → Unicode scalar → 原始 UTF-8 转换，并拒绝 surrogate 或 grapheme 内边界。使用锁文件已存在的 `unicode-segmentation 1.13.3`；若需直接 dependency，通过 Cargo 更新依赖图，不手改 lock checksum。输入及候选正文仍遵守既有大小上限。

纯读取 `mmt/composerTextSelection` 精确解析两端 authored ranges、正文和可跨越范围，保留 anchor/focus 方向并返回 copy text；TS 不能按相同字符串搜索目标。空正文直接用新 snapshot 已授权 node + offset 0 进入，不伪造 glyph hit。

跨 Message/Narration 规则：

1. 选择保持方向；执行/copy 按源码顺序规范化，允许每端 offset 0 和正文末尾。复制只包含各选中语义正文片段，片段之间加入一个 LF；不含 role 前缀、fence 或 opaque source。
2. 仅相同 resolved body mode 可跨范围。`Opaque.blank` 可以跨越但不被选为正文，其每个物理节点原始字节必须保留。其他 opaque 或不同 resolved body mode 一律 `unsupportedStructure`，包括 copy；不得截断内容假装成功。
3. 替换结果为第一条未选前缀 + replacement + 最后一条未选后缀，放在源码顺序第一条原 envelope，保留其 kind/side/speaker/mode/properties。Rust 删除随后被选中的 statement nodes，但不删除其间 blank nodes。
4. 同节点只允许正文变化；跨节点只允许上述节点减少和第一正文变化。使用现有 PackRegistry、reparse/analyze 与 outside-target 证明，所有其他节点原始字节和 resolved actor/mode/resource 等语义必须相同。若删除导致未选后续消息继承语义变化，返回 `candidateInvalid`，不自动修补后续语句。
5. 返回恰好一个 current-version TextDocumentEdit；允许多个不重叠 TextEdit 保留中间 blank bytes。`sourceDigestAfter` 和 `selectionAfter` 从真实候选重新计算；selection 为 replacement 末端的折叠光标，其 UTF-16 offset 包含第一条保留前缀，statementRange 精确指向候选 statement。客户端不能预测 digest、按 overlap 猜新节点或复用旧 nodeKey。

Enter 与 Shift+Enter 都是正文换行。折叠光标位于正文边界时 Backspace/Delete 不隐式合并消息；只有显式跨正文选择才触发合并。删除全部字符保留合法空 Message/Narration、语义 label bounds 和可点击 caret 区，不能自动删除节点或加入隐藏字符。

### 6. Fenced 正文、引号与 EOL 的可逆序列化

`parser.rs::try_parse_fenced_body` 先确定原始 body_start/body_end，再从 source 取精确切片；仅排除语法规定的 opening-line delimiter，不再条件性拼接 LF。保留 CRLF、前导/尾部正文空行、原 range、合法空 fence 和 unterminated recovery。Raw body 与 LF-normalized wire body 之间有可逆 EOL map；不能用 `trim_end_matches` 丢掉正文尾部换行。

Rust 正文序列化规则：

1. 当前无 fence 且修改后仍能逐字 reparse 为目标正文时保留 inline；否则转 fenced envelope。特别是语义末尾 LF 不能借 unfenced separator 表达，必须用 fence 将该 LF 保留在 body range 内。
2. Delimiter 长度 `N = max(3, 正文最长连续引号数 + 1)`；opener 独立一行，避免正文开头引号被吞进 opener。保留原模式前缀，包括 inherit，不擅自改为显式模式。
3. 非空正文 closer 紧随最后一个正文字符，空正文 closer 位于 opener 的下一行。正文末尾 LF 自然使 closer 出现在下一行，不额外追加一个正文换行；六个相邻引号仍按 opener 解析，不能表示空正文。
4. `find_fence_close` 扫描完整 quote run。Run 长度至少 N 时，最后 N 个引号才是 closing delimiter，之前的引号属于正文；短于 N 不关闭。这是明确的 parser 行为变更，必须覆盖末尾 1、2、N−1 个引号、内部短 quote runs、正常历史 fences 和未闭合恢复，不能用追加正文换行回避。
5. 新插入换行优先用正文既有统一 EOL；无正文 EOL 则用 statement terminator；再无则用文档首个 terminator，空文档用 LF。混合 EOL 正文可以展示/复制，但不授权直接修改，返回 `unsupportedStructure`。不能顺便规范化未选字节，文档 final-EOL 状态必须保持。

新 `composer_text.rs` 保存正文选区解析与原子编辑，但复用现有 AST、projection 与 candidate proof，不创建第二份 AST。Rust core/LSP 的 service/server、stdio/WASM、browserWorker 以及 `composerDocument.ts`/`composerEdit.ts`/`composerRuntime.ts` 必须同一 cutover 更新 exact-key request/command/result、编码转换与 dispatch；未知字段/enum 全部拒绝。

### 7. SVG 是唯一主创作画布，而不是唯一输入控件

原生 `mmt.guiComposer` 的主内容保持真实 Typst/Tinymist SVG；已写 Message/Narration 的点击、光标、选区和正文修改继续发生在最终排版上。底部新增消息输入区属于同一 GUI 的输入 chrome，不是卡片列表、第二画布或第二文档。主卡片列表的 renderer、events 与 CSS 仍应删除而非藏在模式开关后。HTML 可以承担 caret/selection、IME 临时文本、下一轮底部输入区、紧凑工具组、上下文菜单、Picker/Sheet 与源码入口。

Projection 所有节点仍有明确产品/源码对应；unsupported/recoverable 内容具有可发现的高级源码 affordance 和当前 TextDocument range。Blank 可以紧凑展示，但保留独立 identity、结构移动 barrier 和跨文本操作的精确保留规则。不能从图中“不显示”推导源码已不存在。

点击已有正文优先进入已实现的精确 SVG 正文编辑，不同时触发 source navigation，也不得用永久 inspector 或另一份表单替代。点击已有头像、名字、气泡或旁白标签时，speaker/mode/avatar/display-name/continued 仍走现有 Picker/Sheet/PreviewComposer 与 Rust 语义命令。单条选择的操作采用靠近选择对象的上下文入口；批量排列是显式进入和退出的独立模式，不能把复选框、上移/下移工具条或全量属性表单永久铺在画布上。Typst/opaque 的源码编辑器仍是高级出口，不新增通用 Typst AST editor 或内嵌 Monaco Lens。

`ComposerRuntime` 仍是 surface-independent orchestration owner，不拥有 DOM、Workbench context-view、底部 draft 的持久副本或独立文档。桌面/移动共享当前 snapshot、Pack/catalog ports、结构/属性命令与拒绝映射；文本子会话只处理已有正文的授权 selection 和事务状态。新增消息只在发送时通过当前 snapshot 的 Rust `insertStatement` 能力进入 canonical source。

### 8. 同一 preview overlay 在原生 pane 间重挂载

`mmt.guiComposer` 仍通过 `SimpleEditorPane`/`SimpleEditorInput` 注册；input/serializer 只保存 `{version:1,uri}`，不保存正文、selection、nodeKey 或 IME 草稿。原生 pane 是 shell 容器；SVG 内容由现有 PreviewWebviewHost 的唯一 `IOverlayWebview` 提供，不再由专属 WebviewPanel 拥有传输。

GUI 的 `openWith` 与 `keepEditor` 完成后必须 flush Workbench 已注入的同一个 `IStorageService`，使 URI-only input 与 pin 状态在返回前 durable；PWA safe restart 在 reload 前也 flush 这一实例。这里不引入另一份 editor-state storage、持久化队列或 retry subsystem。

启动先等待 `IEditorGroupsService.whenRestored`，再判断是否需要 remembered-source 或 intro fallback；已由原生 serializer 恢复的 GUI input 必须胜出，不能被 fallback 覆盖。恢复的 pane 可以先 mount，但首次 `syncPreviewSurface`/SVG source bind 必须等初始 Pack registry 同步落定（包括已验证的 empty-registry fallback），之后才请求 `mmt/getTypstRenderProject`；该门槛不依赖自动预览是否开启，并继续复用既有 Pack fallback 合同。

`previewWebviewHost.ts` 通过同一 VS Code `IWebviewService.createWebviewOverlay` 创建一次 overlay，保持 `retainContextWhenHidden:true`、scripts、localResourceRoots、CSP、ready/publication ACK/resync/committed generation 合同。传输改为 `setHtml`/`postMessage`/`onMessage`（读取 `event.message`），URI/CSP 使用同一 VS Code 的 `asWebviewUri`/`webviewGenericCspSource`。

```ts
attachSurface(claimant: object, container: HTMLElement, clippingContainer: HTMLElement): void;
releaseSurface(claimant: object): void;
layoutSurface(claimant: object): void;
```

内部使用 `claim(claimant, mainWindow, undefined)`、`layoutWebviewOverElement` 和 `release`。旧 claimant 释放不得关闭新 claimant；pane 隐藏/切换不销毁 iframe，只有产品 runtime dispose 销毁 shared overlay。ResizeObserver、pane/window resize、shell part visibility/layout 变化触发布局，使用 clippingContainer，不能覆盖 Sidebar/其他 editor group。

新 `previewHostPane.ts` 按现有 native pane 模式注册 `mmt.previewHost`，供源码侧只读预览；它只是另一挂载目标，不拥有 renderer/session/store。`main.ts` 由一个集成负责人将 source/render/export binding 提取为 `bindPreviewSource(document)`；GUI 打开/激活也调用。GUI 的“预览”只聚焦当前 SVG，源码侧预览才打开旁边 native preview pane；source→preview navigation 保留。删除 panel-only open/reveal/close 与 ViewColumn 辅助，fixture reveal/export callsites 同步迁移。

使用 native `IEditorService.onDidActiveEditorChange/onDidVisibleEditorsChange` 判断 GUI 激活，不能只依赖 TextEditor 事件。一个 overlay 仅显示一个 active document，其他 GUI pane 提供可聚焦 inactive placeholder。切换后先验证 sourceUri/identity 再收输入，不得把 A 的旧图当 B 的编辑图。

### 9. 几何以真实 characterization 为门槛

先沿 `e2e/preview-interaction.spec.ts`、`e2e/fixtures.ts` 的 live document、frame readiness 和 glyph 点击路径，在 `.tmp` 临时脚本中记录 click→MMT offset、offset→caret、range→rectangles。样例覆盖 ASCII/CJK/emoji/组合字符/比例字体与长行/fenced 多行/重复文本、offset 0 与末尾、缩放与重排。实验只测能力，不先改 vendor；cursor 数量与平均字宽不是通过证明。

本轮 baseline 已在真实 Google Chrome 151.0.7922.108（headless，沿既有 fixture 的合成 pointer 路径）完成，实验进程 exit 0，但能力门槛失败：初始精确边界点击仅 63/93 通过；`WiMiWi` DOM caret 相对 SVG glyph advance 在 offset 5 误差为 5.370695 CSS px、offset 1 为 1.925096 CSS px，超过 1 CSS px。Typst control 的六个不同 offset 返回同一 navigation point，证明现有 source navigation 不是 caret 查询。12 次 pointer probe 独立触发 Tinymist location query panic，每次均记录并恢复真实 runtime 后才继续，最终证据不沿用早期 poisoned-worker 结果。Offset/range、zoom/reflow、empty-body bounds 的矩阵均已记录；空正文保留 label bounds，但没有可伪造的 glyph caret。以上实测要求启用下述 renderer 补丁分支，不能降级为近似 caret；此实验不是 OS IME 验证。

新 `composerTextGeometry.ts` 为纯几何/映射适配器，不拥有源码/编辑权，固定端口：

```ts
hitTest(point, uncertainty, identity, signal);
caret(endpoint, identity, signal);
selection(selection, identity, signal);
move(selection, direction, granularity, extend, preferredX, identity, signal);
```

Identity 必须绑定 sourceUri/version/sourceDigest、renderKey、renderer session/generation。`hitTest` 的 canonical `PreviewRendererPointUncertainty = {x,y}` 与 point 同为 normalized page units，两个分量必须 finite 且位于 `[0,1]`；缺失、未知字段、非有限或越界值一律拒绝，不默认或 clamp。它只用于扩大 native containment：命中的精确 glyph stop、source、affinity、distance 与 nearest-stop 选择不变，扩展后相交的不同 source cluster 仍按歧义 fail closed。Native SVG page extent 先取 `D = ceil(f32(extent))` 再归一化/反归一化；不得用非整数 native extent 偷换分母。普通导航的 `PreviewPagePoint`/`PreviewRendererPoint`/Rust `PreviewPoint` 合同保持不变。结果为 authored 位置或已授权语义端点和 normalized page `{pageIndex,x,y,width,height}` boxes；caret 另含 `affinity:"before"|"after"`。空结果为 unavailable，不能回退 statement 中点。复用 `.tsel` normalization、glyph bounds、preview text location 与 source mapping；DOM 只测空间，推导 offset 必须绑定 Rust 正文、具体 projected span 和 renderer identity，不按全页 textContent 搜索。

```ts
type ComposerTextProjectionParams =
  Omit<PreviewComposerTargetParams, "location"> & {
    selection: ComposerTextSelection;
  };
type ComposerTextProjectionResult =
  | {
      kind: "Mapped";
      anchor: PreviewBackendLocation;
      focus: PreviewBackendLocation;
      segments: PreviewBackendLocation[];
    }
  | { kind: "Rejected"; reason: ComposerEditRejectedReason };
```

纯读取 `mmt/composerTextProjection` 使用 `typst_backend.rs` 现有 projection identity gate 和 `emit.rs` source-map origins。只返回唯一、可逆正文片段，按 emitted escaped text 的字符边界转换；fence/Typst wrapper 不进入 selection，多段不压成跨 wrapper 的大 range。全部 identity 字段保留，不凭客户端正文搜索补映射。

前导、连续或末尾 LF 形成的**语义空行**需要明确的 generated layout anchor，因为上游会丢弃空文本 source span。Typst 0.15 的真实 compile/query 已验证 `#box(width:0pt)[#text("")#metadata((mmtTextCaret:N))]` 保留实际 hard-frame 空文本 strut/baseline，且不引入任何字符。Emitter 仅为这些语义空行生成该 metadata-only anchor；N 是空 text literal 内的 generated UTF-8 offset，经 collapsed `TextBody` origin 精确对应 authored raw LF boundary。Metadata、box 和 wrapper 不成为复制正文或任意 source-edit range；不修改 authored MMT、不插入 sentinel，也不建立第二份 source state。Parser 已排除、由 projection 表示为 `Opaque.blank` 的 formatting separator 不是语义空行，不生成 anchor 或气泡正文行；若 separator 错入正文，必须修 parser boundary，不能用模板 padding、Composer trim/split 或 compiler/runtime 特判隐藏。Renderer 必须读取真实 semantic-empty-line box extent、baseline 与累计 transform，不以平均行距、邻行推算或虚构 glyph 代替。

每例 hit offset 必须正确；有 glyph 的 caret 落在 glyph advance 边界且 CSS 测量误差不超过 1 px，语义空行 caret 使用上述真实 layout anchor；selection 只覆盖目标行；缩放/重排后重新查询仍对应同一语义选区。整条空正文仍可用 semantic label bounds 的显式 GUI 空区；重复文本不能串消息；比例字体/ligature 或空行均不得用平均字宽/行距近似。

由以上实测触发的唯一底层分支：在 `third_party/tinymist/pin.json` 的 fork source revision 中实现 `mmt/previewRenderer.v1` 的 `hitTestText`（normalized page point + required `uncertainty:{x,y}` → source caret + affinity）、`locateCaret`（uri/position/affinity → caret boxes）、`locateRange`（uri/range → selection boxes）。三者均要求且回显 committed sessionId/generation，输出 page-normalized coordinates，支持一处源码多个 rendered occurrences，不提供 edit plan。`hitTestText` 必须严格验证 uncertainty 的 exact keys、有限性与 `[0,1]` 范围，不能默认或 clamp；Frame traversal 累计 group transform，按 glyph cluster span/advance 定位并解析字符串转义偏移。Uncertainty 仅扩展 containment，不改变精确 stop edge/source/affinity/distance 或 nearest-stop 排序；扩展后出现多个不同 source 仍拒绝。坐标按 `ceil(f32(native page extent))` 归一化；不能精确归属的 span 必须拒绝，不取 AST 节点中点。视觉上下键以 caret/line geometry 保持 preferredX，无需移植通用 navigation/AST service。

同步 `previewRendererProtocol.ts`、`tinymistCapabilities.ts`、`previewRendererSession.ts` 和 native/WASM process/worker 合同；将 renderer 实现作为普通 commit 推送到 `xiyihan0/tinymist` 的维护分支，更新完整 `source.revision`，再从 clean exact checkout 走 `build-tinymist-artifacts.mjs build-promote`/`repin`。Repin 从新产物取得 decoded identity，消费 publication prepare manifest 更新 encoded digest/size/URL，不手填 hashes；不再 capture/apply patch，也不使用 submodule。仅在另行授权后发布新 digest 不可变 runtime 制品，不部署站点；无凭据不绕过校验。Workbench runtime-delivery 必须消费并验证新制品，不能仍读取旧 CDN。若未来重新执行此实验并全部通过，则该条件分支不做；当前已触发，不在本轮跳过。

### 10. 串行文本输入、跨消息剪贴板与 IME

新 `composerTextSession.ts` 是 ComposerRuntime 子对象，状态限于当前授权 selection、递增 sequence、pending semantic intents、composition、几何反馈和 native history presentation bookmarks，不复制持久正文。语义 `ComposerState` 保持这些既有字段且不保存屏幕精度；仅 host→webview 的 `ComposerStateMessage` 增加 required `screenCoordinatePrecision:number`。Webview 消息严格为：

```ts
{ type: "composer-intent", sessionId, sequence, renderKey, intent }
{ type: "composer-state", sessionId, sequence, renderKey,
  status: "ready" | "pending" | "blocked", carets, boxes,
  screenCoordinatePrecision }
{ type: "composer-drained", sessionId, sequence }
```

具体 outer message discriminator 沿既有 `previewWebviewProtocol.ts` 约定使用；消息名固定为 `composer-intent`/`composer-state`，另有只确认传输排空的 `composer-drained`，不新增同义 envelope。Intent 固定为 `pointer`（phase start/move/end/cancel、point、extend、归一化 `clickCount:1|2`）、`move`（direction left/right/up/down、granularity grapheme/word/visualLine/document、extend）、`replace`（typing/paste/cut 只带 text、origin；delete 必须带 `text:""`、`origin:"delete"`、`direction:"backward"|"forward"`、`granularity:"grapheme"|"word"`）、`composition`（phase start/update/end/cancel、text）、`history`（direction undo/redo）、`copy`。`clickCount` 显式区分单击与双击词选择，不由宿主按时间间隔猜测，也不携带 raw source/text。Delete 的 direction/granularity 让宿主区分折叠光标的正文内删除与已显式选中的跨正文删除；不能用合成 move+Backspace 产生隐式跨消息合并。非 delete replace 必须拒绝多余 direction/granularity，delete 必须拒绝非空 text、缺失或未知 deletion 字段。严格 exact-key producer/consumer 按 variant 同步迁移，不增加用户可见模式。消费入口验证 exact keys、size、sequence、session、identity；不接收 DOM text 作为源码、任意 TextEdit 或 raw MMT range。

Pointer intent 还必须携带 exact `uncertainty:{x,y}`；其 finite `[0,1]` 分量由 host 顶层 Float32 `screenCoordinatePrecision` 与实际 PointerEvent local Float32 precision 组合，再以 inverse SVG CTM 绝对行和保守映射为 normalized page uncertainty，不能使用固定 CSS-pixel padding。Host 必须在 overlay layout/resize 时刷新 wire precision；touch-handle 等合成 native caret sample 使用 `{x:0,y:0}`。该字段逐层原样传给 geometry/native renderer。

Webview 以 HTML caret/selection overlay 和 caret 附近透明 textarea 桥接输入，不保存正文。Pointer hit → existing mapping → Rust selection read → host 授权 selection；支持 Shift、双击词选择、视觉上下/Home/End、Pointer Events 拖选和边缘滚动。Drag 可合并 latest point；已经接受的文字 intent 不可丢弃。

每个文字 intent 串行：当前授权 selection → `replaceTextSelection` → 严格验证结果 → 一次 apply → 等新 document/snapshot → 用候选 digest 和 exact statementRange 恢复新节点 → 下一个 intent。自身预期 document event 更新会话但不关闭输入桥；外部编辑/切文档/Pack 变化取消授权，停止自动 apply pending。普通输入按事件提交，不用 300ms 整字段防抖；render queue 保持 latest-wins，授权输入队列必须按序无损。Mapping pending 可保留旧视觉 caret，但旧几何不授权新指针编辑。

Host 从所有 Rust TextEdit 计算 exact candidate 并校验 `sourceDigestAfter` 后、实际 mutation 前，runtime 只在当前权限检查成功时登记一条包含该 candidate bytes 的 pending expected-change。Document event 必须以实际 `document.getText()` 与 candidate 完全相等，并同时满足 incarnation/version/signal gate，才可归类为 own edit；不能依赖 Monaco `contentChanges` 的数量、range 或数组形状。空 candidate 同样有效。

指针必须匹配当前 committed renderKey/geometry。文字 intent 则可引用同一未中断授权会话中实际发布过、尚未退休的 renderKey；自身重渲染不是语义冲突，不能把已发出但尚在途的按键当 stale 丢弃。首次收到较新 key 的有序 intent 后可退休更早 key；未知 key、外部冲突及退休会话不得再授权修改。无论渲染快慢，源修改仍按 selection、sequence、Rust 候选 digest 和新 snapshot 的 FIFO 证明执行。

Iframe 处理 blocked state 后发送 `composer-drained`，sequence 为最后发出的 intent sequence；同一发送通道的 FIFO 保证该 ACK 前的 intent 先到达。Host 对 known-session 的每个新 sequence 显式执行 admission；即使因 pending/stale geometry 拒绝 pointer，也必须回传该 sequence 的 blocked acknowledgment 并撤销旧 selection authority，不能无响应卡住 gesture。拒绝 pointer 前已经接受的文字仍须先排空；其后的文字既不能重用旧 selection，也不能 retarget 到新文档。Host 在已发出的会话身份与序列约束下，将旧会话在途文字路由到原会话的 recovery-only 路径，绝不重定向到新文档；收到匹配 ACK 后释放旧路由。每次 blocked 后重新开放 admission 都使用新 activation sessionId，普通 pending→ready 重渲染不换会话。Focus/Sheet/blocked transient 的 admission pause 必须持续到已接受工作 settlement/retirement 完成，过期 drain 不得取消较新的 IME；IME 末尾 update/end 使用稳定 recoveryId 更新同一临时恢复块，不能追加重复草稿。

IME compositionstart 捕获 selection/version；update 只更新临时输入/候选 overlay，不申请 WorkspaceEdit；end 一次 replace 并去重随后 input；cancel 不改源码。重排不能重建 textarea、夺焦点或重置 composition；不创建临时 MMT/Typst 编译副本。真实提交后由 Typst SVG 替换临时 HTML。Blur 时若 oversized composition 无法序列化为 cancel/recovery payload，必须先保留完整、可复制的本地 draft 再清除 composition；不得截断 draft 或修改 source。

Copy/Cut 使用 Rust read 的 plain text；cut 必须 clipboard 写成功后才删，权限失败文件不变。Paste 一律正文，即使含 `>`、`@` 或引号也交 Rust 序列化，不解释成 DSL。任何跨 barrier 失败不得部分 copy/replace。

外部冲突、后端失败、invalid candidate 保留未提交输入为可复制临时恢复内容，通过现有 notification/Sheet 说明原因；不跳到相似消息，不静默丢字。关闭/切换有 pending 时先等待队列或提示复制/丢弃，不把 IME 草稿写入持久 workspace。

恢复块仅留在内存中，绑定稳定 ID；原生通知、状态栏和命令面板的“恢复未提交文字”提供复制/显式丢弃，关闭提示不丢数据。复制必须观察真实浏览器 clipboard Promise 成功；不能用吞掉权限错误的包装器授权 cut 或清除恢复块。安全更新先停止 admission、排空已接受输入并保存 canonical 文档；有未解决恢复块时拒绝重启。窗口关闭对未提交输入使用 beforeunload 保护，不把草稿另存为持久模型。

### 11. 同一个 native model 的原生 undo/redo

`composerEdit.ts::applyComposerTextEdit` 复用严格 edit parser，先由 Rust edits 计算 exact candidate 并校验 `sourceDigestAfter`，apply 前校验 URI/version、model version、sourceDigest，再把 candidate 传给同步 `canApply(candidate)` gate。Runtime 只在该 gate 的当前权限检查成功时记录 candidate。通过 IModelService 取同一个 MMT model，只将 Rust edits 交给 `pushEditOperations`；无 model 时通过既有 openTextDocument/模型服务载入同 URI，不创建副本、不 `setValue`、不由客户端序列化正文。执行 `pushEditOperations` 的同步区间内临时用 model supported options API 关闭 `trimAutoWhitespace`，在 `finally` 恢复此前值；不能全局更改用户设置。离散 property/structure 仍使用既有 workspace.applyEdit，原 `Edit` 分支不改成 alias。

同一会话且 selection 连续的 typing 归为一组；750ms idle、pointer/navigation、换行、paste/cut、IME、结构操作和焦点切换都关闭边界。组前后用 `pushStackElement`，组内不逐键 push，传 before/after source selections。`pauseInput` 与 transient pause 必须先排空此前已接受 typing，再关闭 undo boundary 和解除 pause；不能在 drain 尚未 settlement/retirement 时提前分组或允许 obsolete drain 影响新 composition。IME commit 和一次跨消息替换各是完整组。原 model undo/redo 是唯一历史；presentation bookmark 按 model alternativeVersionId 恢复 GUI selection，不建独立 undo stack。外部编辑和离散 Composer 命令先结束文本组。

### 12. 重排恢复、移动端与生命周期闭环

接受每个新 render artifact 后，用当前新 snapshot selection 重新查询 geometry，不沿用上一帧 normalized point。保留 rendered occurrence、selection direction、preferredX 和 viewport anchor；新位置不可用则 blocked + source entry，不跳同文消息。输入仅在 caret 离开可见区时滚动；主动滚动取消迟到 reveal。Zoom、SVG diff/full resync 和 resize 都重算 overlay。

桌面默认源码；`matchMedia("(max-width: 550px)")` 的 URI/document-incarnation 在 page lifecycle 首次打开/恢复默认 GUI，用户显式切源码后不反复强制。320 CSS px 为最小验收宽度，保留 safe-area、`viewport-fit=cover`、44px targets 和可达 Sheet。SVG preview viewport 为主画布唯一滚动 owner，移除 card-list scroll owner，无外层横向溢出；软键盘通过 visualViewport 和当前 caret reveal 处理。Touch selection handles 复用宿主语义选区，不依赖 iframe 内跨 foreignObject 原生选区。

Input/Sheet/drag/clipboard 在 runtime quiesce/dispose 停止新工作，所有 owned subscriptions/overlay 按原 disposal graph 释放。已 apply 文本进入现有持久化、History 和 PWA；不新建存储。Export 只使用已确认 canonical revision，未提交 IME 不进入文件或 PDF。

### 13. 下一轮 icon-first chat chrome（计划，未实现）

#### 13.1 参考产品只提供交互取舍

MoeTalk（<https://moetalk.xiyihan.cn>）与 U1805 Momotalk（<https://u1805.github.io/momotalk/chat>）截图确认了三项可迁移原则：对话成品应占据绝大多数视觉空间；连续新增消息需要固定、低摩擦的底部输入；常用角色应以头像快速切换，而不是反复打开大型表单。这里只采用信息层级和交互节奏，不复制其聊天 renderer、皮肤、数据模型或源码行为。

`editors/vscode-web/.tmp/ui-design/gui-panel-concept-a.webp` 与早期 `gui-wireframe-a.svg` 是被反馈否定的探索物，不是规范资产。Concept A 仍然过大、文字按钮过多，不能作为尺寸、组件或实现参考，也不能据其生成新的聊天 renderer。

#### 13.2 桌面布局

桌面从上到下固定为三个区：

1. **纤细顶栏**：只保留文档名/保存或同步状态等短状态，以及 undo、redo、export、more 的图标组。动作按语义分组并留出间距，不使用一排大型说明文字按钮；低频和陌生动作放入带文字的菜单。
2. **主 SVG 画布**：占据剩余空间并继续是既有消息的最终排版、点击和编辑表面。没有永久角色侧栏、永久属性 inspector、逐条复选框或常驻排列工具条。
3. **紧凑底部 Composer**：第一行显示当前角色头像、默认单行且随内容增长的输入框、image 图标和 send 图标；其下是紧凑分组工具与水平角色头像 tray。Image 的最终命令语义只能复用届时已有的授权资源能力，未验证前不能扩展 DSL 或伪造本地消息。

#### 13.3 移动布局

移动端保留同样的三个区域和操作语义，不降级成另一套卡片 UI。顶栏可压缩分组，SVG 仍是唯一主画布滚动 owner；底部 Composer 留出 safe-area，并随 `visualViewport` 和软键盘保持输入、发送与当前 caret 可达。320 CSS px、至少 44 CSS px 的主要触控目标、无外层横向滚动和既有触控选区合同继续成立。

移动键盘的真实设备细节、精确图标顺序、tray 在极窄宽度下的折叠/滚动微规则仍须原型和实机验证；这些开放项不能被某张探索图提前定案，也不能改变唯一 source 或 Rust 授权边界。

#### 13.4 新消息与已有消息是两条明确流程

- **新增消息**：作者在底部 Composer 选择角色并输入 draft；选择角色本身和每次按键都不创建 projection node、不写 MMT。点击 send 时，宿主针对最新 URI/version/digest 重新取得当前合法插入 boundary、角色和模式能力，并提交一个 Rust `insertStatement`。只有 WorkspaceEdit 成功应用并出现新 snapshot 后才清除已发送 draft；失败或 stale 时保留可恢复文本，不在画布中制造乐观消息。
- **编辑已有消息**：作者直接点击 SVG 正文，继续使用已实现的精确几何、选区、IME 和 native undo。选择头像/气泡/标签显示与该对象相邻的上下文动作；编辑期间底部未发送 draft 及当前新消息角色选择必须保留，不能被旧消息正文或属性值覆盖。
- **结构操作**：单条删除、属性和可用移动入口只在上下文中出现；需要多条选择/排列时显式进入 bulk arrange mode，并提供清楚的退出。该模式仍只发送 server capability 授权的结构命令，不允许拖拽、复选状态或视觉顺序取得源码权限。

#### 13.5 角色 tray 由使用行为自动维护

角色 tray 不是用户维护的“收藏夹”。当前 runtime presentation scope 中被选中的角色会自动进入 tray，包括只选择、尚未发送消息的角色；新增条目不得重排已有角色，确保位置稳定。Teacher/Sensei 的独立 quick-switch affordance 是已确认产品原则；完整角色库通过按需 Picker/Sheet 打开，不常驻占用画布侧边。当前结构 wire 不把 Builtin speaker 放入 picker，因此 quick switch 的提交映射必须在实施前通过 Rust server capability 明确解决，不能由客户端拼出 `__Sensei`、伪造 actor reference，或用一个无法发送的视觉按钮冒充完成。

Tray 只保存角色选择的 presentation state，不改变 `scriptActorChoices`/Pack catalog，也不授予 speaker mutation。角色在最新 catalog 中失效时按既有 `speakerUnavailable`/Pack 漂移规则处理；UI 不保留一个可绕过 Rust 的旧 reference。跨 reload 是否恢复未发送 draft/角色 tray、恢复多长时间以及使用哪个既有 storage owner 属于待验证策略，不在此轮文档中暗示已实现或另建存储。

#### 13.6 Source、draft、history 与导出不变量

`.mmt` TextDocument 始终是唯一 canonical authored state。底部 draft 是可丢弃/可恢复的 transient presentation state，不是第二份 canonical document、client AST、隐藏 projection node 或 preview 输入。它必须在用户编辑已有 SVG 内容时保持不变，但在发送成功前不得进入 save、Local History、native undo/redo、render 或 export；发送成功后产生的普通 TextDocument edit 才由这些既有 owner 观察。GUI/source 切换和已有正文编辑继续共享同一 native model 与 undo 栈。

URI-only editor serializer 仍不得持久化 draft。Draft 在关闭、reload、冲突和安全更新中的最终保留政策尚未由用户确认；实施前必须在“不静默丢失”和“不建立第二 canonical source”之间给出可验证方案，并与既有未提交输入 recovery 合同一致。

#### 13.7 可访问性与未决细节

所有纯图标按钮必须有稳定 accessible name；桌面提供 tooltip；触控目标满足现有尺寸要求。图标不能只靠颜色或位置表达 disabled/selected 状态。陌生、破坏性或低频动作可以且应该在菜单/Sheet 中显示文字；icon-first 不等于 icon-only everywhere。

已确认原则是 SVG 主画布、紧凑顶/底 chrome、底部连续新增、上下文编辑、自动角色 tray、独立 bulk arrange mode 和唯一 source。尚未确认的是移动软键盘实机行为、精确图标顺序、tray 的窄屏微布局以及未发送 draft 的跨生命周期持久策略；实现和验收必须把这些列为开放决策，不能自行补成产品功能。

## Failure Mapping

- URI/version/sourceDigest 不匹配：`staleDocument`；nodeKey/range/kind 或无法唯一精确定位：`targetChanged`。
- Wire unknown/malformed/overlong 或 target-command 不匹配：JSON-RPC invalid params；合法形状中的正文 offset 越界、surrogate/grapheme 内边界或非法正文值：`invalidValue`。
- 非正文、不同 resolved body mode、非 blank opaque、mixed-EOL 正文写入或既有不支持结构：`unsupportedStructure`。
- 当前文档/候选阻止该操作：既有 `documentHasErrors` / `candidateInvalid`；未选节点继承语义漂移必须 `candidateInvalid`，不修复。
- Speaker/avatar 无法重新解析：既有 `speakerUnavailable` / `avatarUnavailable`；不新增并行 rejection enum。
- Apply 前 model/document incarnation/runtime/catalog 漂移：客户端 stale/cancel，不 retry/retarget；文本 pending 保留可复制恢复内容。
- 未 committed 或过期 renderer identity/geometry：unavailable/blocked，不用中点/旧画面获取编辑权。

失败仍走现有 MomoScript notification/status/Sheet；不增加第二错误队列。

## Risks / Trade-offs

- Lossless/Opaque 与 snapshot-local identity 不变；可见 SVG 不是完整源码分区，也不能替代节点身份。
- 跨文本只允许 blank，结构移动仍不能跨任何 opaque；两个规则不能混淆。跨文本不修补后续继承语义，合法输入也可能因 candidate proof 被拒绝。
- Parser closing-run 消歧改变历史歧义输入的解析，必须用显式 fixtures 证明 trailing quotes、正常 fences 与 recovery；不能偷偷追加正文 LF。
- 几何 baseline 已触发 renderer 分支；没有精确新 runtime 不得交付近似表面。Tylina 0.15.2 只作静态架构参考，不复制代码、不运行其二进制或引入 sidecar。
- OS IME、真实 Chrome 或 runtime publication 凭据缺失时，完成可达实现/验证并明确列出未验证/阻塞项；合成事件、旧 CDN 或 typecheck 不能冒充验收。

## 已实现架构的历史 Migration Plan

以下步骤保留为第 1–12 节既有实现的交付记录，不是第 13 节 icon-first chrome 已完成或已部署的声明。下一轮未完成实施与验收只以 `tasks.md` 第 14–15 节为准。

1. 在本 change 冻结 SVG-first 产品/wire/parser/acceptance 合同，重新打开受影响任务；运行 strict OpenSpec，并完成真实 geometry characterization。当前已观测几何失败要求 renderer 分支。
2. Rust/core/LSP 定义文本端点、read/edit/result、可逆 fenced/EOL、候选 proof 与 stdio/WASM exact-key cutover；先查 exported symbol references，不做客户端兼容层。
3. 合同冻结后并行推进 core/LSP、shared overlay/native panes 和 geometry/renderer；`main.ts`、共享 wire 与规范只设一个集成负责人，分支编辑期间不跑全局 build/lint/suite。
4. Core/wire 一致后接 input session、原生 history、跨消息/IME；几何实现作为普通 fork source commit 推送并更新完整 source pin，再由 `build-tinymist-artifacts.mjs` 的 build-promote/repin 与独立 runtime publication owner 生成制品，不 capture/apply patch、不手改 vendor/digest。
5. 按既有 Rust core/LSP、MMT WASM vendor、native/WASM contracts、TypeScript checks、runtime-delivery、production build、preview/gui/lifecycle/PWA E2E 顺序集中验证；源码、History、Pack、Export、PWA owner 不换。
6. 留下 ASCII/CJK/emoji/组合字符、fence/newline/empty/CRLF/final-EOL、跨消息正反向/blank/barrier/继承、快输入/延迟/stale、真实 IME、caret ≤1px/跨页/重排、GUI/source undo/redo、两个文档 overlay、320px/keyboard/offline/PDF 的真实行为证明。

无持久化 schema 迁移，已有 `.mmt`/IndexedDB workspace 原样使用。不得在 geometry 实验或单字段 demo 后宣布整项完成；本轮不授权 commit/push、站点部署或绕过发布凭据。