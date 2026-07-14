## ADDED Requirements

### Requirement: pack-v3 manifest 分离逻辑资源与物理存储

pack-v3 SHALL 使用 manifest 元数据作为实体、贡献、slot、set、variant 与 storage 引用的权威索引。

#### Scenario: 资源路径通过 manifest 条目解析

- GIVEN DSL 资源路径引用 `ba::梦/ba_extpack::sticker/#1`
- WHEN resolver 加载 pack-v3 元数据
- THEN `ba::梦` 被解析为目标实体
- AND `ba_extpack` 被解析为 contribution namespace
- AND `sticker/#1` 通过该 slot 的默认 set 与 manifest variant 元数据解析，而不是通过文件系统顺序解析

#### Scenario: 资源路径可以显式指定 set

- GIVEN DSL 资源路径引用 `ba::未花/sticker/战损/#1`
- WHEN resolver 加载 pack-v3 元数据
- THEN `战损` 被解析为 `sticker` slot 下的某个 set
- AND `#1` 在该 set 的 variant 顺序内解析
- AND 该 ordinal 不会跨 set 查找

#### Scenario: 扩展资源包贡献资源但不隐式覆盖

- GIVEN 扩展资源包为 `ba::梦` 贡献 sticker sets 或 variants
- WHEN base pack 已经为该实体定义默认资源
- THEN 扩展资源包追加 contribution-scoped sets 或 variants
- AND 除非显式 override 层写明，否则 MUST NOT 静默替换 base defaults

#### Scenario: 编号 selector 使用声明顺序

- GIVEN variant 使用 `#n` ordinal selection
- WHEN resolver 将 ordinal 映射为资源
- THEN ordinal MUST 来自所属 set 内 manifest 声明的 `ordinal` 字段或等价的显式 manifest 顺序
- AND resolver MUST NOT 从目录遍历结果推断顺序

#### Scenario: 多 set 下裸编号需要默认 set

- GIVEN 某个 subject 的 `sticker` slot 下存在多个 set
- WHEN 作者写出 `[:未花, #1:]` 或 `ba::未花/sticker/#1`
- THEN resolver 只能在该 slot 存在明确 `default` set 时解析
- AND 若没有明确 `default`，resolver MUST report ambiguous

### Requirement: compressed sequence storage 在 Typst 渲染前解码

pack-v3 MAY 使用 AVIFS image sequence 或其他 compressed sequence blob 存储静态图片序列，但 Typst 渲染 SHALL 消费 materialized static images。

#### Scenario: sticker variant 指向 AVIFS 帧

- GIVEN sticker variant 的 `source.storage` 指向 `image-sequence` storage entry
- AND 该 variant 具有明确的 `frame`
- WHEN 渲染流水线准备 Typst 输入
- THEN 它把该帧解码到受控 cache 位置
- AND 把 materialized static image path 交给 Typst

#### Scenario: Native AVIFS decoding uses libavif with dav1d

- GIVEN native materializer 收到 AVIFS `image-sequence` storage 和 0-based frame
- WHEN 它解码该帧到 PNG cache
- THEN `libavif` MUST parse the container, select the frame, and preserve color/alpha association
- AND `dav1d` SHOULD be the preferred AV1 payload decoder when available
- AND materializer MUST NOT pass the complete AVIFS container directly to dav1d as a raw AV1 stream

#### Scenario: sticker set 可以声明默认 sequence storage

- GIVEN sticker set 声明了 `storage` 为某个 `image-sequence` storage entry
- AND set 内 variant 只声明 `frame`
- WHEN materializer 准备该 variant
- THEN variant 继承所属 set 的 storage
- AND `frame` 指向该 sequence blob 内的 0-based frame index

#### Scenario: sequence storage 声明解码相关元数据

- GIVEN pack-v3 storage entry 的 kind 是 `image-sequence`
- WHEN materializer 准备解码它
- THEN storage metadata 包含 codec、container、frame count、sha256、alpha mode、quality profile 与 random access capability
- AND 缺失或不一致的元数据会在渲染前导致 validation failure

#### Scenario: 解码帧 cache 使用内容寻址

- GIVEN 同一个 sequence blob frame 被多个文档使用
- WHEN renderer materializes 该帧
- THEN cache key 至少包含 storage sha256、frame index、decoder profile、output format 与 output size
- AND source blob 或 decoder profile 变化后不会复用旧 cache

### Requirement: pack-v3 资源访问保持沙箱约束

pack-v3 SHALL 在资源存储为压缩 blob 时仍保留现有 asset safety model。

#### Scenario: storage path 使用 pack-relative 解析

- GIVEN storage entry 引用某个文件路径
- WHEN loader 解析该路径
- THEN 该路径相对 pack root 解释
- AND 绝对路径或父目录穿越会被拒绝

#### Scenario: materialized output 保持在 renderer cache root 下

- GIVEN sequence frame 被解码用于渲染
- WHEN materializer 写出解码图片
- THEN 输出路径位于配置的 MMT cache 或 sandbox 目录内
- AND 用户编写的 DSL 文本不能直接选择输出路径

### Requirement: Kivo Wiki 构建器生成可审计的基础资源包

pack-v3 基础资源包构建器 SHALL 能从 Kivo Wiki 数据源重建主资源包，并产出构建报告。

#### Scenario: Kivo student 生成独立 entity

- GIVEN Kivo Wiki 返回某个 student detail
- WHEN 构建器生成 pack-v3 manifest
- THEN 该 student 默认映射为一个独立 entity id
- AND 不同 skin 的 student 记录通过 `meta.related_entities` 关联，而不是隐式合并

#### Scenario: entity id 和 deterministic names 使用不同命名规则

- GIVEN Kivo Wiki student detail 提供国服翻译
- WHEN 构建器生成 entity core
- THEN entity id 使用中文 canonical 名称
- AND entity `names` MUST be non-empty
- AND `names[0]` SHALL be the default script actor name supplied by the preset
- AND 默认皮肤使用中文角色名
- AND 非默认皮肤使用 `中文角色名_中文皮肤名`
- AND 国服翻译缺失时回退到国际服/英文名

#### Scenario: 联动角色使用全名作为默认 name

- GIVEN Kivo Wiki student detail 对应 Blue Archive 联动角色
- WHEN 构建器生成 entity names
- THEN `初音未来`、`御坂美琴`、`食蜂操祈`、`佐天泪子` 这四类联动角色使用全名作为 `names[0]`
- AND 构建器不使用 `未来`、`美琴`、`操祈`、`泪子` 作为默认 name

#### Scenario: Search aliases stay outside the main manifest

- GIVEN Kivo Wiki 提供昵称、多语言名称或其他检索词
- WHEN 构建器生成第一版主 manifest
- THEN those search aliases MUST NOT be emitted as deterministic entity names by default
- AND SHOULD be preserved in raw source data or a future catalog/search index

#### Scenario: Duplicate deterministic names are reported

- GIVEN two generated entities contain the same deterministic name
- WHEN 构建器写出 build report
- THEN it MUST list the conflicting name and all owning entity ids
- AND MUST NOT silently select one entity as the winner

#### Scenario: 主 manifest 暂不输出 entity meta

- GIVEN 构建器生成第一版默认资源包 manifest
- WHEN 写出 entity object
- THEN entity object 不包含 `meta`
- AND 多语言名称、学校/社团与差分皮肤关系留给后续 catalog 或索引文件

#### Scenario: gallery 差分组生成 sticker set

- GIVEN Kivo student detail 中的 `gallery` 包含 `初始立绘差分` 或 `战损差分`
- WHEN 构建器识别这些图集为 sticker set
- THEN 每个图集组生成一个 `sticker.set`
- AND `gallery.images[]` 的顺序固化为 set 内 variant ordinal

#### Scenario: 初始立绘差分使用 default set id

- GIVEN Kivo gallery title 是 `初始立绘差分`
- WHEN 构建器生成 sticker set
- THEN set id 是 `default`
- AND set handles 包含原始标题 `初始立绘差分`
- AND set handles 包含 `default`
- AND 构建器不自动生成去掉 `差分` 后缀的 handle

#### Scenario: 构建报告记录压缩结果

- GIVEN 构建器完成素材下载与 AVIFS 编码
- WHEN 写出构建报告
- THEN 报告包含 source API version、成功 set 数、跳过 set 数、原始体积、压缩体积、编码 profile、sha256 与失败原因列表

### Requirement: Language core uses a narrow platform materializer contract

Rust language core SHALL pass fully resolved logical resources to a platform materializer and consume only controlled Typst-readable outputs.

#### Scenario: Core delegates storage I/O

- GIVEN resolver 已产出包含 pack namespace、storage id、path 或 frame 的 `ResolvedResource`
- WHEN compilation 进入 materialize 阶段
- THEN core SHALL call `ResourceMaterializer` with that resolved value
- AND core MUST NOT itself open arbitrary workspace paths、perform network fetches or invoke a decoder
- AND successful output SHALL be a controlled Typst-readable static image path

#### Scenario: Materializer failure preserves resource origin

- GIVEN platform materializer 无法读取 blob、解码 frame 或写入 cache
- WHEN 它返回 materialize error
- THEN compilation SHALL report `Materialize` phase
- AND diagnostic SHALL point to the original marker or actor revision resource origin

#### Scenario: Decoder profile participates in cache identity

- GIVEN image-sequence frame 的 decoder build、输出格式或输出尺寸发生变化
- WHEN platform materializer 计算 cache key
- THEN cache identity MUST include storage sha256、frame index、decoder profile、output format 与 output size
- AND 不会复用不兼容的旧输出

#### Scenario: Browser planning reuses the logical resource contract

- GIVEN Web language service 已安装经过 `PackRegistry` validation 的 manifest
- WHEN 它为 `image-dir` 或 `image-sequence` 资源构建 render project
- THEN core MUST resolve and validate logical resource/storage metadata without network、filesystem or decoder I/O
- AND the request MUST preserve pack namespace、storage identity、authored origin and cache identity inputs
- AND Web host MUST perform fetch/decode as a revision-bound platform materialization step
- AND browser runtime failures MUST NOT be reclassified as parser or resolver failures

#### Scenario: Browser sequence materialization preserves cache identity

- GIVEN a render request identifies an AVIFS frame
- WHEN Web host downloads and decodes that frame
- THEN it MUST validate storage sha256、frame bounds、codec/profile and declared output size
- AND its cache identity MUST include storage sha256、frame、decoder profile、output format and output size
- AND a result for an obsolete document revision MUST NOT replace the current preview
