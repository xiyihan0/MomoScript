## Overview

这份笔记记录 `kivo.wiki` / `api.kivo.wiki` 当前可用于重建主资源包的数据结构。它不是 pack-v3 schema 本身，而是迁移工具和数据抓取器的参考。

主要来源：

- API README：`https://github.com/Dale233/bluearchive-api-kivowiki`
- 学生列表：`https://api.kivo.wiki/api/v1/data/students?page=1&page_size=1`
- 学生详情：`https://api.kivo.wiki/api/v1/data/students/{student_id}`
- 学校列表/详情：`https://api.kivo.wiki/api/v1/data/schools`
- 关系列表/详情：`https://api.kivo.wiki/api/v1/data/relations`
- 示例页面：`https://kivo.wiki/data/character/42`、`https://kivo.wiki/data/character/1?mode=appreciation`

## Response Wrapper

API 返回值外层通常为：

```json
{
  "code": 2000,
  "codename": "Koyuki",
  "data": {},
  "message": "OK",
  "success": true,
  "time": 1777339290,
  "version": "1.0.0-beta.43"
}
```

迁移工具应只把 `data` 作为业务数据输入，同时记录 `version` / `time` 到导入日志或 `meta.external.kivo`，方便后续 diff。

## Relevant Endpoints

### Students List

```text
GET https://api.kivo.wiki/api/v1/data/students
```

常用参数：

- `page` / `page_size`：分页
- `character_data_search`：学生姓名模糊搜索
- `is_skin`：筛选是否换装
- `school`：学校 id
- `is_npc` / `is_install` / `is_install_global` / `is_install_cn`
- `birthday` / `body_shape` / `weapon_type`
- `name_sort` / `id_sort` / `height_sort` / `birthday_sort`

列表项字段较少，适合发现 id 和基础索引：

```json
{
  "id": 76,
  "skin": "",
  "skin_jp": "",
  "skin_cn": "",
  "skin_zh_tw": "",
  "family_name": "小鸟游",
  "given_name": "星野",
  "family_name_jp": "小鳥遊",
  "given_name_jp": "ホシノ",
  "family_name_cn": "小鸟游",
  "given_name_cn": "星野",
  "avatar": "//static.kivo.wiki/images/students/.../avatar.png",
  "school": 1,
  "main_relation": 19
}
```

### Student Detail

```text
GET https://api.kivo.wiki/api/v1/data/students/{student_id}
```

详情页字段很多，建议按用途分组，而不是一比一复制进 manifest。

身份与名称：

- `id`
- `skin` / `skin_jp` / `skin_cn` / `skin_zh_tw`
- `skin_list`
- `family_name` / `given_name`
- `family_name_jp` / `given_name_jp`
- `family_name_kr` / `given_name_kr`
- `family_name_en` / `given_name_en`
- `family_name_zh_tw` / `given_name_zh_tw`
- `family_name_cn` / `given_name_cn`
- `nick_name`

简介与角色信息：

- `introduction` / `introduction_cn`
- `momo_talk_signature`
- `age`
- `grade`
- `height`
- `birthday`
- `hobby`
- `school`
- `main_relation`
- `relation`

创作者与实装信息：

- `designer`
- `illustrator`
- `character_voice`
- `character_voice_cn`
- `release_date`
- `release_date_cn`
- `release_date_global`
- `is_install`
- `is_install_cn`
- `is_install_global`
- `is_npc`
- `show_list`
- `body_shape`
- `special_appearance`

图片、语音和图集：

- `avatar`
- `sd_model_image`
- `recollection_lobby_image`
- `spine`
- `model`
- `voice_play_icon`
- `voice_pause_icon`
- `voice`
- `voice_cn`
- `voice_kr`
- `gallery`

游戏战斗数据：

- `character_datas[].character_id`
- `character_datas[].dev_name`
- `character_datas[].combat_style`
- `character_datas[].type`
- `character_datas[].attack_attribute`
- `character_datas[].defensive_attributes`
- `character_datas[].team_position`
- `character_datas[].battlefield_position`
- `character_datas[].rarity`
- `character_datas[].limited`
- `character_datas[].equipment`
- `character_datas[].skill`
- `character_datas[].basic`
- `character_datas[].weapons`

导入与更新时间：

- `source`
- `contributor`
- `created_at`
- `updated_at`
- `info_declare_uuid`
- `skill_declare_uuid`
- `supplementary_uuid`
- `supplementary_declare_uuid`

## Observations

### Kivo skin 是独立学生 id

Kivo 将同一人物的不同 skin 作为独立学生记录。例如：

- `76`：小鸟游星野，默认 skin
- `42`：小鸟游星野，泳装 skin

两者字段集合一致，但 `id`、`skin`、`avatar`、`introduction`、`nick_name`、`release_date`、`character_datas[].character_id`、语音和图集都可能不同。

pack-v3 因此倾向将不同 skin 建成不同 entity id，只在 `meta.related_entities` 中说明关系。

### skin_list 可用于建立 related_entities

`skin_list` 形态如下：

```json
[
  { "id": 76, "avatar": ".../avatar.png", "skin": "", "skin_cn": "" },
  { "id": 42, "avatar": ".../泳装/avatar.png", "skin": "泳装", "skin_cn": "泳装" },
  { "id": 287, "avatar": ".../昔日/avatar.png", "skin": "一年级", "skin_cn": "" },
  { "id": 373, "avatar": ".../临战/avatar.png", "skin": "临战", "skin_cn": "武装" }
]
```

迁移工具可以用它生成：

```json
"related_entities": [
  { "type": "alternate_skin", "entity": "ba::hoshino_swimsuit" },
  { "type": "alternate_skin", "entity": "ba::hoshino_old" }
]
```

具体 entity id 仍由主资源包命名规则决定。

### gallery title 对应 sticker set 候选

`https://kivo.wiki/data/character/1?mode=appreciation` 中，未花的 `gallery` 包含多组差分：

```json
[
  { "title": "官方图集", "images": ["..."] },
  { "title": "初始立绘差分", "images": ["..."] },
  { "title": "战损差分", "images": ["..."] },
  { "title": "学校泳装", "images": ["..."] },
  { "title": "运动服", "images": ["..."] }
]
```

这些图集组说明 pack-v3 需要 `slot -> set -> variant` 层级。迁移时：

- `初始立绘差分`、`战损差分`、`学校泳装`、`运动服` 这类同构差分组可以生成 `sticker.sets`
- 每个 `gallery.images[]` 的数组顺序可以作为 `ordinal` 初始来源
- `官方图集`、`相关图像` 更适合作为普通 gallery / asset catalog，不应默认放入 `sticker`

### protocol-relative URL 需要规范化

Kivo 图片和语音 URL 常以 `//static.kivo.wiki/...` 形式出现。迁移工具应在抓取时规范化为 `https://static.kivo.wiki/...`，但 manifest 内最终应引用 pack-relative storage，而不是长期依赖远端 URL。

### relation 不应直接命名为 club

Kivo README 将 `/relations` 说明为“社团(?)”，实际更像关系/组织/阵营索引。pack-v3 的 meta 中建议保留 `main_relation` / `relations` 命名，不要第一版强行改成 `club`。

## Suggested Mapping To pack-v3

### Entity Core

Kivo 字段到 pack-v3 entity core 的建议映射：

```json
{
  "entities": {
    "星野_泳装": {
      "names": ["星野_泳装", "星野(泳装)"],
      "display_name": "星野",
      "slots": {}
    }
  }
}
```

注意：

- 第一版 `entity id` 直接使用中文 canonical 名称；非默认 skin 使用 `中文角色名_中文皮肤名`
- entity `names` 与中文 canonical id 同源；缺失时回退到国际服/英文名，参与 DSL 裸名解析
- `names[0]` 是该 character preset 提供的默认 script actor name
- Kivo `nick_name` 与多语言别称只服务 IDE 检索，不参与 DSL 裸名解析，也不应自动全部升级为 deterministic names
- Blue Archive 的四位联动角色应使用全名作为默认 name：`初音未来`、`御坂美琴`、`食蜂操祈`、`佐天泪子`

### Entity Meta

Kivo 字段到 pack-v3 `meta` 的建议映射：

```json
{
  "meta": {
    "external": {
      "kivo": {
        "student_id": 42,
        "character_id": 10045,
        "updated_at": 1774870533
      }
    },
    "names": {
      "family": {
        "zh-CN": "小鸟游",
        "ja-JP": "小鳥遊",
        "en-US": "Takanashi"
      },
      "given": {
        "zh-CN": "星野",
        "ja-JP": "ホシノ",
        "en-US": "Hoshino"
      },
      "skin": {
        "zh-CN": "泳装",
        "ja-JP": "水着",
        "zh-TW": "泳裝"
      },
      "nicknames": {
        "zh-CN": ["水星野", "水星", "水大叔", "水叔"]
      }
    },
    "profile": {
      "age": 17,
      "grade": "三年生",
      "height_cm": 145,
      "birthday": "01-02",
      "hobby": { "zh-CN": "午睡、休息" },
      "momo_talk_signature": { "zh-CN": "午睡中~随时欢迎伙伴哦" },
      "introduction": { "zh-CN": "为了悠闲度过夏日，才来到无人岛的阿拜多斯对策委员会会长。" }
    },
    "affiliation": {
      "school": { "source_id": 1 },
      "main_relation": { "source_id": 19 },
      "relations": [{ "source_id": 18 }, { "source_id": 17 }]
    },
    "credits": {
      "designer": ["9ml"],
      "illustrator": ["9ml"],
      "voice_actor": {
        "ja-JP": ["花守由美里"],
        "zh-CN": ["刘雯"]
      }
    },
    "game": {
      "weapon_type": "SG",
      "body_shape": "Small",
      "is_npc": false,
      "special_appearance": false,
      "release_date": {
        "jp": "2022-07-20",
        "global": "2023-01-31",
        "cn": "2024-06-13"
      }
    }
  }
}
```

### Sticker Sets

Kivo `gallery` 到 pack-v3 `sticker.sets` 的建议映射：

```json
{
  "slots": {
    "sticker": {
      "default": "initial",
      "sets": {
        "initial": {
          "display_name": "初始立绘差分",
          "handles": ["初始"],
          "storage": "mika_initial_stickers_avifs",
          "variants": [
            {
              "id": "initial_001",
              "ordinal": 1,
              "frame": 0
            }
          ]
        },
        "damaged": {
          "display_name": "战损差分",
          "handles": ["战损"],
          "storage": "mika_damaged_stickers_avifs",
          "variants": []
        }
      }
    }
  }
}
```

## Data Not Recommended For Core Manifest

第一版主资源包 manifest 不建议直接内嵌：

- 完整 `voice` / `voice_cn` / `voice_kr` 列表
- 完整 `gallery` 原始 URL 列表
- 完整技能数值与成长数据
- `more` 中的大段 wiki 正文
- 远端静态资源 URL 作为最终 source

这些内容更适合作为：

- 迁移工具输入
- IDE catalog / search index
- 可重建的外部数据缓存
- pack 构建阶段的下载清单

## Open Questions

### entity id 命名规则

当前草案第一版倾向直接使用中文 canonical 名称作为 entity id。默认皮肤使用中文角色名，例如 `星野`；非默认皮肤使用 `中文角色名_中文皮肤名`，例如 `星野_泳装`。Kivo `id` 很稳定，但不适合直接作为作者可读资源路径；它应保留在构建报告或后续 catalog 中。

### gallery 组过滤规则

不是所有 Kivo gallery 都应该进入 `sticker` slot。需要为 `官方图集`、`相关图像`、活动图、设定图等类别制定过滤或映射规则。

### entity name 生成规则

entity names 与中文 canonical id 同源；缺失时回退到国际服/英文名。Kivo 的 `nick_name` 经常是逗号分隔字符串，且可能包含大量俗称；迁移工具可以把它们保留在 raw source 或后续 catalog，但升级为 deterministic names 前需要人工或规则审查。

联动角色应使用全名作为默认 entity name，而不是只用 given name。第一版 override 名单为 `初音未来`、`御坂美琴`、`食蜂操祈`、`佐天泪子`。
