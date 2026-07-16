# Why

生产 Web 编辑器当前由 `MmtIndexedDbFileSystemProvider` 直接把工作区文件写入单一 IndexedDB
`files` store。它已经保证同一文档的变更按顺序持久化，但还没有以下边界：

- 用户误删、误覆盖或重命名文件后没有 Local History 可恢复；
- 浏览器工作区不能显式切换到用户选择的真实本地目录；
- IndexedDB、目录 handle、权限恢复和未来 Desktop 原生目录之间没有统一 backend contract；
- 没有跨设备同步连接器，也没有 ETag、条件写入和冲突检查点；
- 如果直接增加本地目录或 WebDAV 双写，会出现多个“当前版本”、部分写入和静默分叉。

这些能力会改变存储 schema、公开工作流和故障恢复语义，必须先把可验收合同固定下来，再分阶段实现。

# What Changes

- 在 VS Code Workbench `FileSystemProvider` 下面增加统一 `WorkspaceCoordinator` 和可切换
  `WorkspaceBackend`；第一批 backend 为现有 IndexedDB 与浏览器 File System Access 本地目录。
- 为逻辑工作区分配稳定、不可由目录名或 WebDAV URL 推导的 `workspaceId`，并明确任一时刻只有一个
  active backend 是当前文件的事实来源。
- 将 `momoscript-workspace-v1` 的 IndexedDB schema 无损升级到 version 2，增加 workspace metadata、
  content-addressed blobs、revisions、changes、heads、operation journal 和同步基线；保留并迁移所有 v1 文件字节与元数据。
- 增加 IntelliJ 风格 Local History：覆盖编辑、创建、删除、重命名、恢复、导入、外部目录变化和 WebDAV pull；
  恢复本身生成新 revision，不改写既有历史。
- 增加 File System Access backend：显式目录选择、handle 持久化、重新授权、外部变化重扫，以及跨
  IndexedDB/本地磁盘的 write-ahead journal 和崩溃恢复。
- 增加 WebDAV connector。它通过 coordinator 读写当前 backend，而不是成为第三份镜像或替代 backend；
  第一阶段只做手动同步、条件请求、同步前检查点和显式冲突结果。
- 增加工作区后端、权限、历史容量、待恢复 journal、同步状态和冲突的可见 UI；任何降级或切换都不得静默发生。

# Implementation Status

本 change 当前只有设计与 spec delta，尚未修改生产存储实现。任务全部保持未完成，直到对应行为有聚焦测试和浏览器验收证据。

# Scope

第一条实施主线是 `editors/vscode-web/` 的生产 Web 编辑器：

1. backend abstraction 与 v1 → v2 无损升级；
2. IndexedDB Local History、恢复和容量治理；
3. File System Access backend、权限恢复、journal 与外部变化；
4. 手动 WebDAV 同步与冲突处理；
5. 证明同一 coordinator contract 可由 Desktop 原生文件系统 adapter 复用，但本 change 不要求替换 VS Code Desktop 自己的 workspace filesystem。

# Cross-change Implementation Order

Local History 的实际 origin allocation 依赖 `add-pwa-offline-runtime` 定义的共享 `OriginStorageCoordinator`，但 workspace backend、v2
schema migration 和 history data model 不依赖 PWA shell。顺序固定为：

1. 先落地 PWA change task 0.2 的 shell-agnostic coordinator interface、durable inventory/reservation foundation；
2. 再执行本 change task 3.5/3.6，先注册 protected/history-policy-managed bytes 和 blocked/degraded states，再原子更新 inventory 并申请 History desired budget；
3. 最后开放 PWA shell/pack 的大体积 staging 与 eviction plan。

任一 change 可以承载第 1 步的共享模块实现，但必须满足同一 spec/contract test；禁止为赶进度在 History 内加入临时独立 allocator，
也禁止 PWA 在 workspace inventory 尚未接入时启用生产 shell/pack download。

# Non-Goals

- 不实现 Git object database、commit、branch、merge、rebase 或 remote 协议。
- 不实现实时协作、CRDT、多主自动合并或后台无提示同步。
- Local History 不是远端备份；历史数据库默认不上传到 WebDAV。
- 不把 pack cache、WASM、字体、预览临时产物或 Service Worker cache 纳入工作区同步。
- 不在不支持 `showDirectoryPicker()` 的浏览器伪造本地目录能力；IndexedDB backend 必须继续完整可用。
- 不承诺连接任意 WebDAV 服务。浏览器端仍受 HTTPS、CORS、认证方式和服务器条件请求能力限制。

# Impact

- 生产 Web：`editors/vscode-web/src/filesystem.ts`、启动/命令/UI、浏览器 E2E 与新增 workspace storage modules。
- 存储：IndexedDB database 名称保持 `momoscript-workspace-v1`，schema version 升为 2；升级不能删除 v1 `files` 数据。
- 平台 API：IndexedDB、Web Locks、File System Access、StorageManager、Fetch/WebDAV。
- 安全：本地目录权限必须由用户手势授予；WebDAV endpoint 默认要求 HTTPS；凭据不得明文持久化到 workspace database。
- 既有合同：`mmtfs://workspace/` authority、根路径 `/`、按 source order 持久化和 reload 恢复必须继续成立。
