## ADDED Requirements

### Requirement: Key-value directives follow parser rules

语法对于 `@key: value` 形式的键值指令，SHALL 予以接受；其中 key 按 `[A-Za-z_][\\w.-]*` 匹配，并在 parser 中归一化为小写。

### Requirement: Body directives use strict implemented forms

语法对于当前已实现的指令集合，SHALL 进行识别，并对每种写法做严格校验。

### Requirement: Statements, blocks, and continuation lines follow line-based parsing

语法对于 `-`、`>`、`<`，只有在后面跟随空白时才 SHALL 将其视为 statement 起始；一旦进入正文解析，未匹配行 SHALL 被视为 continuation 文本。

### Requirement: Dialogue speaker markers resolve using the implemented state machine

语法对于 `>` 与 `<` statement，SHALL 支持显式说话人、按边分别维护的 backreference，以及按首次出现顺序索引的引用方式。

### Requirement: Special message directives preserve their implemented semantics

语法对于 `@reply`、`@bond` 和 `@pagebreak`，SHALL 严格按当前实现支持。

### Requirement: Inline expressions follow compiler tokenization rules

语法对于内联表达式，SHALL 依据 `parse_inline_segments` 与 compiler 当前的 target 解析规则进行处理。
