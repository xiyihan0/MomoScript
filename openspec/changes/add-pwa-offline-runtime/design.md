# Architecture

```text
Window
+----------------------+       +------------------------+
| Workbench Runtime    |<----->| PwaUpdateCoordinator   |
| WorkspaceCoordinator |       | PackOfflineManager     |
+----------+-----------+       +-----------+------------+
           |                               |
           +-----------+-------------------+
                       v
             OriginStorageCoordinator
        protected inventory / reservations / GC plans
                       |
           +-----------+------------+
           |                        |
     IndexedDB registries       reservation token
                                    |
                                    v
                         Root Service Worker
                         exact shell/pack routes
                                    |
                    +---------------+---------------+
                    |                               |
         Cache Storage shell revisions    Cache Storage pack revisions
```

Service Worker 不解释 MMT、Typst project、workspace AST 或 pack semantic manifest。它只执行经过 page-side coordinator 授权的
版本化下载、完整性校验、exact request routing 和 cache 生命周期。Workspace、PWA shell、pack installer 通过同一个
`OriginStorageCoordinator` 竞争 origin storage，禁止各自调用 `navigator.storage.estimate()` 后独立作出写入决策。

## Current Baseline

2026-07-16 工作树中的 `editors/vscode-web/dist` 为 188 个文件、57.80 MiB、0 个 source map。最大本地文件是两张
Noto Sans CJK 字体（19.12/18.58 MiB）、Workbench 主 JS（9.97 MiB）和 MMT LSP WASM（1.63 MiB）。该数值不包含：

- 启动时从 `mms-pack.xiyihan.cn` 加载的 Tinymist WASM；生产实测 response 为 9,240,839 encoded bytes、32,346,976 decoded bytes；
- 首次 preview 时加载的 Typst compiler WASM；
- 可选 MainFont；离线时已有 bundled Noto fallback；
- 任何 pack image/AVIFS resource。

因此 reservation 必须根据 shell build manifest 的完整 local + selected remote decoded inventory 计算，不能用 `dist` 大小或 HTTP
transfer size代替。构建体积只是观测基线，每个 release 都重新生成 inventory。

当前线上 ready 页面没有 manifest link、root Service Worker、controller 或 Cache Storage。`IndexedDbPackCache` 只缓存 manifest JSON/ETag；
`BoundedStringCache` 和 sequence fetch map 都是页面内存缓存。

## Manifest And Installability

manifest 使用稳定 identity：

```json
{
  "id": "/",
  "name": "MomoScript",
  "short_name": "MomoScript",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "background_color": "#181818",
  "theme_color": "#181818",
  "lang": "zh-CN",
  "prefer_related_applications": false
}
```

icons 至少提供 192×192、512×512 和 512×512 maskable PNG，图形 safe zone 必须实测。`index.html` 保留 theme color 并增加
`<link rel="manifest">`、Apple touch icon 和必要的 iOS metadata。

必须区分两个正交状态：

- `browserInstalled`：浏览器以 standalone/app window 启动，或收到 `appinstalled`；
- `offlineReadyRevision`：完整 shell revision 已缓存、校验并被 registry 标为 active。

浏览器安装不意味着离线 ready；离线 ready 也不要求用户安装到桌面。Chromium 的 `beforeinstallprompt` 只作为 progressive enhancement；
iOS/macOS/Firefox 使用各自浏览器 UI 或帮助文案，不能伪造原生 prompt。

## Build And Artifact Catalog

采用 `vite-plugin-pwa`：

```ts
VitePWA({
  strategies: "injectManifest",
  srcDir: "src/pwa",
  filename: "sw.ts",
  registerType: "prompt"
})
```

`injectManifest` 只负责构建 root worker、注入本地 build asset list 和 manifest 集成；update/staging/activation 由项目代码控制。禁止使用
`autoUpdate`。Workbox 默认 2 MiB precache 上限小于当前字体和主 bundle，因此 `maximumFileSizeToCacheInBytes` 只提高到覆盖已审计的必需本地
artifact（第一版 24 MiB），并由 build 在出现更大 artifact 时失败；不得以宽泛 200 MiB 上限掩盖意外产物。

build 输出一个可确定复算的 `pwa-shell-manifest.json`：

```ts
interface ShellManifest {
  schema: 1;
  buildId: string;
  local: ShellArtifact[];
  remoteRuntime: RuntimeArtifactSelection[];
  expectedDecodedBytes: number;
}

interface ShellArtifact {
  requestUrl: string;
  sha256: string;
  encodedBytes?: number;
  decodedBytes: number;
  contentType: string;
  role: "html" | "script" | "style" | "worker" | "wasm" | "font" | "image" | "webview";
}
```

`buildId` 绑定 manifest schema、所有 request URLs、hash、size 和 runtime compatibility version。`index.html`、MMT LSP、Tinymist、Typst
compiler/renderer、Workers、Workbench extensions、必需 fonts 与 Webview iframe bootstrap 必须属于同一个 buildId。

跨域 runtime 定义收束到单一 `runtimeArtifacts.ts` catalog；`preview.ts`、`tinymistLanguageClient.ts` 和 shell manifest generator 共用，禁止
页面 hardcode 与 PWA 清单维护两份 URL/hash。每个远端 artifact 可以声明有序 candidate（例如 zstd delivery 与 identity fallback）；shell
只激活实际下载并通过校验的 selection，registry 记录选中的 exact request URL。

source maps、测试 artifact、workspace、pack、WebDAV、optional MainFont 和未被启动/preview 路径使用的 legacy asset 不进入 shell manifest。

## Root Service Worker Boundaries

`/sw.js` scope 为 `/`。首次安装只建立一个有界 bootstrap/recovery response 和 registry schema；禁止在 `install` event 中无容量许可地下载
完整 100 MiB 级 shell。完整离线安装由页面显式触发。

fetch handler 只允许：

1. same-origin document navigation：active shell 存在时返回该 revision 的 `/index.html`；不存在时 network-first，断网返回“离线运行时未安装”；
2. exact active/previous shell manifest request：从对应 shell cache 返回；
3. exact active pack installation-index request：从对应 pack cache 返回；
4. 其他请求：保持正常 network 行为，不做 wildcard runtime caching。

navigation fallback 必须同时检查 `mode === "navigate"`、document destination/HTML accept 和 denylist。`.wasm`、`.js`、`.css`、font、worker、
manifest、pack blob、API/WebDAV 与不存在的 asset 绝不回退 HTML。

root worker 不缓存 opaque response、redirected response、non-2xx、错误 MIME、超限 body 或 hash mismatch。跨域 runtime/pack 必须是可检查的
CORS response；验证 clone 的 decoded bytes，缓存原 Response，保留 `Content-Encoding` / `Vary` 语义，不自行重写 zstd body/header。

## Explicit Offline Shell Installation

状态机：

```text
online-only
  -> checking-space
  -> staging
  -> verifying
  -> offline-ready

failure/cancel
  -> discard-staging
  -> retain-active
```

用户点击“启用离线使用”后，page-side coordinator：

1. 读取当前 ShellManifest；
2. 取得 workspace storage status 与 origin inventory；
3. 以 decoded payload + safety margin 请求 reservation；
4. 显示下载量、估计持久占用、当前 protected/reclaimable bytes 和清理计划；
5. 用户接受后把 reservation token 与 manifest 发送给 root worker；
6. worker 下载到 `mmt-shell:staging:<buildId>`，逐项验证 status/CORS/redirect/MIME/size/hash；WASM 还运行 `WebAssembly.validate`；
7. 校验 cache 与 manifest 完整对应后，registry transaction 才将 buildId 标为 active；
8. 启动一次离线 smoke 后显示 `offline-ready`。

下载超出 reservation、quota failure、cancel、网络中断或校验失败时只删除 staging；已有 active shell、workspace/history 和 installed pack 都保持。

## Origin-wide Storage Coordination

IndexedDB、Cache Storage 与 OPFS 共享 origin quota，并可能被浏览器按 origin 整体驱逐。建立唯一 `OriginStorageCoordinator`，所有大于固定
bootstrap 上限的 shell/pack/cache 写入必须先取得 durable reservation。它接受各 subsystem 的 inventory：

| Category | Owner | Policy |
|---|---|---|
| workspace current bytes | workspace storage | protected，PWA/pack 永不删除 |
| pinned heads/checkpoints/sync baseline | Local History | protected |
| pending/conflict journal、unreconciled durable head | workspace storage | protected；阻止 staging/activation |
| ordinary unpinned history | Local History | 只能由 history policy GC，PWA 不直接删除 |
| active shell | PWA | operationally pinned；更新失败仍需启动 |
| previous shell | PWA | 新 revision healthy 且无旧 client 后可回收 |
| shell/pack staging | owning installer | 首先回收 |
| active offline pack | Pack Manager | reproducible，但移除需用户确认 |
| previous/orphan pack、materialization cache | Pack Manager/preview | reproducible，优先回收 |

File System Access 目录自身不计入 origin bytes，但其 IndexedDB history、journal、handle metadata 仍计入 protected inventory。

reservation 不能只看 `quota - usage`。至少包含：

```text
operation decoded peak bytes
+ response/index metadata
+ max(64 MiB, 20% of operation decoded bytes) write margin
+ workspace growth reserve
```

`navigator.storage.estimate()` 是估算值；coordinator 同时使用 subsystem registry bytes，并在每批写入后核对实际进度。跨域 response 的浏览器
padding 和 Content-Encoding 差异按更保守的 decoded size 预留。任何 subsystem 不得绕过 coordinator 独立“先写再清理”。

统一回收顺序：failed/orphan staging → unreferenced materialization cache → inactive previous pack → healthy previous shell → 用户确认的 LRU offline pack。
PWA/pack 不触发 Local History GC 来为下载让路，也不删除 active shell、current workspace、pinned history、journal 或 sync safety state。
空间仍不足时，安装/更新在下载前失败，并继续使用当前 active revision。

`add-workspace-storage-history-sync` 的状态与 PWA hard gate：

- `migration-failed`、`quota/history-blocked`、`history-degraded + unreconciled`、pending/conflict journal：禁止 shell/pack staging 和 update activation；
- writer lease 未持有、持久化 queue 未 flush：允许查看更新，但禁止 restart；
- 状态恢复后必须重新读取 inventory 和 reservation，不能复用旧估算。

`navigator.storage.persist()` 由 origin coordinator 在用户显式启用离线或保护本地工作区时调用一次并显示结果。grant/deny 适用于整个 origin，
不能标成某一个 pack 的保证；deny 不等于功能失败，但 UI 必须继续标注 best-effort/eviction 风险。

## Prompt Update And Safe Activation

新 worker 到达 `waiting` 后只报告 update manifest 与预计空间，不自动 staging。更新分两步：

1. `下载更新`：取得新的 origin reservation，staging/verify 完成后显示 restart-ready；
2. `重启并应用`：调用 runtime owner 的 `prepareForReload()`。

`prepareForReload()` 必须：

- 取得 workspace writer lease，暂停新 mutation；
- 等待 `persistenceByUri`、Local History edit groups 和 metadata transactions flush；
- 拒绝 pending/conflict FSA journal、unreconciled external state 或 migration；
- abort 并等待 preview/materialization 到达安全边界；
- 记录当前 source URI/session 恢复 metadata；
- detach listeners/controllers，并准备受控 graceful shutdown。

成功后 page 向 waiting worker 发送 `ACTIVATE(buildId)`；worker 才调用 `skipWaiting()`。首版不自动调用 `clients.claim()`。等待 worker
`activated` 后当前接受更新的页面执行一次 guarded reload；不能依赖 `beforeunload` Promise 完成 flush。

拒绝或关闭 update UI 时，当前 shell 继续完整工作。其他已打开 tab 不被强制 reload；它们通过 client revision handshake 使用旧 exact assets，
previous cache 在 `clients.matchAll()` 与 heartbeat 都无法证明旧 client 已退出前不得清理。workspace writer lease 保证只有 writer tab 可发起 activation。

## Probation And Rollback

新 revision 激活后进入 probation，不立即删除 previous。首次启动必须验证：

- active cache/manifest 完整；
- Workbench 和 workspace 打开；
- MMT LSP 与 Tinymist Worker/WASM ready；
- Typst compiler/renderer 执行一个最小内存 smoke；
- Webview bootstrap 能加载；
- 没有从 previous revision 或 network 补洞。

全部通过后发送 `SHELL_HEALTHY(buildId)`，再等待旧 client 退出后回收 previous。启动失败时 root worker 的最小 recovery UI 可把 active asset pointer
切回 previous cache并 reload。该 rollback 回退 shell assets/manifest，不声称把已经激活的 Service Worker binary 降级；因此 worker registry/cache schema
必须至少向后兼容一个 revision。若 previous 也不可用，只允许 online repair、导出可读 workspace 或清理 reproducible caches，禁止“修复”时删除 IndexedDB workspace。

Cache Storage 与 IndexedDB registry 不能跨 API 原子提交。启动/recovery 必须处理：complete staging without pointer、pointer to missing/incomplete cache、
orphan cache、active damaged but previous complete；任何状态都不能混拼两个 buildId。

## Webview Service Worker Coexistence

当前 Vite output 包含 VS Code Webview 的 `assets/service-worker-*.js`。根 worker 只把它作为 exact shell artifact，不接管其内部协议或扩大其 scope。
Phase 0 必须在真实浏览器验证：

- root `/` scope 与 Webview worker scope/clients；
- 首次在线后完全离线打开 Webview；
- root update 接受/拒绝时 Webview 使用同一 shell revision；
- old Workbench client 请求 old Webview asset 时 previous cache 可满足；
- Webview worker registration failure 可见但不破坏 workspace；
- unregister、cache corruption 和 clear-site-data recovery。

未通过该决策门不得发布离线 ready 文案。

## Explicit Offline Pack Installation

pack semantic manifest 不适合直接作为下载清单；`image-dir` 不能给出每个 response 的 size/hash。分发侧新增与 semantic revision/hash 绑定的
`installation-index.json`：

```ts
interface PackInstallationIndex {
  schema: 1;
  namespace: string;
  semanticManifestSha256: string;
  revision: string;
  totalDecodedBytes: number;
  entries: Array<{
    requestUrl: string;
    sha256: string;
    encodedBytes?: number;
    decodedBytes: number;
    contentType: string;
    role: "avatar" | "image" | "image-sequence" | "catalog";
  }>;
}
```

builder 必须从实际发布文件生成，按 URL 排序并验证 total。Service Worker 不从目录遍历、HTML 或当前脚本引用猜下载集合。

状态机为 `not-installed → checking-space → downloading → verifying → staged → active`。active revision 不边下载边覆盖；保留 previous 到新 revision
被 preview 成功使用。取消/失败只删 staging。Pack Manager 支持 install、pause/resume、remove、repair 和逐项进度；resume 只复用已经 hash 验证的 response。

materializer 通过统一 resource fetch abstraction 先查 exact active pack cache，再联网。离线缺 pack/entry 或损坏属于 revision-bound preview/build
diagnostic；MMT syntax、semantic 和 no-I/O language projection 继续工作。Service Worker 不缓存 WebDAV、任意用户 URL 或未被 active installation index 授权的 response。

## Offline And Eviction States

UI 至少区分：

- online-only；
- browser-installed but offline runtime missing；
- shell offline-ready / pack not installed；
- shell + selected packs offline-ready；
- update available/downloading/restart-ready；
- quota blocked / best-effort storage；
- cache damaged / previous rollback available；
- workspace protected-state blocked；
- origin data evicted。

浏览器可能在 storage pressure 下驱逐整个 origin。启动时对 registry、Cache Storage 和 IndexedDB workspace 做一致性检查：pack/shell 可重新下载；workspace
恢复依赖 File System Access、WebDAV、导出或仍存在的 IndexedDB，不得根据空 registry 推断“用户从未创建文件”。iOS 文案不使用“永久离线”。

## Deployment Contract

Netlify 和生产 Edge/CDN 必须满足同一断言：

| Path | Required response |
|---|---|
| `/`, `/index.html`, `/sw.js`, `/manifest.webmanifest`, `/pwa-shell-manifest.json` | `no-cache, max-age=0, must-revalidate` 或等价重验证 |
| content-hashed `/assets/*` | `public, max-age=31536000, immutable` |
| WASM | `application/wasm`，不得 fallback HTML |
| module/worker JS | 标准 JavaScript MIME |
| fonts/manifest/SVG | 对应标准 MIME |
| unknown worker/WASM/pack/API path | 真实 404/5xx，不返回 index |

`/sw.js` 必须是稳定 URL、HTTPS、scope `/`，不能被 CDN 长期 immutable、HTML rewrite 或透明内容变换。cross-origin runtime/pack origin 必须提供 CORS、
稳定 Content-Length/ETag、正确 MIME，content-addressed blob immutable；redirect、Content-Encoding 和 `Vary` 必须与 shell/pack validator 约定一致。

## Platform Targets

- Chrome/Edge Desktop：完整 install/offline/update 支持；
- Android Chromium：完整支持，增加低内存/低存储实机验证；
- macOS Safari 17+：Add to Dock 与离线支持，不能依赖 `beforeinstallprompt`；
- iOS Home Screen 17+：conditional support，必须验证冷启动、WASM memory 和驱逐恢复；
- Firefox Desktop：支持普通 Web/离线 shell，不承诺 manifest desktop install promotion。

能力检测失败时保持在线编辑器，不因缺 install API、`persist()` grant 或 File System Access 而拒绝启动。

## Verification Strategy

- build-time：manifest schema、exact asset inventory、hash/size/MIME、24 MiB audited limit、source-map/test exclusion、runtime URL single source；
- production-like HTTP：headers、MIME、navigation denylist、真实 404、CORS/redirect/content-encoding；
- Chromium E2E：首次 online-only、显式 offline install、完全断网冷启动、三个 WASM runtime、Webview、pack 缺失；
- revision fixture：A 正常运行，B waiting；拒绝 B、下载 B、dirty workspace 阻止 restart、flush 后激活、single reload、probation、previous cleanup；
- fault matrix：每个 shell/pack staging batch crash、QuotaExceeded、hash/MIME mismatch、cache entry missing、registry/cache partial commit、rollback；
- origin pressure：workspace protected bytes + active shell + pack + staging，验证只回收 reproducible cache并在不足时拒绝下载；
- multi-client：writer/read-only tabs、旧 client exact asset、无自动 claim/reload；
- platform manual/automation：Chrome/Edge、Android、Safari/macOS、iOS Home Screen、Firefox offline web。

## Deferred Decisions

- app store/TWA 包装、Push、Background Sync；
- 增量/delta shell patch；
- pack 按 entity/set 的部分安装；
- OPFS 是否替代 Cache Storage 保存大型 AVIFS；
- 自动清理 active offline packs；
- 超过一代的 shell rollback；
- 自动三方同步或 WebDAV background scheduling。

## References

- [Vite Plugin PWA: Inject Manifest](https://vite-pwa-org.netlify.app/workbox/inject-manifest)
- [Vite Plugin PWA: large precache files](https://vite-pwa-org.netlify.app/guide/faq)
- [MDN: Making PWAs installable](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable)
- [MDN: ServiceWorkerGlobalScope.skipWaiting()](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerGlobalScope/skipWaiting)
- [MDN: ServiceWorkerContainer controllerchange](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerContainer/controllerchange_event)
- [MDN: Storage quotas and eviction criteria](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)
- [MDN: StorageManager.persist()](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist)
- [MDN: Cache.put()](https://developer.mozilla.org/en-US/docs/Web/API/Cache/put)
