## MODIFIED Requirements

### Requirement: 侧边栏提供角色图鉴视图

编辑器 SHALL 在既有 `momoscript.characterGallery` 侧边栏视图中按 active pack manifest 与可选 Entity Catalog 展示角色，且 SHALL NOT 修改 shell 拓扑或引入除 `registerCustomView` 之外的视图机制。

#### Scenario: 浏览实体横向列表

- GIVEN 用户已加载一个含角色实体的 pack manifest
- WHEN 用户打开角色图鉴
- THEN 视图 MUST 分页渲染横向元数据列表，首批 MUST NOT 超过 48 项
- AND 每项 MUST 使用 native list/listitem/button 语义并显示 lazy avatar、差分总数；实体有多个 sticker set 时 MUST 同时显示套组数量
- AND 有有效 Catalog metadata 时 MUST 显示学校与主要关系，缺失字段不得产生空标签
- AND 单 Pack 缺失 affiliation 时 MUST 省略空元数据行，不得用 namespace 重复填充每个角色

#### Scenario: 国服名称优先且 manifest 可回退

- GIVEN manifest 同时提供 `display_name`/`names[]`，可选 Catalog 提供本地化名称
- WHEN gallery 计算实体显示标签
- THEN 有效 Catalog 的 `names.display["zh-CN"]` MUST 优先
- AND 缺失 `zh-CN` 或 Catalog 时 MUST 依次采用带全角括号的 manifest alias、下划线名称推导、与 `display_name` 精确相同的名称、`names[0]` 回退
- AND Catalog 名称或 alias MUST NOT 进入 DSL resolve、speaker resolve 或插入 selector

#### Scenario: 搜索与分组筛选表单

- GIVEN 一个或多个 Pack，Entity Catalog 可用或不可用
- WHEN 用户输入任意语言名称/alias，或操作默认展开的分组筛选表单
- THEN 搜索 MUST 以 NFKC、大小写无关方式匹配 entity key、manifest `display_name`/`names[]` 与 Catalog 全部本地化名称/aliases/taxonomy names
- AND 低基数条件 MUST 仿照资料站筛选表单按名称分组，以原生可切换按钮呈现“全部”、形态（基础/换装）与差分数量范围，不得压缩为无标签下拉框
- AND 每个可切换按钮 MUST 暴露 `aria-pressed`，同组 MUST 为单选且再次选择“全部”后清除该条件
- AND 形态与差分数量筛选 MUST 在 manifest-only 模式可用
- AND Pack、学校、关系等高基数条件 MAY 使用带可见标签的原生选择框；有 Catalog 时学校/关系 MUST 按 entity affiliation 与 Pack namespace 区分 taxonomy id
- AND 多 Pack 时 MUST 提供 Pack 筛选，单 Pack 列表 MUST NOT 在每行重复显示 namespace
- AND 没有 Catalog 时 MUST 隐藏无数据的学校/关系分组，但不得隐藏基础筛选
- AND 表单 MUST 提供统一清除操作，并在约 240–320 px 侧栏内换行而不产生横向溢出

#### Scenario: 用户缩放图鉴

- GIVEN 角色图鉴已打开
- WHEN 用户按住 Ctrl 滚动鼠标滚轮或使用可见缩放控制
- THEN 图鉴缩放 MUST 以 0.1 步长限制在 0.5×–3.0×
- AND 当前缩放 MUST 以 `mmt-gallery-zoom` 键写入 localStorage，并在下次创建视图时恢复
- AND localStorage 不可用时 MUST 保留当前会话内缩放而不使视图失败

#### Scenario: pack 未配置

- GIVEN 未配置或未能加载 pack manifest
- WHEN 用户打开角色图鉴
- THEN 视图 MUST 显示空态和可操作的资源包设置入口
- AND MUST NOT 抛出未处理异常或渲染为通用错误页

### Requirement: 差分浏览使用 AVIFS 抽帧缩略图

进入实体后，视图 SHALL 以默认双列大图展示该实体 sticker set 的变体，缩略图 MUST 由与 preview 共用的 AVIFS 解码路径从对应帧生成，且每格 MUST 标注 `#ordinal`。

#### Scenario: 响应式差分网格

- GIVEN 用户在常规宽度的角色图鉴侧栏打开一个含多个差分的实体
- WHEN 详情完成布局
- THEN 前两项 MUST 位于同一行的两个独立 native button 中
- AND 极窄侧栏或高 zoom 无法维持可点击尺寸时 MAY 退为一列
- AND 视图 MUST NOT 产生横向滚动或裁切差分图

#### Scenario: 解码与缓存

- GIVEN 一个含 7 变体的 sticker set
- WHEN 用户进入该实体的差分级
- THEN 视图 MUST 按 set 只下载一次 AVIFS 字节（内存 LRU ≤5 set）
- AND 解码队列并发 MUST ≤2，缩略图 object URL 缓存 MUST ≤256 且逐出时 revoke
- AND 视图隐藏、实体切换、搜索过滤或 pack 更新时 MUST 中止全部在途下载与解码

#### Scenario: pack 资源 URL 约束

- GIVEN manifest 中的任意 `storage.base`/`path`
- WHEN 视图拼接图片 URL
- THEN URL MUST 满足 HTTPS、与 pack root 同源且路径位于 pack root 前缀内
- AND 不满足时 MUST 拒绝加载并显示占位，不得向任意外源发起请求

### Requirement: 点击差分插入实体限定引用

命令 `mmt.gallery.insertSticker(entityName, ordinal, setId?)` SHALL 在活动 mmt 编辑器的光标/选区处插入 manifest entity key 限定引用。默认 set SHALL 使用 `[:entityName,#ordinal:]`，非默认 set SHALL 使用 `[:entityName,setId/#ordinal:]`；Catalog 展示值不得替代 `entityName`。

#### Scenario: 在 mmt 文档中显示目标并插入

- GIVEN 活动编辑器为 `mmtfs` scheme 的 mmt 文档
- WHEN 用户打开角色详情
- THEN 详情 MUST 显示目标文档相对路径与当前行列，variant button MUST 可用
- WHEN 用户点击差分格 `#2`
- THEN 编辑器 MUST 插入 `[:entityName,#2:]` 并保持编辑器焦点
- AND 本地历史 MUST 将此次插入记录为一次普通 edit

#### Scenario: 插入非默认 sticker set

- GIVEN 用户在实体的非默认 sticker set 中点击差分格 `#2`
- WHEN gallery 调用 `mmt.gallery.insertSticker(entityName, 2, setId)`
- THEN 编辑器 MUST 插入 `[:entityName,setId/#2:]`
- AND 默认 sticker set MUST 省略 set id 并保持 `[:entityName,#2:]`

#### Scenario: 从消息光标解析 gallery 实体

- GIVEN 活动 mmt 编辑器的光标行含显式 speaker
- WHEN 用户调用 `mmt.gallery.insertStickerAtCursor`
- THEN gallery MUST 先按 manifest 实体 key 或 `names[]` 精确匹配该 speaker
- AND 直接匹配失败时 MUST 按当前文档的 `@actor` preset 实体 key 解析 speaker
- AND 命中时 MUST 聚焦角色图鉴并进入该实体差分级
- AND 未命中时 MUST 聚焦角色图鉴主界面

#### Scenario: 非 mmt 编辑器仅浏览

- GIVEN 活动编辑器为 `.typ`、其他非 mmt 文档或不存在
- WHEN 用户浏览角色详情
- THEN 详情 MUST 显示“仅浏览”状态并以 native disabled 禁用全部 variant button
- AND 直接调用插入命令 MUST 显示警告且 MUST NOT 修改任何文档

### Requirement: gallery 不改变 Pack 解析或持久化 schema

gallery SHALL 只读消费 active/release manifest 与可选同版本 Entity Catalog，MUST NOT 新增 IndexedDB store、修改 manifest schema、把 Catalog 发送给 PackRegistry，或要求 `thumbnails` 段存在。

#### Scenario: 无 thumbnails 或 Catalog 的 pack

- GIVEN 一个不含 `thumbnails` 且同目录 Catalog 缺失的合法 v3 manifest
- WHEN 用户浏览实体与差分
- THEN 标签 MUST 回退 manifest，所有缩略图 MUST 由 image-dir/image-sequence storage 实时生成
- AND gallery MUST NOT 因缺失 Catalog 或 `thumbnails` 而报错

## ADDED Requirements

### Requirement: Entity Catalog 严格绑定 manifest 并可降级

Workbench SHALL 从每个已接受 manifest 的同目录读取可选 `entity-catalog.json`，严格验证后才把它用于 gallery 展示。

#### Scenario: active 与 release Catalog 按同目录发现

- GIVEN manifest URL 为 active `/<pack>/manifest.json` 或 release `/<pack>/releases/<digest>/manifest.json`
- WHEN gallery 推导 Catalog URL
- THEN MUST 使用 `new URL("entity-catalog.json", manifestUrl)`
- AND MUST NOT 使用 `pack.base_url` 或运行时 Kivo API
- AND 请求 MUST 使用 HTTPS、与 manifest 同源、禁止 redirect 且不携带凭据

#### Scenario: Catalog 与 manifest 严格绑定

- GIVEN Catalog 响应声称 schema `mmt-pack-entity-catalog.v1`
- WHEN Workbench 接受该响应
- THEN parser MUST 拒绝 schema 未允许的字段和畸形 required/locale/taxonomy/related-entity 值
- AND namespace/version MUST 与 manifest 相同
- AND `pack.manifest_sha256` MUST 等于 manifest 原始 JSON 字节 SHA-256
- AND entity、taxonomy 与 alternate-skin 引用 MUST 解析到同一版本允许的目标

#### Scenario: Catalog 失败按 Pack 回退

- GIVEN Catalog 请求 404、网络失败、缓存陈旧、schema 非法或绑定不匹配
- WHEN gallery 同步该 Pack
- THEN 无效响应 MUST NOT 提升到 active cache
- AND 可用 cache MUST 重新绑定当前 manifest 后才能使用
- AND 没有有效 Catalog 时该 Pack MUST 使用 manifest-only projection
- AND LSP、resolver、preview、export、已接受 manifest 与其他 Pack MUST 不受影响

#### Scenario: alternate skin 保持独立 entity

- GIVEN Catalog `related_entities` 声明 `alternate_skin`
- WHEN gallery 展示该关系
- THEN源实体和目标实体 MUST 继续作为独立列表项、独立 sticker set 和独立插入 key
- AND详情 MAY 提供交叉导航，但 MUST NOT 合并实体或重写 selector
