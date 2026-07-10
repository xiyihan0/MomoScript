## Overview

pack-v3 的核心目标是把资源包从“目录约定 + 若干 JSON”升级成“manifest 驱动的资源数据库”。DSL 看到的是稳定的实体、slot、set、variant 和贡献命名空间；底层可以是 PNG/JPG 文件，也可以是 AVIFS sequence、未来的压缩归档或远端缓存。

这里的关键分层是：

- 逻辑层：实体、确定性名称、slot、set、variant、默认值与贡献来源；搜索 aliases 留给独立 catalog
- 存储层：图片文件、AVIFS sequence、缓存抽帧路径、内容 hash
- 解析层：把 DSL 资源路径和 `[:...:]` selector 解析成某个逻辑 variant
- 准备层：把逻辑 variant 对应的存储条目转成 Typst 可以读取的静态图片

## Design Goals

### 1. manifest 成为唯一索引入口

pack-v3 不再要求 resolver 同时理解 `char_id.json`、`asset_mapping.json`、目录名和分散的 `tags.json`。这些信息可以由迁移工具生成，但运行时应优先读取一个 v3 manifest。

### 2. 逻辑资源路径不暴露物理压缩格式

作者写：

```text
[:ba::晴_露营, ba_extpack::#1:]
[:ba::晴_露营/sticker/happy:]
[:ba::晴_露营/sticker/default/happy:]
```

不应该关心这个资源最终来自 `images/foo.png`、`stickers.avifs` 的第 17 帧，还是后续的其他存储后端。

### 3. AVIFS sequence 是推荐 storage backend

AVIFS sequence 用于压缩分发体积，但它不是渲染语义。渲染准备阶段需要把被引用的帧抽取到受控 cache，再交给 Typst 静态渲染。第一版推荐以 sticker set 为粒度生成一个 AVIFS sequence。

### 4. `#n` 必须有稳定顺序

`#1`、`#2` 这类 ordinal selector 必须来自 manifest 明确声明的顺序。不能用文件系统遍历顺序，也不能用自然排序临时推断。对 `sticker` 这类成组资源，ordinal 作用域是某个明确的 set，而不是整个角色的所有差分混排。

## Candidate Manifest Shape

草案结构：

```json
{
  "schema": "mmt-pack.v3",
  "pack": {
    "namespace": "ba_extpack",
    "name": "蔚蓝档案表情差分扩展资源包",
    "version": "2026.04.28",
    "type": "extension",
    "requires": ["ba"],
    "eula": { "required": false }
  },
  "entities": {},
  "contributions": [
    {
      "target": "ba::梦",
      "slots": {
        "sticker": {
          "default": "default",
          "sets": {
            "default": {
              "display_name": "默认差分",
              "handles": ["默认"],
              "storage": "dream_default_stickers_avifs",
              "variants": [
                {
                  "id": "dream_001",
                  "ordinal": 1,
                  "frame": 0
                },
                {
                  "id": "dream_002",
                  "ordinal": 2,
                  "frame": 1,
                  "handles": ["梦2", ">_<笑"]
                }
              ]
            }
          }
        }
      }
    }
  ],
  "assets": {
    "hero": {
      "kind": "image",
      "source": { "storage": "loose_assets", "path": "hero.png" }
    }
  },
  "storage": {
    "loose_assets": {
      "kind": "image-dir",
      "base": "assets",
      "sha256": "..."
    },
    "dream_default_stickers_avifs": {
      "kind": "image-sequence",
      "path": "blobs/dream_default_stickers.avifs",
      "container": "avifs",
      "codec": "av1",
      "alpha": true,
      "size": [512, 512],
      "frame_count": 120,
      "random_access": "keyframe",
      "sha256": "..."
    }
  }
}
```

## Entity And Contribution Model

base pack 可以在 `entities` 中定义实体：

```json
{
  "entities": {
    "ba::梦": {
      "names": ["梦"],
      "display_name": "梦",
      "slots": {
        "avatar": {
          "default": "default",
          "items": {
            "default": {
              "storage": "avatar_dream_default"
            }
          }
        }
      }
    }
  }
}
```

entity 的 `names` 是作者可以确定性使用的角色名称，必须非空；`names[0]` 是基于该 preset 惰性创建 script actor 时采用的默认名称。`display_name` 可省略，省略时回退到 `names[0]`。搜索 aliases、多语言检索词、学校/社团和皮肤关系不参与确定性解析，应进入后续 catalog 或 search index。

这里的 entity `names` 与 sticker set / variant 的 `handles` 不同：前者用于定位 character preset 并建立 script actor，后者只是在已确定 slot/set 范围内解析资源 selector。

extension pack 默认不创建同名实体，而是在 `contributions` 中显式 patch 到目标实体：

```json
{
  "contributions": [
    {
      "target": "ba::梦",
      "slots": {
        "sticker": {
          "default": "default",
          "sets": {}
        }
      }
    }
  ]
}
```

如果扩展包确实要定义新实体，应写进 `entities`，实体 id 使用该扩展包自己的 namespace。

## Slot And Variant Rules

第一版 slot 至少包含：

- `avatar`：聊天气泡头像
- `sticker`：正文消息里的角色表情包

`avatar` 这类少量命名图片 SHOULD 使用 `items` 分组，并用 slot 内的 `default` 指向默认 item：

```json
{
  "avatar": {
    "default": "default",
    "items": {
      "default": {
        "storage": "avatar_dream_default"
      },
      "angry": {
        "handles": ["生气"],
        "storage": "avatar_dream_angry"
      }
    }
  }
}
```

`sticker` 这类可能存在多套差分的 slot SHOULD 使用 set 分组。set 字段建议包含：

- `default`：slot 内默认 set id，例如 `initial`
- `display_name`：面向作者和 IDE 展示的组名，例如 `初始立绘差分`、`战损差分`、`学校泳装`
- `handles`：该 set 可被 DSL 确定性解析的别名，例如 `初始`、`战损`
- `storage`：该 set 的默认 storage id，常用于“一组差分一个 AVIFS sequence”
- `variants`：该 set 下的具体差分列表

variant 字段建议包含：

- `id`：稳定机器 id，在同一 subject、同一 contribution namespace、同一 slot、同一 set 内唯一
- `ordinal`：可选但推荐，用于 `#n` selector，必须在 set 内 1-based 且唯一
- `frame`：指向所属 set storage 中的 0-based 帧序号
- `handles`：可选，作者可直接写出的确定性别名，例如 `梦2`、`>_<笑`

第一版主 manifest 不建议把 `tags`、`description`、原始 URL 或搜索向量写进 variant。它们更适合进入独立的 `catalog.json` / `search-index.json`，避免运行时 resolver 必须加载百科或语义搜索材料。

`ordinal` 不是文件名编号，也不是数组下标。迁移工具可以从旧文件名、旧 tags 顺序或 Kivo gallery 顺序生成它，但生成后必须固化在 manifest 中。`#n` 的编号范围默认是当前 set；如果一个 slot 下存在多个 set 且没有默认 set，裸 `#n` 应报 ambiguous。

资源路径允许在 slot 后显式指定 set：

```text
<subject-ref>/[contribution_namespace::]<slot>/<variant>
<subject-ref>/[contribution_namespace::]<slot>/<set>/<variant>
```

其中 `<slot>/<variant>` 只在该 slot 有明确 `default` set 时成立。否则作者必须写出 `<slot>/<set>/<variant>`。

`[:...:]` 中的 sticker selector 也采用同一规则：

```text
[:未花, #1:]
[:未花, 战损/#1:]
[:未花, 学校泳装/#1:]
[:未花, ba_extpack::战损/#1:]
```

这里逗号左侧仍是 subject，右侧是 sticker selector；第一版不支持 `[:未花/#1:]` 这种在路径中省略 `/sticker/` 的写法。

## Storage Backends

第一版推荐支持两种 storage backend：

- `image-dir`：普通图片目录，用于兼容现有 PNG/JPG 资源和少量素材
- `image-sequence`：AVIFS sequence，用于压缩大量静态表情序列，推荐按 set 拆分 blob

`image-sequence` 的约束：

- 每个 variant 的 `frame` 指向一个 0-based 解码帧序号，并继承所属 set 的 `storage`
- 如果需要按需随机抽帧，pack 应使用可随机访问的关键帧配置
- 如果使用长 GOP 进一步压缩，manifest 必须声明解码窗口或要求预热整段缓存
- 透明背景资源必须明确声明 `alpha: true`，不能由 renderer 猜测
- lossy / lossless、codec、尺寸、`sha256` 都应写进 storage 元数据

当前推荐 AVIFS 编码 profile 记录在 `avif-compression-and-browser-decode.md`。简要版本为：

```text
avifenc --fps 1 -k 30 -s 8 -j 4 -y 420 --qcolor 80 --qalpha 80
```

其中 `-k 30` 是随机访问与体积的折中；`qalpha=80` 允许透明通道轻度有损；`yuv420` 是当前全量包体积和画质折中候选。如果后续发现浅色线稿或透明差分有明显劣化，可以在构建器中按 set 选择 `yuv444` 或更高质量 profile。

## Rendering Preparation

Typst 阶段不直接消费 AVIFS 帧引用。资源 resolver 应先产出逻辑资源结果：

```json
{
  "entity": "ba::梦",
  "contribution": "ba_extpack",
  "slot": "sticker",
  "set": "default",
  "variant": "dream_001",
  "source": { "storage": "dream_default_stickers_avifs", "frame": 0 }
}
```

渲染准备阶段再把它 materialize 成受控 cache 中的静态图片：

```text
.mmt-cache/pack-v3/ba_extpack/<blob-hash>/frame-000000.png
```

cache key 至少包含：

- pack namespace
- storage `sha256`
- frame index
- decoder profile / version
- 输出格式和尺寸

这样同一个资源在 Python CLI、NoneBot、Web/WASM 编辑器中都能复用同一套逻辑，只是 materializer 的实现不同。

## Open Questions

### AVIFS 编码 profile

当前实测候选是 `aom + AVIFS + q80 + qalpha80 + yuv420 + k30`。第一版 manifest 不应锁死 codec，但要能描述实际使用的 codec、alpha、quality、chroma subsampling 和随机访问能力。

### 抽帧输出格式

Typst 前的 materialized image 可以是 PNG、WebP 或其他 Typst 可读取格式。第一版建议以 PNG 作为最保守目标，后续再评估 WebP。

### manifest 拆分

单个完整 manifest 对运行时最友好，但大资源包可能导致 manifest 过大。后续可以允许 `manifest.json` 作为入口，再按实体拆分 `entities/*.json`，但运行时语义仍应等同于一个完整 manifest。

### 语义查询索引

`description` 和 `tags` 已足够支撑第一版关键词与轻量语义查询。后续若要内置 embedding，应作为派生索引或可重建 cache，不宜成为唯一真相来源。
