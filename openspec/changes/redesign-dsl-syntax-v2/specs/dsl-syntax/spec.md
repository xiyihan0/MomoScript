## MODIFIED Requirements

### Requirement: Body directives use strict implemented forms

下一版 DSL SHALL 收敛正文指令体系，优先采用聚合声明；若提供短行形式，也应视为统一简写而不是独立风格。

#### Scenario: Character configuration moves toward aggregated declarations

- GIVEN 下一版 DSL 需要表达人物默认显示名、来源角色、头像和别名
- WHEN 设计人物配置语法时
- THEN 优先使用类似 `@char ... @end` 的聚合声明
- AND 不再把这些能力拆散到多条互相耦合的指令里

#### Scenario: Character template is cloned into a workspace instance

- GIVEN `ba::日富美` 是资源包提供的不可变人物 template
- WHEN 作者写出 `@char hifumi` 且 block 内包含 `bind: ba::日富美`
- THEN compiler 在当前脚本工作区创建一个从该 template clone 而来的 mutable instance
- AND `hifumi` handle 指向这个 instance
- AND 后续 patch 不修改资源包里的 `ba::日富美` template

#### Scenario: Existing character handle opens its current instance

- GIVEN `hifumi` 已经指向某个 workspace instance
- WHEN 作者再次写出 `@char hifumi` 且 block 内没有 `bind:`
- THEN compiler 打开 `hifumi` 当前指向的 instance
- AND block 内字段 patch 到该 instance 上
- AND 作者不需要为了让修改延续到后续文本而重复 `bind:`

#### Scenario: Existing character handle rejects implicit rebind

- GIVEN `hifumi` 已经指向某个 workspace instance
- WHEN 作者再次写出 `@char hifumi` 且 block 内包含 `bind: ba::日富美`
- THEN compiler MUST report unsupported rebind syntax in the first revision
- AND MUST NOT clone a new instance or mutate the existing binding implicitly

#### Scenario: Script-local character template creates a matching instance

- GIVEN 作者需要创建一个不来自资源包的新人物
- WHEN 作者写出 `@char yz` 且 block 内没有 `bind:`
- THEN compiler 创建一个脚本本地 character template
- AND 同时 clone 一个对应 workspace instance
- AND `yz` handle 指向该 instance

#### Scenario: Additional handles are explicit

- GIVEN `hifumi` 已经指向某个 workspace instance
- WHEN 作者在 `@char hifumi` block 内写出 `handles: 日富美`
- THEN `日富美` 被显式绑定为指向同一个 instance 的额外 handle
- AND 通过 `hifumi` 或 `日富美` 修改该 instance 时，另一个 handle 观察到同一修改

#### Scenario: Multiple positional handles are not implicit aliases

- GIVEN 下一版 `@char` 第一版语法
- WHEN 作者写出 `@char hifumi 日富美`
- THEN compiler MUST reject this form as ambiguous
- AND 作者应使用单一主 handle 加 `handles:` 字段显式添加额外 handle

#### Scenario: Handle conflict is rejected by default

- GIVEN `a` 和 `b` 已经分别指向不同 workspace instance
- WHEN 作者在 `@char a` block 内写出 `handles: b`
- THEN compiler MUST report a handle conflict
- AND MUST NOT implicitly merge instances or rebind `b`

#### Scenario: Asset registration moves toward aggregated declarations

- GIVEN 下一版 DSL 需要注册资源并允许显式 namespace
- WHEN 设计资源声明语法时
- THEN 优先采用类似 `@asset ... @end` 的聚合声明
- AND 允许 `ns` 参数显式指定命名空间
- AND 如果存在 `@asset: hero src:...` 之类的短行形式，它应被视作统一简写而不是另一套配置体系

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

#### Scenario: Statement lines accept implicit continuations

- GIVEN 一条顶层 `>`、`<` 或 `-` statement
- WHEN 后续行不是明确的新顶层节点起始或当前上下文结束标记
- THEN parser MUST append that line as continuation text of the previous statement
- AND preserve the line break between statement content and continuation text

#### Scenario: Statement continuation stops at explicit node starts

- GIVEN 一条 statement 后存在后续行
- WHEN 后续行在未缩进的行首以新的 `>`、`<`、`-` statement 或 `@reply`、`@bond`、`@char`、`@asset`、`@typ`、`@end` 等明确节点头开始
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

- GIVEN 某个 subject 的 `sticker` slot 具有 manifest 或 tags 中声明的稳定顺序
- WHEN 作者写出 `[:#1:]`、`[:ba_extpack::#1:]` 或 `[:ba::晴_露营/sticker/#1:]`
- THEN `#1` 按 1-based ordinal selector 解析
- AND 该 selector 不进入关键词匹配或自然语言语义查询

#### Scenario: Ordinal selector fails deterministically

- GIVEN 作者使用 `#n` 编号 selector
- WHEN 编号越界、缺少稳定顺序信息或 contribution namespace 存在歧义
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

- GIVEN 作者写出 `@mode: T`
- WHEN 后续 statement、reply item 或 bond content 没有局部 body mode override
- THEN those body nodes inherit Typst syntax with MMT macro expansion
- AND later `@mode:` directives update the default for following body nodes

#### Scenario: Mode directive is file-local and body-only

- GIVEN 作者在某个文件中写出 `@mode: T`
- WHEN compiler parses declarations, `@typ` blocks, or another file
- THEN `@mode` MUST NOT affect `@char` fields, `@asset` fields, or `@typ` content
- AND MUST NOT propagate across file boundaries

#### Scenario: Fenced body can override mode locally

- GIVEN 当前默认正文模式是 `t`
- WHEN 作者写出 `T"""#strong[你好] [:#1:]"""`、`rT"""#let s = "literal [:#1:]" """`、`t"""普通文本 [:#1:]"""` 或 `rt"""这里的 [:#1:] 不展开"""`
- THEN the prefix controls only that fenced body
- AND unprefixed fenced bodies inherit the current default body mode

#### Scenario: Inline resource marker is an MMT macro, not Typst syntax

- GIVEN 正文模式是 `t` 或 `T`
- WHEN body text contains `[:#1:]`
- THEN compiler MUST parse it as an MMT inline resource macro before final Typst emission
- AND final emitted Typst source MUST contain valid Typst constructs instead of raw `[:...:]` marker syntax

#### Scenario: Text mode can escape macro opener

- GIVEN 正文模式是 `t`
- WHEN body text contains `\[:`
- THEN compiler MUST preserve it as literal `[:`
- AND MUST NOT start an inline resource macro at that position

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

#### Scenario: Full resource paths identify entity, contribution source, slot, and variant

- GIVEN 一条人物资源引用
- WHEN 作者需要完整指定资源
- THEN 使用 `<subject-ref>/[contribution_namespace::]<slot>/<variant>` 形式
- AND `subject-ref` 可以是全局实体引用或脚本上下文中的 handle
- AND `contribution_namespace` 用于显式指定某个资源包贡献的资源

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

#### Scenario: Field lists use quoted and escaped separators

- GIVEN 某个声明字段使用逗号分隔列表值，例如 `handles:`
- WHEN 作者写出 `handles: hifumi, "日富美, 小鸟游", alias\,with\,comma`
- THEN parser MUST split only on unquoted and unescaped commas
- AND quoted commas and escaped `\,` MUST remain part of the corresponding list item
