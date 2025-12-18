# MomoScript Pack v2（草案）

本目录用于存放可插拔的素材包（pack）。一个 pack 可以代表某个游戏的“基础素材库”，也可以代表扩展/同人差分包。

目标：
- `ba` 不再是特例：蔚蓝档案素材也作为一个 pack 存在，允许被禁用/移除。
- 角色 ID 允许使用 Unicode（如 `晴`、`未花(泳装)`）。
- 磁盘目录结构不强制与角色 ID 对齐：通过映射文件解决“ID -> 头像/表情目录”。
- pack 可声明 EULA，未来可在 bot 侧做 `accept` 强制同意校验。

## 目录结构

```
mmt_packs/
  <pack_id>/
    manifest.json
    char_id.json
    asset_mapping.json
    avatar/            # 可选：头像资源（也可以引用其它位置）
    images/            # 可选：表情资源（也可以引用其它位置）
```

约束：
- `<pack_id>`：仅允许 `[A-Za-z0-9_]+`
- 角色 ID：允许 Unicode，但不建议包含路径分隔符（`/` `\\`）等危险字符

## manifest.json

示例：

```json
{
  "pack_id": "ba_ext_official",
  "name": "BA 扩展差分（官方）",
  "version": "2025.12.18",
  "type": "extension",
  "eula": {
    "required": true,
    "title": "作者 EULA",
    "url": "https://example.com/eula"
  }
}
```

字段说明（建议）：
- `pack_id`：必须与目录名一致
- `type`：`base` | `extension`（目前仅用于语义）
- `eula.required=true`：未来可用于强制用户先同意才能启用/使用

## char_id.json

用于把“用户输入的名字/别名”映射到 pack 内部的角色 ID。

示例：

```json
{
  "晴": "晴",
  "晴(露营)": "晴(露营)",
  "未花(泳装)": "未花(泳装)",
  "未花 泳装": "未花(泳装)"
}
```

## asset_mapping.json

用于把“角色 ID”映射到头像与表情目录（以及 tags.json 的位置）。

示例：

```json
{
  "晴(露营)": {
    "avatar": "avatar/340.png",
    "expressions_dir": "images/晴(露营)",
    "tags": "tags.json"
  }
}
```

约定：
- `avatar`：相对 pack 根目录的路径（也可未来扩展成 `asset:` / `url:`）
- `expressions_dir`：包含图片与 `tags.json` 的目录
- `tags`：默认 `tags.json`，允许自定义（便于兼容第三方格式）

安全建议：
- 不建议让映射指向任意本地路径；后续实现会做路径规范化与目录白名单校验，避免绕过 Typst 沙箱。

