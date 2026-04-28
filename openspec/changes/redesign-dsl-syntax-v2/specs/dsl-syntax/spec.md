## MODIFIED Requirements

### Requirement: Body directives use strict implemented forms

下一版 DSL SHALL 收敛正文指令体系，优先采用聚合声明；若提供短行形式，也应视为统一简写而不是独立风格。

#### Scenario: Character configuration moves toward aggregated declarations

- GIVEN 下一版 DSL 需要表达人物默认显示名、来源角色、头像和别名
- WHEN 设计人物配置语法时
- THEN 优先使用类似 `@char ... @end` 的聚合声明
- AND 不再把这些能力拆散到多条互相耦合的指令里

#### Scenario: Asset registration moves toward aggregated declarations

- GIVEN 下一版 DSL 需要注册资源并允许显式 namespace
- WHEN 设计资源声明语法时
- THEN 优先采用类似 `@asset ... @end` 的聚合声明
- AND 允许 `ns` 参数显式指定命名空间
- AND 如果存在 `@asset: hero src:...` 之类的短行形式，它应被视作统一简写而不是另一套配置体系

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

### Requirement: Inline expressions follow compiler tokenization rules

下一版 DSL SHALL 将消息正文中的表情包、素材引用与轻量查询收束为 `[:...:]` bracket-colon 参数列表。

#### Scenario: Sticker marker uses argument-list syntax

- GIVEN 一条消息正文需要插入当前 subject 的表情包
- WHEN 作者写出 `[:开心:]`
- THEN parser 将其识别为 sticker/resource marker
- AND 单个位置参数按当前 subject 的 `sticker` slot 解析

#### Scenario: Subject and sticker selector can be provided positionally

- GIVEN 一条消息正文需要引用指定人物的表情包
- WHEN 作者写出 `[:晴_露营, >_<笑:]` 或 `[:ba::晴_露营, >_<笑:]`
- THEN 第一个位置参数按 subject-ref 解析
- AND 第二个位置参数按该 subject 的 `sticker` selector 或 query 解析

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

#### Scenario: Semantic sticker query uses explicit question prefix

- GIVEN 作者需要按自然语言描述查找表情包
- WHEN 作者写出 `[:?坏笑:]` 或 `[:ba::晴_露营, ?坏笑:]`
- THEN `?` 后的文本进入自然语言查询
- AND 查询范围限定在当前 subject 或显式 subject 的 `sticker` slot

#### Scenario: Semantic query can be scoped to a contribution namespace

- GIVEN 作者需要在某个资源包贡献的表情包中按自然语言查询
- WHEN 作者写出 `[:ba::晴_露营, ba_extpack::?坏笑:]`
- THEN `ba_extpack` 按 contribution namespace 解析
- AND `?坏笑` 只在该贡献来源下进入自然语言查询

#### Scenario: Quoted semantic query keeps punctuation as query text

- GIVEN 自然语言查询包含逗号、空格或其他分隔字符
- WHEN 作者写出 `[:ba::晴_露营, ba_extpack::?"半眯眼、得意、像是在调侃":]`
- THEN 引号内文本作为完整 query 保留
- AND `?` 仍然是进入自然语言查询的唯一触发标记

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

#### Scenario: Named arguments are local render options

- GIVEN marker 需要为当前表情包设置局部渲染参数
- WHEN 作者写出 `[:ba::晴_露营, ba_extpack::">_<笑", width: 2em:]`
- THEN `width: 2em` 作为该 marker 的局部参数传给渲染层
- AND 参数片段仍需满足 Typst 参数级语法检查

#### Scenario: Deterministic references do not fall back to natural language

- GIVEN marker 中的裸位置参数包含 `:`、`.` 或 `/`
- WHEN 它没有被引号包裹且资源解析失败
- THEN compiler MUST report an unresolved or invalid reference
- AND MUST NOT silently reinterpret it as natural language query

#### Scenario: Natural language fallback is not implicit for quoted deterministic selectors

- GIVEN marker 中出现 `namespace::"literal"`
- WHEN 该 selector 查找失败
- THEN compiler MUST report an unresolved reference
- AND MUST NOT reinterpret `"literal"` as a semantic query unless it used `?`

#### Scenario: Legacy inline target forms are not the preferred next syntax

- GIVEN 当前实现存在 `[expr]`、`[expr](target)`、`(target)[expr]` 或旧 Typst 模式占位形态
- WHEN 下一版 DSL 收敛内联表达式语法时
- THEN 主写法应使用 `[:...:]`
- AND 旧形态只作为兼容或废弃策略另行评估

## ADDED Requirements

### Requirement: `@typ` is the explicit high-power Typst escape hatch

下一版 DSL SHALL 使用 `@typ` 作为显式的高权限 Typst 注入入口。

#### Scenario: Global Typst code uses `@typ`

- GIVEN 作者需要注入顶层 Typst 代码
- WHEN 在 DSL 中表达这类能力时
- THEN 使用 `@typ` 入口
- AND 它与普通内容节点、表情/资源引用标记和局部 patch 明确分层

### Requirement: Local patch syntax embeds valid Typst call arguments

下一版 DSL 的局部 patch SHALL 以 Typst 风格函数参数片段表达，并通过 Typst 语法级检查。

#### Scenario: Patch content must be valid call arguments

- GIVEN 一个节点头部 patch，例如 `>(fill: green, inset: 5pt)`
- WHEN 编译器准备把它展开到对应 Typst 函数调用时
- THEN patch 内容必须能被解析为合法的 Typst 参数列表
- AND 只有通过语法检查且 AST 形态符合预期时，才允许进入 emitter

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
- WHEN 该引用需要 DSL selector、contribution namespace 或 query fallback
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
