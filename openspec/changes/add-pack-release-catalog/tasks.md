## 1. 交付与 catalog 合同

- [x] 1.1 定义 `packs.json` catalog schema（`mmt-pack-catalog-v1`），包含 namespace/name/type/requires/eula/manifest_url/version/manifest_digest/published_at 与 releases 历史数组
- [x] 1.2 固定缓存矩阵：catalog 与活跃 manifest `must-revalidate`，releases/blobs/assets 摘要对象 `immutable`
- [x] 1.3 固定发布顺序（资产 → 归档 → 覆盖 manifest → 更新 catalog）与回滚流程
- [x] 1.4 定义 `pack.base_url` 位置无关合同：builder MUST 写入，解析器向后兼容（显式值优先，URL 派生回退）
- [x] 1.5 写 `specs/pack-delivery/spec.md` spec delta 并通过 `openspec validate --strict`

## 2. Builder 内容寻址命名与 base_url

- [x] 2.1 `build_kivo_pack_v3.py` 产出 blob 与 image-dir 资产时以内容 SHA-256 命名文件，并在 manifest storage 元数据中记录映射
- [x] 2.2 builder 写入 `pack.base_url`（`--base-url` 参数注入，默认生产 URL）
- [x] 2.3 验证 builder 产物仍通过 `PackRegistry` validation 与 Typst 0.15 smoke（avatar + sticker 到 PDF）
- [x] 2.4 builder 报告记录旧语义名 → 摘要名映射，供审计

## 3. 客户端基址解析

- [x] 3.1 `packSync.ts` baseUrl 计算优先 manifest `pack.base_url`（校验 HTTPS 且以 `/` 结尾），回退 URL 派生
- [x] 3.2 扩展 `test:pack-sync` 覆盖：显式 base_url 优先、非法 base_url 拒绝、缺失字段回退派生

## 4. 发布工具

- [x] 4.1 `tools/cdn/publish_pack.mjs` dry-run 模式：digest 计算、上传/复用/覆盖计划生成、publication manifest（`mmt-pack-publication.v1`）
- [x] 4.2 ossutil 上传：`stat` 判存在、`cp --force --meta` 写 Cache-Control、已存在对象 digest 比对后复用或失败
- [x] 4.3 归档 `releases/<digest>/`（manifest.json + build_report.json，immutable）
- [x] 4.4 活跃 manifest 原子覆盖与 catalog 更新（追加 release 记录、翻 manifest_digest，最后一步）
- [x] 4.5 发布后公开校验：fetch `packs.json` 与活跃 manifest，验证 CORS、Cache-Control、可解析与 digest 一致
- [x] 4.6 幂等：对同一 pack 目录重跑 publish 时全部对象 outcome 为 reused/verified，无重复上传

## 5. 首次发布与收尾

- [x] 5.1 repo 落地 `typst_sandbox/pack-v3/catalog.json`（ba_kivo 条目 + releases）
- [x] 5.2 用当前 ba_kivo 构建产物 dry-run 通过后真实发布一版
- [ ] 5.3 确认 pack 目录内 `_headers` 文件当前宿主（OSS 不读取），决定保留或删除
- [ ] 5.4 更新 `openspec/project.md` 与相关 README 的发布入口说明

## 6. 客户端 catalog 消费（后续，多包场景前实现）

- [ ] 6.1 workbench 启动抓 `packs.json` 作为默认 pack 源（复用 15s 超时 / 3 次重试 / IndexedDB 回退管线）
- [ ] 6.2 catalog 抓取失败时回退内置默认 `[PACK_URL]`，行为等同现状
- [ ] 6.3 资源包设置页列出 catalog packs、EULA 状态与 releases 版本下拉
- [ ] 6.4 终态切换：catalog `manifest_url` 指向 `releases/<digest>/manifest.json`，退役活跃指针，发布全程零覆盖

说明：5.3 的 `_headers` 是 Pages/Netlify 约定文件，OSS/ESA 均不读取，删除与否不影响交付，留待 pack 目录收尾时决定。5.4 的 README 发布入口在首次发布稳定后补充。
