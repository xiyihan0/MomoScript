## Overview

把资源包从"手工覆盖语义路径"升级为"内容寻址资产 + 稳定 manifest 指针 + catalog 登记"的发布体系。核心思路完全复用 tinymist 运行时已生产验证的交付模式：内容摘要作为 URL 身份、immutable 缓存、发布后公开校验、ossutil 元数据管理。

关键分层：

- **资产层**：文件名 = 内容 SHA-256，永不覆盖。blob 与 image-dir 资产统一处理。
- **指针层**：`/<namespace>/manifest.json` 稳定 URL，原子 PUT 覆盖，`must-revalidate`。
- **归档层**：`/<namespace>/releases/<manifest-digest>/manifest.json`，历史版本 + 回滚源。
- **登记层**：桶根 `/packs.json`，列出所有 pack 及当前 digest。

## OSS 布局

```text
mms-pack.xiyihan.cn/
├── packs.json                          # catalog，max-age=0, must-revalidate
├── wasm/tinymist/…                     # 现有运行时资产（不动）
├── ba_kivo/
│   ├── manifest.json                   # 活跃指针，max-age=0, must-revalidate
│   ├── releases/<digest>/manifest.json # 归档，immutable
│   ├── blobs/stickers/<entity>/<sha256>.avifs   # 内容寻址，immutable
│   └── assets/avatar/<sha256>.png              # 内容寻址，immutable
└── <第二个 namespace>/…                 # 同构
```

## Design Goals

### 1. 内容寻址是唯一缓存身份

`builder` 计算每个资产字节的 SHA-256（builder 已经为 storage entry 计算 sha256 并写入 manifest），产出文件名即摘要：

- `blobs/stickers/<entity>/<sha256>.avifs`
- `assets/avatar/<sha256>.png`（及 thumbnails 等同理）

manifest 的 storage 元数据指向摘要文件名。同一字节永不出现两个 URL，同一 URL 永远返回同一字节——`immutable` 缓存头因此成立，跨版本升级未变资产零重下。

### 2. manifest 是活跃指针，归档是回滚

- 升级：publisher 先上传新资产与归档 manifest，最后原子覆盖活跃 manifest。
- 回滚：把归档 `releases/<old-digest>/manifest.json` PUT 回活跃位，并把 catalog 的 `manifest_digest` 字段翻回。
- 一致性：活跃 manifest 引用的摘要资产在覆盖前必定已上传，任何时刻客户端拿到的都是完整自洽的某个版本。

### 3. 发布顺序保证客户端永远自洽

1. 上传新增/变更的资产对象（不存在才传；已存在且 digest 一致则复用）。
2. 上传归档 manifest `releases/<digest>/manifest.json`。
3. 覆盖活跃 manifest `/<namespace>/manifest.json`。
4. 更新 catalog `/packs.json`。
5. 发布后公开校验（CORS、Cache-Control、可 fetch、digest 复核）。

任一步失败即中止；1–2 未完成时 3–4 不会执行，客户端最多停留在旧版本。

### 4. catalog 是登记层，不内嵌 manifest 内容

```json
{
  "schema": "mmt-pack-catalog-v1",
  "generated_at": "2026-08-13T00:00:00Z",
  "packs": [
    {
      "namespace": "ba",
      "name": "Kivo Wiki Blue Archive draft pack",
      "type": "base",
      "requires": [],
      "eula": { "required": false },
      "manifest_url": "https://mms-pack.xiyihan.cn/ba_kivo/manifest.json",
      "version": "2026.07.22",
      "manifest_digest": "sha256:…",
      "published_at": "2026-08-13T00:00:00Z"
    }
  ]
}
```

- catalog 小、稳定、低频变，`max-age=0, must-revalidate` + ETag 与现状一致。
- `type` / `requires` / `eula` 从 pack-v3 manifest 复制，供 UI 依赖展示与协议前置提示。
- 条目顺序确定性：按 `namespace` 升序。`generated_at` 由 publisher 写入。

### 5. catalog 源文件在 repo，OSS 上是产物

`typst_sandbox/pack-v3/catalog.json` 是单一事实源（纯 JSON，与发布产物同构，避免 JSON5→JSON 转换层；注释需求由 design/README 承担）。publisher 读取 pack 目录的 manifest.json 与构建报告，计算 digest 后合并/更新该文件，再上传生成的 `packs.json`。OSS 控制台手改与 repo 源并存必然漂移，因此发布后校验会对 catalog 内容做一次 digest 复核。

## 缓存矩阵（由 ossutil `--meta` 管理）

| 对象 | Cache-Control |
|---|---|
| `/packs.json` | `public, max-age=0, must-revalidate` |
| `/<ns>/manifest.json` | `public, max-age=0, must-revalidate` |
| `/<ns>/releases/**` | `public, max-age=31536000, immutable` |
| `/<ns>/blobs/**`、`/<ns>/assets/**`（摘要文件名） | `public, max-age=31536000, immutable` |

说明：

- 现有 `/assets/*` 的 `86400 + SWR 7d` 在摘要命名后可安全升为 immutable；迁移时以 publisher 写入的 `--meta` 为准。
- 现有 pack 目录里的 `_headers` 文件是 Pages/Netlify 约定，OSS 不读取。任务 4.3 确认其当前宿主后决定保留或删除，缓存头权威统一到 publisher。

## 发布工具合同（`tools/cdn/publish_pack.mjs`）

对齐 `publish_tinymist_runtime.mjs`：

- 默认 `--dry-run`：计算 digest、生成发布计划（上传/复用/覆盖清单），不写任何远端。
- `--publish` 要求 `--ossutil-config`、`--bucket`、`--origin`；用 `ossutil stat` 判存在（404 → `NoSuchKey` 视为缺失），`ossutil cp --force --meta "…"` 上传。
- 已存在对象：下载比对 SHA-256，不一致即失败（永不覆盖）。
- 发布后校验：fetch `packs.json` 与活跃 manifest，验证 CORS、Cache-Control、可解析、digest 与本地一致。
- 输出 publication manifest（`mmt-pack-publication.v1`），含每个对象 outcome（published/reused/verified）。

## 客户端消费（Phase 5，本 change 不实现）

多包场景前接入：workbench 启动抓 `packs.json`（复用已加固的 15s 超时 / 3 次重试 / IndexedDB 回退管线），得到 manifestUrl 列表走现有 `synchronizePackSources`；catalog 抓取失败回退内置默认 `[PACK_URL]`。资源包设置页后续可列出 catalog packs 与 EULA 状态。

## 失败模式

| 失败 | 行为 |
|---|---|
| 资产上传失败 | 中止；活跃 manifest 未动，客户端无感知 |
| 归档上传失败 | 中止；同上 |
| 活跃 manifest 覆盖失败 | 中止；catalog 仍指旧 digest，一致 |
| catalog 更新失败 | 上一版 catalog 仍有效（旧 digest 自洽）；publisher 报错，重跑幂等 |
| 客户端 catalog 抓取失败（Phase 5 后） | 回退内置默认 manifest 列表，行为等同现状 |
