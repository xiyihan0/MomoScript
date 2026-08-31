# MomoScript 编辑器系统指南

本文是 `editors/` 的稳定导航与系统总览。子包的具体开发步骤、当前所有权表和故障手册仍由各自 README 维护；规范性行为由 OpenSpec 维护。

## 产品形态与入口

| 目录 | 运行形态 | 详细文档 |
|---|---|---|
| [`editors/vscode/`](./vscode/) | VS Code Desktop/Web 扩展、MMT LSP 客户端、Tinymist 客户端与浏览器 Worker | [VS Code 扩展 README](./vscode/README.md) |
| [`editors/vscode-web/`](./vscode-web/) | 独立浏览器 Workbench，拥有 shell、预览、持久化、资源物化和 PWA 生命周期 | [Web Workbench README](./vscode-web/README.md) |

选择运行形态：需要已安装 VS Code 与 native sidecar 时运行 Desktop 扩展；需要 VS Code Web Extension Host 时运行 Web 扩展；需要完整浏览器产品、预览与离线生命周期时运行独立 Workbench。

## 端到端架构

```text
MMT TextDocument
  -> mmt_lsp versioned snapshot
  -> mmt/composerDocument
  -> one surface-independent ComposerRuntime
  -> native mmt.guiComposer editor (same URI/TextDocument)
  -> Typst projection session/revision
  -> Tinymist native/WASM backend
  -> accepted preview artifact
  -> preview webview
```

三个运行形态共享 Rust parser、版本化 MMT snapshot 和投影身份合同，但传输边界不同：

- **VS Code Desktop**：扩展宿主启动 native `mmt-lsp` stdio server 和 native Tinymist sidecar。
- **VS Code Web**：Web Extension Host 通过 MMT LSP WASM Worker、Tinymist WASM Worker 和浏览器 language client 通信。
- **独立 Workbench**：浏览器 Workbench 装配 Web Extension Host、两个语言 Worker、Typst compiler/renderer、资源物化和 runtime-owned preview webview。

投影的 `session/revision`、后端 generation、render identity 和已接受 preview artifact 形成连续身份链。语言返回值、Worker 消息和 webview 消息均是不可信 wire data，必须在各自 parser/allowlist 边界验证后才能进入状态 owner。

## 所有权与规范来源

规范入口：

- [Language Tooling Spec](../openspec/specs/language-tooling/spec.md)：MMT/Tinymist 语言能力、投影与编辑器合同。
- [Web Workbench Shell Spec](../openspec/specs/web-workbench-shell/spec.md)：`ViewsService`、nested `SplitView`、生命周期与迁移门槛。
- [PWA Offline Runtime change](../openspec/changes/add-pwa-offline-runtime/)：PWA/offline 目标与尚未完成的能力边界。
- [Preview Compilation Optimization change](../openspec/changes/optimize-web-preview-compilation/)：持久增量预览、正确性与性能证据。

具体所有权不要在此复制。`EditorRuntimeController`/`RuntimeOwner`、`ViewsService`/nested `SplitView`、`TypstPreviewController`、`PreviewInteractionController` 和 `PreviewRendererSessionOwner` 的当前关系与故障模式见 [Web Workbench README](./vscode-web/README.md)；Desktop/Web extension transport 与投影生命周期见 [VS Code 扩展 README](./vscode/README.md)。

## 代码导航

| 关注点 | 权威路径 |
|---|---|
| Rust v2 parser、pipeline、projection 与 wire kind producer | [`mmt_rs/src/parser.rs`](../mmt_rs/src/parser.rs)、[`mmt_rs/src/pipeline.rs`](../mmt_rs/src/pipeline.rs)、[`mmt_rs/src/projection.rs`](../mmt_rs/src/projection.rs) |
| 版本化语言服务、native stdio 与 WASM bridge | [`mmt_lsp/`](../mmt_lsp/) |
| Desktop/Web extension host、Workers、providers 与构建脚本 | [`editors/vscode/src/`](./vscode/src/)、[`editors/vscode/scripts/`](./vscode/scripts/) |
| 扩展侧 projected-read 信任边界 | [`editors/vscode/src/projectedReads.ts`](./vscode/src/projectedReads.ts) |
| Workbench 装配与状态连接 | [`editors/vscode-web/src/main.ts`](./vscode-web/src/main.ts) |
| 产品 runtime 与 dispose graph | [`runtimeController.ts`](./vscode-web/src/runtimeController.ts)、[`runtimeOwner.ts`](./vscode-web/src/runtimeOwner.ts) |
| Preview host/webview wire contract 与 iframe runtime | [`previewWebviewHost.ts`](./vscode-web/src/previewWebviewHost.ts)、[`previewWebviewProtocol.ts`](./vscode-web/src/previewWebviewProtocol.ts)、[`previewWebviewRuntime.ts`](./vscode-web/src/previewWebviewRuntime.ts) |
| Preview 交互与持久 renderer session | [`previewInteraction.ts`](./vscode-web/src/previewInteraction.ts)、[`previewRendererSession.ts`](./vscode-web/src/previewRendererSession.ts) |
| GUI Composer projection、runtime、native editor 与 responsive UI | [`composerDocument.ts`](./vscode-web/src/composerDocument.ts)、[`composerRuntime.ts`](./vscode-web/src/composerRuntime.ts)、[`composerEditor.ts`](./vscode-web/src/composerEditor.ts)、[`composerEditorUi.ts`](./vscode-web/src/composerEditorUi.ts) |
| Workspace、IndexedDB、origin storage 与 PWA | [`filesystem.ts`](./vscode-web/src/filesystem.ts)、[`indexedDbWorkspace.ts`](./vscode-web/src/indexedDbWorkspace.ts)、[`originStorage.ts`](./vscode-web/src/originStorage.ts)、[`pwaUpdate.ts`](./vscode-web/src/pwaUpdate.ts) |
| 类型化 E2E bridge 与浏览器 journeys | [`e2eRuntimeBridge.ts`](./vscode-web/src/e2eRuntimeBridge.ts)、[`e2e/`](./vscode-web/e2e/) |
| 共享 production preview server 与 CI runners | [`production-preview-server.mjs`](./vscode-web/scripts/production-preview-server.mjs)、[`test-e2e-chrome.mjs`](./vscode-web/scripts/test-e2e-chrome.mjs)、[`test-preview-performance-ci.mjs`](./vscode-web/scripts/test-preview-performance-ci.mjs) |
| 编辑器 CI 真相来源 | [`.github/workflows/editor-runtime.yml`](../.github/workflows/editor-runtime.yml) |

## 构建与验证矩阵

以下命令从仓库根目录运行。`npm install`/`npm ci`、完整的子包命令说明和故障定位分别见两个子包 README。

| 证明 | 命令 | 前置条件 | CI job |
|---|---|---|---|
| Rust core 与所有 targets | `cargo test --locked --manifest-path mmt_rs/Cargo.toml --all-targets` | 固定 Rust；Typst/AVIF 用例需要对应 CLI | `core-native` |
| native/WASM 共用 LSP 合同 | `cargo test --locked --manifest-path mmt_lsp/Cargo.toml --all-targets` | 固定 Rust | `core-native` |
| 扩展静态检查与生产构建 | `npm --prefix editors/vscode run check`；`npm --prefix editors/vscode run build` | Rust、`wasm-pack`；构建 native target | `extension-desktop`、`extension-web` |
| 扩展 grammar/MMT Worker | `npm --prefix editors/vscode run test:grammar`；`npm --prefix editors/vscode run test:worker` | Playwright Chromium；`test:worker` 会构建 WASM | `extension-desktop`/兼容性验证 |
| native Tinymist transport | `npm --prefix editors/vscode run test:tinymist-process` | `TINYMIST_BIN` 指向经过 pin/digest 验证的 binary | `tinymist-compatibility`、`extension-desktop` |
| Web Tinymist 与 VS Code Web Host | `npm --prefix editors/vscode run test:tinymist-worker`；`npm --prefix editors/vscode run test:web` | `TINYMIST_WEB_PKG` 指向经过 pin/digest 验证的 web package | `tinymist-compatibility`、`extension-web` |
| pack 同步重试与缓存回退 | `npm --prefix editors/vscode run test:pack-sync` | Node | `extension-web` |
| 投影信任边界 | `npm --prefix editors/vscode run test:projected-reads` | 共享 fixture 随仓库提供 | `extension-web` |
| Workbench 静态检查、runtime delivery 与 build | `npm --prefix editors/vscode-web run check`；`npm --prefix editors/vscode-web run test:runtime-delivery`；`npm --prefix editors/vscode-web run build` | 构建机可读取固定 runtime source；prebuild 将校验后的 Brotli 对象写入同源、content-addressed build output | `extension-web` 及浏览器 jobs |
| Workbench focused contracts | `npm --prefix editors/vscode-web run test:preview-artifact`；`npm --prefix editors/vscode-web run test:preview-webview-protocol`；`npm --prefix editors/vscode-web run test:preview-interaction`；`npm --prefix editors/vscode-web run test:preview-render-queue`；`npm --prefix editors/vscode-web run test:preview-renderer-session`；`npm --prefix editors/vscode-web run test:exact-export`；`npm --prefix editors/vscode-web run test:runtime-controller`；`npm --prefix editors/vscode-web run test:composer-document`；`npm --prefix editors/vscode-web run test:composer-runtime` | Node 与已安装依赖 | `extension-web` |
| Grouped real-Chrome production journeys | `npm --prefix editors/vscode-web run test:e2e:chrome` | `TINYMIST_WEB_PKG`、`TYPST_COMPILER_WEB_PKG`、Playwright Chrome | `production-e2e` |
| GUI Composer 原生/桌面/移动 journeys | `npm --prefix editors/vscode-web run test:e2e:gui-composer` | Playwright Chromium；production group 使用真实 Chrome | `production-e2e` |
| HMR/runtime lifecycle | `npm --prefix editors/vscode-web run test:e2e:lifecycle` | `TINYMIST_WEB_PKG`、Playwright Chrome | `lifecycle-e2e` |
| PWA/offline lifecycle | `npm --prefix editors/vscode-web run test:e2e:pwa-offline` | `TINYMIST_WEB_PKG`、`TYPST_COMPILER_WEB_PKG`、Playwright Chromium | `pwa-e2e` |
| Preview differential benchmark | `npm --prefix editors/vscode-web run ci:preview-differential` | 两个 Web runtime package、Playwright Chromium | `preview-differential-e2e` |
| Preview nightly/qualification benchmarks | `npm --prefix editors/vscode-web run ci:preview-nightly` | 两个 Web runtime package、Playwright Chromium | `preview-performance-nightly` |

本地运行 `dev`/`preview` 或单个 Playwright spec 时，以 [`vscode-web/package.json`](./vscode-web/package.json) 的脚本为准；不要用缩短的 smoke 结果替代 differential 或 qualification 证据。

## 运行时产物与来源

- 生产浏览器 journeys 使用仓库中经过校验的 [`editors/vscode/vendor/tinymist-0.15.4-rc3/`](./vscode/vendor/tinymist-0.15.4-rc3/) pinned fixtures；构建前由 `verify-web-vendor.mjs` 校验浏览器 language-service artifacts。
- `tinymist-compatibility` 从 workflow 固定 revision 与补丁构建 native binary/Web package，生成并校验 SHA-256 文件，再上传 `tinymist-pinned-linux-x64`。`extension-desktop` 和 `extension-web` 下载该 artifact 验证兼容性，不把 runner 临时路径当发布来源。
- `typst-compiler-compatibility` 从固定 typst.ts revision、patch、Rust/wasm-pack/Binaryen 工具链构建 compiler WASM，校验 Binaryen 下载、WASM SHA-256 与必需 exports，再上传 `typst-compiler-pinned-web`。需要真实 compiler 的 production/PWA/preview jobs 下载该 artifact，并通过 `TYPST_COMPILER_WEB_PKG` 传入。
- `TINYMIST_BIN`、`TINYMIST_WEB_PKG` 和 `TYPST_COMPILER_WEB_PKG` 都只是已验证产物的位置；digest/SHA 文件与 workflow pin 决定来源可信度。
- 独立 Workbench 的 Tinymist WASM、Typst compiler WASM 与 MainFont regular/bold 在 prebuild 中按 `runtimeArtifacts.ts` 固定的压缩/原始 digest 和长度验证，作为 `*.brotli.bin` 与 `tiny-brotli-dec-wasm@1.0.1` 一起进入 Pages output。浏览器只走同源 Worker 解压边界，不保留外部 runtime fallback；Pack 仍按独立发布合同从配置的 ESA origin 获取。
- 失败时，production、lifecycle 和 PWA jobs 上传各自 `test-results/`；differential 与 nightly jobs 无论结果均上传 `.tmp/preview-performance/ci/` 和 `test-results/` 证据。artifact 名称、保留策略和触发条件以 [workflow](../.github/workflows/editor-runtime.yml) 为准。

## 变更路由与故障入口

| 变更或故障 | 先读 | 执行/诊断入口 |
|---|---|---|
| Workbench shell、Part、sash、runtime ownership 或 dispose | [Web Workbench Shell Spec](../openspec/specs/web-workbench-shell/spec.md) | [Workbench runbook](./vscode-web/README.md)；`runtimeController.ts`/`runtimeOwner.ts` focused contracts |
| MMT/Tinymist language tooling、projection 或 provider | [Language Tooling Spec](../openspec/specs/language-tooling/spec.md) | [扩展 runbook](./vscode/README.md)；extension transcript/Worker scripts |
| PWA、更新、离线安装或 storage quiesce | [PWA Offline Runtime change](../openspec/changes/add-pwa-offline-runtime/) | [Workbench runbook](./vscode-web/README.md) 与 `test:e2e:pwa-offline` |
| GUI Composer、550px 默认、恢复或 stale 编辑 | [Mobile GUI Surface change](../openspec/changes/add-mobile-gui-surface/) | `composerEditor.ts`/`composerRuntime.ts`；`test:composer-document`、`test:composer-runtime`、`test:e2e:gui-composer` |
| Preview renderer、diff/resync、artifact identity 或性能 | [Preview Compilation Optimization change](../openspec/changes/optimize-web-preview-compilation/) | `production-preview-server.mjs`、`test-e2e-chrome.mjs`、`test-preview-performance-ci.mjs` |
| CI runtime delivery、digest、artifact 下载或证据缺失 | [Editor Runtime workflow](../.github/workflows/editor-runtime.yml) | 对照 compatibility producer、消费 job 环境变量和对应 runner；不要绕过 pin 或 digest 校验 |

变更跨越现有 capability 或改变 runtime owner、wire semantics、shell topology、PWA 状态机时，先提交对应 OpenSpec 变更；不要在第二处建立并行事实来源。
