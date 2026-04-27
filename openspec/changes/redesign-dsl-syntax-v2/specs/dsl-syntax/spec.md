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

下一版 DSL SHALL 收敛查询占位的外形，保留后缀 target 形式并废弃前缀 target 形式。

#### Scenario: Query placeholders keep suffix targets

- GIVEN 一条查询占位语法
- WHEN 它需要显式 target
- THEN 使用 `[expr](target)` 或 `[:expr](target)` 形式

#### Scenario: Prefix target form is retired

- GIVEN 当前存在的 `(target)[expr]` 或 `(target)[:expr]` 形式
- WHEN 下一版 DSL 收敛查询语法时
- THEN 这些前缀 target 形式被废弃
- AND 前缀圆括号位置让给节点头部 patch

## ADDED Requirements

### Requirement: `@typ` is the explicit high-power Typst escape hatch

下一版 DSL SHALL 使用 `@typ` 作为显式的高权限 Typst 注入入口。

#### Scenario: Global Typst code uses `@typ`

- GIVEN 作者需要注入顶层 Typst 代码
- WHEN 在 DSL 中表达这类能力时
- THEN 使用 `@typ` 入口
- AND 它与普通内容节点、查询占位和局部 patch 明确分层

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

### Requirement: Slot-context selectors may omit the slot path

下一版 DSL SHALL 在 slot 已由上下文字段确定时，允许使用短资源 selector。

#### Scenario: Avatar patch can use a short variant selector

- GIVEN 一条带有当前说话人的消息节点
- WHEN `avatar:` patch 参数写成 `happy`
- THEN 它按当前 subject 的 `avatar/happy` 解析

#### Scenario: Contribution namespace disambiguates short selectors

- GIVEN 多个资源包为同一实体的同一 slot 贡献了同名 variant
- WHEN 作者需要选择其中一个
- THEN 可以写成 `contribution_namespace::variant`
- AND 编译器按当前 subject 与当前 slot 查找该资源包贡献的 variant

#### Scenario: Slot-context shorthand is not used without slot context

- GIVEN 一个没有明确 slot 字段的资源引用位置
- WHEN 作者写出裸 variant
- THEN parser 不应猜测它属于 `avatar`、`sticker` 或其他资源类型
- AND 作者应使用完整资源路径或其他明确资源引用

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
