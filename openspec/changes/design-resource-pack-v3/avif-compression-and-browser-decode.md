## Overview

这份笔记记录 pack-v3 当前推荐的 sticker 压缩策略、Kivo Wiki 基础资源包构建流程，以及浏览器 AVIF 解码路线。它是 `design.md` 的研究补充，不是 schema；浏览器部分暂不进入当前 parser 实现范围，但保留为后续迁移参考。

当前结论：

- sticker 差分序列优先使用 AVIFS image sequence，而不是 WebM 视频流。
- manifest 只暴露逻辑资源与 storage 元数据，不把 AVIFS 细节泄漏给 DSL 作者。
- 当前主线只要求平台 materializer 把 sequence frame 转成受控静态图片；第一版输出固定为 PNG。
- browser Worker / WASM decoder 暂不构成当前 parser 的 requirement 或 task，但未来 Web materializer 可以复用该研究。

## Kivo Wiki Base Pack Build

基础资源包构建器 SHOULD 以 Kivo Wiki API 作为可重建数据源，而不是手工维护散落 JSON。

推荐输入：

- 学生列表与详情：`https://api.kivo.wiki/api/v1/data/students`
- 学生详情：`https://api.kivo.wiki/api/v1/data/students/{student_id}`
- 学校、关系等辅助表：`schools`、`relations`
- 图集与差分组：学生详情中的 `gallery`

构建阶段建议分为：

1. 抓取索引：分页下载 students list，记录 API `version`、`time`、构建时间和参数。
2. 抓取详情：按 student id 下载详情，规范化 protocol-relative URL 为 `https://...`。
3. 建立实体：每个 Kivo student id 默认生成一个独立 pack-v3 entity；同一人物的不同 skin 通过 `meta.related_entities` 关联，不合并为同一个 entity id。
4. 建立命名：第一版 entity id 直接使用中文 canonical 名称；默认皮肤使用中文角色名，非默认皮肤使用 `中文角色名_中文皮肤名`；entity `names` 与 entity id 同源，`names[0]` 是默认 script actor name，缺失时再回退国际服/英文名；搜索 aliases 不进入主 manifest。
5. 建立 sticker sets：从 `gallery` 中挑选差分组，例如 `初始立绘差分`、`战损差分`、`学校泳装`，每组生成一个 `sticker.set`。
6. 固化顺序：`gallery.images[]` 顺序可作为初始 `ordinal` 来源，写入 manifest 后不得再依赖文件系统顺序。
7. 下载素材：远端 URL 下载到 pack-relative asset staging 目录，并记录原始 URL、内容 hash、下载状态。
8. 编码压缩：对每个 sticker set 独立编码为 AVIFS sequence，并把 sequence storage 写入 manifest。
9. 生成报告：记录成功、跳过、失败原因、原始体积、压缩后体积、v2 manifest 差异。

构建器 SHOULD 保留可审计报告，例如：

```json
{
  "source": "kivo.wiki",
  "api_version": "1.0.0-beta.43",
  "students": 473,
  "sticker_sets": 536,
  "encoded_sets": 493,
  "skipped_sets": 43,
  "original_bytes": 4458208065,
  "encoded_bytes": 53520807,
  "encode_profile": "avifs-aom-q80-a80-yuv420-k30"
}
```

### Naming Rules

默认资源包构建器 SHOULD 使用下面的命名规则：

- 第一版 `entity id` 直接使用中文 canonical 名称，例如 `星野`、`星野_泳装`、`初音未来`。
- 默认 skin 不加后缀；非默认 skin 使用中文皮肤名作为后缀。
- 如果中文名缺失，则回退到国际服/英文名；仍缺失时使用 `student_<kivo_id>`。
- 如果 entity id 冲突，则追加 Kivo student id，例如 `星野_42`，并在构建报告中记录冲突。
- entity `names` 与中文 canonical id 同源；首项是默认 actor name，非默认 skin 可同时提供 `星野_泳装` 和 `星野(泳装)`。
- 主 `manifest.json` 暂时不输出 `meta`；多语言名称、学校/社团、差分皮肤关系后续进入轻量 catalog 或单独索引。
- Kivo `nick_name` 保留在原始来源或独立 catalog，不自动提升为 deterministic entity names。
- entity name 冲突 MUST 写入构建报告；构建器不得静默让后出现的实体覆盖先出现的实体。

联动角色是例外：Blue Archive 的四位联动角色默认 entity name SHOULD 使用全名，而不是只使用 given name。第一版 override 名单包括：

- `初音未来`
- `御坂美琴`
- `食蜂操祈`
- `佐天泪子`

这样可以避免 `未来`、`美琴`、`操祈`、`泪子` 这类短 handle 过泛或与后续角色冲突。

sticker set 命名规则：

- `初始立绘差分` 的 set id SHOULD 是 `default`，不再使用 `initial`。
- 如果某个角色只有一个 sticker set，该 set SHOULD 额外拥有 `default` handle。
- 如果某个 set 本身是默认 set，该 set SHOULD 额外拥有 `default` handle。
- set handle SHOULD 保留 Kivo gallery title 原文，例如 `初始立绘差分`；构建器不得自动 strip 末尾的 `差分` 再生成别名。

## AVIFS Encoding Strategy

当前推荐 profile：

```text
container: avifs
codec: aom
fps: 1
keyframe_interval: 30
qcolor: 80
qalpha: 80
yuv: 420
speed: 8
jobs: 4
```

对应 `avifenc` 参数：

```bash
avifenc --fps 1 -k 30 -s 8 -j 4 -y 420 --qcolor 80 --qalpha 80 input/*.png output.avifs
```

已知 tradeoff：

- `q80 yuv420` 在 Arona 样本中比 `q45 yuv420` 画质更稳，但体积约从 `86K` 增至 `185K`。
- 全量 Kivo sticker 成功项约从 `4.46G` 压到 `53.5M`，压缩比约 `1.20%`。
- `yuv444 q45` 体积更小，约 `28M`，但 PotPlayer 等视频播放器显示链路可能产生误判；浏览器/WASM 解码应以 `avifdec` / libavif 输出为准。
- `svt-av1` 编码速度更快，但当前对 alpha 或非典型序列支持不稳定，第一版不作为默认编码器。

编码器 SHOULD 按 sticker set 逐组处理：

- 同一 set 内帧应使用固定排序，并写入 manifest `ordinal`。
- PNG/JPG/JPEG 且尺寸一致时可直接编码。
- 带 alpha 且尺寸有轻微差异时可先居中 padding 到统一 canvas，再编码，并在 storage metadata 中记录 `canvas_size`。
- 尺寸差异过大、混合模式异常、或无法稳定解码的 set 应跳过并写入构建报告。
- 编码结果必须可用 `avifdec --info` 与首帧解码验证。

`keyframe_interval` 表示相邻独立关键帧的最大间隔。值越小，随机访问后段帧越快，但体积通常更大；值越大，体积可能更小，但浏览器侧按需抽帧可能需要解码更多前置帧。第一版选择 `30` 作为体积与随机访问的折中。

## Manifest Storage Metadata

AVIFS sequence storage 建议写成逻辑上通用的 `image-sequence`，避免 DSL 和 resolver 绑定具体容器：

```json
{
  "storage": {
    "mika_initial_stickers": {
      "kind": "image-sequence",
      "container": "avifs",
      "codec": "av1",
      "encoder": {
        "name": "avifenc",
        "codec": "aom",
        "qcolor": 80,
        "qalpha": 80,
        "yuv": "420",
        "keyframe_interval": 30
      },
      "path": "blobs/stickers/mika/initial.avifs",
      "frame_count": 38,
      "fps": 1,
      "size": [611, 611],
      "alpha": false,
      "sha256": "..."
    }
  }
}
```

variant 继续只关心 frame index：

```json
{
  "id": "initial_001",
  "ordinal": 1,
  "frame": 0
}
```

## Deferred Browser Decoder Research

项目已评估以 `libavif + dav1d`、Emscripten、WASM SIMD 和 Web Worker 建立窄 AVIFS frame decoder，并用 storage hash、frame、decoder build id、输出格式和尺寸组成 cache key。该路线暂不属于当前 parser/pack-v3 实施或验收范围，但不在本文中宣告废弃。

其中仍适用于 native materializer 的平台无关结论已经进入正式设计：

- decoder 不进入 DSL 或 manifest 的逻辑资源语义
- decoder profile 必须参与内容寻址 cache identity
- materialized output 必须是 Typst 可读取的受控静态图片
- 第一版选择 PNG；WebP 仅作为后续优化

## Remaining Compression Question

### q80 yuv420 是否作为长期默认

`q80 yuv420` 当前更稳，但体积约为 `q45 yuv444` 的两倍。后续可以按资源类型分 profile，例如浅色 JPG 图集使用 q80，透明 PNG 差分组使用更激进的 profile。manifest 必须记录实际 profile，因此该调优不改变 DSL 或 resolver 语义。
