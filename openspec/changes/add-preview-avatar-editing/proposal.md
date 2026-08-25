## Why

Preview Composer 已经证明从渲染区域定位当前 statement、由 Rust 生成纯版本化 WorkspaceEdit、再通过 TextDocument/History/Preview 主链应用编辑的路径。人物头像仍只能手写 `@actor` revision；角色图鉴也只把 avatar slot 投影成一个默认缩略图，无法为当前人物或其他人物选择完整 avatar variant。

头像是高频、强视觉的 GUI 操作，也是验证桌面图像选择器与未来移动端 bottom sheet 能否复用同一产品级命令合同的合适下一步。实现必须保持 `.mmt` 文本为唯一事实源，不把 SVG label、Gallery DOM、资源 URL 或 TypeScript 字符串拼接升级为编辑权限。

## What Changes

- 扩展 `mmt/previewComposerTarget`，为已唯一解析的非 builtin actor 返回 `actorAvatar` 描述符：从当前 statement 起的作用域、当前 actor preset identity，以及当前已解析 avatar identity；不暴露内部 ActorId。
- 扩展纯 `mmt/composerEdit`，新增结构化 `setActorAvatarFromStatement` command。选择值包含 pack entity、contribution namespace 与 variant id；Rust 负责验证 PackRegistry identity 并序列化 canonical avatar selector。
- 使用既有 `@actor` revision 语义：优先最小更新只作用于目标起点的相邻 actor block，否则在目标 statement 前插入 canonical actor block。前文保持原头像，目标及后文使用新头像，直到后续 revision 再次修改。
- 明确允许选择其他人物的头像。speaker/ActorId/display-name 保持当前人物，只替换其 avatar resource identity；UI 必须明确展示“当前人物将使用其他人物头像”。
- 扩展生产 Web 的只读 Pack/Gallery 产品模型，投影 base entity 与 contribution 中的全部 avatar items，而不修改 pack-v3 schema、IndexedDB schema 或发布格式。
- 在 Preview Composer 原生右键菜单增加“从本条起更换人物头像…”。桌面首个表面使用受 Composer operation 生命周期管理的指针邻近图片选择器，默认展示当前人物并允许搜索“其他人物”。
- 将资源选择、过滤与 command payload 建成不依赖指针位置的产品级 controller；未来移动端可用 bottom sheet 复用，当前 change 不实现移动端 shell。

## Affected Capabilities

- `language-tooling`：新增 avatar target descriptor、严格 command wire type、PackRegistry 验证、actor revision source edit 与 candidate reanalysis 合同。
- `web-workbench-shell`：新增右键头像 action、图片 picker、revision/pack/runtime 生命周期和无重试 apply 合同。
- `character-gallery`：扩展 active pack 的 avatar variant 只读投影与安全缩略图能力；既有 sticker 插入行为不变。
- 依赖但不修改：Rust v2 `dsl-syntax` 的 `@actor avatar:` revision 与跨 entity avatar path；pack-v3 manifest/resolver；`add-preview-contextual-editing` 的 point-only target 和纯 Composer apply 边界。

## Non-Goals

- 不实现 statement-local、仅单个气泡生效的头像覆盖；该行为需要独立 DSL 语义。
- 不改变 speaker、actor preset、actor names 或 display-name；选择其他人物头像不等于切换人物。
- 不把 statement patch 中的 `avatar:` 解释为 DSL selector；patch 继续保持 Typst 参数语义。
- 第一阶段不从 GUI 选择 `asset::` 自定义头像、不上传本地文件、不编辑 Pack manifest。
- 不把现有角色图鉴改造成全局可变选择状态，不让 sidebar DOM 持有待应用 Composer target。
- 不在本 change 实现移动端布局、bottom sheet、多选、格式刷或完整无源码创作界面。
