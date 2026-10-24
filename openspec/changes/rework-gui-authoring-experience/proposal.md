## Why

普通创作者应能不接触 MMT、Typst 或工作区知识，完成“新建作品→选两人物→写三句→修改一句→调整顺序→导出”。现有唯一 TextDocument、Rust Composer、SVG、原生 undo、持久化和 exact export 是实现基础；问题是默认创作界面仍混合源码工作区、最终纸张预览与连续写作工具。

本 change 实施已批准的《MomoScript 聊天创作体验重整》四切片计划。聊天仍用真实 SVG，经同一 MMT/Rust/Typst 链生成临时创作呈现，不建立 HTML 气泡编辑器或第二份聊天数据。

## What Changes

- 提供聊天创作、排版预览、源码三个真实模式；新作品所有宽度默认聊天，恢复的源码工作区保留其原模式与分屏。新工作区在没有恢复 active input 时仅将现有 fresh fallback 改为在 chat 打开既有 seeded STORY，而非 intro.typ 源码；Intro/源码工具仍可从高级入口打开，不新增 landing pane 或数据模型。一个 URI、原生 undo 栈、ComposerRuntime 和 retained SVG overlay 不变。
- 新建只询问作品名，安全生成不覆盖现有文件的 `.mmt` 路径；既有 `.mmt`/`.mmt.txt` 打开语义不变。
- Rust RenderPreset 增加严格 `{kind:"output"}` / `{kind:"chat",widthPt:number}`。省略为 output，chat 宽度为 240–720 整数；呈现参数不写源文件，sourceDigest 不变，projection/project/render 身份全部隔离。render response 返回相同 DTO。
- 临时 chat 模板在完整 theme 上覆盖阅读尺度、自动页高与边距，隐藏产品纸张 chrome 而不删作者图元；排版沿用原输出参数。底部未发送草稿和已有正文原位编辑互不串用。
- 用原生 Part/EditorPart 临时可见性入口收拢产品界面，保留并恢复源码工作区；顶栏显示真实保存状态和文字模式/导出入口。
- 人物→形态→表情按同 namespace/catalog 内已验证 typed alternate_skin 关系归组，保留所有外部形态记录 ID；不同 external_ids.character 不阻止显式关联，同值可统一重复形态。更正原计划把该字段视为 canonical person ID 的前提，不按名称猜归属。无关系实体保留可区分原名/ID；Catalog 仍整份严格校验（含未知 taxonomy `0`），不做客户端归一化或线上改数。无 Catalog、离线、旧 manifest、自定义角色和原 source gallery 插入路径继续可用。
- 扩展 Rust 原子插入头像选择、语义媒体和 setStatementSide；新增命令严格验证当前权限、资源与完整候选，TS 不拼 DSL。本地图片先写工作区再提交 Rust 意图；既有 LocalFile resolver 支持安全的 source-relative 分段路径，保留 basename、原生沙箱与 containment，不开放任意文件系统/URL。
- 统一 output-only 成品导出，chat/source 导出自动进入排版并等待正确快照；PDF 全文、PNG/JPG/SVG 指定页，图像 2×实际像素尺寸，源文件下载独立。
- 移动端只有一个互斥辅助 Sheet；44px targets、safe area、visualViewport、键盘和 IME 均沿同一授权输入链；以真实应用操作、文件打开和视觉证据验收四切片。

## Affected Capabilities

- `gui-composer`：三模式、连续创作、草稿、结构/属性/媒体、恢复和移动交互。
- `language-tooling`：preset 请求/响应、身份隔离、头像/左右/媒体语义命令及只读 asset choices。
- `rendering-pipeline`：临时 chat 模板和输出不变性。
- `web-workbench-shell`：原生 Parts、模式恢复、唯一 mount 与 source split。
- `character-gallery`：展示层人物分组、形态/表情选择及 source/GUI 插入边界。
- `preview-and-export`：呈现隔离的 viewport 与 output-only exact export。

## Relationship to Existing Changes

本 change 是 `add-mobile-gui-surface` 已实现 SVG-first 架构上的产品交互修正，不撤销其 lossless partition、精确输入、freshness、native history、retained overlay 或 viewport 修复。发生冲突时，本 change 对下列旧条款的替换是明确且限定的：

| 旧条款 | 本 change 的有效合同 |
|---|---|
| gui-composer / Responsive default is applied；web-workbench-shell / Desktop GUI is opened、Mobile GUI is opened by default once、Mobile controls are verified 的宽度默认规则 | 新作品任意宽度默认 chat；恢复源码/明确选择 source 不强制改 GUI；550px 只决定布局与单 EditorGroup |
| gui-composer / GUI chrome stays compact at narrow widths 的常驻 zoom/fit row | chat 无 zoom/fit/page chrome；layout 保留完整适配与锚点 |
| gui-composer / The bottom composer supports continuous dialogue writing 的 pastel/icon-first 全局呈现描述 | 蓝色主操作、文字模式/导出、chat 常驻底栏、layout 不常驻；系统深色只影响 chrome |
| web-workbench-shell / GUI and source request preview 的 alternate read-only mount | MMT 且当前 Rust 能力有效的 layout 可编辑；原始 Typst/生成物/包资源仍只读 |
| character-gallery / alternate skin 保持独立 entity 的独立列表项 | 角色选择可归为一个 UI 人物组；实体、set、variant 和 selector 独立性不变 |
| preview-and-export / Export uses the displayed exact snapshot | 成品只接受 output；仍使用其不可变 exact snapshot，可显式导出旧 output，绝不以 chat 代替 |

既有 active change 文件和本轮之前 language-tooling/gui-composer 的 viewport 改动保留；本 change 的新合同是上述产品行为的权威，旧实现记录不作为新的默认规则。

## Non-Goals

- 不新增可变聊天模型、客户端 AST/序列化器、项目数据库、Pack schema、渲染器/框架、远端实时 Kivo 查询或新的源码权威。
- 不增加 @document page/font DSL 字段、无消费者配置、任意 URL 媒体或任意 Typst 反向编辑。
- 不改变 source gallery 的行内/选区插入适用条件，不把 GUI 的结构边界强加给源码入口。
- 不修改 Tinymist fork/pin，不手改 WASM/digest，不降几何/性能/视觉门槛。
- 不提交、推送、部署、发布 runtime/Pack 或修改线上数据。真实设备、新手和系统读屏体验须有实际记录，否则列为未验证。

## Delivery Order

四切片依次可运行；切片 1 集成并由集成负责人验证后，才实施切片 2。每切片均交实际行为和截图，不以静态 mock 或通过 typecheck 代替。全量计划、责任边界和命令见 design.md 与 tasks.md。
