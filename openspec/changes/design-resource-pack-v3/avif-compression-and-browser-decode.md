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
3. 建立实体：每个 Kivo student id 默认生成一个独立 pack-v3 entity；同一人物的不同 skin 通过 Entity Catalog `related_entities` 关联，不合并为同一个 entity id。
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
- 主 `manifest.json` 不输出 `meta`；多语言名称、学校/社团、差分皮肤关系进入 `entity-catalog.json`。
- Kivo `nick_name` 保留在 Entity Catalog，不自动提升为 deterministic entity names。
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
frame_order: nearest (RGBA48 L1 greedy)
keyframe_interval: auto (max(1, frame_count) per set)
qcolor: 80
qalpha: 80
yuv: 420
speed: 8
jobs: 4
```

构建器先按相似度重排物理输入，再以该组帧数作为 `avifenc -k` 参数。
manifest 保留逻辑编号，并记录逻辑差分到物理帧的逆映射。

已知 tradeoff：

- `q80 yuv420` 在 Arona 样本中比 `q45 yuv420` 画质更稳，但体积约从 `86K` 增至 `185K`。
- 全量 Kivo sticker 成功项约从 `4.46G` 压到 `53.5M`，压缩比约 `1.20%`。
- `yuv444 q45` 体积更小，约 `28M`，但 PotPlayer 等视频播放器显示链路可能产生误判；浏览器/WASM 解码应以 `avifdec` / libavif 输出为准。
- `svt-av1` 编码速度更快，但当前对 alpha 或非典型序列支持不稳定，第一版不作为默认编码器。

编码器 SHOULD 按 sticker set 逐组处理：

- 同一 set 内逻辑差分使用来源显式顺序写入 manifest `ordinal`，物理编码顺序默认按相似度重排。
- PNG/JPG/JPEG 且尺寸一致时可直接编码。
- 带 alpha 且尺寸有轻微差异时可先居中 padding 到统一 canvas，再编码，并在 storage metadata 中记录 `canvas_size`。
- 尺寸差异过大、混合模式异常、或无法稳定解码的 set 应跳过并写入构建报告。
- 编码结果必须可用 `avifdec --info` 与首帧解码验证。

`keyframe_interval` 表示相邻独立关键帧的最大间隔。默认选择每组帧数，使相似差分尽量复用帧间预测；
需要限制后段冷抽帧延迟时，可以显式使用 `--avif-keyframe 30`。

### 默认构建：相似差分重排与长 GOP

从 Kivo 刷新并编码时，使用独立目录保留旧包：

```bash
uv run python tools/build_kivo_pack_v3.py \
  --out-dir typst_sandbox/pack-v3/ba_kivo-2026.10.20 \
  --base-url https://mms-pack.esa.xiyihan.cn/ba_kivo/ \
  --pack-version 2026.10.20 --save-raw --encode-avifs
```

该命令只生成本地产物，不发布。默认使用 `--avif-frame-order nearest --avif-keyframe auto`；
可显式组合 source/nearest 与数值 GOP/auto，在同一批源图上分离两种优化的收益。

`nearest` 使用 NumPy 向量化计算距离，根工作区的默认开发依赖提供 NumPy；
`uv sync` 或上述 `uv run` 会按锁文件安装。显式 source 路径不使用 NumPy。
构建支持 ImageMagick 7 的 `magick`，或 ImageMagick 6 的 `identify`/`convert`。

`nearest` 在统一 canvas 后将各图缩为 48×48 RGBA，以 L1 距离贪心选择下一帧。
首个逻辑差分固定在物理第 0 帧；同距离时选择原始索引较小者。编码输入按这条路径排列，
manifest 中只改 `frame` 为逆置换，`id`、`ordinal`、handles、默认差分及缩略图对应关系不变。
构建报告记录物理帧对应的逻辑索引；该顺序不是 DSL 或角色图鉴的显示顺序。

`auto` 对每个 set 使用 `max(1, 帧数)` 的关键帧间隔，并将实际整数写入 storage profile。
它允许更多帧间预测，但不保证编码器只产生一个关键帧，也不保证额外解码成本为零。
验收应比较相同源图和画质参数下的体积，并实测 native 与浏览器对首、中、末帧的冷抽帧耗时。

### 2026-10-20 同源试编码结果

使用本地 `2026.08.16` Kivo 源图，固定 libavif 1.0.4 / AOM 3.8.2、q80/a80、
yuv420、speed8、jobs4；每组分别编码 source/nearest × GOP30/auto。
样本为睦月_礼服/face（13 帧）、梓/default（10）、日奈_泳装/default（12）、
未花/default（31）、星野_一年级/default_face（48）及当时包内最大组凛/default（90）。
这些帧数与外部报告不同，不能把其百分比当作本包的测量结果。

|编码方案|六组 AVIFS 合计（bytes）|相对 source/GOP30 减少|
|---|---:|---:|
|source / GOP30|1,053,299|0%|
|nearest / GOP30|888,066|15.69%|
|source / auto|890,962|15.41%|
|nearest / auto|742,598|29.50%|

凛组由 453,134 bytes 降至 209,886 bytes（53.68%）。重排后按逆映射抽取的
35 个逻辑位置已逐一对照源图和基线；检查包含混合尺寸 padding、透明背景及实际浏览器 Worker 输出。

长 GOP 的运行时代价可见：凛的最后一个逻辑差分，native 冷进程抽帧三次中位数由
172.7 ms 增至 285.8 ms；生产浏览器 Worker 由 121.9 ms 增至 160.0 ms。
native 含进程启动及 PNG 输出，浏览器含 Worker 启动、digest 校验及 PNG 转换，不含网络下载。
测量期间有独立 Kivo 构建任务，耗时仅作为该环境下的取舍证据。
默认采用 nearest/auto：本资源包优先选择体积收益，并接受上述冷抽帧耗时增加。
需要更低后段延迟时仍可显式使用 `--avif-keyframe 30`。

同日从 Kivo 全量刷新到本地 `typst_sandbox/pack-v3/ba_kivo-2026.10.20/`：
354 个实体、478 个成功编码 set、9,065 个逻辑差分，AVIFS 总计 64,777,234 bytes；
Catalog 含 30 所学校、157 个 relation。抓取、下载及编码错误均为零，
另有 17 个 set 按原有大画布规则跳过，详情保留在 `encode_report.jsonl`。
旧 `ba_kivo/` 目录不被替换。新包已通过仓库发布器上传并激活，公开入口为
`https://mms-pack.esa.xiyihan.cn/ba_kivo/manifest.json`；
manifest SHA-256 为 `2393eb59c84fa44cd69d37ce814f27da43ec512b33e0522d034bd224882d0d06`。
发布器已验证公开 CORS、缓存策略及 manifest/Catalog digest。
已有旧包缓存的 Workbench 刷新后成功加载新角色兰娜，并解码展示其全部 43 个差分；
默认 URL 无需更改，前端无需重新部署。

上游名称变化为 `和美 → 和`、`翠子 → 水子`、`阳子 → 耀子`，使用新包时对应脚本需要迁移。
新实体 `透` 的上游头像与 gallery 均为空，保留实体资料但不生成虚假的头像引用。
全包映射、源图及 blob digest、头像/缩略图引用和 Catalog 绑定已核验；
全部 478 个 AVIFS 的实际尺寸与帧数通过对账，浏览器另抽验新包三组首、中、末逻辑差分。




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
