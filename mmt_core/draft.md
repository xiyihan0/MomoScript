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
