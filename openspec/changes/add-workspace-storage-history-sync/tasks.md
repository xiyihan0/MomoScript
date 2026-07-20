## 1. Storage Foundation

- [x] 1.1 从 `MmtIndexedDbFileSystemProvider` 提取 `WorkspaceCoordinator`、`WorkspaceBackend` 与统一 mutation reason，不改变 `mmtfs://workspace/` URI 或现有 reload 行为
- [x] 1.2 定义稳定 `workspaceId`、backend generation、path normalization/case capability 和 active-backend metadata
- [x] 1.3 为每个 workspace 增加 Web Locks writer lease、第二标签页只读状态与显式接管流程
- [x] 1.4 增加 contract tests，使用同一 mutation transcript 验证 provider 与 IndexedDB backend 的 stat/read/write/mkdir/delete/rename/event 行为
- [x] 1.5 运行 `npm run check` 与本地生产 Web E2E，证明第一切片只重构边界、不改变编辑、preview、Explorer 和 reload
  - Evidence (2026-07-18): `cd editors/vscode-web && npm run check && npm run test:e2e` passes with 3 production-like Chromium scenarios. The editor scenario exercises persisted editing、Explorer、preview、output/problems and reload against the extracted coordinator/backend; `npm run test:e2e:pwa-offline` separately proves a closed/reopened production editor can cold-start and edit from the cached shell.

## 2. IndexedDB Version 2 Migration

- [x] 2.1 在原 `momoscript-workspace-v1` database 上创建 version-2 metadata、blob、revision、change、head、journal、sync baseline 和 handle stores
- [x] 2.2 实现 `v1-baseline-pending` 两阶段迁移、deterministic batch cursor、幂等 resume 和 final publish transaction
- [x] 2.3 建立真实 version-1 fixture，逐路径比对 type/ctime/mtime/bytes，并覆盖历史空 `/workspace` 与非空 subtree
- [x] 2.4 在每个 migration 阶段注入 transaction abort、reload、quota/hash failure，验证旧 `files` 保留、单一 baseline 和 read-only recovery/export
- [x] 2.5 验证已有生产 IndexedDB workspace 在升级后重开最新 `.mmt` / `.typ` 文本并正常驱动 preview

## 3. Local History Engine

- [x] 3.1 实现 SHA-256 blob store、revision/change/head model 与 IndexedDB current-file/history 单 transaction mutation
- [x] 3.2 实现 5 秒 idle / 30 秒最大时长的普通 edit grouping，并保证 destructive、external、sync、checkpoint、restore 和 migration 边界封口
- [x] 3.3 覆盖 create/write/delete/recursive delete/rename/overwrite/import 的 before/after tree 与 source-order history
- [x] 3.4 实现 named checkpoint、文本 Diff、整文件/树恢复；恢复前 checkpoint 与 `restore` revision 不得改写旧历史
- [x] 3.5 依赖 `add-pwa-offline-runtime` task 0.2 注册 protected/history-policy-managed bytes、writer/flush、migration、journal、quota-blocked 与 unreconciled states
- [x] 3.6 在同一 coordinator mutation 中先更新 inventory 再申请 History allocation，实现 desired budget、30 天保留、unreferenced blob GC 和 protected-root pinning
- [x] 3.7 注入 quota/transaction/coordinator failure，验证普通 mutation 不会在 inventory、reservation、current bytes、heads、revision 和 file event 之间部分提交
- [x] 3.8 用 shell/pack reservation fixture 验证外部 installer 不能删除 History、触发 History GC 或复用 blocked/degraded 前的旧 inventory

Focused evidence (2026-07-17): `npm run test:workspace-atomic-apply` covers deterministic backend/path transcript, resumable/idempotent migration and injected hash failure, SHA-256 history/edit grouping/tree/checkpoint/diff/restore, quota atomicity, and second-target rollback plus rollback-failure blocking. `npm run test:origin-storage` covers durable workspace/history inventory, desired History budget, shell/pack protection, and blocked-state fresh-inventory gates.

## 4. Local History UX

- [ ] 4.1 增加 workspace/status UI，显示 identity 短标识、backend、writer lease、history bytes/budget 和 quota/degraded 状态
- [ ] 4.2 增加按文件/工作区浏览 revision、创建 checkpoint、Diff、恢复、导出和清理历史命令
- [ ] 4.3 对二进制历史提供 metadata、导出和整文件恢复，不尝试文本 Diff
- [ ] 4.4 用 Playwright 验证编辑→历史→Diff→恢复→reload，且 preview 使用恢复后的持久内容
- [ ] 4.5 验证清理 pinned state、超预算写入和 writer takeover 都有明确确认与可访问状态

Implementation progress (2026-07-20): the Web Workbench now exposes workspace identity/backend/lease and History bytes in a dedicated Local History Activity Bar view, separate from the compact MomoScript project-settings view. The native-styled timeline supports current-file/workspace scopes, type filters, named checkpoint creation, native `vscode.diff` over read-only `mmt-history:` documents, guarded file/workspace restore, and binary export/whole-file restore. `npm run test:e2e -- editor.spec.ts` proves the production Explorer, MomoScript, and Local History sidebar entries switch independently. Browser smoke additionally exercised the dedicated views, checkpoint creation, and a real native Diff editor. Tasks 4.1–4.5 remain open until origin-coordinator budget/GC controls, complete binary metadata, restore→reload preview E2E, and writer/quota confirmation coverage are all closed.

## 5. File System Access Backend

- [ ] 5.1 实现目录 picker、structured-cloned handle、`queryPermission` / 用户手势 `requestPermission` 与 unsupported-browser capability gating
- [ ] 5.2 实现 local-directory stat/read/list/write/mkdir/delete/rename contract，检测非法 path、大小写碰撞和递归 path manifest
- [ ] 5.3 实现 write-ahead journal：before/intended blobs、pending write、disk hash verification、revision/head finalize 和 provider event ordering
- [ ] 5.4 对 write/delete/recursive delete/copy+delete rename 注入崩溃，覆盖 actual=before、actual=after、mixed/third state 三类恢复
- [ ] 5.5 实现 journal aborted/conflict UI，保留 intended 与 observed bytes，禁止自动覆盖
- [ ] 5.6 验证 permission prompt/denied/handle missing 不静默切 IndexedDB，打开的内存文档只显示 dirty 并提供 reauthorize/export/显式迁移

## 6. External Change Reconciliation

- [ ] 6.1 实现 focus、visibility、手动刷新、sync 前和 read/preview mismatch 触发的稳定 snapshot rescan
- [ ] 6.2 以 path/kind/size/mtime 筛候选并以 hash 定最终差异；不依赖 `FileSystemObserver` 或 mtime 判断正确性
- [ ] 6.3 在更新 cache/head/event 前提交 `external-change` revision，覆盖 create、modify、delete 和 delete+create rename 表示
- [ ] 6.4 实现通用 unreconciled exception：任何 history persistence failure 都发布稳定磁盘事实、pin 旧 head、标记 degraded 并阻止普通写入
- [ ] 6.5 分类 quota-blocked、可重试 transaction/I/O 与持久不可用状态；注入各类失败，验证重扫后补写幂等 delayed external-change
- [ ] 6.6 用真实 Chromium 目录或等价 browser fixture 验证页面隐藏期间外改、持续变化重试上限、preview refresh 与 reload

## 7. Verified Backend Migration

- [ ] 7.1 实现“打开目录作为新工作区”“复制当前工作区到目录”“复制到浏览器存储”三条不同命令
- [ ] 7.2 实现目标扫描、per-path overwrite/skip/cancel 计划、默认 cancel 与 pinned migration checkpoint
- [ ] 7.3 实现 journaled copy、逐文件 hash、active backend/generation 单 transaction 切换和新 provider read-back
- [ ] 7.4 注入目标写入/验证/metadata switch failure，证明旧 backend 保持 active、失败目标不双写
- [ ] 7.5 成功迁移后验证 identity 不变、generation 只增一次、旧 backend 退休且 reload 打开新 backend

## 8. Manual WebDAV Connector

- [ ] 8.1 定义无凭据 connector profile、HTTPS/loopback URL policy、redirect root 校验和 browser session-only credential flow
- [ ] 8.2 实现 CORS/auth/capability probe、PROPFIND tree normalization 和 per-path local hash/remote validator/sync baseline
- [ ] 8.3 实现 sync preview：writer lease、flush、rescan、checkpoint 和 local/base/remote 三方计划，用户接受前不写入
- [ ] 8.4 通过 coordinator 实现 pull、create PUT、conditional overwrite/delete/MOVE，并只在 verified success 后推进 baseline
- [ ] 8.5 实现 409/412/validator change conflict、无 validator unsafe mode、remote conflict copy 和 Monaco Diff；首版不自动 merge
- [ ] 8.6 验证 pack cache、WASM、字体、history、journal、handle 和 preview artifact 永不进入 remote plan
- [ ] 8.7 用受控 WebDAV server 覆盖网络/CORS/auth、空或异常 listing、ETag race、断网中断、冲突决议与重试

## 9. Cross-host Contract And Final Verification

- [ ] 9.1 以最小 fake/native adapter 证明 Desktop 原生 workspace 可复用 coordinator/history contract，且不替换 VS Code Desktop 自身 filesystem
- [ ] 9.2 运行 `cd editors/vscode-web && npm run check && npm run test:resource-cache && npm run test:language-projection`
- [ ] 9.3 运行聚焦 workspace/history/FSA/WebDAV tests 和 `npm run test:e2e`，保留 migration、journal、external change 与 conflict 的可观察证据
- [ ] 9.4 在支持与不支持 File System Access 的浏览器路径验证 IndexedDB、Local History、权限 UI 和 capability gating
- [ ] 9.5 将稳定 requirement 合并到正式 capability spec，更新 proposal implementation status，并仅在全部验收后归档本 change
