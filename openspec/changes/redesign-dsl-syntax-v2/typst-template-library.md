# Typst 模板库草案

## 定位

DSL v2 的 Typst 层应从“读取 JSON 并在模板内解释消息”改为可导入的渲染模板库。Rust emitter 负责 semantic lowering、资源解析与 materialization、正文转义、Typst 语法检查和 source map；模板库只负责把已经合法的 Typst content 渲染成聊天、旁白、回复、羁绊与资源节点。

模板库主路径不应：

- 读取或遍历 MMT JSON schema
- 解析 script actor name、资源 selector 或 `[:...:]`
- 在运行时拼接正文字符串并调用 `eval`
- 直接读取 AVIFS frame、远端 URL 或未经过沙箱检查的路径

旧 JSON renderer 可以作为 legacy adapter 保留，但不作为 v2 public API 的实现基础。

## 包与入口

模板库倾向使用无 import 副作用的 Typst package 风格入口。`lib.typ` 只聚合导出 API；页面、字体与主题设置由显式 template show rule 建立：

```typst
#import "mmt-render/lib.typ" as mmt

#show: mmt.template.with(
  theme: mmt.themes.moetalk(),
  chat: (continued: auto),
)
```

候选文件职责：

- `lib.typ`：聚合导出 public API，不主动输出内容或修改调用方样式
- `template.typ`：文档级 page/text/show 环境与初始配置
- `chat.typ`：`chat`、方向便捷函数、avatar 与 bubble 布局
- `special.typ`：`narration`、`reply`、`bond`
- `resource.typ`：只接受已经 materialize 的 image/content
- `themes/*.typ`：主题字典与 MoeTalk 默认主题
- `legacy/*.typ`：旧 JSON runner 与兼容适配

第一版 public API 整体标记为 experimental。公开函数与参数使用 Typst 生态常见的 kebab-case；不同时维护 snake_case 别名。

## Public API 候选

### 文档与主题

```typst
#show: mmt.template.with(
  theme: mmt.themes.moetalk(),
  chat: (continued: auto),
  show-header: true,
)
```

`template` 负责文档级视觉环境，但 import 本身无可见副作用。主题使用 dictionary 表达默认颜色、间距、圆角、头像尺寸与资源尺寸；节点参数可以覆盖主题值。

### Chat

```typst
#mmt.chat(
  side: left,
  avatar: mmt.avatar(image("assets/yuzu.png")),
  name: [柚子],
  auto-continued: false,
)[正文]

#mmt.chat-left(avatar: ..., name: ...)[正文]
#mmt.chat-right(avatar: ..., name: ...)[正文]
```

- `chat` 是通用入口，`chat-left` / `chat-right` 是 public convenience wrapper
- `avatar` 参数接收已经完成裁切或包装的 content；`mmt.avatar(...)` 负责头像视觉处理
- 节点 patch 直接展开为对应 façade 调用的 Typst 参数，参数名使用 kebab-case
- 第一版允许直接暴露 `fill`、`inset`、`radius`、`tip` 等视觉参数

### Reply、Bond 与 Narration

```typst
#mmt.narration(fill: luma(90%))[旁白]

#mmt.reply(label: [回复])[选项 A][选项 B]

#mmt.bond(label: [羁绊事件])[内容]
```

Typst 0.15 支持用连续 content block 填充 variadic positional arguments，因此 `reply` 倾向定义为 `reply(label: ..., ..items)`，推荐手写形式为 `#mmt.reply[A][B]`。Emitter 也可以生成等价的普通参数调用。

### Resource Content

```typst
#mmt.sticker(image("materialized/sticker-17.png"), width: 2em)
#mmt.avatar(image("materialized/avatar.png"), size: 3em)
```

`sticker` 与 `avatar` 只接收 image/content，不接受 DSL selector、pack key 或普通字符串路径。Emitter 负责生成受控的 `image(...)` 调用；`[:...:](...)` 的后缀 patch 只进入 `sticker` 调用，不泄漏到外层 chat。

### Advanced Visual API

第一版可以公开 `bubble`、`reply-box`、`bond-box` 等底层视觉函数，供高级用户直接组合。由于整个 public API 暂时标记为 experimental，这些函数暂不提供跨版本稳定承诺；文档仍应优先推荐语义入口。

## 连续对话与配置状态

连续方向、同一人物的后续气泡仍由 emitter 根据 semantic IR 判断。建议自动分组 key 至少包含：

```text
(side, actor-binding-id, display-name, avatar-resource-id)
```

Emitter 把结果写入 `auto-continued`，模板根据最终 `continued` 决定是否隐藏头像与名称、去掉 bubble tip，并收缩节点间距：

```typst
#mmt.chat-left(
  auto-continued: true,
  continued: auto,
)[后续消息]
```

`continued` 使用三态：

- `auto`：采用模板位置配置；配置也是 `auto` 时采用 emitter 的 `auto-continued`
- `true`：当前节点强制按连续消息渲染
- `false`：当前节点强制按新消息渲染

MMT 节点 patch 可以显式覆盖当前节点：

```text
>(continued: false) 柚子: 强制重新显示头像和名称
```

Typst 的 `set` / `show` 规则不能以普通 `#let` 自定义函数作为 element target，因此下面的形式不可用：

```typst
// invalid: chat-left is an ordinary custom function
#set mmt.chat-left(continued: true)
```

模板库改为提供显式、位置相关的配置入口：

```typst
#mmt.configure(chat: (continued: true))
#mmt.chat-left(auto-continued: false)[仍按连续消息渲染]

#mmt.configure(chat: (continued: auto))
#mmt.chat-left(auto-continued: false)[恢复 emitter 自动判断]
```

对应 MMT 高权限入口可以直接写入真实 Typst chunk：

```text
@typ
#mmt.configure(chat: (continued: true))
@end
```

配置优先级为：

```text
节点显式参数
> 当前文档位置的 mmt.configure 状态
> template/theme 初始配置
> emitter 的 auto-continued
```

实现建议使用 Typst `state` 保存配置 dictionary，并用 `state.update` 做 partial merge。`chat` 组件在最外层进入一次 `context` 后读取 state；contextual helper 不应把布尔值跨函数边界作为普通值返回，因为 contextual expression 会表现为 content。

## Typst 0.15 Probe

本地最小实验已使用 Typst CLI `0.15.0` 编译验证以下行为：

- `#show: mmt.template.with(chat: (...))` 可以写入文档起始配置
- `mmt.configure` 的 state update 只影响文档位置之后的节点
- `chat-left` 与 `chat-right` 可以共享 chat 配置
- partial update 可以保留同一 dictionary 中未修改的字段
- 节点显式 `continued` 可以覆盖配置状态
- 将配置恢复为 `auto` 后，可以继续采用 emitter 的 `auto-continued`
- `#mmt.reply[A][B][C]` 可以把连续 content block 传给 variadic positional arguments

实验同时确认普通自定义函数不能用于 `#set`，Typst 会报告 `only element functions can be used in set rules`。

## Emitter 与 Source Map

Emitter 应生成真实 façade 调用，而不是把正文重新包装成待 `eval` 的字符串。生成 wrapper 属于 synthetic origin；正文、节点 patch、resource patch 与 `@typ` chunk 应分别维护细粒度 generated Typst byte range 到 MMT source range 的映射。

`mmt.configure` 是普通 emitted Typst chunk。若它来自 `@typ`，Typst diagnostic 应直接映射回该 `@typ` content；若未来由 DSL 专用配置节点生成，则 wrapper 与参数也应分别记录 origin。

## 尚待收敛

- 哪些节点严格打断 emitter 的 automatic continuation group
- 单 sticker 消息是否自动使用 image-only bubble，以及对应参数名
- `template` 第一版具体管理哪些 header/page/raw 样式
- advanced visual API 的完整导出清单
