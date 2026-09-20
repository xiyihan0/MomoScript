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
MMT TextDocument / native model and undo stack
  -> mmt_lsp versioned Rust snapshot
  -> mmt/composerDocument + composerTextSelection/composerTextProjection
  -> one surface-independent ComposerRuntime + ComposerTextSession
  -> native mmt.guiComposer SVG surface (same URI/TextDocument)
  -> Typst projection session/revision
  -> Tinymist native/WASM backend
  -> accepted preview artifact + exact text geometry
  -> one retained overlay mounted in mmt.guiComposer or read-only mmt.previewHost
```

三个运行形态共享 Rust parser、版本化 MMT snapshot 和投影身份合同，但传输边界不同：

- **VS Code Desktop**：扩展宿主启动 native `mmt-lsp` stdio server 和 native Tinymist sidecar。
- **VS Code Web**：Web Extension Host 通过 MMT LSP WASM Worker、Tinymist WASM Worker 和浏览器 language client 通信。
- **独立 Workbench**：浏览器 Workbench 装配 Web Extension Host、两个语言 Worker、Typst compiler/renderer、资源物化，以及由产品 runtime 持有的单个 retained preview overlay；活动的原生 `mmt.guiComposer` 或只读 `mmt.previewHost` 只声明该 overlay 的挂载位置，不创建 renderer/store 副本。

投影的 `session/revision`、后端 generation、render identity 和已接受 preview artifact 形成连续身份链。正文选择和替换还绑定 `TextDocument` version、`sourceDigest` 与 Rust node endpoint；语言返回值、Worker 消息和 webview 消息均是不可信 wire data，必须在各自 parser/allowlist 边界验证后才能进入状态 owner。

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
| Preview retained overlay、native mount 与 webview wire contract | [`previewWebviewHost.ts`](./vscode-web/src/previewWebviewHost.ts)、[`previewHostPane.ts`](./vscode-web/src/previewHostPane.ts)、[`previewWebviewProtocol.ts`](./vscode-web/src/previewWebviewProtocol.ts)、[`previewWebviewRuntime.ts`](./vscode-web/src/previewWebviewRuntime.ts) |
| Preview 交互与持久 renderer session | [`previewInteraction.ts`](./vscode-web/src/previewInteraction.ts)、[`previewRendererSession.ts`](./vscode-web/src/previewRendererSession.ts) |
| GUI Composer projection、runtime、native editor 与 SVG UI | [`composerDocument.ts`](./vscode-web/src/composerDocument.ts)、[`composerRuntime.ts`](./vscode-web/src/composerRuntime.ts)、[`composerEditor.ts`](./vscode-web/src/composerEditor.ts)、[`composerEditorUi.ts`](./vscode-web/src/composerEditorUi.ts) |
| GUI 正文 intent 队列、原生撤销/恢复与精确几何 | [`composerTextSession.ts`](./vscode-web/src/composerTextSession.ts)、[`composerTextGeometry.ts`](./vscode-web/src/composerTextGeometry.ts)、[`composerEdit.ts`](./vscode-web/src/composerEdit.ts) |
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
| Tinymist promotion 回滚与 VSIX 来源 | `npm --prefix editors/vscode run test:tinymist-promotion-boundaries` | Node；验证拒绝伪造 VSIX、只从已认证快照提取、恢复既有或缺省 dist | `tinymist-compatibility` |
| Tinymist 嵌套 frame 正反定位 | 在 `pin.json` `source.revision` 指向的 clean Tinymist fork checkout 中运行 `cargo test --locked --release -p tinymist-query jump::tests` | 固定 Rust；真实编译 fixture 与 JSON 坐标往返，不覆盖 legacy query 尚不支持的非 identity group transform | `tinymist-compatibility` |
| LSP 坐标浮点往返精度 | 在同一 clean exact-source checkout 中运行 `cargo test --locked --release -p sync-ls --features lsp lsp::tests::directed_preview_coordinate_survives_lsp_json -- --exact` | 固定 Rust；真实 Content-Length framing 与 JSON request 解码，不由 query 的 dev feature 代替生产 parser 验证 | `tinymist-compatibility` |
| pack 同步重试与缓存回退 | `npm --prefix editors/vscode run test:pack-sync` | Node | `extension-web` |
| 投影信任边界 | `npm --prefix editors/vscode run test:projected-reads` | 共享 fixture 随仓库提供 | `extension-web` |
| Workbench 静态检查、runtime delivery 与 build | `npm --prefix editors/vscode-web run check`；`npm --prefix editors/vscode-web run test:runtime-delivery`；`npm --prefix editors/vscode-web run build` | 构建机可读取固定 runtime source；prebuild 将校验后的 Brotli 对象写入同源、content-addressed build output | `extension-web` 及浏览器 jobs |
| Workbench focused contracts | `npm --prefix editors/vscode-web run test:preview-artifact`；`npm --prefix editors/vscode-web run test:preview-webview-protocol`；`npm --prefix editors/vscode-web run test:preview-interaction`；`npm --prefix editors/vscode-web run test:preview-render-queue`；`npm --prefix editors/vscode-web run test:preview-renderer-session`；`npm --prefix editors/vscode-web run test:exact-export`；`npm --prefix editors/vscode-web run test:runtime-controller`；`npm --prefix editors/vscode-web run test:composer-edit`；`npm --prefix editors/vscode-web run test:composer-document`；`npm --prefix editors/vscode-web run test:composer-runtime` | Node 与已安装依赖 | `extension-web` |
| Grouped real-Chrome production journeys | `npm --prefix editors/vscode-web run test:e2e:chrome` | `TINYMIST_WEB_PKG`、`TYPST_COMPILER_WEB_PKG`、Playwright Chrome | `production-e2e` |
| SVG GUI Composer journeys | `npm --prefix editors/vscode-web run test:e2e:gui-composer` | Playwright Google Chrome；覆盖真实 renderer、字符/跨消息选区、原生 undo/recovery、精确 geometry、reload 与窄视口 | `production-e2e` |
| HMR/runtime lifecycle | `npm --prefix editors/vscode-web run test:e2e:lifecycle` | `TINYMIST_WEB_PKG`、Playwright Chrome | `lifecycle-e2e` |
| PWA/offline lifecycle | `npm --prefix editors/vscode-web run test:e2e:pwa-offline` | `TINYMIST_WEB_PKG`、`TYPST_COMPILER_WEB_PKG`、Playwright Chromium | `pwa-e2e` |
| Preview differential benchmark | `npm --prefix editors/vscode-web run ci:preview-differential` | 两个 Web runtime package、Playwright Chromium | `preview-differential-e2e` |
| Preview nightly/qualification benchmarks | `npm --prefix editors/vscode-web run ci:preview-nightly` | 两个 Web runtime package、Playwright Chromium | `preview-performance-nightly` |

本地运行 `dev`/`preview` 或单个 Playwright spec 时，以 [`vscode-web/package.json`](./vscode-web/package.json) 的脚本为准；不要用缩短的 smoke 结果替代 differential 或 qualification 证据。

开发态依赖扫描覆盖 HTML、独立 preview webview 和 Worker 入口；仅对 `node_modules` 中实际预打包的依赖应用 import-meta URL 重写，本地 wasm-bindgen glue 保留相对资产 URL。冷启动生命周期验证要求首次加载只有一个 document generation，不能靠已有 Vite 缓存掩盖依赖扫描失败后的自动重载。

materialization journey 的活动文档/布局恢复先经过既有 `prepareForReload` 持久化边界；预览就绪不能代替 native Workbench storage flush。该验证保留原生编辑器恢复优先级，不承诺未经落盘的瞬时/崩溃重载会恢复最新布局。

GUI journey 中的 IME 是在真实 Chrome 内派发的 synthetic composition/input 事件，窄屏与软键盘场景是 viewport shrink。CI/当前自动环境不提供物理中文 OS 输入法或真实移动设备的软件键盘，因此候选窗、提交/取消与软件键盘行为仍未验证；不能把自动 journey 扩大为物理输入证明。

## 运行时产物与来源

- 生产浏览器 journeys 使用仓库中经过校验的 [`editors/vscode/vendor/tinymist-0.15.8/`](./vscode/vendor/tinymist-0.15.8/) pinned fixtures；构建前由 `verify-web-vendor.mjs` 校验浏览器 language-service artifacts，并要求 grammar notice 与 `third_party/tinymist/pin.json` 中受信的官方 universal VSIX release tag、asset 名称和 SHA-256 完全一致。
- `third_party/tinymist/pin.json` 使用 `mmt-tinymist-pin.v2`：`source.repository` 与完整 `source.revision` 是唯一可执行源码权威；`upstream.repository`、`upstream.revision`、`upstream.version` 只记录官方 base/release provenance，并与 `release.universalVsix` 一起认证官方 grammar/license 输入。维护历史位于 `https://github.com/xiyihan0/tinymist.git` 的 `mmt/0.15.8` 分支，但分支 tip 不能代替完整 source SHA。
- 普通 renderer/backend 改动和 upstream sync 由 source owner 在该 fork 中形成、推送正常 Git commit，再由产品 owner 更新 source pin 并资格验证。产品仓库不保存或 capture/apply Tinymist patch，也不使用 submodule；推送 source commit 不等于更新 product vendor、发布 runtime 或完成 release。
- 从仓库根目录准备新的直接 checkout，并始终让命令从 pin 读取 repository/revision，避免在文档中复制可漂移的 SHA：

```bash
export TINYMIST_SRC=/absolute/path/to/tinymist-source
TINYMIST_REPOSITORY="$(node -p "require('./third_party/tinymist/pin.json').source.repository")"
TINYMIST_REVISION="$(node -p "require('./third_party/tinymist/pin.json').source.revision")"
git clone --no-checkout "$TINYMIST_REPOSITORY" "$TINYMIST_SRC"
git -C "$TINYMIST_SRC" checkout --detach "$TINYMIST_REVISION"

# 用固定工具链构建 native/Web，再计算并落盘候选 artifact identity。
node editors/vscode/scripts/build-tinymist-artifacts.mjs build-promote

# 已由同一 exact checkout 构建时，只重新读取/落盘候选 artifact identity。
node editors/vscode/scripts/build-tinymist-artifacts.mjs promote

# 认证官方 VSIX、运行完整资格链，并原子更新 pin/evidence/vendor/本地同源交付。
TINYMIST_VSIX=/absolute/path/to/tinymist-universal.vsix \
  node editors/vscode/scripts/build-tinymist-artifacts.mjs repin

# CI 只输出新 qualification bundle，并恢复 canonical 文件与执行前的 dist。
TINYMIST_QUALIFICATION_DIR=/absolute/path/to/new-bundle \
  node editors/vscode/scripts/build-tinymist-artifacts.mjs qualify
```

- 四种 mode 都拒绝 `HEAD != pin.source.revision` 或存在 tracked source dirt；`promote`、`repin`、`qualify` 只接受该 checkout 已有的 native/Web build outputs。`repin` 要求扩展 npm 依赖、Playwright Chromium 与 `unzip`，从已认证 VSIX 的同一私有只读快照提取 grammar/license，在同一回滚事务内生成 evidence/qualification/manifest/decision/准入 bundle，并只保留通过资格验证的 `dist`。
- `repin` 会计算 decoded/encoded identity、准备 content-addressed 本地同源对象并更新 product pin/vendor，但返回 `published: false`；它不上传 CDN、不部署站点，也不把 source push 或本地准备宣称为完整 release。远端 runtime publication 仍需独立授权、凭据和公开 CORS/media type/encoding/digest/`WebAssembly.validate` 校验。
- 生产 provider 的 artifact identity 与资格策略由同一 capability manifest 生成到 `tinymistProviderQualification.generated.ts`，不再手工维护另一份 SHA/资格表；实际 provider admission 必须接受已取证的 artifact 并拒绝错误 digest/version。`qualify` 原子输出与实际二进制对应的证明包，无论成功或失败都恢复 canonical evidence、生成模块和执行前的 `dist`；消费 job 不能仅凭构建自产的 SHA 文件获得准入。
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
| GUI Composer、SVG 正文编辑、550px 默认、恢复或 stale 编辑 | [Mobile GUI Surface change](../openspec/changes/add-mobile-gui-surface/) | `composerEditor.ts`/`composerRuntime.ts`/`composerTextSession.ts`/`composerTextGeometry.ts`；`test:composer-edit`、`test:composer-document`、`test:composer-runtime`、`test:e2e:gui-composer` |
| Preview renderer、retained overlay/native mount、diff/resync、artifact identity 或性能 | [Preview Compilation Optimization change](../openspec/changes/optimize-web-preview-compilation/) | `previewWebviewHost.ts`/`previewHostPane.ts`/`previewRendererSession.ts`、`production-preview-server.mjs`、`test-e2e-chrome.mjs`、`test-preview-performance-ci.mjs` |
| CI runtime delivery、digest、artifact 下载或证据缺失 | [Editor Runtime workflow](../.github/workflows/editor-runtime.yml) | 对照 compatibility producer、消费 job 环境变量和对应 runner；不要绕过 pin 或 digest 校验 |

变更跨越现有 capability 或改变 runtime owner、wire semantics、shell topology、PWA 状态机时，先提交对应 OpenSpec 变更；不要在第二处建立并行事实来源。
