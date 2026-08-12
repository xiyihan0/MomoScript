## 1. 交付与 catalog 合同

- [ ] 1.1 定义 `packs.json` catalog schema（`mmt-pack-catalog-v1`），包含 namespace/name/type/requires/eula/manifest_url/version/manifest_digest/published_at
- [ ] 1.2 固定缓存矩阵：catalog 与活跃 manifest `must-revalidate`，releases/blobs/assets 摘要对象 `immutable`
- [ ] 1.3 固定发布顺序（资产 → 归档 → 覆盖 manifest → 更新 catalog）与回滚流程
- [ ] 1.4 写 `specs/pack-delivery/spec.md` spec delta 并通过 `openspec validate --strict`

## 2. Builder 内容寻址命名

- [ ] 2.1 `build_kivo_pack_v3.py` 产出 blob 与 image-dir 资产时以内容 SHA-256 命名文件，并在 manifest storage 元数据中记录映射
- [ ] 2.2 验证 builder 产物仍通过 `PackRegistry` validation 与 Typst 0.15 smoke（avatar + sticker 到 PDF）
- [ ] 2.3 builder 报告记录旧语义名 → 摘要名映射，供审计

## 3. 发布工具

- [ ] 3.1 `tools/cdn/publish_pack.mjs` dry-run 模式：digest 计算、上传/复用/覆盖计划生成、publication manifest（`mmt-pack-publication.v1`）
- [ ] 3.2 ossutil 上传：`stat` 判存在、`cp --force --meta` 写 Cache-Control、已存在对象 digest 比对后复用或失败
- [ ] 3.3 归档 manifest 到 `/<ns>/releases/<digest>/manifest.json`（immutable）
- [ ] 3.4 活跃 manifest 原子覆盖与 catalog 更新（最后一步）
- [ ] 3.5 发布后公开校验：fetch `packs.json` 与活跃 manifest，验证 CORS、Cache-Control、可解析与 digest 一致
- [ ] 3.6 幂等：对同一 pack 目录重跑 publish 时全部对象 outcome 为 reused/verified，无重复上传

## 4. 首次发布与收尾

- [ ] 4.1 repo 落地 `typst_sandbox/pack-v3/catalog.json`（ba_kivo 条目）
- [ ] 4.2 用当前 ba_kivo 构建产物 dry-run 通过后真实发布一版
- [ ] 4.3 确认 pack 目录内 `_headers` 文件当前宿主（OSS 不读取），决定保留或删除
- [ ] 4.4 更新 `openspec/project.md` 与相关 README 的发布入口说明

## 5. 客户端 catalog 消费（后续，多包场景前实现）

- [ ] 5.1 workbench 启动抓 `packs.json` 作为默认 pack 源（复用 15s 超时 / 3 次重试 / IndexedDB 回退管线）
- [ ] 5.2 catalog 抓取失败时回退内置默认 `[PACK_URL]`，行为等同现状
- [ ] 5.3 资源包设置页列出 catalog packs 与 EULA 状态
