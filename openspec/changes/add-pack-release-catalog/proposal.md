## Why

`mms-pack.esa.xiyihan.cn`（阿里云 OSS + ESA）的桶根目录没有任何记录"存在哪些资源包"的文件。加第二个资源包没有登记处，客户端、发布工具和人都只能靠硬编码或口口相传知道有哪些包。

现有发布流程还存在三个问题：

- **无发布自动化**：`tools/build_kivo_pack_v3.py` 只产出本地目录，上传 OSS 靠手工；而 tinymist 运行时已有完整先例（`tools/cdn/publish_tinymist_runtime.mjs`，ossutil 2.3/V4 的 JSON stat、对象属性参数与发布后公开校验），资源包没有对应工具。
- **immutable 缓存与语义路径冲突**：`/blobs/*` 已标 `max-age=31536000, immutable`，但文件名是语义路径（`blobs/stickers/一花/default.avifs`），不含内容摘要。重建改写同路径字节时，老客户端的一年期缓存会与新 manifest 组合，下载后 SHA-256 校验失败，该资源渲染失败直到缓存过期。这是当前就存在的正确性隐患。
- **无回滚**：manifest 覆盖后旧版本无处可找；catalog 缺失使"翻回上一版"没有机器可读依据。

## What Changes

- 资产内容寻址：builder 以内容 SHA-256 命名资产文件（blob 与 image-dir 资产），manifest 记录映射；资产对象永不覆盖，`immutable` 缓存从此安全。
- manifest 增加 `pack.base_url` 字段（additive，绝对 HTTPS，以 `/` 结尾）：资产解析不再从 manifest URL 位置派生，manifest 成为位置无关的自描述文档。
- manifest 保持稳定 URL（`/<namespace>/manifest.json`），升级时原子覆盖（OSS PUT）；历史版本归档到 `/<namespace>/releases/<manifest-digest>/`（manifest.json + build_report.json），归档文件字节等同活跃版且自带 `base_url`，可直接被客户端作为版本锁定 URL 引用。
- OSS 根目录新增 `packs.json` catalog（schema `mmt-pack-catalog-v1`）：每包一条记录（namespace、name、type、requires、eula、manifest_url、version、manifest_digest、published_at）外加 `releases` 历史数组（digest、version、manifest_url、published_at），作为版本选择的数据源。`max-age=0, must-revalidate`。
- 新增 `tools/cdn/publish_pack.mjs`：dry-run 默认、发布编排（资产 → 归档 manifest → 覆盖活跃 manifest → 更新 catalog）、ossutil 上传、发布后公开校验，全部对齐 tinymist 发布脚本的既有模式。
- repo 内 catalog 源文件 `typst_sandbox/pack-v3/catalog.json` 作为单一事实源；OSS 上的 `packs.json` 是发布产物，不在控制台手改。

## 设计修正说明

落 OpenSpec 时修正为**不用 302**：阿里云 OSS 的对象级重定向（`x-oss-website-redirect-location`）只在静态网站托管模式下生效，CDN 回源走 API 模式不会得到重定向响应。改以 manifest 原地覆盖 + 归档实现同样的效果，客户端抓取语义零变化，且未变资产的摘要 URL 跨版本复用，升级不产生全量重下。

后续讨论又确认两点：归档 manifest 因位置派生基址而在归档位不自洽，以及版本选择需要客户端可锁定的 URL。解法是 `pack.base_url` 显式字段——manifest 自带基址后，归档文件在归档位置即可被直接引用（配置填 `releases/<digest>/manifest.json` 即锁定版本），服务端回滚仍是"归档拷回活跃位 + catalog 翻 digest"。

## Implementation Status

尚未实现。本 change 先固定交付与 catalog 合同（spec delta + schema），随后实现 builder 命名改动与发布工具；客户端 catalog 消费留到多包场景前再做（当前仅 ba_kivo 一个包，硬编码默认 + 兜底足够）。

## Impact

- Formal spec delta：`pack-delivery`（新）
- 相关设计：`design-resource-pack-v3`（manifest/storage sha256 元数据是命名来源）、`add-pwa-offline-runtime`（不可变资产直接对应 shell manifest 的 exact URL + SHA-256 precache）
- 主实现：`tools/cdn/publish_pack.mjs`、`tools/build_kivo_pack_v3.py`（摘要命名 + base_url 写入）、`typst_sandbox/pack-v3/catalog.json`
- 客户端 `editors/vscode/src/packSync.ts` 增加基址优先级（manifest `pack.base_url` > URL 派生，向后兼容）；catalog 驱动的默认 pack 源解析在 Phase 6 才接入 `editors/vscode-web/`，本 change 不改变现有 `synchronizePackSources` 与 `IndexedDbPackCache` 的抓取合同
