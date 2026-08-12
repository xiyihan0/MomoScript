## ADDED Requirements

### Requirement: 资产对象内容寻址且永不覆盖

资源包交付中的 blob 与 image-dir 资产 SHALL 以内容 SHA-256 命名，同一 URL 永远返回同一字节，发布过程 MUST NOT 覆盖已存在的摘要对象。

#### Scenario: 摘要命名使 immutable 缓存安全

- GIVEN 一个 pack 重建后某资产字节发生变化
- WHEN builder 产出该资产文件
- THEN 文件名包含该资产字节的 SHA-256
- AND 旧摘要 URL 仍返回旧字节，新摘要 URL 返回新字节
- AND manifest 的 storage 元数据指向新摘要文件名

#### Scenario: 发布时禁止覆盖已存在对象

- GIVEN 目标桶中已存在与待上传对象同名的对象
- WHEN publisher 执行发布
- THEN publisher 下载该对象并比对 SHA-256
- AND digest 一致时复用该对象（outcome 为 reused）
- AND digest 不一致时发布失败，不覆盖远端字节

### Requirement: 活跃 manifest 是稳定指针，归档提供回滚

每个 pack SHALL 有稳定 URL `/<namespace>/manifest.json` 作为活跃指针，通过原子 PUT 更新；每个发布版本的 manifest SHALL 归档到 `/<namespace>/releases/<manifest-digest>/manifest.json`。

#### Scenario: 升级顺序保证客户端自洽

- GIVEN 新版本包含新增或变更的摘要资产
- WHEN publisher 按顺序执行发布
- THEN 全部新资产先于活跃 manifest 覆盖上传
- AND 归档 manifest 在活跃 manifest 覆盖前写入
- AND 任一步失败时活跃 manifest 与 catalog 保持旧版本引用

#### Scenario: 回滚恢复到旧版本

- GIVEN 当前活跃 manifest digest 为 D2，归档中存在 digest 为 D1 的历史 manifest
- WHEN 操作者执行回滚
- THEN 归档的 D1 manifest 被 PUT 回 `/<namespace>/manifest.json`
- AND catalog 中该 pack 的 `manifest_digest` 字段翻回 D1
- AND 旧 manifest 引用的摘要资产仍在桶中可用（永不删除）

### Requirement: 桶根 catalog 登记所有 pack

OSS 桶根 SHALL 提供 `packs.json`（schema `mmt-pack-catalog-v1`），列出每个已发布 pack 的 namespace、name、type、requires、eula、manifest_url、version、manifest_digest 与 published_at。

#### Scenario: catalog 条目派生自 pack manifest

- GIVEN 一个 pack 的 manifest 定义了 namespace、name、type、requires 与 eula
- WHEN publisher 更新 catalog
- THEN 对应条目复制这些字段并附带 manifest_url 与当前 manifest_digest
- AND 条目按 namespace 升序排列
- AND generated_at 由 publisher 写入

#### Scenario: catalog 缓存策略允许即时更新

- GIVEN 客户端通过 CDN 抓取 `packs.json`
- WHEN 发布新 catalog
- THEN 该对象的 Cache-Control 为 `public, max-age=0, must-revalidate`
- AND 客户端 ETag 校验在下次抓取时获得新内容

### Requirement: 发布后公开校验

publisher SHALL 在发布完成后通过公开 URL 校验交付结果：CORS 头、Cache-Control、响应可解析性与内容 digest 与本地发布物一致。

#### Scenario: 校验失败阻断发布成功状态

- GIVEN 发布步骤全部执行完成
- WHEN 公开校验发现 catalog 或活跃 manifest 的 digest 与本地不一致
- THEN publisher 以失败退出并报告差异对象
- AND 不产生"发布成功"的 publication manifest
