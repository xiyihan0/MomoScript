#set page(paper: "a4", margin: (x: 54pt, y: 48pt))
#set text(size: 10.5pt, fill: rgb("#20242b"), font: "FZLanTingYuanGBK")
#set par(leading: 0.72em, justify: true)
#set heading(numbering: "1.")
#show raw: set text(font: ("JetBrains Mono", "FZLanTingYuanGBK"))

// Typst does not ship an MMT raw grammar. These rules deliberately provide a
// small, line-oriented highlighter instead of pretending `lang: "mmt"` is known.
#let mmt-token(body, fill: rgb("#20242b"), weight: "regular") = text(fill: fill, weight: weight, body)
#let mmt-line(line) = {
  if line.starts-with("//") {
    mmt-token(raw(line), fill: rgb("#70805f"))
  } else if line.starts-with("@") {
    let directive = line.split(":").first()
    mmt-token(raw(directive), fill: rgb("#8c4ea3"), weight: "bold")
    if directive.len() < line.len() { raw(line.slice(directive.len())) }
  } else if line.starts-with(">") or line.starts-with("<") or line.starts-with("-") {
    mmt-token(raw(line.slice(0, 1)), fill: rgb("#3155a6"), weight: "bold")
    let rest = line.slice(1)
    let speaker = rest.split(":").first()
    if speaker.len() == rest.len() {
      raw(rest)
    } else {
      mmt-token(raw(speaker), fill: rgb("#9b641e"))
      mmt-token(raw(":"), fill: rgb("#3155a6"))
      raw(rest.slice(speaker.len() + 1))
    }
  } else {
    raw(line)
  }
}
#let mmt-raw(it) = {
  let body = it.text.split("\n").map(mmt-line).join(linebreak())
  if it.block { block(width: 100%, body) } else { body }
}
#show raw.where(lang: "mmt"): mmt-raw

#show heading.where(level: 1): it => block(above: 1.4em, below: 0.7em)[
  #text(size: 17pt, weight: "bold", fill: rgb("#3155a6"))[#it.body]
]
#show heading.where(level: 2): it => block(above: 1.1em, below: 0.45em)[
  #text(size: 13pt, weight: "bold", fill: rgb("#4267b2"))[#it.body]
]
#let panel(title, body, tone: "blue") = {
  let colors = if tone == "warn" {
    (fill: rgb("#fff6df"), stroke: rgb("#d39a20"))
  } else if tone == "ok" {
    (fill: rgb("#ecf8ef"), stroke: rgb("#4b9b62"))
  } else {
    (fill: rgb("#eef5ff"), stroke: rgb("#7aa7e8"))
  }
  block(width: 100%, fill: colors.fill, stroke: colors.stroke, radius: 6pt, inset: 11pt)[
    #strong(title) #linebreak() #body
  ]
}

// Strings are converted to raw MMT; an existing raw block/content value passes
// through unchanged. Use a raw block for multiline samples so no escaping is needed.
#let code(source, lang: "mmt") = {
  let body = if type(source) == str { raw(source, block: true, lang: lang) } else { source }
  block(
    width: 100%,
    fill: rgb("#f5f6f8"),
    stroke: rgb("#d8dce3"),
    radius: 5pt,
    inset: 10pt,
    body,
  )
}

#align(center)[
  #text(size: 24pt, weight: "bold", fill: rgb("#3155a6"))[MomoScript 新手上路]
  #v(5pt)
  #text(size: 12pt, fill: rgb("#5c6573"))[从第一行剧本到 Typst 预览]
]

#v(12pt)

= 先找到并打开剧本

左侧 *Explorer（资源管理器）* 是虚拟工作区。新建文件时，请使用以下任一后缀：

#table(
  columns: (1fr, 2.4fr),
  inset: 7pt,
  stroke: rgb("#d8dce3"),
  table.header([*文件名*], [*用途*]),
  [story.mmt], [推荐的标准剧本文件名。],
  [story.mmt.txt], [仍按 MMT 解析，便于某些只接受文本后缀的分享场景。],
  [intro.typ], [你现在看到的 Typst 指南；它不是 MMT 剧本。],
)

+ 在 Explorer 顶部选择“新建文件”，输入例如 #raw("first-story.mmt")，按 Enter。
+ 已有文件时，直接在 Explorer 单击 #raw(".mmt") 或 #raw(".mmt.txt") 文件打开。
+ 点击编辑器标签或文件树中的目标文件，确认当前活动编辑器就是要预览的剧本。

#panel([不要改错文件], [本页是 #raw("intro.typ") 教程。真正的剧本应写进单独的 #raw(".mmt") 或 #raw(".mmt.txt") 文件；不要把下面的示例直接粘进 Typst 正文。])

= 最小可用剧本

MMT 按行识别节点。#raw(">") 是左侧消息，#raw("<") 是右侧消息，#raw("-") 是旁白。资源包已经提供角色名时，直接使用即可，不需要先声明 actor：

#code(```mmt
> 晴: 你好，老师！
< 你好！这是右侧消息。
- 一段旁白。
```)

#image("intro-assets/basic.png", width: 100%)

大多数时候不需要写 #raw("@actor")。只有需要显式声明独立脚本角色、增加别名或覆盖显示配置时，才使用 actor block：

#code(```mmt
@actor qing
preset: ba::晴
display-name: "晴"
also-as: [晴同学]
@end
> qing: 用脚本名说话。
> 晴同学: 这仍然是同一个 actor。
```)
#image("intro-assets/actor.png", width: 100%)


#panel([什么时候需要 preset], [#raw("preset:") 只用于首次建立命名 actor，或无头 #raw("@actor") 打开资源包预设的默认 actor。若角色已由资源包名称直接解析，或 actor 已经存在，不要重复写 preset；对已存在 actor 重新指定 preset 会被拒绝。], tone: "ok")

已存在的 actor 可再次用 #raw("@actor 名称 ... @end") 修改后续显示名或头像；修改只影响后面的节点。不要给已存在 actor 再写 #raw("preset:")。

= 对白、续行与轮换角色

== 消息与续行

角色名和正文之间使用英文冒号。没有角色标记的下一条同方向消息会继续使用该方向当前 actor；#raw("_0:") 也是“当前 actor”。普通文本行会续接到上一条消息，直到遇到新的未缩进顶层节点：

#code(```mmt
> 晴: 第一行
第二行仍属于晴的同一条消息。
> _0: 这是下一条消息。
< 右侧默认是老师一侧。
```)
#image("intro-assets/continuation.png", width: 100%)


== #raw(">_") 轮换与 #raw(">~") 固定顺序

同一方向先出现两位角色后，#raw("_:")（等价于 #raw("_1:")）会切换到最近的另一位角色；连续使用即可两人交替。#raw("~n:") 则按该方向角色首次出现的固定顺序选人：

#code(```mmt
> 优香: 第一位左侧角色。
> 诺亚: 第二位左侧角色。
>_: 自动切回优香。
>_: 再自动切回诺亚。
>~1: 按首次出现顺序选择优香。
>~2: 按首次出现顺序选择诺亚。
```)

#image("intro-assets/rotation.png", width: 100%)

左右方向各自维护历史。历史不足时会确定性报错，所以在建立足够历史前应写明确角色名。

= 回复选项与特殊内容

== 回复选项

紧凑写法用未转义、未被引号包住的 #raw("|") 分隔。下面也演示 #raw("code") 的字符串输入；适合没有换行和复杂引号的短例子：

#code("@reply: 是 | 否 | 也许 | 不知道\\|算了")
#image("intro-assets/reply-inline.png", width: 100%)


较长选项使用原始代码块。每项必须以块内 #raw("-") 开头，普通续行属于当前项，块尾仍是 #raw("@end")：

#code(```mmt
@reply
- 接受邀请
  明天就出发
- "暂时拒绝 | 以后再说"
@end
```)
#image("intro-assets/reply-block.png", width: 100%)


== 羁绊或特殊内容

#raw("@bond:") 只消费同一行；块写法中的所有普通行都是同一段内容，#raw("-") 在 bond 块中不是选项标记：

#code(```mmt
@bond: 羁绊等级提升

@bond
关系发生了新的变化。
- 这一行仍是 bond 正文。
@end
```)
#image("intro-assets/bond.png", width: 100%)


= 资源标记：#raw("[:...:]")

正文中的 #raw("[:...:]") 是 MMT 资源宏，不是 Typst 方括号语法。当前 Rust v2 只做*确定性资源选择*：

#table(
  columns: (1.25fr, 2.2fr),
  inset: 6pt,
  stroke: rgb("#d8dce3"),
  [*写法*], [*含义*],
  [#raw("[:开心:]")], [在当前消息说话人的 sticker slot 中选择名为“开心”的 variant。],
  [#raw("[:#1:]")], [选择当前说话人明确 default sticker set 中、manifest 稳定顺序的第 1 项。编号从 1 开始。],
  [#raw("[:ba::晴_露营, >_<笑:]")], [显式指定人物，再指定 sticker variant。],
  [#raw("[:ba::晴_露营, ba_extpack::\">_<笑\":]")], [variant 来自指定 contribution namespace；引号保护特殊字符。],
  [#raw("[:asset, hero:]")], [引用已经声明的稳定自定义素材。旁白、reply、bond 没有说话人时应使用这类显式空间或显式人物。],
  [#raw("[:#1:](width: 2em)")], [后缀括号是该资源节点的 Typst 渲染参数，不属于 selector。],
)

#panel([资源选择不会“猜”], [#raw("[:?坏笑:]") 这类自然语言查询尚不支持。名称不存在、编号越界、没有 default set、多个贡献重名或命名空间不明确时都会失败，不会退回关键词搜索。资源包 manifest 的显式顺序和命名决定结果，因此同一输入才能稳定复现。], tone: "warn")

资源存在性取决于当前工作区加载的资源包。先在资源目录、补全或 manifest 中确认人物、set 与 variant，再复制标识；不要把物理图片路径或 AVIFS 帧号当作逻辑 variant。旁白、reply 与 bond 没有当前说话人，不能只写 #raw("[:#1:]")，应显式写人物，例如 #raw("[:晴, #1:]")。

= Typst 能力：#raw("@typ")、局部 patch 与正文模式

== 先定义变量和函数，再使用

#raw("@typ") 是高权限逃生口。单行形式适合简单定义；多行形式要求 #raw("@end")。定义必须出现在引用之前。下面的 #raw("accent") 变量既用于消息 patch，#raw("callout") 函数也在稍后的 Typst 正文中调用：

#code(```mmt
@typ
#let accent = rgb("#24324a")
#let callout(body) = text(fill: white, weight: "bold", body)
@end

>(fill: accent, inset: 6pt) 晴: T"""#callout[先定义，再调用。]"""
```)

#image("intro-assets/typst.png", width: 100%)

局部 patch 写在 #raw(">")、#raw("<") 或 #raw("-") 后面的括号中，只作用于当前节点，并且必须是合法的单行 Typst 调用参数。资源选择不要写进 statement patch；应把 sticker 放在正文的 #raw("[:...:]") 中。

== 正文模式

#table(
  columns: (0.55fr, 1.7fr, 1.2fr),
  inset: 6pt,
  stroke: rgb("#d8dce3"),
  [*模式*], [*正文语法*], [*展开资源宏*],
  [#raw("t / text")], [普通文本], [是],
  [#raw("T / typst")], [Typst markup], [是],
  [#raw("rt / raw-text")], [普通文本], [否],
  [#raw("rT / raw-typst")], [Typst markup], [否],
)

#raw("@mode: T") 会让本文件后续正文继承 Typst 模式；也可以只给一个 fenced body 加前缀：

#code(```mmt
@mode: text
> 晴: T"""#strong[局部 Typst 正文]"""
> 晴: rt"""这里的 [:#1:] 保持为普通文字"""
```)
#image("intro-assets/mode.png", width: 100%)


至少三个双引号组成 fence；它还能保护正文里的行首 #raw(">")、#raw("@reply") 等文本不被拆成新节点。需要在正文中原样展示 marker 时，使用 #raw("rt") / #raw("rT") 最清楚。

= 一个渐进式完整例子

先复制下面的无资源宏版本到新建的 #raw("first-story.mmt")。它直接使用当前默认资源包中的晴，不需要冗余 actor 声明；Typst 变量和函数也先定义、后使用：

#code(```mmt
@typ
#let accent = rgb("#24324a")
#let step(body) = text(fill: white, weight: "bold", body)
@end

- 放学后的教室安静下来。
> 晴: 第一步：角色和消息已经可以预览。
< 很好。接下来要做什么？
>(fill: accent) 晴: T"""#step[第二步：调用刚才定义的函数。]"""
@reply
- 继续学习资源标记
- 先检查对白和换行
@end
@bond: 完成第一次共同练习
- 保存文件，再打开 Typst 预览检查结果。
```)

#image("intro-assets/full.png", width: 100%)

确认它能预览后，再从资源清单中找到一个*实际存在且唯一*的 sticker selector，把某条晴的消息改成例如：

#code(```mmt
> 晴: 看看这个表情：[:#1:](width: 2em)
```)
#image("intro-assets/sticker.png", width: 100%)


只有当晴的 sticker slot 存在明确 default set，且第 1 项在 manifest 中有稳定顺序时，这一行才会成功；否则请使用资源面板给出的完整人物、set、contribution 与 variant。

= 打开预览

1. 在 Explorer 中打开目标 #raw(".mmt") 或 #raw(".mmt.txt") 文件。
2. 点击编辑器右上角的 *“Typst 预览”*（打开预览图标）。
3. 等待 “MomoScript 预览” 面板渲染。修改剧本后保存；若环境没有自动刷新，重新触发“Typst 预览”。
4. 若预览仍显示另一份文件，先重新激活目标文件标签，再执行预览命令。

#panel([理解流水线], [MMT 先经过语法解析、角色与资源解析、素材准备和 Typst 生成，最后才渲染。任何前置阶段失败，预览都不会用“最接近”的资源替代；这正是可复现输出所需要的行为。])

= 常见错误与调试顺序

#table(
  columns: (1.35fr, 2.4fr),
  inset: 7pt,
  stroke: rgb("#d8dce3"),
  [*现象*], [*先检查什么*],
  [提示缺少或未结束 block], [检查每个无冒号 #raw("@actor")、#raw("@reply")、#raw("@bond")、#raw("@typ") 是否有未缩进的 #raw("@end")；缩进后的控制词只是正文。],
  [左侧消息没有说话人], [第一条 #raw(">") 消息应写明确 actor 名，并确保角色能从资源包解析；省略名字只会沿用已存在的当前 actor。],
  [unknown actor / preset], [核对 #raw("::") 命名空间、人物名和大小写；#raw("@actor unknown") 不带 preset 不会自动创建角色。],
  [resource unresolved / ambiguous], [核对人物、default set、1-based 编号与 contribution namespace。不要尝试 #raw("?") 查询，也不要依赖资源包加载顺序消除冲突。],
  [Typst 参数报错], [检查 patch 是否单行、括号是否成对、参数是否为合法 Typst 调用参数；资源参数应放在 marker 后缀，而不是 #raw("[:...:]") 内。],
  [看似新节点却成了正文], [顶层 #raw(">")、#raw("<")、#raw("-")、#raw("@...") 前不要缩进；缩进行会作为上一节点的续行。],
  [预览没变化], [确认当前活动文件、保存状态与预览面板对应关系，再查看诊断和输出信息；优先修复位置最靠前的根因，后续报错可能只是连锁反应。],
)

#panel([推荐的小循环], [每次只增加一个结构：先保存并预览最小消息，再加 reply / bond，再加 Typst patch，最后才加入已确认存在的资源 marker。这样出错时，最近一步就是最小排查范围。], tone: "ok")

#v(12pt)
#align(center)[#text(fill: rgb("#687386"))[现在，新建一份 #raw(".mmt") 文件，从最小例子开始写你的故事吧。]]
