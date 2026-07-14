## 1. Shared Language Service

- [x] 1.1 实现 versioned document store 与 full-sync snapshots
- [x] 1.2 实现 UTF-8/UTF-16 position codec 和中文/surrogate tests
- [x] 1.3 实现 syntax diagnostics、document symbols 和 folding ranges
- [x] 1.4 定义 revision-bound preview scheduler interface，不阻塞语言查询

## 2. LSP Transports

- [x] 2.1 实现 initialize/shutdown、didOpen/didChange/didClose 和基础 request dispatch
- [x] 2.2 实现 native stdio binary
- [x] 2.3 实现 WASM request/notification bridge
- [x] 2.4 用同一 transcript fixture 对比 native/shared behavior

## 3. VS Code

- [x] 3.1 建立 Desktop/Web 双入口和共享 language client 配置
- [x] 3.2 建立 browser Worker bridge
- [x] 3.3 添加 `.mmt` language configuration 与 TextMate grammar
- [x] 3.4 Desktop/Web build 均通过且不在 Web bundle 引入 Node API

## 4. Reliability And Runtime

- [x] 4.1 统一 native/WASM notification error、bridge parse error 与 snapshot preservation
- [x] 4.2 将 diagnostic labels 映射为 LSP related information
- [x] 4.3 实现顶层 directive、mode 和 actor/asset field completion
- [x] 4.4 增加真实 Chrome Worker/WASM transcript 并修复 initialize startup race
- [x] 4.5 增加 VS Code Web Extension Host runtime transcript
- [x] 4.6 固化跨平台 binary layout 并移除 Bash-only 构建入口

## 5. Next Milestone

- [x] 5.1 实现 no-I/O Typst projection 与双向 `ProjectionSegment`
- [x] 5.2 原型验证固定 Tinymist native/WASM sidecar
- [x] 5.3 接入 Typst diagnostics/completion/hover/signature help
- [x] 5.4 使用 Desktop/Web 恢复性 fixture 验证 full emission，并固化触发 region A/B 的失败门槛

## 6. Backend Recovery

- [x] 6.1 实现 Tinymist Web Worker 运行时重启与最新虚拟工程 replay
- [x] 6.2 增加真实浏览器 restart transcript，验证重启前后 completion 一致

## 7. Host Backend Hardening

- [x] 7.1 明确 VS Code host coordinator 边界并删除未使用的 Rust backend transport façade
- [x] 7.2 校验 host protocol、Tinymist `0.15.2` 与 completion/hover/signature capabilities
- [x] 7.3 projection 构建失败时关闭旧 virtual project 并清除 host diagnostics
- [x] 7.4 按 JSON-RPC 方法响应 Tinymist server request，未知方法返回 `-32601`
- [x] 7.5 将 VS Code cancellation 转换为 Tinymist `$/cancelRequest`
- [x] 7.6 实现 native process restart、initialize 与最新 virtual project replay
- [x] 7.7 增加 native/Web transcript 与 Desktop/Web Extension Host 回归验证

## 8. Remote Pack Completion

- [x] 8.1 定义 host 加载原始 pack-v3 manifest、Rust 原子安装 registry 的传输合同
- [x] 8.2 实现 `mmt/updatePackManifests` 与失败时保留最后有效 registry
- [x] 8.3 实现 actor block `preset:` 字段的 canonical entity completion
- [x] 8.4 Desktop/Web 加载默认 BA Kivo manifest 并保留有效缓存
- [x] 8.5 增加 native/WASM transcript 和 Web Extension Host 回归验证

## 9. Production Web Editor

- [x] 9.1 使用 Monaco/VS Code Workbench 替换旧 React 编辑器生产入口
- [x] 9.2 将工作区文件与已确认的 pack manifest 持久化到 IndexedDB
- [x] 9.3 分离 no-I/O Tinymist projection 与真实资源 render project
- [x] 9.4 从 pack-v3 `image-dir` storage 安全下载并注入真实人物头像
- [x] 9.5 增加资源大小、路径、HTTPS、redirect 与 stale revision 防护
- [x] 9.6 增加 Browser Worker render-project transcript 与真实浏览器头像/刷新验收

## 10. Diagnostics And Runtime Closure

- [ ] 10.1 将 syntax、mode、actor、asset、resource、pack resolve/planning 与 placeholder Typst-check 收束为单一 live diagnostic 集合，替换当前 syntax+actor 子集并避免重复
- [ ] 10.2 让 language projection 与 render project 共享同一次 parse/analysis 和 position index，删除每次变更的重复 parse/index
- [ ] 10.3 为 `TypstRenderProjectUpdate` 增加 source-version/revision-bound resolve/planning diagnostics，并保留 phase、labels 与 authored range
- [ ] 10.4 将 Web fetch、AVIFS decode 与最终 render/layout failure 建模为独立 preview/build diagnostics，拒绝旧 revision 覆盖
- [ ] 10.5 建立生产 Web runtime owner、逆序启动失败 rollback、可等待 graceful dispose 与 unload/HMR 同步 Worker terminate 保底
- [ ] 10.6 消除 Web 标准 `didChange` + 同版本 `mmt/updateDocument` 的双路同步；保持 `version <= current.version` 幂等拒绝，不以同版本重建 snapshot
- [ ] 10.7 增加 live/render diagnostic 去重、pack resolve/planning、资源 I/O failure、runtime reload/HMR 与双路同步迁移的聚焦回归
