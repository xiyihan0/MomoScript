# MomoScript VS Code

VS Code Desktop 和 Web 共用 `mmt_lsp` language service。Desktop 启动 native stdio binary，Web
通过 `vscode-languageclient/browser`、Worker 和 Rust/WASM bridge 使用同一套 parser behavior。

```bash
npm install
npm run check
npm run build
npm run test:worker
npm run test:web
```

`npm run build` 会生成当前平台的 native
`bin/<platform>-<arch>/mmt-lsp[.exe]`、WASM package 和 Desktop/Web bundles；这些构建产物不提交到
Git。发布时应按 VS Code target 分别构建平台包。第一阶段提供 syntax diagnostics、document
symbols、folding ranges、结构 completion 和 revision-bound preview 调度事件。Rust core 已提供
no-I/O Typst projection 与保守双向映射；Tinymist sidecar 和实际 preview renderer 属于下一里程碑。

`test:worker` 在真实 Chrome 中直接验证 Worker/WASM LSP transcript；`test:web` 使用
`@vscode/test-web` 在 VS Code Web Extension Host 中验证扩展激活和 providers。首次运行后者会下载
约 50 MB 的 VS Code Web 测试资源。
