# dsl-syntax 规格

## Purpose

定义当前已经实现的 MomoScript 语法表面，以 `mmt_core/dsl_parser.py` 的解析行为和 `mmt_core/dsl_compiler.py` 的解释行为为准。

## Requirements

### Requirement: Key-value directives follow parser rules

语法对于 `@key: value` 形式的键值指令，SHALL 予以接受；其中 key 按 `[A-Za-z_][\\w.-]*` 匹配，并在 parser 中归一化为小写。

#### Scenario: Metadata is captured from a single-line directive

- GIVEN 一行 `@title: Demo`
- WHEN parser 将其识别为键值指令
- THEN 生成一个 key 为 `title` 的 metadata 节点
- AND value 为第一个冒号之后经过修整的文本

#### Scenario: `@typst_global` uses the dedicated node type

- GIVEN 一行 `@typst_global: #let foo = 1`
- WHEN parser 读取该行
- THEN 它生成 `TypstGlobal` 节点而不是通用 metadata 节点
- AND compiler 将最新值保存为 `typst_global`

#### Scenario: Triple-quoted key-value blocks are allowed

- GIVEN 某条指令的 value 以 `\"\"\"` 或更长的引号分隔符开头
- WHEN 后面出现单独成行且长度一致的结束分隔符
- THEN 中间所有行都成为该指令的 value
- AND 结束分隔符必须使用相同长度的引号

#### Scenario: Key-value directives remain valid after body parsing begins

- GIVEN 正文中出现一行 `@asset.hero: https://example.invalid/hero.png`
- WHEN parser 发现它符合通用键值指令模式
- THEN 它仍被解析为 metadata，而不是未知正文指令
- AND 即使前面已经出现过 statement，这条规则仍然成立

### Requirement: Body directives use strict implemented forms

语法对于当前已实现的指令集合，SHALL 进行识别，并对每种写法做严格校验。

#### Scenario: Pack aliases are recorded but not used for selector resolution

- GIVEN `@usepack <pack_id> as <alias>`
- WHEN compiler 处理它时
- THEN 该 alias 被记录到输出 pack metadata 中
- AND 当前的说话人解析仍只理解已经实现的命名空间，例如 `ba`、`kivo` 和 `custom`

#### Scenario: Alias and custom-character directives validate their operands

- GIVEN `@alias`、`@tmpalias`、`@aliasid`、`@unaliasid`、`@charid`、`@uncharid` 这类指令
- WHEN parser 和 compiler 处理它们时
- THEN 缺失必要参数会被拒绝
- AND `@charid` 的 id 必须匹配 `^[\\w][\\w\\-]*$`

#### Scenario: Avatar directives use the current implemented behavior

- GIVEN `@avatarid <id> <asset>`
- WHEN compiler 处理它时
- THEN 被引用的 custom id 必须已经通过 `@charid` 定义
- AND `asset` 既可以解析成标准学生头像 token，例如 `kivo-288`，也可以解析成 `asset:<name>` 引用

#### Scenario: Standard avatar override stays asset-based

- GIVEN `@avatar <name>=<asset>`
- WHEN compiler 处理它时
- THEN 被命名的说话人必须能解析成非 Sensei 角色
- AND 右侧为空时表示清除 override
- AND 右侧非空时按 asset override 保存，而不是按学生头像查找保存

### Requirement: Statements, blocks, and continuation lines follow line-based parsing

语法对于 `-`、`>`、`<`，只有在后面跟随空白时才 SHALL 将其视为 statement 起始；一旦进入正文解析，未匹配行 SHALL 被视为 continuation 文本。

#### Scenario: Standard statement lines are parsed by prefix

- GIVEN 一行以 `- `、`> ` 或 `< ` 开头
- WHEN parser 读取正文时
- THEN `-` 被解析成 narration
- AND `>` 与 `<` 被解析成带可选说话人标记的对话 statement

#### Scenario: Triple-quoted statement blocks preserve block content

- GIVEN 某条 statement 的内容以 `\"\"\"` 或更长匹配引号开头
- WHEN 找到对应结束分隔符时
- THEN parser 为该 statement 产出 block 节点
- AND compiler 将其标记为 `no_inline_expr`

#### Scenario: Continuation lines append to the previous message

- GIVEN 一行正文既不是已识别指令，也不是 statement 起始
- WHEN 编译执行时
- THEN 这一行会追加到上一条 message 的内容里
- AND 默认分隔符是换行

#### Scenario: Blank lines are meaningful only after body parsing begins

- GIVEN 在正文开始前出现空行
- WHEN parser 仍在扫描前导 metadata
- THEN 该空行被忽略

#### Scenario: Blank lines in Typst mode extend the previous message

- GIVEN 在正文开始后出现空行
- AND Typst mode 已开启
- WHEN 编译执行时
- THEN 该空行会作为空 continuation 追加到上一条 message

#### Scenario: `#` lines are not global comments in the body

- GIVEN 在正文开始后出现一行以 `#` 开头的文本
- WHEN 它不位于 `@reply` block 内部
- THEN 它会被视作普通 continuation 文本，而不是注释

### Requirement: Dialogue speaker markers resolve using the implemented state machine

语法对于 `>` 与 `<` statement，SHALL 支持显式说话人、按边分别维护的 backreference，以及按首次出现顺序索引的引用方式。

#### Scenario: Explicit markers use the first top-level colon

- GIVEN 一行 `> Hoshino: hi`
- WHEN parser 对 payload 进行拆分
- THEN 位于括号和方括号之外的第一个冒号用于分离 marker 与 content
- AND `[...]` 或 `(...)` 内部的冒号不会触发说话人 marker 解析

#### Scenario: Backreferences and indexes are side-local

- GIVEN `_:`、`_2:`、`~:`、`~2:` 这类 marker
- WHEN compiler 解析它们时
- THEN `_` 与 `~` 都按 `1` 处理
- AND 解析使用该对话方向自身维护的历史记录

#### Scenario: Left-side dialogue defaults to Sensei

- GIVEN 一条 `<` statement 没有显式说话人，且当前左侧说话人也不存在
- WHEN compiler 解析该行
- THEN 产出的 message 使用 Sensei 作为说话人

#### Scenario: Right-side dialogue requires a known current speaker

- GIVEN 一条 `>` statement 没有显式说话人，且当前右侧说话人也不存在
- WHEN compiler 解析该行
- THEN 编译以 missing-speaker 错误失败

#### Scenario: Explicit unknown speakers in dialogue fall back to custom characters

- GIVEN 某个对话 marker 中的显式 selector 无法通过已知命名空间解析
- WHEN compiler 处理该对话 statement 时
- THEN 该 selector 可能回退为一个带哈希的 custom character id
- AND 指令参数中的 selector 解析不使用这个回退逻辑

### Requirement: Special message directives preserve their implemented semantics

语法对于 `@reply`、`@bond` 和 `@pagebreak`，SHALL 严格按当前实现支持。

#### Scenario: Inline reply syntax requires at least one non-empty option

- GIVEN 一行 `@reply: a | b | c`
- WHEN parser 按 `|` 拆分 payload
- THEN 空项会被丢弃
- AND 至少要剩下一个选项

#### Scenario: Block reply syntax uses `@end` as an exact closing token

- GIVEN 一个以 `@reply` 开始的 block
- WHEN 解析 reply 项时
- THEN block 内部的空行和以 `#` 开头的注释行会被忽略
- AND `@end` 必须独占一行
- AND block 内出现其他 `@` 指令会被拒绝

#### Scenario: Bond defaults to the latest display name

- GIVEN `@bond` 没有显式文本
- WHEN compiler 产出 bond message 时
- THEN 内容默认变成 `进入{last display name}的羁绊剧情`
- AND 如果此前不存在 display name，则使用 `未知角色`

#### Scenario: Page breaks are exact directives

- GIVEN 一行以 `@pagebreak` 开头
- WHEN parser 处理它时
- THEN 该指令必须严格等于 `@pagebreak`
- AND 任何额外尾随内容都会被拒绝

### Requirement: Inline expressions follow compiler tokenization rules

语法对于内联表达式，SHALL 依据 `parse_inline_segments` 与 compiler 当前的 target 解析规则进行处理。

#### Scenario: Non-Typst mode accepts the three implemented expression forms

- GIVEN 普通模式下的正文文本
- WHEN 扫描内联表达式时
- THEN `[query]`、`[query](target)` 和 `(target)[query]` 会被识别
- AND 反斜杠转义适用于方括号、圆括号和反斜杠本身

#### Scenario: Typst mode only promotes colon-prefixed brackets to expressions

- GIVEN Typst 模式下的正文文本
- WHEN 扫描内联表达式时
- THEN 只有 query 以 `:` 开头的表达式才会被解析成 expression
- AND 普通 `[...]` 文本会被保留下来给 Typst 标记语法使用

#### Scenario: Empty-target asset and URL expressions use specialized output

- GIVEN 一个没有 target 的表达式
- WHEN query 是 `asset:<name>`
- THEN compiler 产出 asset segment

#### Scenario: URL-like expressions become image segments

- GIVEN 一个没有 target 的表达式
- WHEN query 是 HTTP、HTTPS、协议相对地址或 `data:image/` URL
- THEN compiler 产出 image segment

#### Scenario: Implicit expression targets use the current non-Sensei text speaker

- GIVEN 一个没有 target 的表达式，例如 `[期待]`
- WHEN 当前文本说话人是非 Sensei 的 `kivo-*` 或 `ba.*` 角色
- THEN compiler 以当前说话人为目标解析这个表达式
- AND 否则该表达式会按当前实现分支被拒绝，或退回为纯文本

#### Scenario: Inline expression target namespaces are narrower than dialogue selectors

- GIVEN 一个内联表达式 target
- WHEN compiler 解析它时
- THEN 当前实现接受裸学生名、`kivo-*` 和 `ba.<name>`
- AND 不支持的 target 命名空间，例如 `custom.<id>`，会被拒绝

#### Scenario: Backreference targets inside expressions use global text history

- GIVEN 一个表达式 target，例如 `(_)` 或 `(_2)`
- WHEN compiler 解析它时
- THEN 它使用的是此前文本说话人的全局历史
- AND 而不是对话 marker 所使用的按边维护的局部历史
