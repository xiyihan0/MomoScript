# MomoScript VS Code

VS Code Desktop 和 Web 共用 `mmt_lsp` language service。Desktop 启动 native stdio binary，Web
通过 `vscode-languageclient/browser`、Worker 和 Rust/WASM bridge 使用同一套 parser behavior。

编辑器跨包架构、运行形态与验证入口见 [编辑器系统指南](../README.md)。

```bash
npm install
npm run check
npm run test:grammar
npm run test:worker
TINYMIST_BIN=/path/to/tinymist npm run test:tinymist-process
TINYMIST_WEB_PKG="$PWD/vendor/tinymist-0.15.4-rc3" npm run test:tinymist-worker
TINYMIST_WEB_PKG="$PWD/vendor/tinymist-0.15.4-rc3" npm run test:web
npm run build
```

`npm run build` 生成当前平台的 native `mmt-lsp`、WASM bridge 和 Desktop/Web bundles；构建产物不提交。
发布 VSIX 时按 VS Code target 分别构建平台包。

当前扩展发布由同一 pure analysis 生成的完整、去重 live diagnostics，并提供 pack-aware character completion、
symbols、folding、revision-bound Typst projection/preview 事件，以及经投影映射的 Tinymist completion、
hover、signature help 和 diagnostics；稳定合同见 `openspec/specs/language-tooling/spec.md`。Desktop 使用
native Tinymist sidecar；Web 使用固定的 Tinymist 0.15.4-rc3 WASM Worker。

客户端会声明 `publishDiagnostics.versionSupport` 并拒绝版本不等于当前 projection revision 的诊断；
实测 Tinymist 0.15.4-rc3 Web/Native backend 都可能省略 `version`。每个 MMT LSP 会话使用随机 UUID，每次
projection revision 使用 `untitled:/mmt-projection/<source-hex>/<session>/main-<revision>.typ` 独立 entry URI。
切换时旧 entry 立即退出当前 projection 索引，但 host 保留最近两个文件代际；更旧且无 owner 的文件经过
revision 校验的 30 秒 bounded grace 后才 `didClose`。晚到的无版本诊断仍指向已退休 URI，不能映射到当前
投影；异步映射完成前还会再次检查当前 session/revision。

同步一轮虚拟文件后，host debounce 250 ms 并向最新 entry 发送 `textDocument/foldingRange`，触发 Tinymist
implicit focus 与 diagnostics。这里不使用会持久锁定 main 的 `tinymist.focusMain`；不同 MMT 文档的后续
completion/hover/folding 请求仍可正常切换 focus。

`test:worker` 在 Chromium 中验证 MMT WASM LSP、pack-sensitive diagnostics、人物补全和渲染资源协议；
`test:grammar` 使用固定 Tinymist grammar 验证 inline/multiline `T`/`rT`、MMT marker overlay 与长 fence；
两个 Tinymist transcript 分别验证 native/Web backend handshake 和重启重放。
`test:web` 另在真实 VS Code Web Extension Host 中覆盖扩展激活、provider 注册和诊断发布。

生产浏览器编辑器位于 `../vscode-web/`。它使用同一 MMT/Tinymist backend，但另行拥有 Monaco/VS Code
Workbench、IndexedDB workspace、pack cache、resource materialization 与 typst.ts preview 生命周期。
单一 `EditorRuntimeController` 负责逆序启动回滚、可等待 graceful dispose、HMR 替换和 unload 同步
Worker terminate 保底。
