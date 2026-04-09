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

### Requirement: Declaration values support lightweight string literals

下一版 DSL SHALL 在声明层支持轻量字面量系统，以处理带空格或特殊字符的值。

#### Scenario: Quoted values preserve special characters

- GIVEN 一个配置值包含空格、逗号或其他容易引起分词歧义的字符
- WHEN 作者编写声明层参数时
- THEN 可以使用单引号或双引号字符串
- AND parser 应正确保留该值
