## Context

本设计采用获批的四切片计划。规范定义目标行为，不声称 UI、真实设备或导出产物已验收。既有 10 个未提交文件中的原生 pane 尺寸传播、native scroll selection、fit 锚点、overscan/bounds 复用和 renderKey 视口隔离必须保留。

## Goals / Non-Goals

目标是以单一 SVG 聊天创作完成普通闭环，同时保留专业排版、源码、原生工作区和高级内容。MMT 是 canonical source；Rust 独占语义、序列化、候选验证和 WorkspaceEdit；Tinymist 只是空间 oracle；SVG 是呈现/交互，不是源文档。无第二份聊天数据、客户端 AST、HTML 气泡主编辑器或并行 renderer。

不新增 page/font DSL、Pack schema、runtime 发布、协作、任意 URL 媒体或 Tylina 代码；不修改既有作者配置来达到临时呈现。

## Product Layout

### 聊天创作

```text
┌ 作品名 ▾ · 真实保存状态    聊天创作 ▾    导出作品 ┐
│ [角色库]             单一 SVG 聊天画布             │
│                      点正文原位编辑                │
│               选中：编辑 / 插入 / 移动 / 删除       │
│              可收起角色库或属性（二选一）           │
├ 当前角色 · 形态/表情      追加到末尾 / 在此插入     ┤
│ [+ 添加] [下一条消息输入框                  ] [发送]│
│ 老师 · 本作/最近角色横向快捷栏              [角色库]│
└───────────────────────────────────────────────────┘
```

角色库初始收起。空白画布显示“开始第一段对话”、选角/老师入口，不显示纸张、标题块、页码、阴影或缩放条。选中不覆盖底部草稿。插入状态展示相邻摘要、按钮“插入”和“返回末尾”；直接正文会话显示“正在修改第 N 条 / 完成编辑”。

### 排版预览

```text
┌ 作品名 ▾ · 真实保存状态    排版预览 ▾    导出作品 ┐
│ [排版设置]      页码 · 缩放 · 适合宽度              │
│                  作者最终 SVG 页面                 │
│                  定位 / 选中 / 原位编辑             │
│                  属性与高级局部源码入口             │
└───────────────────────────────────────────────────┘
```

不常驻底部连续追加输入。标题/作者/页眉/时间用现有 DocumentConfig/Overrides。页面/字体/分页显示真实模板/产物信息；未支持的配置不造空控件。

### 源码

```text
┌ 作品名 ▾ · 真实保存状态       源码 ▾     导出作品 ┐
│ 原生 Monaco 源码       │ 可选当前 SVG 分屏          │
│ 文件 / 搜索 / 诊断     │ chat 或 output，不能双 SVG │
└───────────────────────────────────────────────────┘
```

≤550px 单 EditorGroup，以“查看画布/返回源码”代替挤窄的分屏。恢复既有源码工作区不强制转 chat；普通新作品任意宽度默认 chat。

普通首次使用仅修改现有 fresh fallback 分支：当新工作区没有恢复的 active input 时，直接在 chat 打开现有 seeded STORY，而非默认打开 intro.typ 源码。先等待原生恢复决策；既有 source/split 恢复完全不变。Intro/源码工具仍可从高级入口打开，不新建 landing pane、数据模型或第二份故事。

## Decisions

### 1. Existing owners remain authoritative

| State | Owner |
|---|---|
| authored bytes / history | current TextDocument/native model and native undo |
| durable workspace / Local History | existing fs provider/coordinator and history services |
| snapshot / commands / text session | existing ComposerRuntime / ComposerTextSession |
| mode, draft, append/insert target | URI-bound existing controller and composerDrafts |
| preview artifact / renderer / overlay | existing runtime stores, renderer and one retained overlay |
| native Part visibility / geometry | ViewsService/EditorPart and existing SplitViews |
| export | ExactExportUiController / ExactExportService |

一个 mount claimant 绑定同一 ComposerRuntime/TextSession。chat/layout 均可在 MMT/Rust 能力成立时编辑；原始 Typst、package、generated 的只读来源边界不变。source split 不建立第二个活跃 SVG owner。

### 2. Mode switch is an input transaction

composition 未结束时延后切换，保留候选；已接受文本通过现有 drain/retired-session 路由排空后再解绑。URI 草稿保留正文、speaker、avatarChoice、append/insert target、恢复文字；URI-only editor serializer 不加入正文或草稿格式。

选区书签使用 authored endpoint/range 与 native alternativeVersionId 变换，在新 snapshot 重新授权，不复用 nodeKey。删除/外部冲突清除授权并提供恢复，不匹配相同文字猜目标。视口按 workspace+URI+完整呈现记录语义/页面锚点；只有匹配 renderKey 的报告能更新当前记录。

### 3. RenderPreset is a Rust projection input

```text
Rust: RenderPreset::Output | RenderPreset::Chat { width_pt: u32 }
wire: {kind:"output"} | {kind:"chat",widthPt:number}
```

`mmt/getTypstRenderProject.renderPreset` 省略为 output；响应显式返回 renderPreset。exact keys；未知 kind、额外字段、非整数、<240/>720 都拒绝，不归一化。chat 使用真实内容槽 ResizeObserver，将 CSS px 对应的 SVG 逻辑宽取整并限制于 240–720；整数有效宽不变不重编译。辅助面板打开/收起影响真实容器而非 window 猜宽。

EmitOptions、ProjectionProfile::Render、GetTypstProjectParams 和 build_render_project_generation 共享参数。preset、width、presentation version 进入 options digest 和 projection/render cache。sourceDigest 只代表真实源码；同源不同呈现各有 generated Typst/source map/projectDigest/projectionKey/renderKey。切换 preset 走现有 full sync，不复用另一 preset 的增量 base、不增加重试。所有 native/WASM/extension/Workbench/renderer exact-key producer/consumer 同步迁移；WASM 只走 vendor 命令。

### 4. Template controls authoring presentation, not CSS tricks

在完整现有 theme 上叠加内部 presentation/chat-width：height:auto，边距四侧 12pt，正文16pt、头像40pt、头像间隔8pt、消息间隔12pt、连续间隔4pt、圆角12pt，无生成页眉/页脚。chat 是 1 SVG 逻辑单位=1 CSS px，居中最大720px，不调用 fit-width；真实 glyph/容器测量证明16px阅读尺度，不能套用 CSS pt 换算。保留显式 pagebreak、作者正文/名字/头像/媒体/内联样式/高级内容与其来源。背景按 preset 注入，不隐藏作者图元。output 参数与白底行为不变。

### 5. Product chrome temporarily borrows native visibility

作品菜单含新建、打开、保存、本地历史/恢复、撤销/重做、源文件下载与高级工作区。仅新建询问作品名；trim 后保留中文，路径分隔符/控制字符替换 `_`，空名/`.`/`..` 拒绝，`.mmt` 只补一次，同名 `名称 (2).mmt` 递增，使用现有 workspace.fs/openComposerDocument，不覆盖文件。

chat/layout 使用 isPartVisibile/setPartVisibility 和 EditorPart 临时配置隐藏原生文件树、活动栏、面板、状态栏和标签栏；返回源码恢复进入前状态，不写持久偏好、不用 CSS 遮住仍占布局的 Parts。保存标签来源是 dirty、进行中的 save Promise、实际 fs 成败；失败可重试，导出/模式切换不隐式保存。

### 6. People grouping does not merge resource identities

同 namespace/catalog 内按已验证、明确类型为 alternate_skin 的关系连通分量构造人物组；不同 external_ids.character 不得否决该显式关系。external_ids.character 是外部形态记录 ID，而非 canonical person ID，保留其原值；同值可合并重复形态记录，但不跨 namespace/catalog。分量内按规范 entity ID 排序形成确定性的私有 group key。既无 typed alternate_skin 关系、又无重复记录身份的实体独立，以原 displayName/entity ID 保持可区分。绝不按同名、括号或下划线推断归属。

此处更正原批准计划中的事实前提：集成负责人提供的生产数据证据中，艾米的形态记录分别为10001/10136/20032，爱露为10000/10031/10089，佳代子为13005/10064/10088。同一人物的不同形态具有不同 external_ids.character，因此原“多个不同 character ID 阻止归组”的规则撤销，改以 typed alternate_skin 证据为准，实体/资源引用仍不合并。

归组前仍须整份 Catalog 严格验证并绑定 manifest。未知 taxonomy ID `0`（生产七海记录的既有无效数据）继续导致该 Pack 整份 Catalog 拒绝并走 manifest-only；不将 `0` 归一化为空、不丢单条记录形成部分 Catalog，也不修改线上数据。该既有数据问题不通过客户端容错“修复”。

多形态人物标题优先共同 given；否则原显示名。未关联的独立实体使用可区分的原 displayName/entity ID，不因共同 given 造成虚假归属。形态优先 skin 的 zh-CN，再其他已有本地化；缺失显示“形态未标注”与原名/ID。表情始终是形态实体内 avatar variant。完整搜索保留多语言名称/alias/学校组织。无 Catalog/旧 manifest/自定义项保持可用；不请求实时 Kivo。换旧消息头像允许跨人物但不改 speaker。

### 7. Avatar, side and media remain semantic Rust edits

新 message 的 `avatar: ComposerAvatarChoice | null` / Rust Option 全调用者原子迁移。发送按需生成 actor avatar revision 与消息，合为一次 WorkspaceEdit/undo stop；仅成功 apply 后清正文，保留 speaker/avatar。老师为内置身份，只能使用当前授权右侧。

`setStatementSide` / core SetStatementSide、`ComposerMessageCapabilities.setSide` 的允许值数组决定左右 UI；老师不能左。保留 body、continued、speaker、相邻继承语义并完整候选验证，不在 TS 改 sigil。名字/头像注明 fromStatement 的后续作用范围；continued、body mode 与 Source Lens 留在高级入口。

`ComposerNewStatement` 新增 `{kind:"media",side,speaker,avatar,continued,media}`；media 仅 `{kind:"asset",assetName}`、`{kind:"workspaceImage",relativePath}`、`{kind:"sticker",entityId,setId,ordinal}`。Rust 验证已声明 asset、当前 pack sticker、sanitized workspace resolver；选择不冲突 asset 名，生成 @asset 与已有宏，一次 WorkspaceEdit。快照暴露语义分析产生的只读 asset choices。媒体可选块/移动/删/改属性，不获得不存在的正文 caret。

为支持上述 `assets/<uuid>.png|jpg`，既有 LocalFile resolver 从 basename-only 扩展为相对作者文档目录的安全分段路径。各 segment 必须非空且不为 `.`/`..`；拒绝绝对路径、反斜杠、控制字符、冒号，不把不安全输入归一化为有效路径。Semantic lowering、language/render projection、browser loader、native materializer 使用同一语法和 source-relative 基准；既有 basename 与独立 URL IR 合同不变。平台文件权限、native canonical-path/root containment（含 symlink 逃逸）继续约束实际读取，workspaceImage 不接受任意文件系统或 URL。

本地 PNG/JPEG 先经原生 picker 解码，再写文档目录下 `assets/<uuid>.png|jpg`，成功后提交 workspaceImage。写文件失败不动源码；源码拒绝则保留草稿并只清理该次新建且未被接受引用的文件；既有资源不碰。失效插入目标要求重新选择。GUI 差分选择只返回 media choice，source gallery 原行内/选区命令保持原适用条件。

### 8. Export is an output snapshot workflow

chat/source 点击“导出作品”后 drain 已接受输入、进入 layout 并等待 output 快照，现有队列自动继续，不要求二次点击、不建离屏 renderer。未发送草稿保留并提示不在本次成品。PDF 全文；PNG/JPG/SVG 明确选页，图像2×及实际尺寸，JPG白底/0.92；SVG内联授权资源、移除选区/编辑层。

只接受 preset=output。过期 output 只能显式选“导出当前排版快照”，chat 绝不是 stale 备选。immutable artifact pin/source/projection/render 校验与 finally 释放继续。idle→waiting/exporting→complete/cancelled/error 使用现有状态机，实际 Blob/下载成功才完成；资源缺失/超大图报真实错误，提供 PDF/排版入口，不截断/换格式。源文件独立下载当前规范 TextDocument。

## Feature Migration

| Existing ability | Product entry and preserved contract |
|---|---|
| 新建/打开 | 作品菜单；新建仅作品名，既有文件原样打开 |
| 保存/自动保存/Local History | 真实状态、菜单保存/恢复；不改自动保存策略 |
| undo/redo | 原生快捷键与菜单；无第二历史 |
| 文件/诊断/工作区 | source 原生入口与高级工作区 |
| 连续写作 | chat 常驻底栏；成功才清正文，保留角色/表情 |
| 本作/最近/完整库 | 横向 tray 与按需人物→形态→表情面板 |
| 自定义角色/头像 | 现有状态展示、局部源码/源码入口；不虚构 GUI 写入管线 |
| 正文/跨消息/IME/剪贴板 | chat/layout 共用精确 ComposerTextSession |
| 编辑/插入/移动/删除 | 选中四动作、摘要、能力状态；上/下/移到，非拖拽必需 |
| 说话人/头像/名字/左右 | 属性；fromStatement 明示；新 side Rust 能力 |
| continued/正文模式 | 高级属性，保留 Typst/宏能力 |
| Source Lens/opaque/@typ | 更多→局部源码/source；来源和写入权不放宽 |
| 旁白/图片/差分 | +添加；旁白复用，媒体走新 Rust 意图 |
| zoom/Fit width/page | layout；保留原滚动/fit/renderKey 修复 |
| PDF/PNG/JPG/SVG | 统一 output exact export；范围/尺寸明确 |
| .mmt 下载 | 独立源文件操作，不是另一个项目格式 |
| .typ/generated/package | 原只读/导航边界，绝不因模式获写入权 |

## Mobile, Visual and Failure States

≤550px 单 EditorGroup；顶栏可截断作品名/真实状态、文字模式按钮和“导出”。角色、形态/表情、属性、添加、导出共享一个互斥辅助槽：桌面可收面板，手机同一个 Bottom Sheet，内部前进/返回、不叠遮罩，独立滚动、标题、关闭、焦点约束/恢复和 Esc。

320px角色快捷栏不挤正文行；约360px可视高度时输入最多约3行，tray 收敛当前角色/选角；visualViewport 高度/offset 和四侧 safe area 决定位置。键盘下发送、输入、caret 和关闭可见，目标≥44px。

字号16/13/18(600)/14(500)，间距4/8/12/16/24/32，控件10px/面板16px/Sheet20px圆角、2px线性图标。浅色文字#213547、辅助#63788B、背景#F7FAFC、聊天底#EDF4F8、边界#DDE6EE、主操作#4A8AC6，粉#F6B2C1只作少量品牌装饰。系统深色只影响 chrome，不反相 SVG 或改作者色。空白有真实入口；加载保留最近接受画面并标更新中，无画面才骨架；选中蓝色描边/摘要；编辑caret/编辑态；stale有恢复文字、复制、重新选目标确认重试；错误不清输入、不自动重放。aria-live不逐帧/逐字播报。

## Implementation and Qualification

切片1：新建/三模式/临时preset/身份隔离/原生chrome/输入切换，集成验证完成才开始切片2。切片2：人物层级、保留头像连续发送、四动作、side/media、授权故障复现与修复。切片3：跨模式/源码同步、真实设置和 output 导出/独立源文件。切片4：移动/并发/兼容/滚动性能/视觉全验收。

命令与具体验收列于 tasks.md。只有集成负责人在全部相关改动落地后运行验证；子代理不启动 build/test/lint/format。每切片须实际 UI 操作与桌面/手机截图；最后打开 PDF、解码 PNG/JPG、独立打开 SVG 并做同 renderKey output 对照。不得用文件头/非空、静态 mock 或旧部署作验收。

真实 iOS/Android 输入法、物理触摸、Safari动态地址栏、系统读屏和真人新手没有设备记录就列未验证。自动化视口/合成 composition 与实际系统 IME 证据分开。既有失败与本次引入失败分列，不降低性能/像素/几何门槛；selection与字形误差≤1 CSS px，滚动采用原120条带头像/80次wheel场景。
