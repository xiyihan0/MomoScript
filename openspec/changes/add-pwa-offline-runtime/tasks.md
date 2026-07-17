## 0. Prerequisite Contracts

- [x] 0.1 定义 page、root worker、workspace、Local History 和 Pack Manager 共用的 `OriginStorageCoordinator` message/schema/version contract
- [x] 0.2 落地 shell-agnostic durable inventory/reservation foundation，足以批准 History desired budget；不得依赖 shell/pack 已实现
- [ ] 0.3 完成 `add-workspace-storage-history-sync` task 3.5/3.6 的 inventory/state 注册，再原子更新 inventory 并申请 History desired budget
- [x] 0.4 完成 `add-mmt-lsp-vscode` Web runtime owner：逆序 startup rollback、可等待 `prepareForReload` / graceful dispose 与 unload 同步 Worker terminate fallback
  - Evidence: `cd editors/vscode-web && npm run test:runtime-owner && npm run test:pwa-quiesce` covers reverse rollback、graceful deadline/fallback and the production safe-restart adapter without adding another listener or runtime lifecycle.
- [x] 0.5 用 fault-injecting fake subsystems 验证 reservation、release、crash expiry 和并发 shell/pack request 不重复占用同一 free bytes

## 1. Phase 0 Browser And Deployment Decision Gate

- [ ] 1.1 建立最小 root `/sw.js` prototype，只安装固定上限 bootstrap/recovery，不下载完整 shell
- [ ] 1.2 在 production-like server 配置 HTML/worker/manifest revalidation、hashed asset immutable、MIME 和 navigation denylist
- [ ] 1.3 验证未知 WASM/worker/manifest/pack/API 返回真实 404/5xx，不被 SPA fallback 改为 HTML 200
- [ ] 1.4 在真实 Chromium 中验证 root worker 与现有 VS Code Webview `service-worker-*` scope、离线 bootstrap、更新与 unregister
- [ ] 1.5 测量当前完整 local + remote runtime decoded inventory、Cache Storage 实际增量与 zstd/identity selection，记录可重复 build report
- [ ] 1.6 未通过 root/Webview coexistence、跨域 runtime cache 和完全离线 smoke 前，保持生产 UI 不显示 offline-ready

## 2. Manifest And Deterministic Shell Build

- [ ] 2.1 固定 `vite-plugin-pwa`/Workbox 依赖，配置 `injectManifest`、`registerType: prompt` 和审计后的 24 MiB 单文件上限
- [ ] 2.2 添加 manifest `id/name/short_name/start_url/scope/display/colors/lang` 与 192/512/maskable icons，并验证 safe zone
- [ ] 2.3 将 Tinymist、Typst compiler 和 fallback candidates 收束到单一 `runtimeArtifacts.ts` catalog，移除 page/PWA 双份 URL/hash
- [ ] 2.4 生成 deterministic `pwa-shell-manifest.json`，包含 exact URL、SHA-256、encoded/decoded size、MIME、role、compatibility 和 buildId
- [ ] 2.5 build-time 拒绝遗漏必需 runtime、超限 artifact、重复 URL/role、hash/size 不一致，并排除 `.map`、测试、workspace、pack 和 legacy duplicate
- [ ] 2.6 验证 Chromium installability；Safari/iOS/Firefox 仅显示真实支持的安装入口或说明

## 3. Origin-wide Storage Coordinator

- [x] 3.1 建立 IndexedDB inventory/reservation registry，区分 workspace protected、history-policy-managed、active shell、previous/staging shell、active/previous pack 与 materialization cache
- [x] 3.2 实现 decoded peak + metadata + `max(64 MiB, 20%)` margin + workspace growth reserve 的统一 reservation
- [ ] 3.3 将 workspace current/pinned heads/checkpoints/journal/sync baseline/unreconciled durable head 注册为 PWA/pack 不可删除的 protected bytes
- [ ] 3.4 实现回收计划：failed/orphan staging → materialization cache → inactive previous pack → healthy previous shell → 用户确认的 active offline pack
- [x] 3.5 阻止 PWA/pack 直接触发 Local History GC、删除 active shell 或绕过 coordinator 独立调用 estimate 后写入
  - Evidence: `cd editors/vscode-web && npm run test:origin-storage` exercises the durable class registry, conservative reservation formula, ordered reclaim plan, explicit active-pack confirmation, Typst package pins and eviction/invalidation callbacks while proving protected workspace/history inventory is byte-for-byte unchanged.
- [ ] 3.6 集中处理 `persisted()` / 用户触发 `persist()`，将 grant/deny 表示为 origin-wide 状态而非单 pack 保证
- [ ] 3.7 注入 estimate padding/staleness、QuotaExceeded、transaction abort 和 crash，验证只回收 reproducible bytes且 reservation 幂等释放

## 4. Explicit Offline Shell

- [ ] 4.1 实现 online-only/checking-space/staging/verifying/offline-ready registry 与状态 UI，browser-installed 状态单独显示
- [ ] 4.2 用户确认后向 worker 发送 durable reservation token；按 shell manifest 下载到 `mmt-shell:staging:<buildId>`
- [ ] 4.3 逐项验证 status、CORS、redirect、MIME、decoded size/hash，WASM 额外 `WebAssembly.validate`，拒绝 opaque/error HTML
- [ ] 4.4 验证 exact cache membership 后单事务 promote active；cancel/failure/超 reservation 只清 staging并保留当前 active
- [ ] 4.5 实现 root fetch exact routing、same-origin document navigation 与 bounded offline-not-installed recovery，其他请求 network pass-through
- [ ] 4.6 完全断网冷启动 Workbench、workspace、MMT LSP、Tinymist、Typst compiler/renderer 与 Webview，不得从 network/previous revision 补洞

## 5. Prompt Update、Safe Restart And Rollback

- [ ] 5.1 waiting worker 只发布 manifest/size；实现“下载更新”和“重启并应用”两步 UI，不自动 staging/skipWaiting/reload
- [ ] 5.2 update staging 复用 origin reservation，保留 active A 与 workspace safety；空间不足在下载 B 前失败
- [x] 5.3 实现 `prepareForReload()`：writer lease、document queue、history edit group、journal/unreconciled/migration gate、preview abort/await 和 session metadata
  - Evidence: `PwaSafeRestartQuiesceAdapter` pauses new document/project work, validates the live writer and workspace metadata gates, flushes the coordinator/document queues, aborts and awaits tracked materialization, persists recovery metadata, then invokes the existing runtime owner's `quiesce()`; `npm run test:pwa-quiesce` covers success、deadline/blocker recovery and concurrent/idempotent calls.
- [ ] 5.4 仅在安全边界发送 `ACTIVATE(buildId)`；worker 调用 `skipWaiting()` 但不自动 `clients.claim()`，接受页面只 reload 一次
- [ ] 5.5 实现 client revision handshake/heartbeat；旧 tab 不强制 reload，previous cache 在所有 A clients 退出前保留
- [ ] 5.6 实现 probation：Workbench/workspace、MMT、Tinymist、Typst smoke、Webview 全通过后 `SHELL_HEALTHY`
- [ ] 5.7 实现 asset-pointer rollback 与 registry/cache crash reconciliation；明确 worker binary 不回滚，schema 至少兼容前一 revision
- [ ] 5.8 用 A/B fixture 验证拒绝更新、dirty/blocked workspace、flush failure、accept、single reload、probation failure、rollback 与 cleanup

## 6. Explicit Offline Pack Installation

- [ ] 6.1 在 pack builder/distribution 生成与 semantic manifest SHA-256 绑定的 `installation-index.json`，列 exact URL/size/MIME/hash/role/total
- [ ] 6.2 对 installation index 增加 deterministic schema/排序/total/已发布文件校验，semantic manifest mismatch 在下载前失败
- [ ] 6.3 实现 not-installed/checking-space/downloading/verifying/staged/active/previous Pack Manager 状态机
- [ ] 6.4 pack 下载必须使用 origin reservation 与 exact CORS/hash/MIME 校验；失败/取消不覆盖 active revision
- [ ] 6.5 实现按 verified bytes 的 progress、pause/resume、remove、repair 和 previous rollback；active pack LRU 删除需用户确认
- [ ] 6.6 将 browser materializer 接到 active pack cache → network fetch abstraction，禁止任意 URL/runtime/API 进入 pack cache
- [ ] 6.7 离线缺 pack/entry、损坏 cache 和 repair failure 只产生 revision-bound preview/build diagnostic，不污染 live language diagnostics

## 7. Storage Pressure、Eviction And Recovery UX

- [ ] 7.1 增加 origin storage dashboard：usage/quota estimate、persisted、protected/reclaimable/reserved、shell/pack revisions 和清理计划
- [ ] 7.2 覆盖 workspace `migration-failed`、`quota/history-blocked`、`history-degraded + unreconciled`、pending/conflict journal 对 staging/activation 的 hard gate
- [ ] 7.3 构造 workspace protected + active shell + pack + 2× update peak，验证不足时拒绝 update而不删除 workspace/history/current shell
- [ ] 7.4 启动时核对 registry/Cache Storage/IndexedDB，处理 orphan staging、pointer missing、cache damage、partial user clearing 和 whole-origin eviction
- [ ] 7.5 recovery 只清理 reproducible caches；workspace 缺失时只显示真实可用的 File System Access/WebDAV/export recovery
- [ ] 7.6 iOS/非 persistent 文案明确 best-effort 和 eviction 风险，不使用“永久离线”或“本地备份”

## 8. Deployment And Cross-platform Verification

- [ ] 8.1 为 Netlify 与生产 Edge/CDN 建立自动 HTTP contract test，覆盖 `/sw.js`、HTML、manifest、shell manifest、hashed assets、MIME、CORS 和 404
- [ ] 8.2 验证 CDN zstd/identity runtime response 在 Service Worker cache 中保持 Content-Encoding/Vary 语义并以 decoded bytes 校验
- [ ] 8.3 运行 `cd editors/vscode-web && npm run check` 以及现有 resource/language projection tests，确保 PWA 不建立第二套 preview/resource 逻辑
- [ ] 8.4 增加并运行 PWA shell、origin storage、pack installer 聚焦 tests 与本地 Playwright offline/update suite
- [ ] 8.5 在 Chrome/Edge Desktop、Android Chromium、macOS Safari、iOS Home Screen 与 Firefox offline Web 执行平台矩阵
- [ ] 8.6 验证安装/离线/update/rollback/pack 状态的可访问名称、进度、取消和错误恢复

## 9. Production Rollout And Archival

- [ ] 9.1 先发布 manifest/root worker/online pass-through，不宣称 offline-ready；观察 registration、scope 与错误率
- [ ] 9.2 通过 Phase 0 后灰度开放显式 shell offline install，再开放 prompt update，最后开放 pack install
- [ ] 9.3 每阶段验证旧客户端、拒绝更新、rollback、unregister 与 origin cleanup，不以清站点数据作为正常迁移步骤
- [ ] 9.4 用当前 build 重新生成 payload/quota report，更新 proposal implementation status 与平台矩阵证据
- [ ] 9.5 全部 requirement 验收后把稳定 capability 合并到正式 specs，并归档本 change 与旧可行性研究状态
