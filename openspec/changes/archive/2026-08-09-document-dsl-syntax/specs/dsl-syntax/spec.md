## ADDED Requirements

### Requirement: Key-value directives follow parser rules

语法对于 `@key: value` 形式的键值指令，SHALL 予以接受；其中 key 按 `[A-Za-z_][\\w.-]*` 匹配，并在 parser 中归一化为小写。

#### Scenario: Metadata is captured from a single-line directive

- GIVEN 一行 `@title: Demo`
- WHEN parser 将其识别为键值指令
- THEN 生成一个 key 为 `title` 的 metadata 节点
- AND value 为第一个冒号之后经过修整的文本

### Requirement: Body directives use strict implemented forms

语法对于当前已实现的指令集合，SHALL 进行识别，并对每种写法做严格校验。

#### Scenario: Pack aliases are recorded but not used for selector resolution

- GIVEN `@usepack <pack_id> as <alias>`
- WHEN compiler 处理它时
- THEN 该 alias 被记录到输出 pack metadata 中
- AND 当前的说话人解析仍只理解已经实现的命名空间

### Requirement: Statements, blocks, and continuation lines follow line-based parsing

语法对于 `-`、`>`、`<`，只有在后面跟随空白时才 SHALL 将其视为 statement 起始；一旦进入正文解析，未匹配行 SHALL 被视为 continuation 文本。

#### Scenario: Standard statement lines are parsed by prefix

- GIVEN 一行以 `- `、`> ` 或 `< ` 开头
- WHEN parser 读取正文时
- THEN `-` 被解析成 narration
- AND `>` 与 `<` 被解析成带可选说话人标记的对话 statement

### Requirement: Dialogue speaker markers resolve using the implemented state machine

语法对于 `>` 与 `<` statement，SHALL 支持显式说话人、按边分别维护的 backreference，以及按首次出现顺序索引的引用方式。

#### Scenario: Explicit markers use the first top-level colon

- GIVEN 一行 `> Hoshino: hi`
- WHEN parser 对 payload 进行拆分
- THEN 位于括号和方括号之外的第一个冒号用于分离 marker 与 content
- AND 嵌套结构内部的冒号不会触发说话人 marker 解析

### Requirement: Special message directives preserve their implemented semantics

语法对于 `@reply`、`@bond` 和 `@pagebreak`，SHALL 严格按当前实现支持。

#### Scenario: Inline reply syntax requires at least one non-empty option

- GIVEN 一行 `@reply: a | b | c`
- WHEN parser 按 `|` 拆分 payload
- THEN 空项会被丢弃
- AND 至少要剩下一个选项

### Requirement: Inline expressions follow compiler tokenization rules

语法对于内联表达式，SHALL 依据 `parse_inline_segments` 与 compiler 当前的 target 解析规则进行处理。

#### Scenario: Non-Typst mode accepts the three implemented expression forms

- GIVEN 普通模式下的正文文本
- WHEN 扫描内联表达式时
- THEN `[query]`、`[query](target)` 和 `(target)[query]` 会被识别
- AND 反斜杠转义适用于方括号、圆括号和反斜杠本身
