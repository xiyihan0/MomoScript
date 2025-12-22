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

### 3.2 行内式
```
@reply: 123 | 234 | 345
```

## 4. 羁绊事件（Bond）
允许不写文本，默认填充 `{上一个说话人名称}的羁绊剧情`。

```
@bond
```

或显式指定：
```
@bond: 日富美的羁绊剧情
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
  "content": "日富美的羁绊剧情",
  "line_no": 20
}
```
