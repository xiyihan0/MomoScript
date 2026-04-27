## Overview

这一版 DSL 重构围绕一个核心判断展开：后续渲染主路径将从“生成 JSON 再由 Typst 文档解释遍历”转向“由 MMT 直接展开为 Typst 文档”。在这个前提下，语法层必须承担更多结构化职责，而不是继续依赖模板运行时兜底。

## Design Goals

### 1. 让核心 DSL 更聚焦

核心 DSL 负责：

- 叙事节点结构
- 说话人与人物引用
- 查询占位
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

- 聚合声明：例如 `@char ... @end`
- 短行声明：作为聚合声明的可选简写，例如 `@asset: hero src:...`

二者都倾向使用同一套 `key: value` 风格，而不是继续混用 `name=value`、位置参数和特殊指令形态。

## Candidate Syntax Direction

### 人物配置

倾向采用聚合声明：

```text
@char yz
name: "游戏开发部的柚子"
from: ba::柚子
avatar: asset::yz_default
alias: yuzu
@end
```

原因：

- `avatar` 更像人物实体属性，而不是流程中的临时命令
- 人物定义需要容纳多个相关字段，散装指令会继续加重心智负担

### 资源配置

倾向采用块状配置作为推荐形态，并允许以后根据使用频率保留统一短行简写：

```text
@asset hero
ns: custom
src: https://example.com/hero.png
@end
```

对应的短行简写候选可以是：

```text
@asset: hero src:https://example.com/hero.png
@asset: hero ns:custom src:https://example.com/hero.png
```

其中：

- `ns` 若省略，默认使用 `custom`
- 是否长期保留短行简写与 `@asset.<name>:` 旧语法，仍待决定

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

### 查询占位

倾向收敛为：

- `[expr]`
- `[expr](target)`
- Typst 模式下的 `[:expr]`
- Typst 模式下的 `[:expr](target)`

并废弃：

- `(target)[expr]`
- `(target)[:expr]`

原因：

- 前缀圆括号形态要让位给头部 patch
- 群友试用反馈显示 `(target)[expr]` 基本没有实际使用

### 命名空间和值层引用

倾向在值层统一采用 `::` 表示命名空间：

- `ba::柚子`
- `custom::dream`
- `asset::yz_default`

这里的目标是把结构分隔用的 `:` 和值内部命名空间分隔区分开来。

### 统一资源路径

人物资源路径倾向采用：

```text
<subject-ref>/[contribution_namespace::]<slot>/<variant>
```

其中：

- `subject-ref` 可以是全局实体引用，例如 `ba::梦`，也可以是在脚本上下文中已经绑定的 handle
- `contribution_namespace` 表示某个资源包对该实体贡献的资源来源，例如 `ba_extpack`
- `slot` 第一版至少包含 `avatar` 和 `sticker`
- `variant` 表示该 slot 下的具体差分名

示例：

```text
ba::梦/avatar/default
ba::梦/sticker/happy
ba::梦/ba_extpack::sticker/happy
dream/ba_extpack::avatar/smile
```

这里 `avatar` 专指聊天气泡旁边的说话人头像；`sticker` 专指发在对话内容里的角色表情包。旧讨论中的 `charface` 不作为下一版推荐命名。

### slot 上下文简写

在已经知道 slot 的位置，例如 patch 的 `avatar:` 或 `sticker:` 参数中，允许使用更短的 selector：

```text
[subject-ref/][contribution_namespace::]<variant>
```

例如：

```text
>(avatar: happy) dream: 你好
>(avatar: ba_extpack::happy) dream: 你好
>(sticker: ba_extpack::surprised) dream: [惊讶]
>(avatar: other/ba_extpack::happy) dream: 复用另一个 handle 的头像
```

这些简写只在 slot 已由字段名确定的位置启用。没有 slot 上下文时，应使用完整资源路径，避免让 parser 猜测 `happy` 属于 `avatar`、`sticker`、`asset` 或其他资源类型。

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

## Open Questions

### `@asset` 是否长期同时保留短行简写

目前已经倾向推荐块状配置：

```text
@asset hero
ns: custom
src: https://example.com/hero.png
@end
```

但是否长期同时保留：

```text
@asset: hero src:https://example.com/hero.png
```

仍待决定。

### `@bond` 是否只保留无冒号版本

目前倾向让 `@bond` 默认支持后续多行内容，从而弱化 `@bond:` 与 `@bond` 的区别；但是否保留 `@bond:` 作为长期兼容语法，仍待决定。

### 短行声明的统一风格是否只采用 `key:value`

当前认为 `key:value` 与 `key: value` 都可接受；是否完全禁用 `key=value`，还可继续收敛。

### 资源路径里的 handle 是否允许出现在 pack manifest

脚本 DSL 中倾向允许 `handle/slot/variant`，但 pack manifest 没有脚本上下文，原则上应使用全局实体引用，例如 `ba::梦/avatar/default`。

## Non-Goals

- 这次 change 不直接实现 parser / compiler 改写
- 这次 change 不定义全部 patch 字段白名单
- 这次 change 不决定最终 Typst emitter 的全部函数签名
