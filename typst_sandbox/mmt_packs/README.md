# MomoScript Pack v2（草案）

本目录描述 **Pack v2** 的格式：用于存放可插拔的素材包（pack）。

实现侧默认从 `typst_sandbox/pack-v2/` 读取（可用环境变量 `MMT_PACK_V2_ROOT` 修改）。
一个 pack 可以代表某个游戏的“基础素材库”，也可以代表扩展/同人差分包。

目标：
- `ba` 不再是特例：蔚蓝档案素材也作为一个 pack 存在，允许被禁用/移除。
- 角色 ID 允许使用 Unicode（如 `晴`、`未花(泳装)`）。
- 磁盘目录结构不强制与角色 ID 对齐：通过映射文件解决“ID -> 头像/表情目录”。
- pack 可声明 EULA，未来可在 bot 侧做 `accept` 强制同意校验。

## 目录结构

```
typst_sandbox/pack-v2/
  <pack_id>/
    manifest.json
    asset_mapping.json
    char_id.json        # 可选：别名映射（缺省视为 {}）
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
  "requires": ["ba"],
  "eula": {
    "required": true,
    "title": "作者 EULA",
    "url": "https://example.com/eula"
  }
}
```

字段说明（建议）：
- `pack_id`：建议填写；若填写必须与目录名一致
- `type`：`base` | `extension`（目前仅用于语义）
- `requires`：依赖的基础包列表（例如扩展包依赖 `ba`）；目前主要用于约定/文档，后续可用于自动加载/校验
- `eula.required=true`：未来可用于强制用户先同意才能启用/使用
  - bot 侧 `/mmt-pack list`：`required=false` 会默认显示 `accepted`；`required=true` 则需要 `/mmt-pack accept <pack_id>`

## char_id.json

用于把“用户输入的名字/别名”映射到 pack 内部的角色 ID。

该文件 **可选**：不提供时，默认等价于 `{}`（仍然可以用角色 ID 本身进行引用）。

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
- `avatar`：相对 pack 根目录的路径
  - `type=base`：必须提供
  - `type=extension`：允许为空（通常继承 `requires` 指向的基础包头像）
- `expressions_dir`：包含图片与 `tags.json` 的目录
- `tags`：默认 `tags.json`，允许自定义（便于兼容第三方格式）

角色 ID 约定：
- **不要**在这里写 `ba.亚津子` 这种“带命名空间”的 key；这里的 key 应该是包内角色 ID（例如 `亚津子`）。
- 如果扩展包要“合并到基础包同一角色”，扩展包中应使用与基础包一致的角色 ID（例如基础包里是 `亚津子`，扩展包也写 `亚津子`）。

安全建议：
- 不建议让映射指向任意本地路径；后续实现会做路径规范化与目录白名单校验，避免绕过 Typst 沙箱。
