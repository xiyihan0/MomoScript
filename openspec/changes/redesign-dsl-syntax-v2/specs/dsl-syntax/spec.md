## MODIFIED Requirements

### Requirement: Body directives use strict implemented forms

下一版 DSL SHALL 收敛正文指令体系，聚合声明是 canonical form；第一版明确提供的短行形式 MUST lowering 到同一语义模型，而不是形成独立风格。

#### Scenario: Script actor configuration uses aggregated declarations

- GIVEN 下一版 DSL 需要表达角色预设、显示名、头像和其他脚本名称
- WHEN 作者配置剧本中的登场角色
- THEN canonical syntax SHALL use an `@actor ... @end` aggregated declaration
- AND MUST NOT require the author to understand mutable instance references or internal ids

#### Scenario: Headless actor opens the preset default actor

- GIVEN `ba::日富美` 是资源包提供的只读 character preset
- AND 该 entity 的 `names[0]` 是 `日富美`
- WHEN 作者写出无头 `@actor` 且 block 内包含 `preset: ba::日富美`
- THEN compiler SHALL open or lazily create that preset's default script actor
- AND the actor's initial state SHALL come from the preset
- AND the resource pack entity MUST remain immutable

#### Scenario: Headless actor requires a preset

- GIVEN 作者写出没有位置名称的 `@actor` block
- WHEN block 内也没有 `preset:`
- THEN compiler MUST report that the actor target is missing
- AND MUST NOT create an anonymous actor

#### Scenario: Named actor with preset creates an independent actor

- GIVEN `ba::日富美` 是资源包提供的 character preset
- WHEN 作者写出 `@actor hifumi` 且 block 内包含 `preset: ba::日富美`
- AND `hifumi` 尚未解析到已有 actor
- THEN compiler SHALL create an independent script actor initialized from that preset
- AND `hifumi` SHALL become its primary actor name

#### Scenario: Existing actor name opens its actor

- GIVEN `hifumi` 已经解析到某个 script actor
- WHEN 作者再次写出 `@actor hifumi` 且 block 内没有 `preset:`
- THEN compiler SHALL apply block fields to that actor's current state
- AND later statements SHALL observe a new actor revision
- AND earlier statements MUST retain the revision captured when they were lowered

#### Scenario: Existing actor rejects implicit preset replacement

- GIVEN `hifumi` 已经解析到某个 script actor
- WHEN 作者再次写出 `@actor hifumi` 且 block 内包含 `preset: ba::日富美`
- THEN compiler MUST report unsupported preset replacement in the first revision
- AND MUST NOT silently replace the actor's initial preset or merge actors

#### Scenario: Missing named actor does not infer a local preset

- GIVEN `unknown` 尚未解析到 actor
- WHEN 作者写出 `@actor unknown` 且没有 `preset:`
- THEN compiler MUST report an unknown actor name
- AND MUST NOT implicitly create a resource-less character preset

#### Scenario: Additional actor names are explicit and additive

- GIVEN `hifumi` 已经解析到某个 script actor
- WHEN 作者在 `@actor hifumi` block 内写出 `also-as: [日富美, hifumi2]`
- THEN each listed name SHALL be added as another deterministic name for the same actor
- AND modifying the actor through any of those names SHALL affect later statements using the others
- AND `also-as:` MUST NOT replace the actor's existing names

#### Scenario: Multiple positional actor names are rejected

- GIVEN 下一版 `@actor` 第一版语法
- WHEN 作者写出 `@actor hifumi 日富美`
- THEN compiler MUST reject this form as ambiguous
- AND 作者应使用一个主要名称加 `also-as:` 显式添加其他名称

#### Scenario: Actor name conflict is rejected by default

- GIVEN `a` 和 `b` 已经分别解析到不同 script actors
- WHEN 作者在 `@actor a` block 内写出 `also-as: [b]`
- THEN compiler MUST report an actor name conflict
- AND MUST NOT implicitly merge actors or move `b`

### Requirement: Document presentation uses one aggregated file-level declaration

下一版 DSL SHALL 使用单一 `@document ... @end` block 表达文档标题栏与编译时间设置；该声明作用于整份文档，而不是形成按位置变化的渲染状态。

#### Scenario: Document declaration configures title bar fields

- GIVEN 作者需要设置标题、作者或标题栏可见性
- WHEN 作者写出 `@document ... @end`
- THEN block SHALL accept scalar `title`、optional scalar `author` and boolean `show-header`
- AND omitted fields SHALL retain the v2 template defaults
- AND unknown、duplicate、list-valued or malformed fields MUST produce source-ranged semantic diagnostics

#### Scenario: Document declaration is unique and precedes renderable content

- GIVEN document presentation is file-wide configuration
- WHEN a source contains more than one `@document` block
- THEN compiler MUST reject every later declaration and identify the first declaration
- WHEN `@document` appears after a statement、reply、bond or raw `@typ` content
- THEN compiler MUST report that document configuration must precede renderable content
- AND MUST NOT apply it as a mid-document state transition

#### Scenario: Compiled-at accepts hidden and manual forms

- GIVEN the template header accepts optional compiled-at content
- WHEN `compiled-at` is omitted or is the unquoted keyword `none`
- THEN generated Typst SHALL pass no compiled-at value
- WHEN `compiled-at` is any other scalar value
- THEN MMT SHALL pass that value as literal header text
- AND quoted `"auto"` or `"none"` SHALL remain literal text rather than a control keyword

#### Scenario: Automatic compiled-at is host-injected and deterministic

- GIVEN `compiled-at: auto`
- WHEN a CLI export or interactive preview render begins
- THEN the host MUST inject one explicit instant and local UTC offset into the MMT compilation session
- AND MMT SHALL format that instant before Typst emission
- AND the Typst template MUST NOT read the operating-system or browser clock
- AND repeated compilation with the same source、instant and offset MUST produce byte-identical generated Typst
- AND an interactive preview MUST pin the instant to its document revision until an explicit refresh or a newer source revision starts another render session

#### Scenario: Automatic time supports format and timezone

- GIVEN `compiled-at: auto`
- WHEN `compiled-at-format` is omitted
- THEN MMT SHALL use locale-independent `[year]-[month]-[day] [hour]:[minute]:[second]` output
- WHEN `compiled-at-format` is present
- THEN MMT SHALL interpret it using Rust `time` format-description syntax
- AND an invalid format MUST produce a diagnostic at the field value
- WHEN `timezone` is omitted or is `local`
- THEN formatting SHALL use the offset injected by the host
- WHEN `timezone` is `utc`、`Z` or a fixed `+HH:MM` / `-HH:MM` offset
- THEN MMT SHALL format the same instant in that offset
- AND `compiled-at-format` or `timezone` without `compiled-at: auto` MUST be rejected as inapplicable

#### Scenario: Language projection does not invent a clock

- GIVEN syntax diagnostics or editor projection runs without a preview/export time input
- WHEN the document requests `compiled-at: auto`
- THEN the language core SHALL omit compiled-at from that non-rendering projection
- AND MUST NOT read a clock or emit a changing value
- AND the preview/export host remains responsible for a revision-pinned time input

#### Scenario: Explicit host overrides win field by field

- GIVEN document lowering has produced DSL-authored title-bar settings
- WHEN a host explicitly supplies `title`、`author`、`show-header` or literal `compiled-at` overrides
- THEN only the supplied fields SHALL replace their DSL-authored values
- AND omitted host fields MUST preserve the DSL result
- AND a literal compiled-at override SHALL replace automatic formatting rather than combine with `compiled-at-format` or `timezone`
- AND the CLI SHALL expose these overrides as `--title`、`--author`、`--show-header` / `--no-header` and `--compiled-at`
- AND `--clock` SHALL supply a reproducible host instant for DSL `compiled-at: auto` without itself changing the document mode
- AND `--clock` MUST accept RFC 3339 with an explicit `Z` or numeric offset, and that parsed offset SHALL become the injected `local` offset

#### Scenario: Asset registration supports canonical block and shared short form

- GIVEN DSL v2 需要注册资源并允许显式 namespace
- WHEN 作者使用 `@asset hero ... @end` block
- THEN compiler SHALL lower `src`、可选 `ns` 与 asset name 到 `ScriptAsset`
- AND `ns` 缺省为 `custom`
- WHEN 作者使用 `@asset: hero src:...` short form
- THEN compiler SHALL apply the same required fields、defaults、validation and duplicate-name rules
- AND legacy `@asset.<name>:` metadata syntax MUST NOT become a v2 asset declaration

#### Scenario: Inline reply uses pipe-separated items

- GIVEN 作者需要编写紧凑 reply 选项
- WHEN 作者写出 `@reply: 是 | 否 | "也许 | 之后再说" | 不知道\|算了`
- THEN parser MUST split only on unquoted and unescaped `|`
- AND quoted `|` and escaped `\|` MUST remain part of the reply item text

#### Scenario: Reply block uses explicit item markers

- GIVEN 作者需要编写块状 reply 选项
- WHEN 作者写出 `@reply ... @end`
- THEN each reply item MUST start with a block-local `-` item marker
- AND following ordinary lines MUST be appended as continuation text of the current item until the next block-local `-` item marker or `@end`
- AND continuation lines MUST preserve their original indentation
- AND `|` MUST NOT split items inside block-form `@reply`

#### Scenario: Reply item fenced body belongs to the current item

- GIVEN block-form `@reply` 中某个 `-` item 后跟 fenced block
- WHEN fenced block 内容包含 `|`、`@reply:` 或 `>` 行头
- THEN those characters MUST be preserved as the current item body
- AND MUST NOT create additional reply items or top-level nodes

#### Scenario: Bond block remains ordinary content

- GIVEN 作者写出 block-form `@bond`
- WHEN 后续行不是明确的新顶层节点起始或 `@end`
- THEN parser MUST append those lines as bond content continuation
- AND MUST NOT interpret `-` as a bond item marker

#### Scenario: Bond colon form is single-line or fenced

- GIVEN 作者写出 `@bond: payload`
- WHEN parser 读取该 directive
- THEN parser MUST consume only the same-line payload
- AND MUST NOT implicitly append following ordinary lines as bond continuation
- AND if the payload starts a fenced block, parser MAY consume that fenced payload before ending the bond node

### Requirement: Statements, blocks, and continuation lines follow line-based parsing

下一版 DSL SHALL 允许 statement 与特殊指令在头部携带只作用于当前节点的局部 patch。

#### Scenario: Statement-local patch applies only to the current node

- GIVEN 一条 `>`、`<`、`-` 或特殊指令节点
- WHEN 其头部带有 `(...)` patch
- THEN 该 patch 只作用于当前节点
- AND 不会隐式继承到后续节点

#### Scenario: Patch remains single-line in the first revision

- GIVEN 下一版 DSL 的头部 patch 语法
- WHEN 设计第一版 parser 规则时
- THEN patch 只允许单行形式
- AND 多行 patch 不作为第一版目标

#### Scenario: Syntax parser only checks patch enclosure

- GIVEN 一个节点头部 patch，例如 `>(fill: green, inset: 5pt)`
- WHEN syntax parser 读取该节点
- THEN syntax parser MUST verify that the outer `(...)` patch enclosure is balanced
- AND MUST preserve the patch raw argument text and source range
- AND MUST NOT validate Typst argument semantics in the syntax phase

#### Scenario: Typst argument validation happens after syntax parsing

- GIVEN syntax parser 已经保留某个 patch 的 raw argument text
- WHEN compiler 准备把该 patch 展开到 Typst façade 函数调用
- THEN compiler MUST validate the patch as Typst call arguments before emission
- AND Typst validation errors SHOULD map back to the original patch source range

#### Scenario: Statement lines accept implicit continuations

- GIVEN 一条顶层 `>`、`<` 或 `-` statement
- WHEN 后续行不是明确的新顶层节点起始或当前上下文结束标记
- THEN parser MUST append that line as continuation text of the previous statement
- AND preserve the line break between statement content and continuation text

#### Scenario: Statement continuation stops at explicit node starts

- GIVEN 一条 statement 后存在后续行
- WHEN 后续行在未缩进的行首以新的 `>`、`<`、`-` statement 或 `@reply`、`@bond`、`@actor`、`@asset`、`@typ`、`@end` 等明确节点头开始
- THEN parser MUST stop the previous statement continuation before that line
- AND parse the line according to its own node kind

#### Scenario: Indented node-like lines remain continuation text

- GIVEN 一条 statement 后存在缩进行
- WHEN 该缩进行看起来像 `>`、`<`、`-` statement 或 `@reply` 等节点头
- THEN parser MUST keep it as continuation text of the current statement
- AND MAY emit an info-level diagnostic that the line was treated as text because it is indented

#### Scenario: Fenced statement body protects line-head markers

- GIVEN 一条 statement 的正文使用 `"""..."""` fenced body
- WHEN fenced body 内部出现 `@reply:`、`>`、`<`、`-` 或 `@end` 等文本
- THEN parser MUST keep that text inside the statement body
- AND MUST NOT treat it as a top-level node start

#### Scenario: Longer fences can contain shorter quote runs

- GIVEN statement 或 reply item 的 fenced body 使用 N 个连续双引号打开，且 N >= 3
- WHEN body 内部出现少于 N 个连续双引号
- THEN parser MUST keep them as body text
- AND only a closing fence with at least N consecutive double quotes can close the body

#### Scenario: Colon directives are single-line or fenced payloads

- GIVEN 作者写出 `@name: payload`
- WHEN parser 读取该 directive
- THEN parser MUST consume only the same-line payload
- AND MUST NOT implicitly append following ordinary lines as continuation
- AND if the payload starts a fenced block, parser MAY consume that fenced payload before ending the directive

#### Scenario: Non-colon directives are explicit blocks

- GIVEN 作者写出无冒号的 `@name` directive block
- WHEN parser 读取该 block
- THEN parser MUST require an explicit top-level `@end`
- AND missing `@end` MUST produce an unterminated block diagnostic

#### Scenario: Top-level control tokens are unindented

- GIVEN 一行看起来像 `@end`、`@name`、`>`、`<` 或 `-`
- WHEN 该行存在前导缩进
- THEN parser MUST NOT treat it as a top-level control token
- AND SHOULD preserve it as text or field content according to the current context

### Requirement: Dialogue speaker references remain explicit syntax nodes

下一版 DSL SHALL 保留当前实现中的 `_n` / `~n` 说话人引用语法，并将其作为 speaker marker 建模。

#### Scenario: Backreference marker references side-local MRU distinct speakers

- GIVEN 当前方向已有 current actor 和说话人历史
- WHEN 作者省略 speaker marker 或写出 `_0:`
- THEN statement MUST keep the current script actor on that side
- WHEN 作者写出 `_:`、`_1:` 或 `_2:` 作为 `>` / `<` statement 的说话人 marker
- THEN `_:` 与 `_1:` MUST resolve to the most recently used different actor after excluding current actor and deduplicating history
- AND `_2:` MUST resolve to the second actor in that side-local MRU distinct-speaker order
- AND selecting `_n` MUST update current actor, so repeated `_:` can alternate two recent actors
- AND `>` 与 `<` MUST maintain independent current actors and MRU distinct-speaker histories

#### Scenario: Repeated shorthand alternates two speakers

- GIVEN 输入依次为 `> 优香: 1`、`> 1.5`、`> 诺亚: 2`、`> 2.5`、`> _: 3`、`> _: 4`
- WHEN compiler resolves left-side speakers
- THEN the resolved actor sequence MUST be `优香`、`优香`、`诺亚`、`诺亚`、`优香`、`诺亚`
- AND continuation statements without a marker MUST NOT add another actor to the distinct-speaker order

#### Scenario: Unique-index marker references side-local first-seen order

- GIVEN 当前方向已有首次出现顺序记录
- WHEN 作者写出 `~:`、`~1:` 或 `~2:` 作为 `>` / `<` statement 的说话人 marker
- THEN `~:` 与 `~1:` MUST resolve to the first script actor seen on the same side
- AND `~2:` MUST resolve to the second distinct script actor seen on the same side
- AND `>` 与 `<` MUST maintain independent unique speaker indexes

#### Scenario: Speaker references point to script actor identities

- GIVEN 某个 speaker marker 已经解析到 script actor
- WHEN 后续 `_n` 或 `~n` 引用该历史说话人
- THEN compiler MUST resolve the reference to the same actor identity
- AND the new statement SHALL capture that actor's current revision
- AND MUST NOT resolve it merely to the preset id、actor name 或 display name string

#### Scenario: Invalid speaker references fail deterministically

- GIVEN 作者使用 `_n` 或 `~n` speaker marker
- WHEN 当前方向没有足够的 speaker history 或 unique speaker index
- THEN compiler MUST report an invalid speaker reference
- AND MUST NOT silently fall back to a textual speaker name

#### Scenario: Omitted speaker preserves side-local current state and Sensei default

- GIVEN `>` 或 `<` statement 没有 speaker marker，或显式使用 `_0:`
- WHEN 当前方向已有 script actor speaker
- THEN statement SHALL capture that actor's current revision
- AND the omission MUST NOT create a new history selector or actor
- WHEN 右侧方向尚无当前 actor
- THEN `<` statement SHALL use the configured right-side built-in identity, whose default id is `__Sensei`
- AND a built-in speaker SHALL have no actor revision
- AND its display name、avatar 与 avatar-column policy SHALL come from presentation configuration rather than id-specific template branches
- WHEN 左侧方向尚无当前 actor
- THEN `>` statement MUST report a missing current speaker

### Requirement: Inline expressions follow compiler tokenization rules

下一版 DSL SHALL 将消息正文中的表情包与素材引用收束为 `[:...:]` bracket-colon 参数列表；第一版 `[:...:]` 只表达确定性资源选择，不启用自然语言查询 fallback。

#### Scenario: Sticker marker uses argument-list syntax

- GIVEN 一条消息正文需要插入当前 subject 的表情包
- WHEN 作者写出 `[:开心:]`
- THEN parser 将其识别为 sticker/resource marker
- AND 单个位置参数按当前 subject 的 `sticker` slot 解析

#### Scenario: Subject and sticker selector can be provided positionally

- GIVEN 一条消息正文需要引用指定人物的表情包
- WHEN 作者写出 `[:晴_露营, >_<笑:]` 或 `[:ba::晴_露营, >_<笑:]`
- THEN 第一个位置参数按 subject-ref 解析
- AND 第二个位置参数按该 subject 的 `sticker` selector 解析

#### Scenario: Contribution namespace can disambiguate sticker variants

- GIVEN 某个实体的 `sticker` slot 有多个资源包贡献
- WHEN 作者写出 `[:ba::晴_露营, ba_extpack::happy:]`
- THEN `ba_extpack` 按 contribution namespace 解析
- AND `happy` 按该贡献来源下的 sticker variant 解析

#### Scenario: Namespaced selector may quote the right-hand literal

- GIVEN sticker variant 名称包含容易与语法冲突的字符
- WHEN 作者写出 `[:ba::晴_露营, ba_extpack::">_<笑":]`
- THEN namespace 仍按 `ba_extpack` 解析
- AND 引号内文本作为完整 variant literal 保留
- AND 该 selector 仍是确定性资源查找，不进入自然语言语义查询

#### Scenario: Natural language query syntax is deferred

- GIVEN 第一版 `[:...:]` marker 语法
- WHEN 作者写出 `[:?坏笑:]` 或 `[:ba::晴_露营, ba_extpack::?坏笑:]`
- THEN compiler MUST report unsupported query syntax
- AND MUST NOT reinterpret `?坏笑` as a deterministic sticker selector

#### Scenario: Ordinal selector references manifest order

- GIVEN 某个 subject 的 `sticker` slot 具有明确的 sticker set
- AND 该 set 具有 manifest 中声明的稳定 variant 顺序
- WHEN 作者写出 `[:#1:]`、`[:ba_extpack::#1:]`、`[:ba::晴_露营/sticker/#1:]` 或 `[:ba::晴_露营/sticker/default/#1:]`
- THEN `#1` 按 1-based ordinal selector 解析
- AND ordinal 的作用域是该 sticker set 内的 variants，而不是整个 subject 的全部 sticker 资源
- AND 该 selector 不进入关键词匹配或自然语言语义查询

#### Scenario: Syntax parser tokenizes inline marker arguments

- GIVEN 正文模式启用 MMT inline macro expansion
- WHEN syntax parser scans a `[:...:]` marker
- THEN parser SHOULD tokenize the marker body into an argument list using unquoted and unescaped commas
- AND namespace separators such as `ba_extpack::">_<笑"` SHOULD be preserved as structured syntax
- AND ordinal selectors such as `#1` SHOULD be represented as ordinal syntax rather than plain text
- AND parser MUST NOT access pack manifests or resolve resource existence in this phase

#### Scenario: Ordinal selector fails deterministically

- GIVEN 作者使用 `#n` 编号 selector
- WHEN 编号越界、缺少稳定顺序信息、缺少明确 default set 或 contribution namespace 存在歧义
- THEN compiler MUST report an unresolved or ambiguous reference
- AND MUST NOT fall back to keyword or semantic matching

#### Scenario: Explicit resource spaces bypass subject interpretation

- GIVEN marker 的第一个位置参数是 `sticker`、`asset`、`tmp`、`file` 或 `url`
- WHEN 作者写出 `[:sticker, 开心:]`、`[:asset, hero:]`、`[:file, images/foo.png:]` 或 `[:url, https://example.com/a.png:]`
- THEN 第一个位置参数按资源空间解析
- AND 不会被解释为 subject-ref

#### Scenario: Bare subject selector requires message speaker

- GIVEN inline marker 使用裸 selector 或 ordinal selector，例如 `[:#1:]`
- WHEN marker 出现在有明确 speaker 的 `>` 或 `<` message statement 中
- THEN compiler MAY resolve it against that speaker's `sticker` slot
- AND the speaker MUST come from the current message statement, not from a previous global context

#### Scenario: Bare subject selector is invalid outside message speaker context

- GIVEN inline marker 使用裸 selector 或 ordinal selector，例如 `[:#1:]`
- WHEN marker 出现在旁白、`@reply` item 或 `@bond` content 中
- THEN compiler MUST report that an explicit subject is required
- AND 作者应写出 `[:柚子, #1:]` 这类带 subject 的形式

#### Scenario: Resource render options use marker suffix patch

- GIVEN marker 需要为当前表情包设置局部渲染参数
- WHEN 作者写出 `[:ba::晴_露营, ba_extpack::">_<笑":](width: 2em)`
- THEN `[:...:]` 内部只按资源 selector 解析
- AND 后缀 `(...)` 作为该资源节点的局部渲染参数传给渲染层
- AND 后缀参数片段仍需满足 Typst 参数级语法检查

#### Scenario: Resource selector cannot embed Typst call syntax

- GIVEN marker 需要引用带 contribution namespace 的 sticker
- WHEN 作者写出 `[:ba::晴_露营, ba_extpack::happy(width: 2em):]`
- THEN compiler MUST report invalid selector syntax
- AND 作者应写成 `[:ba::晴_露营, ba_extpack::happy:](width: 2em)`

#### Scenario: Deterministic references do not fall back to natural language

- GIVEN marker 中的裸位置参数包含 `:`、`.` 或 `/`
- WHEN 它没有被引号包裹且资源解析失败
- THEN compiler MUST report an unresolved or invalid reference
- AND MUST NOT silently reinterpret it as natural language query

#### Scenario: Quoted deterministic selectors stay deterministic

- GIVEN marker 中出现 `namespace::"literal"`
- WHEN 该 selector 查找失败
- THEN compiler MUST report an unresolved reference
- AND MUST NOT reinterpret `"literal"` as natural language query text

#### Scenario: Legacy inline target forms are not the preferred next syntax

- GIVEN 当前实现存在 `[expr]`、`[expr](target)`、`(target)[expr]` 或旧 Typst 模式占位形态
- WHEN 下一版 DSL 收敛内联表达式语法时
- THEN compiler MUST treat those forms as deprecated outside any explicitly selected legacy parser
- AND 下一版主 parser 不把它们作为主路径兼容目标

## ADDED Requirements

### Requirement: `@typ` is the explicit high-power Typst escape hatch

下一版 DSL SHALL 使用 `@typ` 作为显式的高权限 Typst 注入入口。

#### Scenario: Global Typst code uses `@typ`

- GIVEN 作者需要注入顶层 Typst 代码
- WHEN 在 DSL 中表达这类能力时
- THEN 使用 `@typ` 入口
- AND 它与普通内容节点、表情/资源引用标记和局部 patch 明确分层

### Requirement: Body modes separate text syntax from macro expansion

下一版 DSL SHALL 使用正文模式区分 text/Typst 语法与 MMT inline macro 展开策略。

#### Scenario: Body mode has syntax and macro dimensions

- GIVEN parser 读取 statement、reply item 或 bond 正文
- WHEN 正文模式是 `t`、`T`、`rt` 或 `rT`
- THEN `t` 表示 text body with MMT macro expansion
- AND `T` 表示 Typst body with MMT macro expansion
- AND `rt` 表示 text body without MMT macro expansion
- AND `rT` 表示 Typst body without MMT macro expansion

#### Scenario: Mode directive affects following body nodes

- GIVEN 作者写出 `@mode: T` 或 `@mode: typst`
- WHEN 后续 statement、reply item 或 bond content 没有局部 body mode override
- THEN lowering 阶段使 those body nodes inherit Typst syntax with MMT macro expansion
- AND later `@mode:` directives update the default for following body nodes
- AND syntax parser MUST preserve `@mode` as a directive instead of changing later node parse shape during line parsing

#### Scenario: Mode directive accepts short and long names

- GIVEN 作者需要设置文件级正文模式
- WHEN 作者写出 `@mode: t`、`@mode: text`、`@mode: T`、`@mode: typst`、`@mode: rt`、`@mode: raw-text`、`@mode: rT` 或 `@mode: raw-typst`
- THEN compiler SHOULD normalize them to `t`、`T`、`rt` 或 `rT`
- AND unknown mode names MUST produce a diagnostic

#### Scenario: Mode directive is file-local and body-only

- GIVEN 作者在某个文件中写出 `@mode: T`
- WHEN compiler parses declarations, `@typ` blocks, or another file
- THEN `@mode` MUST NOT affect `@actor` fields, `@asset` fields, or `@typ` content
- AND MUST NOT propagate across file boundaries

#### Scenario: Fenced body can override mode locally

- GIVEN 当前默认正文模式是 `t`
- WHEN 作者写出 `T"""#strong[你好] [:#1:]"""`、`rT"""#let s = "literal [:#1:]" """`、`t"""普通文本 [:#1:]"""` 或 `rt"""这里的 [:#1:] 不展开"""`
- THEN the prefix controls only that fenced body
- AND unprefixed fenced bodies inherit the current default body mode during lowering

#### Scenario: Inline resource marker is an MMT macro, not Typst syntax

- GIVEN 正文模式是 `t` 或 `T`
- WHEN body text contains `[:#1:]`
- THEN compiler MUST parse it as an MMT inline resource macro before final Typst emission
- AND final emitted Typst source MUST contain valid Typst constructs instead of raw `[:...:]` marker syntax

#### Scenario: Macro-enabled body can escape marker opener

- GIVEN 正文模式是 `t` 或 `T`
- WHEN body text contains `[\:`
- THEN compiler MUST NOT start an inline resource macro at that position
- AND the remaining content MUST continue to follow the active text or Typst body semantics
- AND in `T` mode, Typst expressions after the escaped opener, such as `#1`, MUST remain eligible for normal Typst evaluation

#### Scenario: Raw macro modes preserve marker text

- GIVEN 正文模式是 `rt` 或 `rT`
- WHEN body text contains `[:#1:]`
- THEN compiler MUST preserve the marker text as normal body content
- AND MUST NOT resolve or expand it as a resource macro

#### Scenario: Typst mode uses typst-syntax as an overlay boundary

- GIVEN 正文模式 is `T` or `rT`
- WHEN compiler validates the body
- THEN compiler MUST use Typst syntax checking for the Typst body text
- AND for `T` mode, compiler SHOULD use Typst CST/AST ranges to allow replacement in markup regions, including markup inside content blocks
- AND compiler SHOULD exclude strings, raw blocks, comments, code expressions, and other non-replaceable regions before scanning for `[:...:]`
- AND compiler MUST treat Typst `Escape` leaf nodes as macro-scan boundaries, so `[\:` does not get stitched into a `[:` marker
- AND compiler SHOULD NOT treat `\[:...:]` as the recommended escape form because it can be invalid Typst markup unless the closing bracket is also escaped
- AND macro scanning SHOULD run within each replaceable source range independently, without stitching across excluded ranges
- AND compiler SHOULD NOT require a fork or grammar modification of `typst-syntax` for MMT macro support

### Requirement: Local patch syntax embeds valid Typst call arguments

下一版 DSL 的局部 patch SHALL 以 Typst 风格函数参数片段表达，并通过 Typst 语法级检查。

#### Scenario: Patch content must be valid call arguments

- GIVEN 一个节点头部 patch，例如 `>(fill: green, inset: 5pt)`
- WHEN 编译器准备把它展开到对应 Typst 函数调用时
- THEN patch 内容必须能被解析为合法的 Typst 参数列表
- AND 只有通过语法检查且 AST 形态符合预期时，才允许进入 emitter

#### Scenario: Statement patch targets statement rendering parameters

- GIVEN 一条对话或旁白 statement 带有头部 patch
- WHEN 作者写出 `>(fill_color: green, inset: 5pt) 柚子: 你好`
- THEN patch 参数作用于当前 statement 对应的 MMT Typst façade 渲染函数
- AND compiler MUST NOT 把 patch 参数解释为 `[:...:]` 资源 selector

#### Scenario: Statement patch cannot select stickers

- GIVEN 作者想在消息中插入当前 subject 的 sticker
- WHEN 作者写出 `>(sticker: #3) 柚子: 你好`
- THEN compiler MUST reject this as unsupported DSL selector-in-patch syntax
- AND 作者应在正文中写 `> 柚子: [:#3:]`

### Requirement: Value-level namespace references use `::`

下一版 DSL SHALL 在值层优先使用 `::` 表示命名空间引用。

#### Scenario: Value references separate structure from namespace

- GIVEN 一条 DSL 声明需要引用命名空间内的值
- WHEN 写出配置值时
- THEN 结构分隔仍使用单个 `:`
- AND 值内部命名空间采用 `::`，例如 `ba::柚子` 或 `asset::yz_default`

### Requirement: Character resources use entity-scoped paths

下一版 DSL SHALL 使用实体作用域下的统一资源路径表达人物头像和表情包资源。

#### Scenario: Avatar resource paths identify entity, contribution source, slot, and variant

- GIVEN 一条人物资源引用
- WHEN 作者需要完整指定聊天气泡头像资源
- THEN 使用 `<subject-ref>/[contribution_namespace::]avatar/<variant>` 形式
- AND `subject-ref` 可以是全局 entity 引用或脚本上下文中的 actor name
- AND `contribution_namespace` 用于显式指定某个资源包贡献的资源
- AND `variant` 是 avatar slot 下的逻辑头像 variant

#### Scenario: Sticker resource paths identify entity, contribution source, set, and variant

- GIVEN 一条人物资源引用
- WHEN 作者需要完整指定正文表情包资源
- THEN 使用 `<subject-ref>/[contribution_namespace::]sticker/[set]/<variant>` 形式
- AND `subject-ref` 可以是全局 entity 引用或脚本上下文中的 actor name
- AND `contribution_namespace` 用于显式指定某个资源包贡献的资源
- AND `set` 指定 sticker slot 下的某个 set
- AND `variant` 是该 set 内的逻辑 variant，不是物理图片路径或 AVIFS frame

#### Scenario: Sticker path may omit set only when default set is explicit

- GIVEN 某个 subject 的 `sticker` slot 定义了明确 default set
- WHEN 作者写出 `<subject-ref>/sticker/<variant>` 或 `<subject-ref>/[contribution_namespace::]sticker/<variant>`
- THEN resolver MAY treat the omitted set as that default set
- AND 如果没有明确 default set，compiler MUST report ambiguous instead of searching all sets

#### Scenario: Slot omission is limited to contexts with a default slot

- GIVEN 某个资源 selector 出现在 `[:...:]` marker、`avatar:` field 或 `sticker:` field 中
- WHEN selector 省略 slot 名称
- THEN `[:...:]` marker MAY default to `sticker`
- AND `avatar:` field MAY default to `avatar`
- AND `sticker:` field MAY default to `sticker`
- AND ordinary resource paths, patch arguments, and Typst argument fragments MUST NOT infer a slot implicitly

#### Scenario: Avatar and sticker slots are distinct

- GIVEN 下一版 DSL 需要区分气泡头像和消息内容里的角色表情包
- WHEN 定义人物资源 slot 时
- THEN `avatar` 表示聊天气泡旁边的说话人头像
- AND `sticker` 表示发在对话内容里的角色表情包

### Requirement: Patch arguments do not use slot-context selector shorthand

下一版 DSL 第一版 SHALL NOT 在节点头部 patch 中启用裸资源 selector 简写。

#### Scenario: Avatar patch keeps Typst argument semantics

- GIVEN 一条带有当前说话人的消息节点
- WHEN `avatar:` patch 参数写成 `happy`
- THEN parser 不应把 `happy` 隐式重写为当前 subject 的 `avatar/happy`
- AND patch 内容仍按 Typst 参数片段处理

#### Scenario: Resource selector logic stays in sticker markers

- GIVEN 作者需要在正文中引用角色表情包或资源
- WHEN 该引用需要 DSL selector、contribution namespace 或 ordinal selector
- THEN 使用 `[:...:]` marker 表达
- AND 不在 patch 参数里复刻同一套解析规则

#### Scenario: Patch resource references must be explicit

- GIVEN patch 参数确实需要引用资源
- WHEN 第一版 DSL 尚未设计专用 Typst helper
- THEN 作者应使用完整字符串路径或其他显式资源引用形式
- AND 裸 `contribution_namespace::variant` 不在 patch 中获得特殊 DSL selector 语义

### Requirement: Non-character assets use dedicated namespaces

下一版 DSL SHALL 将非人物资源从人物资源路径中分离出来。

#### Scenario: Stable custom assets use `asset::`

- GIVEN 一个由脚本、项目或资源包声明的稳定自定义素材
- WHEN 作者引用它时
- THEN 使用 `asset::name` 形式

#### Scenario: Runtime temporary assets use `tmp::`

- GIVEN 一个由运行环境注入的临时素材
- WHEN 作者引用它时
- THEN 使用 `tmp::name` 形式
- AND 该引用不保证脱离当前会话后仍可复现

### Requirement: Resource pack contributions do not implicitly override each other

下一版 DSL SHALL 将多个资源包对同一人物实体的资源贡献合并，但不按导入顺序静默覆盖冲突资源。

#### Scenario: Extension pack patches an existing entity

- GIVEN `ba_extpack` 为 `ba::梦` 追加资源
- WHEN 编译器加载该资源包
- THEN 它把资源贡献挂到 `ba::梦`
- AND 不创建新的 `ba_extpack::梦` 实体，除非 manifest 显式声明该实体

#### Scenario: Duplicate variants require explicit disambiguation

- GIVEN 多个资源包为同一实体、同一 slot 提供了同名 variant
- WHEN 作者使用裸 variant 引用该资源
- THEN 编译器报 ambiguous
- AND 作者必须通过 `contribution_namespace::variant` 或完整资源路径显式指定来源

#### Scenario: Extension packs do not silently change defaults

- GIVEN 扩展资源包为已有实体提供了新的默认风格资源
- WHEN 没有脚本层或显式配置层 override
- THEN base pack 的默认资源保持不变
- AND 扩展资源包贡献的资源只能通过显式 selector 使用

### Requirement: Declaration values support lightweight string literals

下一版 DSL SHALL 在声明层支持轻量字面量系统，以处理带空格或特殊字符的值。

#### Scenario: Quoted values preserve special characters

- GIVEN 一个配置值包含空格、逗号或其他容易引起分词歧义的字符
- WHEN 作者编写声明层参数时
- THEN 可以使用单引号或双引号字符串
- AND parser 应正确保留该值

#### Scenario: Field lists use explicit brackets

- GIVEN 某个声明字段需要列表值，例如 `also-as:`
- WHEN 作者写出 `also-as: [hifumi, "日富美, 小鸟游", name\,with\,comma]`
- THEN parser MUST treat `[...]` as an explicit list
- AND split only on unquoted and unescaped commas inside the list
- AND quoted commas and escaped `\,` MUST remain part of the corresponding list item

#### Scenario: Bare comma-separated fields are ambiguous

- GIVEN 某个声明字段需要列表值
- WHEN 作者写出 `also-as: hifumi, 日富美` without `[...]`
- THEN compiler SHOULD report ambiguous field list syntax
- AND MUST NOT silently reinterpret the bare scalar value as a list
