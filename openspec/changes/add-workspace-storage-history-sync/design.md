# Architecture

```text
Monaco / VS Code Workbench        commands / history / status UI
          |                                      |
          v                                      |
MmtWorkspaceFileSystemProvider                    |
          |                                      |
          +------------------+-------------------+
                             v
                  WorkspaceCoordinator <----- WebDavConnector
                             |
                   +---------+---------+
                   |                   |
         active WorkspaceBackend   LocalHistoryStore
                   |
         +---------+---------+
         |                   |
 IndexedDbBackend   FileSystemAccessBackend
```

`MmtWorkspaceFileSystemProvider` 继续暴露现有 `mmtfs://workspace/` authority。语言服务、preview、Explorer
和 Monaco 不感知文件来自哪个 backend。所有 mutation 必须先进入单一、串行的 `WorkspaceCoordinator`；
backend、history、journal 和文件变更事件不能由 UI 各自旁路更新。

## Workspace Identity

每个逻辑工作区有一个由 `crypto.randomUUID()` 生成的稳定 `workspaceId`。它与以下值均不等价：

- IndexedDB database 名；
- 本地目录名、路径或 `FileSystemDirectoryHandle.name`；
- WebDAV endpoint、用户名或远端目录；
- `mmtfs://workspace/` authority。

`WorkspaceRecord` 至少保存：

```ts
interface WorkspaceRecord {
  workspaceId: string;
  displayName: string;
  createdAt: number;
  activeBackend: IndexedDbBackendRef | LocalDirectoryBackendRef;
  backendGeneration: number;
  headSequence: number;
  migrationState?: WorkspaceMigrationState;
}
```

显式“复制当前工作区到本地目录”保留 `workspaceId`，成功切换时递增 `backendGeneration`。显式“打开目录作为新工作区”
生成新 identity。目录重命名、endpoint 改名或重新授权都不能意外生成新 identity。

同一 `workspaceId` 任一时刻只能有一个 active backend。active backend 是当前文件唯一事实来源：

- IndexedDB active 时，`files` store 是当前内容；
- File System Access active 时，用户目录是当前内容，IndexedDB 只保留 handle、history、heads、journal 和同步 metadata；
- WebDAV 只是 connector，不保存或替代当前工作副本；
- 切换完成后的旧 backend 不得继续镜像写入，也不得在权限或网络失败时被静默恢复为 active。

Web 运行时必须按 `workspaceId` 获取 writer lease。优先使用 Web Locks API；无法取得 lease 的页面只读打开，并显示
“此工作区已在另一个标签页写入”。接管必须是显式用户操作，不能由超时自动抢占。

## Backend Contract

```ts
type WorkspaceMutation =
  | { kind: "write"; path: string; bytes: Uint8Array; create: boolean; overwrite: boolean }
  | { kind: "mkdir"; path: string }
  | { kind: "delete"; path: string; recursive: boolean }
  | { kind: "rename"; from: string; to: string; overwrite: boolean };

interface WorkspaceBackend {
  readonly kind: "indexeddb" | "local-directory" | "native";
  readonly capabilities: WorkspaceBackendCapabilities;
  stat(path: string): Promise<WorkspaceEntry>;
  readDirectory(path: string): Promise<WorkspaceEntry[]>;
  readFile(path: string): Promise<Uint8Array>;
  snapshot(signal: AbortSignal): Promise<WorkspaceSnapshot>;
  apply(mutation: WorkspaceMutation, signal: AbortSignal): Promise<MutationResult>;
  dispose(): Promise<void>;
}
```

路径在 coordinator 边界规范化为以 `/` 开头的 project-relative POSIX path。`..`、NUL、空 segment 和越过根目录必须拒绝。
backend 必须报告 case sensitivity 和原子能力；跨 backend 迁移在写入前检测大小写折叠碰撞，不能静默覆盖。

所有 provider mutation 带内部 `reason`：`edit`、`create`、`delete`、`rename`、`restore`、`import`、
`external-change`、`webdav-pull` 或 `backend-migration`。reason 是 history 和 UI metadata，不改变文件 API。

## IndexedDB Version 2

数据库名称继续使用 `momoscript-workspace-v1`，只将 `indexedDB.open(name, 2)` 的 schema version 升为 2，避免创建
一个看似全新的空数据库。现有 `files` store 保持 key 和 payload 兼容；新增 store：

| Store | Key / purpose |
|---|---|
| `workspace-meta` | `workspaceId` 与 active backend、generation、migration marker |
| `history-blobs` | SHA-256 → immutable bytes、size、media hint |
| `history-revisions` | `[workspaceId, sequence]` → timestamp、reason、label、mutable edit-group state |
| `history-changes` | `[workspaceId, sequence, ordinal]` → path、previousPath、before/after hash、entry kind |
| `history-heads` | `[workspaceId, path]` → 当前/最后已观察 hash、mtime、entry kind |
| `operation-journal` | journal id → pending/committed/aborted/conflict operation |
| `sync-baselines` | `[workspaceId, connectorId, path]` → local hash、remote validator、remote existence |
| `directory-handles` | handle id → structured-cloned `FileSystemDirectoryHandle` |

### Resumable v1 → v2 upgrade

`onupgradeneeded` 只创建 store 和 `v1-baseline-pending` marker，不删除、重写或清空 `files`。打开 provider 前执行可恢复的
post-open migration：

1. 读取或生成默认 `workspaceId`；
2. 扫描所有 v1 entries，保留 path、type、ctime、mtime 和 bytes；
3. 分批计算文件 SHA-256，写入 blobs 与 staged heads；
4. 建立一个 `import` baseline revision；
5. 在同一 final transaction 中发布 heads、headSequence 并将 marker 设为 complete；
6. 逐字节核对 `files` store 与 baseline 引用后才允许正常写入。

每批以 deterministic path cursor 和 migration id 记录进度。页面在任意步骤崩溃后必须从 marker 继续，重复执行不得生成重复 revision。
如果 quota、hash 或 transaction 失败，旧 `files` 数据保持可导出，工作区进入明确的 migration-failed/read-only 状态；不得打开一个空工作区，
也不得以 v2 已成功为名继续无历史写入。历史空 `/workspace` compatibility entry 仍按既有合同清理，但任何非空 subtree 都视为用户数据。

## Local History Model

blob 以 SHA-256 内容寻址；revision 是用户可见的时间点；change 记录 before/after hash 和路径变化。`history-heads` 使当前状态无需
回放全部 revisions，也为本地目录外部变化保存最后已知基线。

IndexedDB backend 的写入必须在一个 transaction 中完成：

```text
store after blob
-> create/update revision and changes
-> update history head
-> mutate files
-> commit
-> update memory cache and emit VS Code file events
```

transaction 失败时，当前文件、history head 和用户可见事件都不前进。

高频 `edit` 写入按 `(workspaceId, path)` 聚合为可变 edit group：默认在 5 秒无输入或累计 30 秒时封口；group 保留第一次
`beforeHash` 和最后一次 `afterHash`，中间未再引用 blob 可由 GC 回收。create/delete/rename/import/restore/external-change/
webdav-pull、named checkpoint 和 backend switch 总是封口并创建独立 revision。

恢复操作必须：

1. 读取所选 revision 的 blob/tree；
2. 先为恢复前的当前状态建立 checkpoint；
3. 通过 coordinator 向 active backend 写入；
4. 创建 reason=`restore` 的新 revision；
5. 保留被恢复 revision 和恢复前 checkpoint，不移动或删除旧历史。

首版 Diff 使用 Monaco Diff Editor，文本可逐文件恢复；二进制只提供 metadata、导出和整文件恢复。

## Retention And Quota

Local History 是有界本地数据，不宣称备份。默认 desired budget 为 `min(100 MiB, origin quota estimate * 10%)`，取不到估算时为
50 MiB；实际 allocation 必须由 `add-pwa-offline-runtime` 定义的 `OriginStorageCoordinator` 在 origin-wide inventory 中批准，History
不得独立把 `navigator.storage.estimate()` 当成可支配空间。用户可调整 desired budget 和保留天数，默认普通 revision 保存 30 天。

GC 先删除无人引用 blob，再按最旧的普通 edit groups 回收；不得回收：

- active `history-heads` 引用的 bytes；
- File System Access 最后已观察 tree 的 bytes；
- pending/conflict journal 的 before、intended-after 和 observed blobs；
- 当前 WebDAV sync baseline 所需的 blobs；
- 用户显式 pin 的 checkpoint。

Workspace storage 必须向 origin coordinator 报告：

- protected bytes：current IndexedDB files、active/last-observed heads、pinned checkpoints、pending/conflict journal、sync baseline 和
  unreconciled durable head；
- history-policy-managed bytes：普通 unpinned revisions，只能由 Local History 自身按 retention policy GC；
- reclaimable workspace cache（若未来存在）：必须与 user/history data 分开；
- `migration-failed`、`quota/history-blocked`、`history-degraded + unreconciled`、pending/conflict journal 与 writer/flush 状态。

Shell/pack installer 不得直接删除 History 或调用 History GC 为下载让路。上述 blocked/degraded/recovery 状态是 PWA staging/activation 的 hard
gate；状态恢复后外部 installer 必须重新申请 inventory/reservation，不能复用旧 estimate。

若 pinned data 已超过预算，UI 必须显示实际占用和原因。coordinator 在 mutation 前尝试 GC；仍无法为安全 revision/journal 分配空间时，
必须报告 quota/history blocked，而不是静默执行未记录的 provider mutation。外部程序绕过 provider 修改本地目录时无法提前阻止，因此任何
阻止稳定 external observation 写入 history 的持久化失败都使用下文唯一的 unreconciled 例外；该例外只能保持磁盘事实可见，不能把未记录
状态伪装成完整 history。

## File System Access Backend

`showDirectoryPicker()` 只能从用户手势触发。成功后将 handle structured-clone 到 `directory-handles`，启动时先调用
`queryPermission({ mode: "readwrite" })`：

- `granted`：扫描并打开；
- `prompt`：显示“重新授权”，仅在用户点击后调用 `requestPermission()`；
- `denied` 或 handle 不可用：active backend 进入 unavailable，不切到 IndexedDB，不创建空目录。

权限失效时，已经打开的 Monaco model 可以保持内存内容和 dirty 状态，但所有持久化 mutation 必须失败并显示状态。用户可选择重新授权、
导出内存文本，或把 Local History 中最后已知 snapshot 显式复制到 IndexedDB；后者是一个新的 backend migration，不是自动 fallback。

### Cross-system write-ahead journal

本地磁盘和 IndexedDB 没有跨系统 transaction。每个 FSA mutation 按以下顺序执行：

```text
1. 读取并 hash 受影响路径，确保 before state 等于 history head
2. 在 IndexedDB transaction 中保存 before/intended-after blobs 和 pending journal
3. 执行磁盘 write/delete/rename；关闭 writable stream
4. 重新读取受影响路径并 hash 验证 expected-after tree
5. 在 IndexedDB transaction 中提交 revision、heads，并把 journal 标为 committed
6. 更新 provider cache，发出文件事件
```

rename 在 File System Access API 不能原子移动时实现为 journaled copy + verified delete。目录递归操作把确定性 path manifest 写入 journal，
不能只记录顶层名称。

启动时必须在发布工作区前恢复 pending journal：

| 实际磁盘状态 | 恢复结果 |
|---|---|
| 完全等于 expected-after | 补提 revision/head，标记 committed |
| 完全等于 before | 标记 aborted，保留 intended-after blob 并提示用户重试或丢弃 |
| 混合状态或两者均不等 | 保存 observed blobs，标记 conflict，不自动覆盖任何一侧 |

恢复判断只使用 hashes、entry kinds 和完整受影响 path set，不能使用 mtime 猜测成功。

## External Changes

本地目录可能被 VS Code、Git、文件管理器或其他程序绕过 provider 修改。首版在以下时机重扫：

- 页面从 hidden 变为 visible 或重新获得 focus；
- 用户执行“刷新工作区”；
- WebDAV sync 开始前；
- read/preview 遇到缺失或 metadata 不一致。

`FileSystemObserver` 若可用只能缩短发现延迟，不能成为正确性前提。重扫先比较 path/kind/size/mtime，随后对候选变化计算 hash。正常路径下，
最终差异必须以一个或多个 reason=`external-change` revision 写入 history，之后才更新 durable heads、cache 和 VS Code file events。
删除文件的 before blob 由最后已知 head 保留。无法取得稳定 file identity 时，首版把外部 rename 表示为 delete + create，不根据相同
hash/mtime 猜测 rename。

若 quota exhaustion、IndexedDB transaction abort、storage I/O error 或其他 history persistence failure 阻止 external-change revision，
磁盘仍是 active backend 的事实来源：provider 必须把最新稳定的 observed state 发布给 read/cache/events/preview，同时设置
`history-degraded + unreconciled` overlay，保留并 pin 最后一个 durable head，且不声称 observed state 已进入历史。UI 必须区分
quota-blocked、可重试 transaction/I/O error 与持久不可用状态，并显示最近一次失败原因和安全重试动作。

普通 coordinator mutations 在 unreconciled 状态下被阻止，只允许释放容量、重试 history persistence、导出和恢复操作。重试前必须再次
扫描 active directory 得到最新稳定状态；持久化恢复后，从最后 durable head 到该最新 observed state 补写一个幂等 delayed
external-change revision，更新 head 并清除 degraded 状态。degraded 期间的中间外部版本可能无法恢复，UI 必须明确这一事实。

扫描过程中再次变化时丢弃该扫描并重试；达到重试上限后显示“目录持续变化”，不发布混合 snapshot。

## Backend Migration

“复制当前工作区到本地目录”和“复制到浏览器存储”是显式、可预览的迁移：

1. 获取目标权限并扫描目标；
2. 检测同名、大小写折叠、非法路径和空间冲突；
3. 显示 overwrite/skip/cancel 计划，默认 cancel；
4. 创建 pinned `backend-migration` checkpoint；
5. journaled 写入 staging/target，并逐文件 hash 验证；
6. 在 IndexedDB transaction 中切换 `activeBackend`、递增 generation、更新 heads；
7. 重新绑定 provider，确认读回后才退休旧 backend 当前文件。

失败时 active backend 和 generation 不变。成功后旧 backend 不继续双写；它的 checkpoint 可以由历史保留。目标目录已含内容且用户选择 merge 时，
每个覆盖/保留决定进入 migration revision。

## WebDAV Connector

WebDAV connector 以 `connectorId` 绑定 `workspaceId`，只保存无凭据 endpoint、remote root、能力和 per-path baseline。浏览器密码/token
默认只保留在内存会话；Desktop 后续可用 VS Code `SecretStorage`。URL 中的 userinfo 必须拒绝，endpoint 默认要求 HTTPS（loopback 开发
例外），redirect 后的 origin/root 必须重新验证。

首版流程只由用户触发：

```text
acquire workspace writer lease
-> flush edit groups
-> rescan active backend
-> Local History named checkpoint
-> PROPFIND/list remote tree
-> compare local hash / last baseline / remote ETag
-> plan pull, push, delete, conflict
-> show plan
-> execute accepted operations through coordinator
-> update baseline only after verified success
```

PUT/DELETE/MOVE 使用 `If-Match` 或 `If-None-Match`。412/409、ETag 变化、remote redirect 或 body mismatch 都进入 conflict，不覆盖本地或远端。
服务器没有可靠 validator 时 connector 标记为 unsafe：默认只允许 pull 和创建不存在的远端文件；覆盖/删除必须逐项显式 force，UI 不宣称冲突安全。

首版不做自动文本 merge。双边变化时保留当前本地文件与远端原内容，将远端版本作为安全命名的 conflict copy 写入 active workspace，并打开 Diff。
远端保持未修改，直到用户选择结果并再次条件 push。所有 pull、conflict copy 和用户决议都经过 coordinator，形成 history revision。

同步范围是 provider 暴露的用户工作区文件；pack/resource cache、WASM、字体、history stores、journals、handles 和 preview 临时产物永不上传。
网络或认证失败不得阻塞语言服务、已打开文档或 preview，也不得把远端空响应解释为删除整个本地工作区。

## UI Contract

最少提供：

- 当前 workspace 名称、workspaceId 的短标识和 active backend；
- `浏览器存储`、`本地目录：已授权/需授权/不可用`；
- `打开目录作为新工作区`、`复制当前工作区到目录`、`复制到浏览器存储`、`重新授权`；
- Local History 列表、checkpoint、Diff、整文件恢复、导出、容量和 GC；
- pending/aborted/conflict journal 恢复界面；
- WebDAV `测试连接`、`同步预览`、`立即同步`、conflict 和最后成功时间；
- writer lease、migration、history-degraded 和 quota-blocked 状态。

任何 backend switch、force WebDAV operation、history 清理、冲突覆盖或权限请求必须由明确用户动作触发。

## Verification Strategy

- 用真实 version-1 IndexedDB fixture 建库，升级后逐路径、逐字节和 ctime/mtime 比对；在每个 migration batch 中断并验证可恢复/幂等。
- 用 fault-injecting backend 验证 IndexedDB transaction 不产生半个 revision、journal 的 before/after/mixed 状态矩阵，以及 rename/delete path set。
- 在 Chromium E2E 中验证目录选择、handle 恢复、permission prompt/denied、无静默 fallback、外部 create/change/delete 和 reload。
- 用两个页面验证 writer lease 与显式接管。
- 用受控 WebDAV fixture server 验证 PROPFIND、ETag 条件 PUT、412、无 ETag degraded mode、CORS/auth failure、conflict copy 和断网恢复。
- 保留既有生产 Web 验证：`npm run check`、resource/language projection tests 和本地 Playwright；新增 suite 必须覆盖 reload 后文本与 history 恢复。

## Deferred Decisions

以下只允许在对应实现阶段补 spec，不得被实现悄悄决定：

- 多工作区切换 UI 是否保留最近列表，还是首版仅保留一个 active workspace；
- 历史跨设备导出/导入格式；
- Desktop native adapter 的 watcher 与 SecretStorage 细节；
- 自动 WebDAV 调度、后台 Service Worker sync 和自动文本三方合并；
- 稳定 `FileSystemObserver` 可用后是否降低 focus rescan 频率。
