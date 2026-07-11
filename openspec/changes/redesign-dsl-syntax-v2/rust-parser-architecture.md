## Overview

这份文档记录 Rust DSL v2 parser / language core 的实施架构。它服务于 `design.md` 中的语言合同；当前 `mmt_rs` 已按这些边界实现，不再是可推倒的实验脚手架。

当前已实现 syntax AST、inline/declaration parser、mode/actor/asset/resource lowering、pack-v3 registry、resolve、materializer coordination、Typst façade emitter、chunk-level source map、diagnostic phases、strict/permissive pipeline，以及公开 parser/analysis API。尚未完成的主线边界是 native CLI/build 入口、仓库内 pack-v3 fixture 驱动的真实 Typst 0.15 端到端编译，以及 compile/layout diagnostic 到 MMT origin 的平台集成。

`analysis` 模块提供版本化 JSON ABI，而不直接暴露 Rust enum 的内存布局。`analyze_text_json` 与 `analyze_text_wasm` 返回 schema `mmt.syntax.v2` 的完整 syntax AST、UTF-8 byte ranges 和带 1-based line/column 的 diagnostics。WASM export 是纯文本宿主 portability surface，不读取 pack、文件、网络或 decoder，也不表示当前阶段已经迁移 Web 编辑器。

旧实验版 `compile_text_*_wasm` JSON compiler 不属于 v2 API，也不提供兼容承诺。正式 build/CLI 路径应使用 native `compile_text_strict`；需要编辑器式恢复的宿主可使用 parser/analysis 或 permissive `compile_text`。

## Module Boundaries

当前模块边界：

- `source`：管理原文、UTF-8 byte offset、line index、`TextRange` 与 line/column 映射
- `syntax`：保存 statement、directive、reply、bond、blank/error、patch、body mode 与忠实 source ranges
- `parser` / `inline`：执行行驱动 syntax parsing、fence/reply/patch、`[:...:]` 和声明 literal/list 解析
- `typst_check`：使用 `typst-syntax` 检查 Typst body/patch/generated source，并识别 `T` 模式可展开 overlay 的 markup ranges
- `semantic`：处理 body mode、character preset、script actor/revision/name、speaker history、asset 和资源 marker normalization
- `pack` / `resolve`：校验 pack-v3 manifest，并把逻辑 selector 解析到 contribution、variant、storage 与 frame
- `materialize`：通过窄 `ResourceMaterializer` 协调平台 I/O，并把成功结果绑定为 Typst 可读路径
- `emit`：生成 Typst façade calls、origin table 与 generated-range source map
- `diag`：统一 diagnostic severity、phase、labels 与 recoverable error 表达
- `pipeline`：依次协调所有阶段；strict 路径按 error phase 短路，permissive 路径保留部分结果
- `analysis`：提供稳定、版本化、只读的 JSON analysis surface

内部 range 建议统一使用 UTF-8 byte offset，而不是 char offset。Rust 字符串切片、`typst-syntax` 与常见 Rust 文本库都以 byte range 为基础；对外展示时再通过 line index 转为 line/column。这样既能安全处理中文，又能直接与 Typst 语法检查结果对齐。

## Syntax AST 与 Semantic IR 分层

syntax 层应尽量只回答“作者写了什么”，semantic 层才回答“这些写法引用了什么实体或资源”。第一版核心类型可以沿用下面的形状：

```rust
pub struct SyntaxDocument {
    pub nodes: Vec<SyntaxNode>,
    pub diagnostics: Vec<Diagnostic>,
    pub range: TextRange,
}

pub enum SyntaxNode {
    Statement(StatementSyntax),
    DirectiveLine(DirectiveLineSyntax),
    DirectiveBlock(DirectiveBlockSyntax),
    Reply(ReplySyntax),
    Bond(BondSyntax),
    Blank(BlankSyntax),
    Error(ErrorNode),
}
```

statement 保存说话人 marker、局部 patch 与正文，但不在 syntax 层解析出最终人物：

```rust
pub struct StatementSyntax {
    pub kind: StatementKind,
    pub marker: Option<SpeakerMarkerSyntax>,
    pub patch: Option<PatchSyntax>,
    pub body: BodySyntax,
    pub range: TextRange,
}

pub enum SpeakerMarkerSyntax {
    Explicit { raw: String, range: TextRange },
    BackRef { n: u32, range: TextRange },
    UniqueIndex { n: u32, range: TextRange },
}
```

patch 在 syntax 层只保存外壳与原文：

```rust
pub struct PatchSyntax {
    pub raw_args: String,
    pub range: TextRange,
    pub args_range: TextRange,
}
```

正文模式把 text / Typst 与 macro / raw 两个维度显式记录下来：

```rust
pub struct BodySyntax {
    pub mode: BodyMode,
    pub source: String,
    pub range: TextRange,
    pub parts: Vec<BodyPartSyntax>,
}

pub enum BodyMode {
    Inherit,
    TextMacro,
    TypstMacro,
    TextRaw,
    TypstRaw,
}
```

`Inherit` 表示正文没有显式模式前缀，syntax parser 不在此处应用 `@mode`；lowering
阶段再按当前文件中最近的 `@mode`（没有时为默认 `t`）解析最终模式。显式
`t` / `T` / `rt` / `rT` fenced body 则直接记录对应模式。

`[:...:]` 在 syntax 层可以拆成参数列表，并把 `#n` 识别成编号 selector；但不查资源包：

```rust
pub struct InlineMacroSyntax {
    pub args: Vec<MacroArgSyntax>,
    pub render_patch: Option<PatchSyntax>,
    pub range: TextRange,
    pub args_range: TextRange,
}

pub enum MacroValueSyntax {
    Bare(String),
    Quoted { value: String, quote: QuoteKind },
    Namespaced { namespace: String, value: Box<MacroValueSyntax> },
    Ordinal { n: u32 },
}
```

聚合指令使用通用 block AST，而不是为 `@actor`、`@asset` 等提前写死不同节点类型：

```rust
pub struct DirectiveBlockSyntax {
    pub name: String,
    pub head_args: Vec<LiteralSyntax>,
    pub patch: Option<PatchSyntax>,
    pub items: Vec<DirectiveItemSyntax>,
    pub range: TextRange,
}

pub enum DirectiveItemSyntax {
    Field(FieldSyntax),
    Body(BodySyntax),
    Error(ErrorNode),
}
```

`@actor` 的字段白名单、`preset:` 是否允许、`also-as:` 是否冲突、`@asset` 是否缺少 `src:` 等判断，都应放到 semantic 层。syntax 层只负责保留 block 结构和字段原文。

`@typ ... @end` 是 content block，而不是配置字段 block。syntax parser 将起止标记之间
的全部内容（包括看似 `name: value` 或以 `@` 开头的 Typst 文本）保留为单个
`TypstRaw` body；只有精确的未缩进 `@end` 终止该块。这样 `@typ` 可以作为连续原文
chunk 进入 Typst 检查和 source map，而不会被通用 field parser 改写。

第一阶段 semantic lowering 可以拆成独立、可组合的 pass。`resolve_body_modes`
按节点顺序解释文件内的 `@mode`，只为 statement、reply item 和 bond body 产出
`body range -> resolved mode`；配置 block、普通 directive payload 与 `@typ` 不进入该
映射。未知 mode 产生 semantic diagnostic，但不覆盖之前有效的文件默认值。完整
semantic IR 后续可在该结果上继续叠加 actor revision、speaker history 与资源解析。

actor lowering 通过只读 `CharacterPresetCatalog` 接收资源包预设，不直接修改 manifest，
也不把 pack-v3 JSON 结构耦合进语义状态机。其第一阶段输出至少包含：

- `ScriptActor`：稳定 actor identity、初始 preset id、确定性 actor names 与 revision 列表
- `ActorRevision`：从当前位置起生效的 display name / avatar 状态及声明来源 range
- `ResolvedStatementSpeaker`：statement range、actor identity 与该语句捕获的 revision number

内建 speaker 不伪装成资源包 actor。statement speaker 使用
`SpeakerIdentity::Actor(ActorId)` / `SpeakerIdentity::Builtin(BuiltinSpeakerId)` 区分；
builtin 没有 actor revision。lowering options 可以分别配置左右方向在没有 current actor
时的 builtin fallback，默认仅右侧（`<`）使用 `__Sensei`。显示名、avatar 与是否保留 avatar
列属于后续 presentation 配置，模板不能按 `__Sensei` 字符串写特殊分支。

无头 `@actor` 与正文中唯一匹配的 preset name 都打开或惰性创建 preset default actor，
并把 preset 的 deterministic names 绑定到同一 identity；`@actor <name>` 携带
`preset:` 时则创建独立 actor。`also-as:` 只增加名称，名称冲突和已有 actor 的 preset
replacement 必须在修改 name table 或 revision 前失败，不能留下半应用状态。

speaker lowering 为左右方向分别维护 current actor、message history 与 first-seen unique actor list：
省略 marker / `_0` 保持 current actor；`_n`（n >= 1）排除 current actor 后按消息历史逆序
去重，取得第 n 位最近使用的不同 actor，因此重复 `_1` 可以在最近两位 actor 间交替。
`~n` 仍从同方向不同 actor 的首次出现顺序取第 n 项。引用都读取该 actor 的当前 revision 供新 statement 捕获；早期 statement
保存的 revision number 不随之后的 `@actor` 修改而变化。

## 错误恢复

parser 可以为 IDE 场景做 panic recovery，但恢复必须是显式可见的：

- 不支持嵌套 directive block；block 内遇到新的明确顶层 block 起始时，应报告 diagnostic
- 坏 block 可以恢复到下一个明确顶层节点起始，但必须产出 `ErrorNode`
- `ErrorNode` 应保留坏区间原文 range，避免静默丢文本
- CLI / 严格编译路径看到 error diagnostic 时仍应失败；恢复只用于继续展示后续错误与 IDE 体验

core 对此提供两种明确入口：`compile_text` 是 IDE 使用的 permissive pipeline，会保留
错误后的部分 IR、占位输出与所有阶段 diagnostic；`compile_text_strict` 是 CLI/build
入口，在 syntax、semantic、resolve、materialize、Typst precheck 每个阶段检查 error，
并在进入下一阶段前短路。尤其 syntax/semantic/resolve error 发生后不得调用
materializer，避免无效脚本触发文件、网络或 decoder I/O。

## 构建产物与 Typst backend

`compile_text_strict` 的宿主输出不应只是一段临时 `.typ` 字符串。构建层应把 generated
Typst、`EmittedTypst` source map、模板库文件和 materialized assets 组织成同一个
`CompilationBundle`（最终名称可在实现时调整），再提供两个共享该 bundle 的 backend：

- internal backend：实现 Typst 0.15 `World`，调用 `typst::compile::<PagedDocument>`，直接
  生成文档，并通过 `WorldExt::range(SourceDiagnostic.span)` 把 compile/eval/layout 错误
  回射到 MMT origin；
- project backend：把入口 `.typ`、模板和物化资源导出到自包含目录，使用相对路径，使用户
  可以直接执行 `typst compile --root <dir> <dir>/main.typ`，并可保留该目录用于调试。

两个 backend MUST 使用相同的 generated source 和物化资源布局，不能分别重新 lowering
或拼装 Typst。source map 可作为 sidecar 写入导出目录，但不要求 Typst CLI 理解该文件；
由 MMT CLI 调用外部 Typst 时，仍可读取 Typst diagnostic 的 generated 文件位置后执行回射。

对于 `T` 模式 overlay macro，`[:...:]` 扫描应按 Typst CST/AST 给出的可替换源码区间分段执行，不能跨越 string、raw、comment、code expression 等不可替换区间拼接出一个 marker。`#1` 虽然会破坏 Typst content 结构，但第一版因为 `#` 后只允许数字编号，仍可在允许的 markup source range 上按 MMT overlay macro 独立扫描处理。

## Typst 0.15 Diagnostic Probe

基于 `typst 0.15.0` 的临时 probe 结论：

当前 Rust core 已固定依赖 `typst-syntax 0.15`。`check_typst_source` 使用 numbered
`Source` 检查正文；`check_typst_args` 把 patch 放入合成 façade 调用检查，再将包括
zero-length 在内的错误 range 投影回原始 MMT patch，不向调用方暴露 wrapper 坐标。

- `typst 0.15.0` 和 `typst-syntax 0.15.0` 的 MSRV 是 Rust `1.92+`
- `typst::compile::<PagedDocument>(&world)` 返回的错误是 `SourceDiagnostic`
- `SourceDiagnostic` 包含 `span: DiagSpan`、`message`、`hints`、`trace`
- `WorldExt::range(error.span)` 可以把 Typst diagnostic span 转成 generated `.typ` 的 UTF-8 byte range
- `Source::lines().byte_to_line_column(...)` 可以把 byte range 起点转成人类可读的 line / column
- 语法预检查可以用 `Source::new(file_id, text)` 后的 `source.root().errors_and_warnings()`，再用 `Source::range(...)` 把 syntax diagnostic span 转 byte range
- 直接使用裸 `typst_syntax::parse(text)` 时不应假定已有适合 source map 的文件上下文；建议包成 `Source` 后让 Typst 为 syntax tree numberize

实测错误形态：

- `#let x =` 这类语法错误可返回 `8..8` 这样的 zero-length byte range，表示错误发生在插入点
- `#rect(width: "oops")` 这类 eval / type error 可精确落在参数值，例如 `"oops"` 的 byte range
- `#mmt-image(width: 2em)` 这类未知变量错误可精确落在未知符号本身

因此，下一版 source map 应以 generated Typst byte range 作为机器映射主键，并支持 zero-length range 查询。Typst diagnostic 处理链路建议是：

```text
Typst SourceDiagnostic
-> WorldExt::range(DiagSpan)
-> generated .typ byte range
-> MMT source map lookup
-> MMT origin range + diagnostic phase/kind
```

## Source Map 与 Emitted Chunk

source map 不应作为最后补上的行号表，而应从 emitter 一开始就作为带来源的字符串拼接器维护。

建议核心模型：

```rust
pub struct EmitChunk {
    pub text: String,
    pub origin: Origin,
}

pub enum Origin {
    MmtRange {
        file_id: FileId,
        range: TextRange,
        kind: OriginKind,
    },
    Generated {
        kind: GeneratedKind,
        parent: Option<OriginId>,
    },
}
```

`OriginKind` 可以区分：

- `TextBody`
- `TypstBody`
- `StatementPatch`
- `ResourceMarker`
- `ResourcePatch`
- `TypDirective`
- `DirectiveField`

`GeneratedKind` 可以区分：

- `TemplateWrapper`
- `EscapedText`
- `MacroExpansion`
- `ResourceCallWrapper`
- `StatementCallWrapper`

生成 Typst 时不应直接 `push_str`，而应通过 `emit(text, origin)` 写入 chunk。flatten 成最终 `.typ` 时，同时生成：

```text
generated_typst_range -> origin
```

映射层建议分三类：

- 直接映射：`@typ` block、`T"""..."""` 中原样进入 Typst 的片段，generated range 直接对应 MMT range
- 局部转换映射：普通 text body 被 escape 成 Typst markup/text 后，按较小 segment 映射回原 text range
- 宏展开映射：`[:#1:](width: 2em)` 展开成 Typst resource call 时，wrapper 是 generated 且 parent 指向 marker，后缀 `width: 2em` 映射回 `ResourcePatch`

查询 source map 时需要处理：

- 普通包含命中：diagnostic range 落在某个 generated range 内
- zero-length 命中：diagnostic range 为空时，按插入点查找相邻或包含该点的最具体 chunk
- generated wrapper 命中：错误落在模板生成结构时，回退到 wrapper 的 parent origin，例如整条 statement 或 marker

多阶段 pipeline 的错误不应都伪装成 Typst 错误。建议至少区分：

- syntax：MMT parser / Typst syntax precheck 错误
- semantic：`@actor`、speaker、`[:...:]` selector、资源引用规范化错误
- materialize：资源包 storage、AVIFS 抽帧、缓存文件生成错误
- typst：最终 Typst 编译 / eval / layout 错误

resolver 与 materializer 也应接收并传播 origin。比如 `[:#999:]` 在 resolver 阶段失败时，直接指向 macro range；AVIFS 解码失败时指向引用它的 marker；如果失败来自资源后缀 patch，则优先指向 patch range。

debug 模式下，emitter 可以在展开 `.typ` 中插入轻量注释，例如标记 MMT 行号或 origin id，方便人工打开生成文件排查。但机器映射必须依赖 source map 数据结构，而不是依赖注释文本。

当前第一阶段 emitter 已直接生成 `mmt.chat-left` / `chat-right`、`narration`、`reply`、
`bond` façade 调用和 `@typ` chunk。它接收 mode resolution、actor lowering 与显式
`MaterializedContent`，不会把 actor avatar selector 或 `[:...:]` 当作文件路径；未完成
materialization 的引用产生 materialize diagnostic。`EmittedTypst` 同时保存 generated
source、origin table 与 source-map entries，并提供普通 range 和文件末尾 zero-length
range 的 origin lookup；generated wrapper 可沿 parent 回退到对应 MMT node。

最终 Typst compile/eval 在平台层完成时，应把 `WorldExt::range(DiagSpan)` 得到的 generated
byte range 连同消息传给 `EmittedTypst::map_typst_diagnostic`。该接口沿 source-map parent
链返回最具体的 MMT range；例如错误命中展开后的 `width: 2em` 时，应定位到资源 suffix
patch，而不是整条 statement。找不到 MMT origin 的纯模板错误保留 Typst phase 与消息，
但 range 为空，调用方可同时展示 generated `.typ` 位置。

除逐片段预检查外，pipeline 还应在所有 façade wrapper 拼接完成后，对完整 generated
source 再执行一次 `typst-syntax` 0.15 解析，并把这些 generated ranges 通过同一接口
回映射。这一遍用于捕获只在组合后出现的括号、content block 或模板 wrapper 语法错误，
不能由“每个用户片段单独合法”推断整份 `.typ` 必然合法。

`T` 模式 overlay pass 先扫描 MMT marker 候选，并把候选替换为保持 byte length 与
换行位置的 Typst identifier 文本，再交给 `typst-syntax` 0.15 建立 CST。只有候选起点
leaf 仍处于 `SyntaxMode::Markup` 时才展开，因此普通 markup 与嵌套 content block 可用，
string、raw、comment、math 和 code expression 中的同形文本保持原样。Emitter 随后按
这些 range 分段写入原 Typst chunk 与 materialized resource call，二者分别维护 origin。

resource semantic pass 将 macro 参数规范化为 `Sticker`、`Asset`、`Temporary`、`File`
或 `Url` selector。Sticker selector 显式保存 subject、contribution namespace、可选 set
与 name/ordinal variant；裸 selector 只接受当前 statement 的 actor speaker，builtin、
narration、reply 和 bond 不获得隐式 subject。该 pass 不访问 manifest，也不做自然语言
fallback。Resolver/materializer 可把结果按 marker range 绑定到 `MaterializedContent`；
emitter 再生成 `mmt.sticker(image(...), patch...)`，并把 suffix patch 单独标为
`ResourcePatch` origin。

`@asset` 也由独立 semantic pass 处理。块状声明和 `@asset: ...` 短行声明必须归一化为
同一个 `ScriptAsset` IR；`src` 必填，`ns` 缺省为 `custom`。由于稳定引用目前只有
`asset::<name>`，不同 namespace 下同名的脚本资产仍视为冲突，不能让 namespace 形成
一个 DSL 无法显式访问的隐藏消歧维度。URL 与本地 basename 在 IR 中分型；本地输入在
lowering 阶段拒绝目录分隔符和 traversal，实际工作区读取仍由 materializer 的沙箱边界负责。

pack-v3 manifest 由独立 `PackRegistry` 加载和校验，并实现只读
`CharacterPresetCatalog`。registry 负责 entity id 规范化、contribution target、默认
slot/set、variant handle/ordinal 和 storage 引用的确定性解析；它不解码图片，也不生成
临时文件。解析结果必须同时携带 contribution namespace 与 storage 所属 pack namespace，
因为 storage id 只在单个 pack 内唯一。未显式 contribution namespace 时，如果基础包和
扩展包都命中同一 selector，必须报 ambiguous，禁止通过加载顺序实现隐式覆盖。

统一 core pipeline 依次执行 syntax parse、mode/actor/asset/resource lowering、pack resolve、
平台 materialize 与 Typst emit。`ResolvedResource` 保留 marker range、render patch 和具体
资源类型；pack 资源进一步携带 pack namespace、storage id、storage metadata、相对 path
与 frame。脚本内显式声明的 `@asset` 优先于同名 pack asset。materializer 通过窄 trait
注入，不允许 parser core 自行访问网络、任意文件系统或 decoder；失败 marker 在
`MaterializedContent` 中标记为已诊断，emitter 生成占位内容但不重复报告 materialize 错误。
资源 target 区分正文 `Inline` 与 `ActorAvatar(actor_id, revision)`；后者把 `avatar:` 的
当前 subject 简写、contribution 简写、完整 avatar path 或 `asset::name` 解析后绑定到
对应 revision，不能退回模板层按字符串猜测头像来源。
