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
- THEN resolver 只能在该 slot 存在明确 `default_set` 时解析
- AND 若没有明确 `default_set`，resolver MUST report ambiguous

### Requirement: video-frame storage blob 在 Typst 渲染前解码

pack-v3 MAY 使用 WebM video-frame blob 存储静态图片序列，但 Typst 渲染 SHALL 消费 materialized static images。

#### Scenario: sticker variant 指向 WebM 帧

- GIVEN sticker variant 的 `source.storage` 指向 `video-frames` storage entry
- AND 该 variant 具有明确的 `source.frame`
- WHEN 渲染流水线准备 Typst 输入
- THEN 它把该帧解码到受控 cache 位置
- AND 把 materialized static image path 交给 Typst

#### Scenario: sticker set 可以声明默认 WebM storage

- GIVEN sticker set 声明了 `storage` 为某个 `video-frames` storage entry
- AND set 内 variant 只声明 `source.frame`
- WHEN materializer 准备该 variant
- THEN variant 继承所属 set 的 storage
- AND `source.frame` 指向该 WebM blob 内的 0-based frame index

#### Scenario: WebM storage 声明解码相关元数据

- GIVEN pack-v3 storage entry 的 kind 是 `video-frames`
- WHEN materializer 准备解码它
- THEN storage metadata 包含 codec、container、frame count、hash、alpha mode 与 random access capability
- AND 缺失或不一致的元数据会在渲染前导致 validation failure

#### Scenario: 解码帧 cache 使用内容寻址

- GIVEN 同一个 WebM blob frame 被多个文档使用
- WHEN renderer materializes 该帧
- THEN cache key 至少包含 storage hash、frame index、decoder profile、output format 与 output size
- AND source blob 或 decoder profile 变化后不会复用旧 cache

### Requirement: pack-v3 资源访问保持沙箱约束

pack-v3 SHALL 在资源存储为压缩 blob 时仍保留现有 asset safety model。

#### Scenario: storage path 使用 pack-relative 解析

- GIVEN storage entry 引用某个文件路径
- WHEN loader 解析该路径
- THEN 该路径相对 pack root 解释
- AND 绝对路径或父目录穿越会被拒绝

#### Scenario: materialized output 保持在 renderer cache root 下

- GIVEN WebM frame 被解码用于渲染
- WHEN materializer 写出解码图片
- THEN 输出路径位于配置的 MMT cache 或 sandbox 目录内
- AND 用户编写的 DSL 文本不能直接选择输出路径
