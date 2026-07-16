# Why

`editors/vscode-web/` 已是生产 Web 编辑器，但当前只是在线 Web 应用。仓库中已有
`add-mmt-lsp-vscode/pwa-feasibility-and-design.md` 可行性研究，尚未形成可以实施和验收的 capability delta。

2026-07-16 的代码与生产检查显示：

- `index.html` 没有 Web App Manifest link，仓库没有 PWA icons、根 Service Worker 或注册逻辑；
- `https://mms.xiyihan.cn/` 在编辑器 ready 后仍无 Service Worker registration、controller 或 Cache Storage，origin storage 未获 persistence；
- 当前本地 `dist` 为 188 个文件、约 57.80 MiB、无 source map；启动还依赖跨域 Tinymist WASM，preview 首次使用时依赖跨域 Typst compiler WASM；
- 当前 `IndexedDbPackCache` 只保存 active/staging manifest JSON 与 ETag，实际 pack resource bytes 只存在页面内请求/字符串缓存；
- 当前卸载路径在 `beforeunload` 中调用异步 dispose 但不等待，也没有可供 PWA update 使用的 workspace flush/quiesce 合同；
- IndexedDB、Cache Storage 和未来 OPFS 在同一 origin quota/eviction pool 中，但现有 workspace、history、shell 和 pack 设计没有统一容量协调器。

直接加入宽泛 precache 或自动 `skipWaiting()` 会带来约 100 MiB 级下载、旧 JS/新 WASM 混用、编辑中 reload、更新峰值挤占
workspace/history，以及 pack cache 与应用壳相互驱逐。需要独立 change 固定安装、离线、更新、配额和恢复语义。

# What Changes

- 增加正式 Web App Manifest、192/512/maskable icons 和 progressive install UI；浏览器安装状态与“完整离线运行时已安装”状态严格分离。
- 使用 `vite-plugin-pwa` 的 `injectManifest` 构建自定义根 Service Worker；保持 prompt update，不启用自动 update/skipWaiting/reload。
- 构建版本化 shell manifest，覆盖本地 Workbench/Workers/WASM/fonts/Webview bootstrap，以及经过完整性验证的跨域 Tinymist/Typst runtime artifacts；source maps、workspace 和 pack 不进入 shell。
- 首次 root worker 只安装有界 bootstrap/recovery 响应。完整 shell 必须由用户显式启用离线后，经 origin-wide storage reservation 才能 staging。
- 增加 `PwaUpdateCoordinator`：download/verify 与 restart 分阶段；restart 前等待 workspace、history 和 runtime owner 安全 quiesce，再激活 waiting worker 并执行一次受控 reload。
- 增加 shell active/previous/staging registry、probation health check 和 asset-level rollback；新 worker 不自动 `clients.claim()`，旧客户端使用的完整 revision 不提前清理。
- 增加 `OriginStorageCoordinator`，统一核算应用壳、offline packs、IndexedDB workspace/history、journals 和 staging peak；PWA/pack installer 只能回收可再生成 cache，不能删除 workspace protected bytes 或独立消耗 `StorageManager` 估算。
- 增加显式 Pack Offline Installer。pack-v3 分发侧提供与 semantic manifest revision 绑定的 installation index，列出 exact URL、size、MIME 和 SHA-256；pack assets 不进入应用 shell precache。
- 增加完全离线启动、缺 pack、缓存损坏、origin eviction、更新接受/拒绝、根 worker 与 VS Code Webview worker 共存的可见状态和验收矩阵。
- 为 Netlify 与当前生产 origin 建立同一部署合同：HTML/worker/manifest 重验证、hashed assets immutable、正确 MIME、仅 navigation fallback、真实 404 和跨域 runtime/pack CORS。

# Implementation Status

本 change 当前只有 proposal、architecture、spec delta 与任务清单。生产代码尚未注册根 Service Worker，也未声明离线可用。

已有研究文档 `openspec/changes/add-mmt-lsp-vscode/pwa-feasibility-and-design.md` 继续作为体积与平台研究输入；正式实施合同以本 change 的
`specs/pwa-runtime/spec.md` 为准。研究文档中“约 2 倍 payload”只用于估算，不能替代本 change 的 origin-wide protected/reclaimable inventory 与 reservation。

# Scope

实施按四条可独立验收的能力推进：

1. manifest、root worker prototype、production-like headers 与 Webview worker 共存决策门；
2. 显式安装的、可完整离线启动的版本化应用壳；
3. prompt update、safe restart、probation 和 asset rollback；
4. 显式 pack installation、repair/remove 与平台/驱逐硬化。

Phase 0 的 manifest、bounded root worker 和 deployment prototype 可以独立进行；任何大体积 shell/pack staging 或 update activation 必须按以下
跨 change 顺序：

1. 本 change task 0.2 先落地 shell-agnostic `OriginStorageCoordinator` interface、durable inventory/reservation foundation；
2. `add-workspace-storage-history-sync` task 3.5/3.6 再先注册 protected/history-policy-managed bytes、`quota-blocked` / `history-degraded + unreconciled` / journal state，随后原子更新 inventory 并申请 History allocation；
3. 本 change Phase 3–6 才能启用 shell/pack reservation、download、eviction 和 update activation。

update activation 还依赖 `add-mmt-lsp-vscode` 的单一 Web runtime owner、可等待 graceful dispose 和同步 terminate fallback。任一 change
可以承载共享 coordinator foundation 的代码，但不得建立第二套 allocator 或以临时 estimate-only 路径绕开顺序。

# Non-Goals

- 不打包 Microsoft Store、Google Play、App Store 或 TWA/WKWebView 原生壳。
- 不实现 Push、Periodic Background Sync、后台 WebDAV、实时协作或通知。
- 不自动下载完整资源包，不把 150–350 MiB pack 目录加入 shell precache。
- 不把 Cache Storage、IndexedDB 或 `navigator.storage.persist()` 宣传为永久备份。
- 不自动 `skipWaiting()`、`clients.claim()` 或刷新正在编辑的客户端。
- 不缓存任意跨域请求、WebDAV credentials/API、错误 HTML、opaque response 或未知 redirect。
- 不要求 Firefox 提供 manifest 原生安装；Firefox 仍应支持普通网页与已准备资源的离线启动。
- 不在本 change 中定义新的 pack semantic/resolver 行为；installation index 是分发 metadata，不进入 MMT language core。

# Impact

- Web build/runtime：`editors/vscode-web/{vite.config.ts,index.html,src/,public/,scripts/,e2e/}` 与新增 PWA modules/tests。
- 依赖：新增 `vite-plugin-pwa`/Workbox build/runtime 组件，版本必须固定并由 lockfile 管理。
- 部署：`netlify.toml` 以及生产 Edge/CDN 同等规则；root `/sw.js`、manifest、runtime manifest、MIME、CORS 与 cache headers。
- Workspace：`add-workspace-storage-history-sync` 必须向 origin coordinator 报告 protected/reclaimable bytes 和 blocked/degraded state。
- Pack：`design-resource-pack-v3` builder/distribution 增加 installation index、total bytes 与 exact hash/MIME 清单。
- 安全：Service Worker 只服务 exact manifest entries；跨域 runtime 和 pack response 必须验证 status、CORS、redirect、MIME、size、hash。
- 既有语言/预览边界保持不变：离线缺资源属于 revision-bound preview/build diagnostic，不成为 syntax/live editor diagnostic。
