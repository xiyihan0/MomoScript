# typst-template-library 规格增量

## ADDED Requirements

### Requirement: DSL v2 emits calls into a side-effect-free Typst template library

下一版渲染主路径 SHALL 生成真实 Typst façade 调用，并将模板库作为无 import 副作用的渲染依赖。

#### Scenario: Import does not render or mutate document styling

- GIVEN emitter 导入 MMT Typst 模板库
- WHEN generated document 执行 `#import ".../lib.typ" as mmt`
- THEN import 本身 MUST NOT 输出可见内容
- AND MUST NOT 在调用方顶层隐式应用 page、text 或 show rules
- AND 文档级样式 SHOULD 通过 `#show: mmt.template.with(...)` 显式建立

#### Scenario: Façade receives lowered Typst content

- GIVEN semantic lowering 与 materialization 已完成
- WHEN emitter 生成 chat、narration、reply、bond、sticker 或 avatar 节点
- THEN emitter MUST 调用对应的 MMT Typst façade function
- AND 模板库 MUST NOT 重新解析 MMT JSON、script actor name、资源 selector 或 `[:...:]`
- AND v2 主路径 MUST NOT 通过运行时字符串 `eval` 解释正文

### Requirement: Public façade uses Typst-native content APIs

模板库 SHALL 使用 Typst content 与命名参数表达渲染节点。

#### Scenario: Reply accepts consecutive content blocks

- GIVEN 一个 `@reply` 节点包含多个 item
- WHEN emitter 生成 Typst
- THEN template library SHALL expose a variadic reply function
- AND generated or handwritten Typst MAY use `#mmt.reply[A][B]`
- AND each content block SHALL correspond to one reply item

#### Scenario: Resource helpers receive materialized content

- GIVEN resolver 已将 sticker 或 avatar selector 解析并 materialize 为静态图片
- WHEN emitter 调用 `mmt.sticker` 或 `mmt.avatar`
- THEN resource helper MUST receive image/content rather than a DSL selector or pack key
- AND marker suffix patch arguments MUST apply only to the resource helper call

### Requirement: Document configuration lowers into the template show rule

MMT SHALL resolve document metadata before emission and pass Typst-native values to the existing `mmt.template.with(...)` façade.

#### Scenario: Header configuration has one source of truth

- GIVEN semantic lowering has produced document title、author、header visibility and optional compiled-at text
- WHEN emitter creates the generated Typst prelude
- THEN it SHALL pass `title`、`author`、`show-header` and `compiled-at` to `mmt.template.with(...)`
- AND the template SHALL render only those lowered values
- AND Web、Desktop、CLI and NoneBot hosts MUST NOT maintain a second hidden title-bar configuration

#### Scenario: Automatic time is resolved outside Typst

- GIVEN the DSL requests automatic compiled-at text
- WHEN the generated Typst reaches the template library
- THEN `compiled-at` MUST already be formatted content or `none`
- AND the template library MUST NOT call a clock、infer a timezone or format an instant

### Requirement: Continued chat rendering supports automatic and explicit control

模板库 SHALL 允许 emitter 自动判断连续消息，同时允许节点和 Typst 配置覆盖最终渲染方式。

#### Scenario: Emitter provides automatic continuation state

- GIVEN 相邻消息经过 semantic lowering 后属于同一连续对话 group
- WHEN emitter 生成后续 chat 调用
- THEN it SHOULD pass `auto-continued: true`
- AND template library SHALL use the effective continued state to control avatar、name、bubble tip 与 compact spacing

#### Scenario: Node patch overrides automatic state

- GIVEN 作者写出 `>(continued: false) 柚子: ...`
- WHEN emitter 展开该 statement
- THEN generated chat call SHALL receive `continued: false`
- AND this explicit node value MUST override `auto-continued` and document configuration

#### Scenario: Configure affects following chat nodes

- GIVEN generated Typst 执行 `#mmt.configure(chat: (continued: true))`
- WHEN 后续 chat node 没有显式 boolean `continued`
- THEN the template library MUST use the configured value
- AND earlier chat nodes MUST remain unaffected

#### Scenario: Auto configuration restores emitter behavior

- GIVEN document configuration 曾覆盖 `continued`
- WHEN generated Typst 执行 `#mmt.configure(chat: (continued: auto))`
- THEN following chat nodes without explicit override MUST fall back to their `auto-continued` value

#### Scenario: Configuration updates merge partially

- GIVEN chat configuration 同时包含 `continued`、`inset` 或其他字段
- WHEN `mmt.configure` 只更新其中一部分字段
- THEN unspecified fields MUST retain their current values

### Requirement: Ordinary custom functions do not pretend to support Typst set rules

模板库 MUST NOT 将普通自定义 façade 函数文档化为可用于 Typst `#set` 的 element function。

#### Scenario: Chat defaults use configure instead of set

- GIVEN 作者希望改变后续 chat 的默认渲染参数
- WHEN `mmt.chat-left` 是普通 Typst custom function
- THEN documentation MUST recommend `mmt.configure(...)`
- AND MUST NOT recommend `#set mmt.chat-left(...)`
