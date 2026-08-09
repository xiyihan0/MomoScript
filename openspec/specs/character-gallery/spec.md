# character-gallery Specification

## Purpose
TBD - created by archiving change add-character-variant-gallery. Update Purpose after archive.
## Requirements
### Requirement: 侧边栏提供角色图鉴视图

编辑器 SHALL 在侧边栏提供 `momoscript.characterGallery` 视图，按 active pack manifest 展示实体网格，且 SHALL NOT 修改 shell 拓扑或引入除 `registerCustomView` 之外的视图机制。

#### Scenario: 浏览实体

- GIVEN 用户打开已发布的 `2026.07.21` pack manifest（该发布版本包含 322 个实体）
- WHEN 用户打开角色图鉴
- THEN 视图 MUST 分页渲染实体网格（首屏 ≤48 个单元），每个单元显示头像与 `display_name`
- AND 搜索输入 MUST 按 `names[]`/`display_name` 子串即时过滤
- AND 头像图片 MUST 懒加载

#### Scenario: 实体显示标签保持可辨识全名

- GIVEN manifest 同时提供 `display_name` 与 `names[]`
- WHEN gallery 计算实体显示标签
- THEN `galleryDisplayLabel` MUST 依次采用带全角括号的 alias、下划线名称推导、与 `display_name` 精确相同的名称、`names[0]` 回退
- AND 下划线名称 MUST 转换为 `主名（差分/层级）` 形式

#### Scenario: 用户缩放图鉴

- GIVEN 角色图鉴已打开
- WHEN 用户按住 Ctrl 滚动鼠标滚轮
- THEN 图鉴缩放 MUST 以 0.1 步长限制在 0.5×–3.0×
- AND 当前缩放 MUST 以 `mmt-gallery-zoom` 键写入 localStorage，并在下次创建视图时恢复
- AND localStorage 不可用时 MUST 保留当前会话内缩放而不使视图失败

#### Scenario: pack 未配置

- GIVEN 未配置或未能加载 pack manifest
- WHEN 用户打开角色图鉴
- THEN 视图 MUST 显示空态并引导到项目视图配置 manifest
- AND MUST NOT 抛出未处理异常或渲染为通用错误页

### Requirement: 差分浏览使用 AVIFS 抽帧缩略图

进入实体后，视图 SHALL 展示该实体 sticker set 的变体网格，缩略图 MUST 由与 preview 共用的 AVIFS 解码路径从对应帧生成，且每格 MUST 标注 `#ordinal`。

#### Scenario: 解码与缓存

- GIVEN 一个含 7 变体的 sticker set
- WHEN 用户进入该实体的差分级
- THEN 视图 MUST 按 set 只下载一次 AVIFS 字节（内存 LRU ≤5 set）
- AND 解码队列并发 MUST ≤2，缩略图 object URL 缓存 MUST ≤256 且逐出时 revoke
- AND 视图隐藏、实体切换或搜索过滤时 MUST 中止全部在途下载与解码

#### Scenario: pack 资源 URL 约束

- GIVEN manifest 中的任意 `storage.base`/`path`
- WHEN 视图拼接图片 URL
- THEN URL MUST 满足 HTTPS、与 pack root 同源且路径位于 pack root 前缀内
- AND 不满足时 MUST 拒绝加载并显示占位，不得向任意外源发起请求

### Requirement: 点击差分插入实体限定引用

命令 `mmt.gallery.insertSticker(entityName, ordinal, setId?)` SHALL 在活动 mmt 编辑器的光标/选区处插入实体限定引用，且 MUST NOT 生成依赖 speaker 上下文的裸 `#n` 形式。默认 set SHALL 使用 `[:entityName,#ordinal:]`，非默认 set SHALL 使用 `[:entityName,setId/#ordinal:]`。

#### Scenario: 在 mmt 文档中插入

- GIVEN 活动编辑器为 `mmtfs` scheme 的 mmt 文档，光标位于某消息内
- WHEN 用户点击差分格 `#2`
- THEN 编辑器 MUST 在光标处插入 `[:entityName,#2:]` 并保持编辑器焦点
- AND 本地历史 MUST 将此次插入记录为一次普通 edit

#### Scenario: 插入非默认 sticker set

- GIVEN 用户在实体的非默认 sticker set 中点击差分格 `#2`
- WHEN gallery 调用 `mmt.gallery.insertSticker(entityName, 2, setId)`
- THEN 编辑器 MUST 插入 `[:entityName,setId/#2:]`
- AND 默认 sticker set MUST 省略 set id 并保持 `[:entityName,#2:]`

#### Scenario: 从消息光标解析 gallery 实体

- GIVEN 活动 mmt 编辑器的光标行含显式 speaker
- WHEN 用户调用 `mmt.gallery.insertStickerAtCursor`
- THEN gallery MUST 先按实体 key 或 `names[]` 精确匹配该 speaker
- AND 直接匹配失败时 MUST 按当前文档的 `@actor` preset 实体 key 解析 speaker
- AND 命中时 MUST 聚焦角色图鉴并进入该实体差分级
- AND 未命中时 MUST 聚焦角色图鉴主界面

#### Scenario: 非 mmt 编辑器

- GIVEN 活动编辑器为 `.typ` 或其他非 mmt 文档
- WHEN 用户点击差分格
- THEN 编辑器 MUST 显示警告且 MUST NOT 修改任何文档

### Requirement: gallery 不引入新的持久化或 pack schema 变更

gallery SHALL 只读消费 active pack manifest，MUST NOT 新增 IndexedDB store、修改 manifest schema，也 MUST NOT 要求 `thumbnails` 段存在。

#### Scenario: 无 thumbnails 段的 pack

- GIVEN 一个不含 `thumbnails` 段的合法 v3 manifest
- WHEN 用户浏览实体与差分
- THEN 所有缩略图 MUST 由 image-dir/image-sequence storage 实时生成
- AND gallery MUST NOT 因缺失 `thumbnails` 而报错

