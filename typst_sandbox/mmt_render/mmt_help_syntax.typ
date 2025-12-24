#show raw: set text(font: ("Cascadia Code","FZLanTingYuanGBK"))
#show raw.where(block: true): it => block(
  fill: luma(240),
  inset: 6pt,
  radius: 4pt,
  text(fill: black, it)
)
#set page(width: 168mm, height: auto, margin: (x: 10mm, y: 10mm))
#set text(size: 10.5pt, font: "FZLanTingYuanGBK", lang: "zh")
#set par(first-line-indent: (amount: 2em, all: true))

= MomoScript
MMT DSL 语法速览

== 头部指令（\@）
- 只在文件开头解析，用于填写元信息或 Typst 全局代码
- 形式：`@key: value`（value 为任意文本）
- 常用：`@title` / `@author` / `@created_at`（会写入输出 JSON 的 `meta`）
- 其它 `@key` 也会写入 `meta`（不与保留字段冲突即可）
- Typst：`@typst_global: ...`（可配合 `"""..."""` 写多行块）
- 资源：`@asset.xxx: https://...`（在正文中用 `asset:xxx` 引用）
- 备注：
  - `@typst: on|off` 只写入 `meta.typst`，实际解析模式以 `--typst` 为准
  - 文档中的 `...` 仅表示“任意内容占位”，不是语法的一部分；实际写法是 `@key: value`

== 动态别名（\@alias）
- 可出现在任意位置，仅修改显示名（不影响 id 查找；对后续气泡持续生效）
- 语法：`@alias 角色名=显示名`（清空：`@alias 角色名=`）

== 临时别名（\@tmpalias）
- 局部作用域显示名覆盖（切换到其它说话人后自动回退）
- 语法：`@tmpalias 角色名=显示名`（清空：`@tmpalias 角色名=`）

== 别名 ID / 自定义人物
- `@aliasid <id> <角色名>` / `@unaliasid <id>`：短 id 映射到真实角色名
- `@charid <id> <显示名>` / `@uncharid <id>`：声明自定义人物（不走学生库）

== 头像覆盖
- 标准库角色：`@avatar 角色名=<asset_name>` / `@avatar 角色名=`
- 自定义人物：`@avatarid <id> <asset_name|学生名|kivo-xxx>` / `@unavatarid <id>`

== 分页
- `@pagebreak`（单独一行，强制分页）

== 语句行
- `- `：旁白（居中系统文本）
- `> `：对方气泡（默认左侧）
- `< `：自己气泡（默认右侧；也可以写成其它角色的右侧气泡）

== 续行
不以 `- ` / `> ` / `< ` 开头的行会被视为上一条语句的续行（一般用 `\\n` 连接）。

== 多行块（`"""..."""`）
当内容以 `"""`（或更多连续引号，如 `""""`）开头时进入多行块，直到遇到“单独一行”的同样引号长度结束。
块内内容原样保留（推荐用于列表/公式/代码）。

== 说话人
`>` 与 `<` 可携带“说话人切换”标记：

- 显式指定：`> {name}: {content}` 或 `< {name}: {content}`
- 方向内回溯：`> _:` / `> _2:`（回到该方向历史的第 1/2 个说话人）
- “第 i 个出现的人物”：`> ~1:`（从对话开始以来第 1 个新出现的说话人）

== 扩展包与命名空间
- `@usepack <pack_id> as <alias>`：引入扩展包并指定别名
- 说话人可写 `namespace.character`（例如 `ba.梦`）

== 表情/图片标记
普通模式（未开启 `--typst`）：
- `[描述]` / `[角色:描述]` / `(角色)[描述]`（会进入 rerank 解析）
- `[asset:xxx]`（引用头部 `@asset.xxx`；需要 resolve 才能下载外链）
- `[://...]` / `[https://...]`（外链图片）
- `[#alias.12]`（按编号引用扩展包内的图片）

Typst 模式（`--typst`）：
- 只识别 `[:描述]` / `[:角色:描述]` / `(角色)[:描述]`
- `[:asset:xxx]`（引用头部 `@asset.xxx`；需要 resolve 才能下载外链）
- `[:#alias.12]`（按编号引用扩展包内的图片）
- 其它 `[...]` 会原样交给 Typst（因此纯文本里的 `[`/`]` 可能需要转义）

== 特殊消息块
- `@reply ... @end`：回复选项块（多行内容）（或者可以有`@reply: msg1 | msg2 | ...`的行内写法）
- `@reply` 的每个选项支持 `"""..."""` 多行块
- `@bond: <文本>`：羁绊剧情块（不填文本会自动生成）
- `@bond` 支持后续“续行”和 `"""..."""` 多行块

== 示例
```text
@title: 测试
@author: (可省略，插件会自动填充)

> 星野: 早上好
> 续行（仍然是星野）
@alias 星野=星野(一年级)
> 1!
@alias 星野=星野(临战)
> 2!

- """
#let fib(n) = if n <= 2 { 1 } else { fib(n - 1) + fib(n - 2) }
#fib(10)
"""

> [:期待]
```

Tip：若开启 `--typst`，可以用 ``` """...""" ``` 在气泡里写 Typst 的原始代码块。
