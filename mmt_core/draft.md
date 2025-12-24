# MMT DSL Draft

## TODO / Pending
- Typst 模板和渲染侧尚未跟进，本草案仅记录语法意图。

## 1. typst_global 行为
- 允许可变（建议从当前位置起生效，支持 append 或 replace）。
- 作用域与安全边界需在实现时明确。

## 2. pagebreak 后的 header 变更
- `@pagebreak` 后允许重新设置 `@title` / `@author`。
- 未重新设置时继承上一页的值。

## 3. 回复选项（Reply）
两种写法都保留，结束标记统一为 `@end`。

### 3.1 块式
```
@reply
- 123
- 234
- 345
@end
```

支持单个选项使用三引号块：
```
@reply
- """
多行内容
"""
@end
```

### 3.2 行内式
```
@reply: 123 | 234 | 345
```

## 4. 羁绊事件（Bond）
允许不写文本，默认填充 `进入{上一个说话人名称}的羁绊剧情`。
支持用“续行”补充多行内容（后续行不以 `-/>/<` 或 `@` 开头即可），也支持三引号块。

```
@bond
```

或显式指定：
```
@bond: 日富美的羁绊剧情
```

三引号块：
```
@bond: """
...多行内容...
"""
```

或：
```
@bond
"""
...多行内容...
"""
```

## 5. JSON 结构草案
新增两种 `yuzutalk.type`：`REPLY` 与 `BOND`。

### 5.1 REPLY
```
{
  "yuzutalk": { "type": "REPLY", "avatarState": "NONE", "nameOverride": "" },
  "label": "回复",
  "items": [
    { "text": "123" },
    { "text": "234" },
    { "text": "345" }
  ],
  "line_no": 12
}
```

### 5.2 BOND
```
{
  "yuzutalk": { "type": "BOND", "avatarState": "NONE", "nameOverride": "" },
  "content": "进入日富美的羁绊剧情",
  "line_no": 20
}
```

## 6. AST/LSP 结构化清单（草案）
目标：把语义尽量前置到 parse 阶段，compiler 只做状态机与语义校验。

### 6.1 位置模型（Span）
- `Span`：`start_line/start_col/end_line/end_col`（1-based）
- 所有 Node 都带 `span`（至少 `start_line/start_col`）

### 6.2 头部指令（Header）
- `@key: value` → `MetaKV(key, value, span)`
- `@typst_global: ...` / `@typst_global: """..."""` → `TypstGlobal(value, span)`

### 6.3 正文指令（Directive）
- `@usepack <pack_id> as <alias>` → `UsePack(pack_id, alias, span)`
- `@alias <name>=<display>` → `Alias(name, display, span)`
- `@tmpalias <name>=<display>` → `TmpAlias(name, display, span)`
- `@aliasid <id> <name>` → `AliasId(id, name, span)`
- `@unaliasid <id>` → `UnaliasId(id, span)`
- `@charid <id> <display>` → `CharId(id, display, span)`
- `@uncharid <id>` → `UncharId(id, span)`
- `@avatarid <id> <asset>` → `AvatarId(id, asset, span)`
- `@unavatarid <id>` → `UnavatarId(id, span)`
- `@avatar <name>=<asset>` → `AvatarOverride(name, asset, span)`
- `@pagebreak` → `PageBreak(span)`
- `@reply: a|b|c` → `Reply(items[], span)`
- `@reply`...`@end` → `Reply(items[], span)`（支持三引号块）
- `@bond` / `@bond: ...` → `Bond(content, span)`（支持三引号块）

### 6.4 语句与续行
- `- / > / <` → `Statement(kind, marker, content, span)`
- 多行块 `"""..."""` → `Block(kind, marker, content, span)`
- 续行 → `Continuation(text, span)`

### 6.5 说话人标记（Marker）
- `> 名字: ...` → `MarkerExplicit(selector, span)`
- `> _n: ...` → `MarkerBackref(n, span)`（`_` 视为 `_1`）
- `> ~n: ...` → `MarkerIndex(n, span)`
- 无 marker → `MarkerNone`
  - `selector` 命名空间仅使用 `.` 作为分隔：`ba.xxx` / `custom.xxx` / `alias.xxx`

### 6.6 内联表达式（InlineExpr，建议在 parse 阶段结构化）
- 非 Typst 模式：
  - `[query]` / `(target)[query]` / `[query](target)` → `InlineExpr(query, target, span)`
- Typst 模式：
  - 仅允许 `[:query]` / `(target)[:query]` / `[:query](target)`（避免与 Typst 的 `[...]` 语法冲突）
- `query` 可细分：
  - `asset:<name>` / `asset:<ns>.<name>` → `InlineAsset(ns?, name)`（namespace 可选，默认按解析顺序）
  - `#5` / `#alias:12` / `#alias.12` → `InlineIndex(alias, n)`
  - `https://...` / `data:image/...` → `InlineImage(url)`
  - `图片` → `InlinePlaceholder`
- `target` 可细分：
  - `ba.xxx` / `custom.xxx` / `alias.xxx` / `_` / `_n`

## 7. 指令参数语法（讨论草案）
目标：为未来复杂指令提供统一、可扩展的参数格式。

候选 A：KV + 块（当前兼容路线）
- 行内：`@cmd key=value key2=value2`
- 块式：`@cmd` ... `@end`
- 块内用 `- item` 或 `key=value` 扩展结构

候选 B：S-Expression（结构表达力强，LSP 解析更一致）
- 形式：`(@cmd arg1 arg2 :key value (list ...))`
- 例：`@cmd (:items ("A" "B") :label "回复")`

## Corner Cases
- `> """123:` 会先被当成“说话人解析”（说话人 = `"""123`），导致块未被识别。
  - 建议写法：`> """` 起块，或 `> 角色名: """`。
- 首行是续行（不以 `-/>/<` 开头）会触发 “continuation line before any statement”。
- `@reply` 块内出现其他 `@` 指令会报错，且 `@reply` 不能为空，必须以 `@end` 结束。
- `@bond` 支持用“续行”与 `"""..."""` 多行块，但三引号结束标记必须独占一行。
- `@pagebreak` 必须独占一行，带内容会报错。
- Typst 模式下正文包含 `[` / `]` 等符号需要转义，否则 Typst 语法报错。
- `@typst_global` 当前是“后写覆盖”，早先气泡不会应用新的定义。
- `@usepack` 别名缺失或拼写错误时，`[#alias.12]` 不会被识别为直引。
- 多行块结束标记必须独占一行：`"""` 行后不能跟文本，否则会被当作块内内容并触发“未闭合”错误。
