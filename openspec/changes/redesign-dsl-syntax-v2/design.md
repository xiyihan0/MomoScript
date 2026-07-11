## Overview

这一版 DSL 重构围绕一个核心判断展开：后续渲染主路径将从“生成 JSON 再由 Typst 文档解释遍历”转向“由 MMT 直接展开为 Typst 文档”。在这个前提下，语法层必须承担更多结构化职责，而不是继续依赖模板运行时兜底。

## Design Goals

### 1. 让核心 DSL 更聚焦

核心 DSL 负责：

- 叙事节点结构
- 说话人与人物引用
- 确定性资源引用标记
- 节点级局部参数 patch

核心 DSL 不负责：

- 大量 Typst 运行时代码
- 把渲染逻辑继续塞回模板解释阶段

### 2. 把 Typst 注入显式分层

下一版倾向把 Typst 能力分成两层：

- `@typ`：高权限顶层 Typst 注入，直接进入文档正文
- 节点头部 patch：仅允许单行、合法的 Typst 参数列表片段，作用于当前节点

这样可以把“任意 Typst 代码”和“局部渲染参数覆盖”分开。

### 3. 统一配置语法的心智模型

配置能力分成两类：

- 聚合声明：例如 `@actor ... @end`
- 短行声明：作为聚合声明的可选简写，例如 `@asset: hero src:...`

二者都倾向使用同一套 `key: value` 风格，而不是继续混用 `name=value`、位置参数和特殊指令形态。

## Candidate Syntax Direction

### 脚本角色配置

作者侧不再暴露 template / mutable instance / handle reference 三层对象关系，而使用更直接的两层模型：

- `character preset`：资源包 entity 提供的只读角色预设，包括确定性名称、默认显示名、avatar 与 sticker 资源
- `script actor`：当前脚本中实际登场、可从当前位置起修改的角色

脚本 actor 可以有多个可写名称。每次修改产生新的 actor revision；statement 捕获当时的 revision，因此后续修改不会追溯改变已经解析的消息。编译器内部可以使用 `CharacterPreset`、`ActorBinding`、`ActorRevision` 与 `ActorNameTable` 表达该模型，但作者只需要理解“预设提供初值，脚本角色状态影响后文”。

推荐聚合声明为：

```text
@actor yz
preset: ba::柚子
display-name: "游戏开发部的柚子"
avatar: asset::yz_default
also-as: [yuzu]
@end
```

其中：

- 头部位置参数是主要脚本角色名称，而不是内部 id
- `preset:` 只在创建 actor 时指定只读角色预设
- `display-name:` 是渲染时显示的名称，不参与脚本名称解析
- `also-as:` 为同一个 actor 增加其他可写名称，语义始终是 additive
- `avatar:` 修改该 actor 从当前位置开始使用的头像状态

无头形式用于打开或创建某个 preset 的默认 script actor，作者不需要额外发明内部名称：

```text
@actor
preset: ba::柚子
avatar: smile
@end
```

资源包 entity 的 `names[0]` 作为默认 actor name，其余 names 也解析到该默认 actor。正文完全不写 `@actor` 时，唯一匹配的资源包名称也可以惰性创建默认 actor：

```text
> 柚子: 你好
```

创建与修改规则：

- 无头 `@actor` 必须包含 `preset:`；它打开或惰性创建该 preset 的默认 actor
- `@actor <name>` 不含 `preset:` 时，打开已有 actor；名称不存在则报错，不隐式创建缺少 preset 的角色
- `@actor <name>` 含 `preset:` 且名称不存在时，基于该 preset 创建一个独立 actor
- 已有 actor 再次带 `preset:` 默认报 unsupported rebind，不替换其初始预设
- `also-as:` 中的名称若已属于其他 actor，默认报 name conflict，不抢占或合并
- `@actor a b` 这类多位置名称写法不作为第一版目标

资源包 aliases 只服务 IDE/catalog 搜索，不进入 actor name table。

### 资源配置

块状配置是 canonical form：

```text
@asset hero
ns: custom
src: https://example.com/hero.png
@end
```

v2 第一版同时支持 lowering 到相同 `ScriptAsset` IR 的 short form：

```text
@asset: hero src:https://example.com/hero.png
@asset: hero ns:custom src:https://example.com/hero.png
```

其中：

- `src` 必填
- `ns` 若省略，默认使用 `custom`
- short form 只支持与 block 相同的 `src` / `ns` 字段，不形成第二套语义
- 旧 `@asset.<name>:` metadata 形式不进入 v2 主 parser

### 节点头部 patch

倾向采用 Typst 风格函数参数形式：

```text
>(fill: green, inset: 5pt) yz: 你好！
<(fill: blue) 老师：嗯？
-(align: left) 这是一段旁白
@reply(label: [请选择])
@bond(fill: green)
```

约束：

- 只作用于当前节点
- 第一版只允许单行
- 内容必须能被解析为合法的 Typst 参数列表
- 不允许在 patch 中嵌入任意 Typst statement block

syntax parser 第一版只负责检查外层 `(...)` 是否闭合，并保留 patch 原文 range；具体内容是否是合法 Typst 参数列表，交给后续 Typst 参数级检查。这样可以把“MMT 行头结构解析”和“Typst 参数语法检查”解耦。

### 说话人 marker 与历史引用

旧语法中的 `_` / `~` 说话人引用第一版先保留，但作为 legacy-compatible speaker marker 明确建模，而不是继续混入普通 selector 字符串。

```text
> 柚子: 你好
> _: 继续由上一位右侧说话人发言
> _2: 引用右侧历史中的上一位之前的说话人
> ~1: 引用右侧首次出现顺序中的第 1 位说话人
```

建议规则：

- `_:` 与 `_1:` 等价，表示当前方向的最近一次说话人
- `_n:` 表示当前方向 speaker history 中向前第 n 个说话人
- `~:` 与 `~1:` 等价，表示当前方向首次出现顺序中的第 1 位说话人
- `~n:` 表示当前方向首次出现顺序中的第 n 位说话人
- `>` 与 `<` 各自维护独立 speaker history 与 unique speaker index
- 在新 `@actor` 模型下，这类引用应解析到 script actor identity，而不是 preset id、名称字符串或 display name

也就是说，历史引用指向 actor identity。多个名称可以指向同一个 actor；通过任一名称修改后，后续历史引用会观察到该 actor 的最新 revision，而已经生成的早期 statement 仍保留原 revision。

### statement 续行与 fenced block

`>`、`<`、`-` 这三类 statement 默认支持续行：

```text
- 12345
67890
```

语义上等价于同一个旁白节点包含两行内容。普通续行的终止条件是遇到新的明确顶层节点起始，例如新的 `>` / `<` / `-` statement、`@reply`、`@bond`、`@actor`、`@asset`、`@typ` 或 `@end` 等。

顶层节点识别只看未缩进的行首。缩进后的 `> `、`@reply` 等文本不切断当前 statement，而是作为 continuation 原样保留；parser 可以为这种“缩进后看起来像节点头”的行给出 info 级 diagnostic。

`"""..."""` 这类 fenced block 不是为了“启用多行”，而是为了保护内容不被行头标记打断：

```text
- """
@reply: 这行只是文本
> 这行也只是文本
"""
```

fence 内部保持为当前 statement 的正文，不参与顶层行头识别。是否继续扫描 `[:...:]` marker 取决于该 statement 的正文模式，而不是 fence 本身。

fence 至少使用 3 个连续双引号。若正文需要包含 `"""`，作者可以使用更长 fence，例如 `""""...""""`；closing fence 需要使用不少于 opening fence 长度的连续双引号。

### 正文模式与 inline macro

正文内容有两个正交维度：文本语法和宏展开。第一版候选标记为：

- `t`：普通 text body，并启用 MMT inline macro
- `T`：Typst body，并启用 MMT inline macro
- `rt`：普通 text body，但禁用 MMT inline macro
- `rT`：Typst body，但禁用 MMT inline macro

文档级默认模式可以通过 `@mode: t` / `@mode: text` / `@mode: T` / `@mode: typst` 等动态设置，影响当前文件内后续 statement、reply item 与 bond 正文，直到下一次设置。`@mode` 是 lowering 阶段应用的文件级 directive：syntax parser 只把它保留为普通 directive line，不因为它改变后续 body 的 parse shape。`@mode` 不影响 `@actor`、`@asset`、`@typ` 等声明或注入块，也不跨文件传播。

支持的 mode 名称倾向为：

- `t` / `text`
- `T` / `typst`
- `rt` / `raw-text`
- `rT` / `raw-typst`

fenced block 可以用前缀局部覆盖当前块：

```text
- T"""#strong[你好] [:#1:]"""
- rT"""#let s = "literal [:#1:]" """
- t"""普通文本 [:#1:]"""
- rt"""这里的 [:#1:] 不展开"""
```

无前缀的 `"""..."""` 在 syntax AST 中保持未覆盖状态；lowering 阶段再根据最近的 `@mode` 或默认 `t` 决定最终正文模式。

`[:...:]` 是 MMT 层 inline macro，而不是 Typst 语法的一部分。它在 `t` 和 `T` 模式下展开，在 `rt` 和 `rT` 模式下保留为普通正文。若需要阻断 marker opener，应写成 `[\:`；这只使开头不再被识别为 MMT macro，剩余内容仍遵循当前 body mode。例如在 `T` 模式中 `[\:#1:]` 交给 Typst 后，`#1` 仍会正常求值为 `1`。如果需要整段禁用宏，应使用 `rt` / `rT`。

`T` / `rT` 模式的 Typst 文本应该先通过 `typst-syntax` 做语法检查和 CST/AST 分析。对于 `T` 模式，编译器在 Typst AST 中找到允许宏替换的 markup/source 区间，包括 content block 内的 markup 区域，并排除 `Str`、`Raw`、注释、code expression 等不可替换区域，再对这些区间做 `[:...:]` overlay macro 扫描与替换。第一版不魔改 `typst-syntax`，而是把它作为 Typst 语法检查与可替换区间识别器。

Typst markup 中不推荐使用 `\[:...:]` 逃逸 MMT marker：`typst-syntax` 会把 `\[` 解析为 `Escape`，但未转义的右括号可能仍触发 Typst bracket 错误。统一使用 `[\:...:]` 阻断 `[:` opener；T 模式 overlay scanner 必须把 Typst `Escape` leaf 当成不可拼接边界，不能跨 `Text "["` 与 `Escape "\:"` 拼出 MMT marker。

### bond 内容块

`@bond` 保留行内写法和块状写法：

```text
@bond: 单行内容

@bond: """
多行 fenced 内容
"""

@bond
多行内容
@end
```

其中：

- `@bond:` 只消费同一行 payload，或消费同一 payload 起始的 fenced body
- `@bond:` 不隐式续接后续普通行
- `@bond ... @end` 是 block form，block 内普通行作为 bond content continuation
- `@bond` 不设计多个列表项，也不引入 `@reply` 风格的 `-` item marker

### reply 选项列表

`@reply` 保留行内紧凑写法和块状显式列表写法，但二者使用不同的列表分隔规则。

行内写法使用 `|` 分隔选项：

```text
@reply: 是 | 否 | "也许 | 之后再说" | 不知道\|算了
```

其中：

- 未引号包裹的 `|` 是分隔符
- 单引号或双引号内的 `|` 是普通字符
- 未引号文本里需要字面量 `|` 时使用 `\|`
- quoted string 使用声明层字符串转义规则

块状写法使用显式 `-` item marker：

```text
@reply
- 是
- 否
- "也许 | 之后再说"
- """
多行
选项
"""
@end
```

其中：

- 只有 `-` 开头的行创建 reply item
- `-` 后面可以是裸文本、quoted string 或 fenced block
- item 后续普通行作为当前 item 的 continuation，直到遇到下一个 block-local `-` item marker 或 `@end`
- fenced block 只属于当前 `-` item
- continuation 保留原始缩进，例如 `  34` 会成为 item 文本中的 `  34`
- `|` 在块状 `@reply` 中没有列表分隔语义

### 表情与资源引用标记

下一版倾向把消息正文里的表情包与素材引用收束为 bracket-colon 参数列表。第一版暂不引入自然语言查询；`[:...:]` 内部只表达确定性资源选择。

```text
[:selector:]
[:subject-ref, selector:]
[:subject-ref, contribution_namespace::variant:]
[:space, ref:]
[:subject-ref, selector:](key: value, ...)
```

其中：

- 单个位置参数默认按当前 subject 的 `sticker` slot 查找
- 两个位置参数时，第一个默认是 subject-ref，第二个是 selector
- 如果第一个位置参数是保留资源空间 `sticker` / `asset` / `tmp` / `file` / `url`，则不解释为 subject
- 第二个位置参数可以带贡献命名空间，例如 `ba_extpack::happy`
- 贡献命名空间右侧允许使用字符串字面量，例如 `ba_extpack::">_<笑"`
- `#n` 表示按 manifest 显式顺序选择第 n 个逻辑 variant，编号从 1 开始；在 `sticker` slot 中该顺序属于某个明确 set
- 资源渲染参数不写在 `[:...:]` 内部，而写在 marker 后缀 `(...)` 中，例如 `[:#1:](width: 2em)`
- marker 后缀 `(...)` 是 Typst 风格参数片段，仍需通过 Typst 参数级检查

裸 subject selector 只在有明确 speaker 的 message statement 中可用，例如 `> 柚子: [:#1:]`。旁白、`@reply` item 与 `@bond` content 没有 speaker，也不继承上下文 speaker；这些位置若要引用 sticker，必须显式写出 subject，例如 `[:柚子, #1:]`。

`sticker` 是成组资源 slot，selector 首先解析到某个 sticker set，再解析到该 set 内的 variant。裸 `#n` 或 `sticker/#n` 只能在该 subject 的 `sticker` slot 存在明确 `default` set 时成立；如果存在多个 set 且没有 default，resolver 必须报 ambiguous。资源 selector 不直接暴露物理图片路径或 AVIFS frame；materializer 会在后续阶段根据逻辑 variant 的 storage/frame 元数据生成 Typst 可读的静态图片。

示例：

```text
[:开心:]
[:#1:]
[:晴_露营, >_<笑:]
[:ba::晴_露营, >_<笑:]
[:ba::晴_露营, ba_extpack::">_<笑":]
[:ba::晴_露营, ba_extpack::#1:]
[:ba::晴_露营/sticker/#1:]
[:ba::晴_露营/sticker/default/#1:]
[:ba::晴_露营/sticker/战损/#1:]
[:ba::晴_露营/ba_extpack::sticker/default/#1:]
[:ba::晴_露营, ba_extpack::">_<笑":](width: 2em)
[:sticker, 开心:]
[:asset, hero:]
[:file, images/foo.png:]
[:url, https://example.com/a.png:]
```

解析优先级倾向为：

- 显式资源空间引用优先，例如 `sticker`、`asset`、`tmp`、`file`、`url`
- 带 subject-ref 的 sticker selector 次之
- 当前 subject 下的 sticker selector 再次之

确定性引用解析失败时不应静默降级为自然语言查询。第一版没有自然语言查询 fallback；裸写的位置参数只要不能按资源 selector 解析，就应该报 unresolved 或 invalid reference。

`namespace::"literal"` 始终表示带命名空间的确定性 selector，引号只影响分词，不改变匹配模式。

`#n` 编号 selector 也是确定性 selector。编号顺序必须来自 manifest 中的显式顺序，不能依赖文件系统遍历顺序；在 `sticker` slot 中编号作用域是某个明确 set。越界、缺少顺序信息、缺少 default set 或 contribution namespace 歧义时应报错，不进入关键词或语义匹配。

`[:...:]` 内部禁止混入 Typst 参数写法。尤其是 `[:ba::晴_露营, ba_extpack::happy(width: 2em):]` 这类把命名空间 selector 和函数调用形态混合的写法不作为第一版目标；应改写为 `[:ba::晴_露营, ba_extpack::happy:](width: 2em)`。

旧的 `[expr]`、`[expr](target)`、`(target)[expr]` 以及旧 Typst 模式占位形态在下一版主语法中直接 deprecated，不作为新 parser 的主路径兼容目标；下一版主写法使用 `[:...:]`。

### 命名空间和值层引用

倾向在值层统一采用 `::` 表示命名空间：

- `ba::柚子`
- `custom::dream`
- `asset::yz_default`

这里的目标是把结构分隔用的 `:` 和值内部命名空间分隔区分开来。

### 统一资源路径

人物资源路径按 slot 类型区分层级。`avatar` 是少量命名图片，路径倾向采用：

```text
<subject-ref>/[contribution_namespace::]avatar/<variant>
```

`sticker` 是成组资源，路径倾向采用：

```text
<subject-ref>/[contribution_namespace::]sticker/[set]/<variant>
```

其中：

- `subject-ref` 可以是全局 entity 引用，例如 `ba::梦`，也可以是脚本上下文中已建立的 actor name
- `contribution_namespace` 表示某个资源包对该实体贡献的资源来源，例如 `ba_extpack`
- `avatar/<variant>` 直接指定该 avatar slot 下的命名头像 variant
- `sticker/[set]/<variant>` 先指定 sticker set，再指定 set 内 variant
- `sticker/<variant>` 是省略 set 的简写，只能在该 slot 存在明确 `default` set 时解析为 `sticker/default/<variant>`
- `variant` 是逻辑资源 variant，不是物理图片文件或 AVIFS frame；物理存储在 pack-v3 materializer 阶段处理

slot 省略只允许在上下文已经提供默认 slot 时使用：

- `[:...:]` marker 默认 slot 是 `sticker`
- `avatar:` 字段默认 slot 是 `avatar`
- `sticker:` 字段默认 slot 是 `sticker`
- 普通资源路径、patch 参数和 Typst 参数片段不获得 slot 省略语义

示例：

```text
ba::梦/avatar/default
ba::梦/sticker/default/happy
ba::梦/sticker/战损/#1
ba::梦/ba_extpack::sticker/default/happy
dream/ba_extpack::avatar/smile
```

这里 `avatar` 专指聊天气泡旁边的说话人头像；`sticker` 专指发在对话内容里的角色表情包。旧讨论中的 `charface` 不作为下一版推荐命名。

### patch 中的资源引用边界

第一版不在节点头部 patch 中引入 slot 上下文简写。也就是说，类似下面的写法暂不作为 v2 第一版目标：

```text
>(avatar: happy) dream: 你好
>(avatar: ba_extpack::happy) dream: 你好
```

原因是 patch 本身应保持为 Typst 风格参数片段；如果让 `avatar: happy` 中的 `happy` 同时承担 DSL selector 语义，就会在 Typst 参数解析之外再引入一层隐式 DSL 值重写。

第一版倾向采用更明确的边界：

- `[:...:]` 负责正文里的 sticker/resource selector
- `[:...:](...)` 负责当前资源节点的渲染参数
- `>(...)` / `<(...)` / `-(...)` 负责当前 statement 节点的渲染参数
- patch 负责传递合法 Typst 参数，不复刻 `[:...:]` 的资源解析规则
- patch 如需引用资源，应先使用完整字符串路径或后续专门设计的显式 Typst helper

因此 `>(sticker: #3)` 不作为第一版合法写法：`sticker` 是 DSL 资源选择语义，不是直接传给 Typst façade 渲染函数的参数。作者应在正文中写 `> yz: [:#3:]`，再用 `[:#3:](width: 2em)` 调整该资源节点的显示参数。

### 自定义素材与临时素材

非人物资源不挂到人物路径下，使用独立命名空间：

```text
asset::hero
tmp::upload_1
```

其中：

- `asset::name` 表示脚本、项目或资源包中声明过的稳定自定义素材
- `tmp::name` 表示运行环境注入的临时素材，例如 Web 编辑器上传文件或机器人会话里的临时图片
- `tmp::` 不保证脚本脱离当前会话后仍可复现

### 多资源包贡献规则

资源包可以定义实体，也可以对已有实体追加资源贡献。扩展资源包 patch 到某个实体时，不会创建新的同名实体。

例如：

```text
ba::梦
gf2::梦
ba_extpack patches ba::梦
```

这里 `ba::梦` 和 `gf2::梦` 是两个不同实体；`ba_extpack` 只是给 `ba::梦` 追加资源贡献。

资源合并遵循：

- 扩展资源包可以追加 `avatar` / `sticker` variant
- 同一实体、同一 slot 下的裸 variant 如果唯一，则可以短写使用
- 若多个资源包贡献了同名 variant，不按导入顺序隐式覆盖
- 冲突时必须通过 `contribution_namespace::variant` 或完整资源路径显式指定
- 扩展资源包不应静默修改 base pack 的默认值；若需要更改默认值，应由脚本层或显式配置层写出

### 字面量系统

DSL 声明层倾向支持：

- 裸值
- 单引号字符串
- 双引号字符串
- 少量必要转义

例如：

```text
name:"游戏开发部的柚子"
label:'请选择一个选项'
src:"https://example.com/a:b,c.png"
```

patch 内部则不走 DSL 字面量解析，而直接按 Typst 参数语法解析。

字段列表第一版使用显式 `[...]`，不把裸逗号自动解释成 list。例如：

```text
also-as: [hifumi, "日富美, 小鸟游", name\,with\,comma]
```

列表分隔规则与 `@reply:` 行内列表保持同一心智模型：list 内部未引号且未转义的逗号用于切分 item；单引号或双引号内的逗号保留为文本；需要字面量逗号时使用反斜杠转义。裸 `key: a, b` 不作为第一版 list 简写，应该报错或至少诊断为歧义写法。

## Implementation Notes

Rust parser / language core 的具体实现架构、Syntax AST 草案、byte range/source map 取舍和错误恢复策略，单独记录在 `rust-parser-architecture.md`。主设计文档只保留语言设计层面的决定，避免后续 parser 细节继续膨胀。

Typst 模板库的职责边界、public façade、主题与位置相关配置状态、连续消息控制和 Typst 0.15 probe，单独记录在 [`typst-template-library.md`](./typst-template-library.md)。模板库只渲染已经 lowering/materialize 的 Typst content；旧 JSON 遍历与正文 `eval` 不进入 v2 主路径。

## First-Revision Decisions

### `@asset` block 与 short form

块状声明是 canonical form：

```text
@asset hero
ns: custom
src: https://example.com/hero.png
@end
```

v2 第一版同时支持 `@asset:` short form，并将其 lowering 到同一个 `ScriptAsset` IR：

```text
@asset: hero src:https://example.com/hero.png
```

short form 是便利语法，不形成第二套字段语义；`src` 仍必填，`ns` 仍缺省为 `custom`。第一版支持不等于承诺长期稳定，归档前应在 public syntax spec 中明确其稳定级别。

### 短行字段分隔符

第一版接受 `key:value` 和 `key: value`，不接受 `key=value`。字段 value 继续使用声明层 literal/list 规则；patch 内部仍使用 Typst 参数语法。

### pack manifest 与 actor name

pack manifest 没有脚本 actor 上下文，资源目标必须使用全局 entity 引用，例如 `ba::梦/avatar/default`。entity 的确定性作者名称由 `names` 表达；脚本 actor name 只在当前编译的 semantic state 中解析，不能写回 pack manifest。

## Non-Goals

- 本阶段不迁移 Web 编辑器，也不承诺兼容旧 `compile_text_*_wasm` JSON compiler；后续 Web 工作单独立项。
- 不完整兼容 Python v1 的 alias、query fallback 与旧 inline target forms；保留项必须由 v2 spec 明确列出。
- 第一版不提供自然语言资源查询 fallback。
- 第一版不要求穷举全部 patch 字段白名单或 advanced visual API。
- 第一版不把 image-only sticker bubble、WebP materialization 或 manifest splitting 作为交付条件。
