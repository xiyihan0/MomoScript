# MomoScript Web PWA 可行性与实施草案

> 状态：可行性调研与设计草案，不是已批准实施规格
>
> 正式实施合同已拆分到 `openspec/changes/add-pwa-offline-runtime/`；本文仅保留体积、平台与可行性研究输入。
>
> 调研日期：2026-07-15
> 适用范围：`editors/vscode-web/`、资源包分发与浏览器离线存储

## 1. 问题与结论

MomoScript Web 编辑器的主要运行时由 VS Code Workbench、MMT LSP WASM、Tinymist WASM、Typst compiler/renderer WASM、字体和资源包组成。运行时体积较大，但现代浏览器的 Service Worker、Cache Storage、IndexedDB 和 StorageManager 足以支撑可安装、可离线的 Web 应用。

**结论：PWA 在工程上可行，推荐实施；但不能把应用与完整资源包作为一个无条件 precache。推荐使用两级缓存：版本化应用壳/渲染运行时，以及由用户显式安装的资源包。**

首要支持目标：

1. Desktop Chrome/Edge；
2. Android Chromium；
3. macOS Safari；
4. iOS Home Screen（带驱逐恢复能力）；
5. Firefox 作为离线 Web 应用，不承诺 manifest 原生安装。

## 2. 当前体积基线

### 2.1 Web 应用

当前 `editors/vscode-web/dist` 实测：

| 分类 | 大小 |
|---|---:|
| 整个 dist | 约 160 MiB |
| Source maps | 约 45.8 MiB |
| 非 source-map runtime 文件 | 约 113.9 MiB |
| 估算压缩传输量 | 约 103.8 MiB |

主要运行时资源：

| 文件类别 | 原始大小 | 估算传输量 |
|---|---:|---:|
| Tinymist WASM | 30.85 MiB | 30.85 MiB |
| Typst compiler WASM | 27.06 MiB | 27.06 MiB |
| Noto Sans CJK Bold | 19.12 MiB | 19.12 MiB |
| Noto Sans CJK Regular | 18.58 MiB | 18.58 MiB |
| Workbench 主 JS | 9.09 MiB | 2.25 MiB |
| MMT LSP WASM | 1.63 MiB | 1.63 MiB |
| NewCMMath | 1.10 MiB | 1.10 MiB |
| Typst renderer WASM | 0.93 MiB | 0.93 MiB |
| Oniguruma WASM | 0.44 MiB | 0.44 MiB |

Source maps 属于部署/调试体积，不是正常浏览器离线 payload，禁止进入 precache。

### 2.2 资源包

当前本地 `ba_kivo` 目录约 257 MiB：

| 类型 | 大小 |
|---|---:|
| WebP | 81.8 MiB |
| PNG | 66.2 MiB |
| AVIFS | 51.1 MiB |
| JSON | 28.9 MiB |
| GIF | 7.45 MiB |

如果离线包仅包含 AVIFS、必要头像和 manifest，应用加资源包约为 150–200 MiB。如果把 legacy WebP/PNG/GIF 一并安装，持久 payload 会接近 350 MiB。

正式设计必须先定义可离线分发集合，不能用仓库目录总大小或单一估算替代实际请求清单。

### 2.3 更新峰值

应用壳或 pack 原子升级期间需要暂时并存新旧 revision。空间预检应按以下上界：

```text
current active bytes
+ complete staging bytes
+ workspace/cache safety margin
```

第一版按约 2 倍目标 payload 预留，不能在下载完成前删除当前可用版本。

## 3. 当前缓存边界

当前实现已有：

- IndexedDB workspace filesystem；
- `IndexedDbPackCache`：持久化 active/staging manifest JSON 与 ETag；
- `BoundedStringCache`：32 MiB 页面内 Base64 string LRU；
- pack manifest revision 的 stage/promote/discard；
- `mms-pack.xiyihan.cn` 的 CORS 与 immutable blob headers。

当前实现没有：

- 根 PWA Service Worker；
- 应用壳离线缓存；
- 持久化 pack asset cache；
- pack 安装进度与恢复；
- asset revision staging/promote/rollback；
- quota 预检和 storage persistence UI；
- 离线资源缺失诊断。

状态权威必须保持以下分层：

| 状态 | 权威来源 |
|---|---|
| Manifest URL 选择 | VS Code configuration service |
| Manifest JSON/ETag 持久副本 | IndexedDB cache |
| 已接受 Pack 语义/revision | MMT LSP monotonic `pack_revision` / `PackRegistry` |
| 离线 asset 安装状态 | 待新增的 pack installation registry |
| 实际 asset bytes | Cache Storage 或 OPFS |

## 4. 两级缓存设计

### 4.1 Tier 1：应用壳与渲染运行时

目标：完全断网后打开编辑器、恢复 workspace、运行 MMT LSP/Tinymist/Typst 并渲染不依赖未安装 pack 的文档。

应纳入版本化 shell revision：

- `index.html`；
- 带 content hash 的 JS/CSS/Worker；
- MMT LSP WASM；
- Tinymist WASM；
- Typst compiler/renderer WASM；
- Oniguruma WASM；
- 启动和渲染必需字体；
- Web Extension 静态资源；
- 明确需要离线的 Webview iframe bootstrap 资源。

不得纳入：

- `.map`；
- 测试 artifact；
- 完整资源包；
- 未被启动路径请求的重复/legacy asset；
- 用户 workspace 内容。

### 4.2 Tier 2：显式资源包安装

资源包不进入应用 precache。用户通过 Pack Manager 显式选择“离线安装”。

推荐状态机：

```text
not-installed
  -> checking-space
  -> downloading-manifest
  -> downloading-assets
  -> verifying
  -> staged
  -> active

failure/cancel
  -> discard staging
  -> retain current active revision
```

推荐持久结构：

```text
IndexedDB: pack-installations
  namespace
  manifestUrl
  activeRevision
  previousRevision
  state
  expectedBytes
  installedBytes
  lastUsedAt
  lastError

Cache Storage: mmt-pack:<namespace>:<revision>
  URL -> immutable Response/blob
```

IndexedDB 保存事务状态、manifest 和索引；Cache Storage 保存可按 URL 复用的 Response。只有在需要大型容器随机访问、局部读取或更精细文件管理时才引入 OPFS。

### 4.3 安装流程

```text
用户选择 Pack
  -> 获取并验证 manifest
  -> 确定 namespace/revision/asset 清单
  -> navigator.storage.estimate()
  -> 检查 active + staging + margin
  -> 可选 navigator.storage.persist()
  -> 下载到 revision staging cache
  -> 校验 status/MIME/size/hash
  -> IndexedDB 单事务切换 active revision
  -> 保留 previous revision
  -> 成功使用后延迟清理 previous
```

禁止边下载边覆盖 active cache。

## 5. Service Worker 策略

### 5.1 推荐集成

建议使用 `vite-plugin-pwa` 提供 manifest/build 集成，但使用可控的自定义 worker：

```text
strategies: injectManifest
registerType: prompt
```

理由：

- 大 WASM 超过 Workbox 默认 2 MiB precache 上限；
- 多 Worker 与 Web Extension Host 有严格版本边界；
- 需要资源包独立生命周期；
- 需要原子 shell revision、回滚和 quota 处理；
- 当前已经存在 VS Code Webview Service Worker。

如果使用 Workbox precache manifest，必须显式排除 source maps，并只提高必需文件的 `maximumFileSizeToCacheInBytes`；禁止用宽泛 glob 把整个 dist 加入 precache。

### 5.2 更新策略

禁止自动 `skipWaiting` 和自动 reload。推荐：

```text
checking
  -> downloading-shell
  -> verifying-shell
  -> waiting-for-user
  -> flushing-workspace
  -> activating
  -> reloading
```

新 worker 完整 staging 后只提示“有更新可用”。用户接受前：

- flush workspace/IndexedDB 写入；
- 确认没有未完成的关键 materialization；
- 记录当前 projection/session 状态；
- 再发送 `SKIP_WAITING`；
- `controllerchange` 后执行一次受控 reload。

拒绝更新时继续运行当前 shell，不能出现旧 JS、新 WASM 或新 Worker 混用。

### 5.3 Offline fallback

离线导航至少区分：

1. shell 已安装：启动正常编辑器；
2. shell 未完整安装：显示明确的离线不可用页面；
3. pack 未安装：编辑器可启动，但资源诊断显示缺失离线 pack；
4. pack 安装损坏：回退 previous revision 或标记需修复；
5. manifest 网络不可达：使用 IndexedDB active manifest，不提升 revision。

禁止把网络失败解释为空 pack 或空 manifest。

## 6. 与现有 Webview Service Worker 共存

当前构建已经包含：

```text
assets/service-worker-*.js
```

该 worker 服务 VS Code Webview iframe。根 PWA worker 可以按 scope 共存，但必须通过原型验证，不能假设当前站点是空白 Service Worker 环境。

必须验证：

- 根 scope 与 Webview iframe scope 的控制关系；
- 首次在线加载后完全离线打开 Webview；
- 根 worker 更新时 iframe worker 是否仍引用旧资源；
- unregister/clear-site-data 后的恢复；
- Webview worker 注册失败时宿主行为；
- Webview 静态资源是否需要进入根 shell cache；
- 旧 Workbench JS、新 MMT/Tinymist WASM 和旧 Webview worker 的混合版本防护。

## 7. StorageManager 与驱逐

### 7.1 空间预检

安装 shell 大更新或 pack 前调用：

```ts
const { usage = 0, quota = 0 } = await navigator.storage.estimate();
const available = Math.max(0, quota - usage);
```

`quota` 是估算上限，不是写入保证。所有 Cache Storage/IndexedDB/OPFS 写入仍需捕获 `QuotaExceededError`。

UI 应显示：

- 当前 origin 使用量；
- 估算 quota；
- 本次 staging 需要量；
- active/previous/staging 各自大小；
- persistence 状态；
- 可清理 pack 列表。

### 7.2 持久化请求

资源包安装完成或用户启用离线模式后：

```ts
const persisted = await navigator.storage.persisted();
if (!persisted) await navigator.storage.persist();
```

行为差异：

- Chromium/Safari 通常按交互启发式自动批准/拒绝；
- Firefox 会向用户提示；
- iOS Home Screen 状态有利于 WebKit 批准，但不能假设必然成功。

### 7.3 驱逐恢复

浏览器默认存储属于 best-effort。设备存储压力或浏览器总体 quota 超限时，origin 可能按 LRU 被整体驱逐。Safari 还可能主动清理长期无交互 origin 的脚本数据。

因此：

- pack 必须可重新下载；
- workspace 应提供导出/同步路径，不能只依赖 origin storage；
- 启动时核对 installation registry 与实际 cache；
- 缓存整体消失时进入可恢复状态，而不是崩溃；
- iOS 不宣传“永久离线资源”。

## 8. 应用 Origin 部署契约

当前根目录 `netlify.toml` 只定义构建目录、构建命令、发布目录和 Node 版本，没有为应用 origin 定义 cache headers、MIME overrides 或 SPA fallback：

```toml
[build]
  base = "editors/vscode-web"
  command = "npm run build"
  publish = "dist"
```

PWA shell revision 和更新协议依赖服务器返回一致的缓存与内容类型语义。正式实施必须在 Netlify 配置或同等部署层建立以下契约。

### 8.1 入口与 Service Worker 必须重验证

`index.html` 和根 Service Worker 脚本（例如 `/sw.js`）不得使用长期 immutable cache：

```http
Cache-Control: no-cache, max-age=0, must-revalidate
```

可以额外使用 ETag，但不能让 CDN 或浏览器长期复用旧入口/旧 worker。否则客户端可能永远看不到新 shell revision，或用旧 HTML 请求已清理的新旧混合 asset。

Web App Manifest 也应重验证或采用短缓存并带 ETag；其更新不能依赖用户手动清站点数据。

### 8.2 内容寻址资源必须长期 immutable

Vite 生成的 hashed `/assets/*` 应使用：

```http
Cache-Control: public, max-age=31536000, immutable
```

该规则只适用于文件名包含可靠 content hash 的资源。非 hash 文件、运行时配置、manifest、worker 入口和 HTML 不得套用。

Source maps 不进入 Service Worker precache；生产环境是否公开 source maps 是独立部署决策。

### 8.3 MIME 必须正确

至少验证：

| 资源 | Content-Type |
|---|---|
| `.wasm` | `application/wasm` |
| `.js` / module worker | `text/javascript` 或标准 JavaScript MIME |
| `.json` / Web App Manifest | `application/json` / `application/manifest+json` |
| `.woff2` | `font/woff2` |
| `.otf` | `font/otf` |
| `.ttf` | `font/ttf` |
| `.ttc` | 平台验证后的字体 MIME，不得回落为 HTML |
| `.svg` | `image/svg+xml` |

WASM 或 module worker 若返回 `text/html`，浏览器错误通常表现为编译/MIME 失败；部署层不得用 SPA fallback 掩盖该问题。

### 8.4 Navigation fallback 必须只处理文档导航

SPA/PWA fallback 只能把符合应用路由的 HTML navigation request 回退到 `index.html`。必须显式排除：

- 根 Service Worker 和 Webview Service Worker；
- `/assets/*`；
- `.wasm`、`.js`、`.css`、字体和 Worker 请求；
- Web App Manifest；
- pack manifest、pack blobs 和 pack assets；
- source maps；
- API 或未来同步端点。

推荐同时检查 request mode/destination 和 `Accept: text/html`，并使用 denylist。不存在的 worker、WASM、manifest 或 pack URL 必须保留真实 404/5xx，不能返回 `index.html` 伪装成功。

### 8.5 部署验证

Phase 0 必须对 production-like server 断言：

- `index.html` 与根 worker 为 revalidate/no-cache；
- hashed assets 为一年 immutable；
- WASM/字体 MIME 正确；
- 不存在的 `.wasm`、worker、manifest、pack blob 返回 404，而不是 HTML；
- 合法应用 navigation 在在线和离线模式下落到正确 shell；
- 部署新 revision 后旧页面能发现更新，拒绝更新时仍可继续使用旧完整 shell。

## 9. 跨域资源包要求

`mms-pack.xiyihan.cn` 当前部署 headers：

```http
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, HEAD, OPTIONS

/manifest.json
Cache-Control: public, max-age=0, must-revalidate

/blobs/*
Cache-Control: public, max-age=31536000, immutable

/assets/*
Cache-Control: public, max-age=86400, stale-while-revalidate=604800
```

正式离线安装还需确认：

- blob URL 在 revision 内真正不可变；
- manifest 为每个离线 asset 提供 size/hash/MIME；
- 服务返回稳定 `Content-Length` 和 ETag；
- `.avifs`、WASM、字体的 Content-Type 正确；
- Range request 是否需要及是否支持；
- CDN 是否会透明重编码；
- 中断后按文件队列恢复，不必重下已校验 asset。

## 10. 平台可行性矩阵

| 平台 | 安装能力 | 大 WASM 离线启动 | 约 150 MiB 存储 | Persistence/驱逐 | 结论 |
|---|---|---|---|---|---|
| Chrome/Edge Desktop | 原生安装 | 支持 | Chromium 单 origin 理论上可达磁盘约 60%，通常充足 | `persist()` 按启发式；存储压力仍需处理 | Go |
| Android Chromium | 原生安装 | 支持，需实机测编译/内存 | 通常可行，低存储设备风险高 | 必须 `estimate()` 与失败恢复 | Go，带空间预检 |
| macOS Safari 17+ | Add to Dock | 支持 | Browser/standalone origin quota 约磁盘 60% | WebKit 启发式 persistence | Go，需 Safari 实测 |
| iOS Home Screen 17+ | 支持 | 支持，但 WASM/内存/后台终止需实机测 | quota 规则通常足够 | 可能主动驱逐；Home Screen 有利于 persistence | Conditional Go |
| Firefox Desktop | 不支持 manifest 原生安装 | 离线网页支持 | best-effort 为磁盘 10% 或 10 GiB 取小；persistent 更高 | `persist()` 提示用户 | Offline Web Go；Install No-Go |

## 11. 实施阶段

### Phase 0：原型与决策门

目标：证明技术边界，不接完整产品 UI。

任务：

- 建立最小 Web App Manifest 和根 worker；
- 缓存实际启动请求清单，不缓存 source maps；
- 测试完全离线启动 MMT LSP、Tinymist 和 Typst；
- 测试根 worker 与 Webview worker 共存；
- 在 Chrome、Android、Safari、iOS Home Screen 测试 `estimate()`/`persist()`；
- 在 Cache Storage 写入并读取至少 200 MiB fixture；
- 模拟 `QuotaExceededError`；
- 测试 prompt update，不自动刷新编辑中的文档。

通过条件：

- 离线启动和 workspace 恢复稳定；
- 三个 WASM runtime 均可启动；
- Webview worker 不冲突；
- 更新不会丢文档或产生混合版本；
- quota 不足有明确、可恢复结果。

### Phase 1：可安装应用壳

任务：

- 正式 manifest、192/512/maskable icons；
- injectManifest worker；
- shell revision staging/verify/activate；
- prompt update UI；
- offline fallback；
- 存储诊断面板；
- E2E 覆盖 install/offline/update。

此阶段不宣称 pack 离线。

### Phase 2：显式 Pack 安装

任务：

- Pack Manager；
- offline install/remove/repair；
- asset 清单与总大小；
- quota 预检和 persistence；
- staging/active/previous registry；
- hash/MIME/size 校验；
- 安装进度、取消和恢复；
- 离线 pack 缺失诊断。

### Phase 3：平台硬化

任务：

- Android 低存储与低内存设备；
- iOS Home Screen 冷启动和驱逐恢复；
- Safari worker 更新；
- Firefox 离线网页模式；
- pack 增量更新或按 set 安装；
- LRU 清理不常用 pack；
- 网络中断、CDN 错误、hash mismatch、损坏 cache。

## 12. Go / No-Go 门槛

### Go

- 应用 shell 可完全离线启动；
- pack 由用户显式安装；
- 安装前检查 staging 峰值空间；
- shell 与 pack 都有 revision/hash 校验；
- 更新有 prompt、staging 和 rollback；
- Webview worker 共存经过真实浏览器验证；
- iOS 产品文案承认缓存可能被驱逐。

### No-Go

- precache 整个 dist 或完整资源包目录；
- 自动下载 150–350 MiB；
- 自动 `skipWaiting`/reload；
- 不保留 active revision 就覆盖更新；
- 不检查约 2 倍更新空间；
- 把 Cache Storage 当永久资产库；
- 继续只用 32 MiB 内存 Base64 cache 却宣称完整离线；
- 未测试现有 Webview Service Worker 冲突。

## 13. 验证矩阵

| 场景 | Chrome Desktop | Edge Desktop | Android Chrome | macOS Safari | iOS Home Screen | Firefox Desktop |
|---|---:|---:|---:|---:|---:|---:|
| Manifest/installability | 必测 | 必测 | 必测 | 必测 | 必测 | 记录不支持 |
| 首次安装 shell | 必测 | 抽测 | 必测 | 必测 | 必测 | 离线网页模式 |
| 完全离线冷启动 | 必测 | 抽测 | 必测 | 必测 | 必测 | 必测 |
| Tinymist/Typst WASM 启动 | 必测 | 抽测 | 必测 | 必测 | 必测 | 必测 |
| 150–350 MiB quota | 必测 | 抽测 | 必测 | 必测 | 必测 | 必测 |
| `persist()` | 必测 | 抽测 | 必测 | 必测 | 必测 | 必测 |
| 更新接受/拒绝 | 必测 | 抽测 | 必测 | 必测 | 必测 | 必测 |
| Webview worker 共存 | 必测 | 抽测 | 必测 | 必测 | 必测 | 必测 |
| 驱逐/损坏恢复 | 必测 | 抽测 | 必测 | 必测 | 必测 | 必测 |

## 14. 参考资料

- [Vite Plugin PWA FAQ：large precache files](https://github.com/vite-pwa/vite-plugin-pwa/blob/main/docs/guide/faq.md)
- [Vite Plugin PWA：Workbox runtime caching](https://github.com/vite-pwa/vite-plugin-pwa/blob/main/docs/workbox/generate-sw.md)
- [Vite Plugin PWA：Inject Manifest](https://github.com/vite-pwa/vite-plugin-pwa/blob/main/docs/guide/inject-manifest.md)
- [MDN：Storage quotas and eviction criteria](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)
- [WebKit：Updates to Storage Policy](https://webkit.org/blog/14403/updates-to-storage-policy/)
- [MDN：Making PWAs installable](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable)
