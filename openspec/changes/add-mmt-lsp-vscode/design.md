# Architecture

第一版采用 Tinymist 的 state/transport 分层思路，但不复制其完整 actor/project 图：

```text
MmtLanguageServer (Rust, shared)
  -> versioned DocumentStore
  -> mmt_rs parser
  -> diagnostics / symbols / folding / structural completion

native: lsp-server stdio -> shared server
web: vscode-languageserver/browser Worker -> WASM bridge -> shared server
```

共享 server 接受 JSON method/params 并返回 JSON result/events。native 与 Web 只负责 JSON-RPC transport，
不得读取或解释 MMT AST。

## Position Encoding

内部继续使用 UTF-8 byte ranges。initialize 时优先接受 client 明确提供的 UTF-8，否则使用 LSP 默认
UTF-16。所有输入 position 和输出 range 都必须经过同一个 `LineIndex`，拒绝落在 UTF-8 codepoint
或 UTF-16 surrogate pair 中间的位置。

## Snapshot And Diagnostics

`didOpen` / `didChange` 创建递增 revision 和完整 parse snapshot。第一版使用 full sync；没有性能证据前
不实现增量 parser。publishDiagnostics 携带文档 version，close 后清空 diagnostics。

Full-sync notification 必须且只能携带一个无 range 的 content change。malformed notification 保留
最后一个有效 snapshot，并由 native/Web 统一生成 `window/logMessage`；native 同时写结构化 stderr。
WASM bridge JSON decode error 保留 `-32700`，不得降级为 `null` params。diagnostic labels 映射为同 URI
的 `DiagnosticRelatedInformation`。

## Completion Boundary

projection 之前只提供 MMT 结构 completion：顶层 directive、`@mode` value、`@actor` 与 `@asset`
field。资源 catalog selector、Typst symbol 和参数 completion 必须等待相应 backend，不在 TypeScript
或 Rust LSP 中建立猜测式第二语义。

## Web Runtime And Distribution

Web verification 分为真实 Chrome Worker/WASM transcript 与 VS Code Web Extension Host 两层。Worker
必须在安装 `BrowserMessageReader` 前完成 WASM 初始化，避免首条 initialize 在 connection listen 前
丢失。extension deactivate 先停止 client，再显式 terminate Worker。

Desktop binary 使用 `bin/<platform>-<arch>/mmt-lsp[.exe]`。构建脚本使用 Node，在当前目标生成 binary；
正式发布按 VS Code platform target 分包，不要求单机一次交叉编译所有目标。

## Preview Scheduling

普通编辑可以触发图片 preview，但 preview 是独立、可取消、revision-bound 的后台任务：

- diagnostics/symbol/folding 不等待 materializer 或 renderer；
- 新 didChange 取消或淘汰旧 preview；
- preview 响应必须携带 URI 和 revision；
- host 可以选择 native、browser 或 remote preview backend；
- preview 失败不覆盖 parser diagnostics。

## Tinymist Boundary

首个切片完成后，再加入 no-I/O Typst projection、双向 projection segments 和 Tinymist sidecar。
不得直接调用当前会进入 `materialize_resources` 的 `compile_text` 生成编辑器 projection。

第一版明确采用 VS Code host coordinator：Rust `mmt-lsp` 负责 MMT 分析、no-I/O projection、source map
和 revision 校验；VS Code Desktop/Web host 负责 Tinymist native/Web 生命周期、virtual project 同步、
请求转发、取消与恢复。嵌入式 Typst delegation 当前是 VS Code 专属能力；其他 LSP client 仍可使用
完整的基础 MMT diagnostics/symbols/folding/completion，但不获得 Typst delegation。通用 native
coordinator 若有实际客户端需求，必须另立 change，不在本阶段改写同步 Rust server 架构。
host backend protocol 当前版本为 `1`，virtual entry URI 使用稳定的
`untitled:/mmt-projection/<source-uri-hex>/main.typ`。选择 Tinymist 明确支持的 `untitled:` VFS，
而不是新增 custom scheme；该 URI 仅在 backend 内部使用，不暴露为用户文档。

Tinymist spike 固定到提交 `3d63da4f93c54ddef0c63e1a6237d67aee13f5fe`（`0.15.2`），Typst
版本为 `0.15.0`。native transcript 使用扩展同版本二进制；Web artifact 使用 Rust `1.92.0` 和：

```text
wasm-pack build --target web --release -- \
  --no-default-features --features web,no-content-hint
```

本次基线 artifact 为 `32,346,976` bytes（gzip `12,250,471` bytes），WASM SHA-256 为
`d9b946a8aa1425eeda71e6fcb603fb85ce30cd79b2a676a5d557971f202af454`。发布流水线必须记录
commit、工具链、feature、大小和 checksum；checksum 变化需要重新运行 browser transcript，而不是
假定同版本号即兼容。

两端都必须对真实 virtual document 验证 initialize、completion、hover 和 shutdown。Web 使用独立
`tinymistWorker`，不得与 MMT parser Worker 共用故障域。固定提交的 `JsTransportSender` 要求
`resolveFn`，虽然 upstream Worker 示例未传且 Rust 当前未使用该字段，宿主 bridge 仍须显式提供。

VS Code Desktop 使用 stdio process client，Web 使用 classic IIFE Worker（VS Code Web 的 Worker shim
依赖 `importScripts`，不能启动 module Worker）；两者复用同一个 TypeScript host router。Rust 负责
判断 Identity segment、映射 completion edits / hover ranges / diagnostics，并在映射前校验 revision；
TypeScript 不解释 MMT AST。所有 backend wire structs 使用 camelCase，避免 `source_version` 被 JS
读取为 `undefined` 后产生无版本 `didOpen`。

TypeScript `TinymistHostBackend` 是该架构唯一的 production host contract。启动必须验证 protocol、
Tinymist `0.15.2` server version 和 completion/hover/signature capabilities；不兼容 backend 必须在接管
middleware 前失败。请求 cancellation 映射为 `$/cancelRequest`。host 对 server request 按方法返回正确
JSON-RPC result，未知方法返回 `-32601`，不得统一伪造 `[]`。Rust 中不保留未接入 production 路径的
backend transport trait 或 request/response façade。

virtual project 先同步模板依赖、最后同步 `main.typ`，使第一次 entry 分析看到完整本地 import graph。
生产 `special.typ` 依赖 `@preview/shadowed` 和装饰图片，编辑器 world 使用保持相同公开函数签名的
I/O-free façade；LSP 不下载 Typst package，也不把二进制图片伪装成 source file。Tinymist `0.15.2`
的 signature query 会在内部将 position 前移一个 offset，host adapter 对该固定版本在请求前回退一个
ASCII trigger position，此兼容逻辑升级 Tinymist 时必须由 transcript 复验。

Desktop Electron Host 与 Web Extension Host 使用同一 fixture 验证 MMT diagnostics/symbols/folding、
结构 completion，以及 embedded Typst diagnostics/completion/hover/signature help。completion 断言必须
检查 Tinymist detail，而不能只检查文档词补全也可能产生的 label。

## Projection Decision

当前 Tinymist spike 以 full permissive emission 作为基线，但尚不将其认定为最终方案。projection pipeline
执行 parse、mode/actor/asset/resource-marker lowering，随后直接为资源绑定
`mmt-assets/placeholder.svg` 虚拟路径并调用现有 emitter；它不调用 resolve 或 materialize。host 会把一张
最小透明 SVG 作为 UTF-8 虚拟文件在 entry 之前同步，避免不存在的占位图片提前中断参数求值。

Desktop/Web 共享恢复性 fixture 已覆盖不完整 MMT、跨正文使用的 `@typ` 定义、statement patch
completion、overlay marker 混合、resource patch 诊断回射和 generated wrapper 跨段诊断。full emission
在这些场景中均可恢复，因此当前不引入第二套 region-preserving 实现。若后续 fixture 出现 full emission
无法提供、而 region projection 能提供的有效结果，再启动实现级 A/B；不能仅因理论上的局部性重复维护
两套 projection。

`ProjectionSegment` 必须按 Typst range 严格连续覆盖完整输出，range 均落在 UTF-8 boundary。映射规则为：

- `@typ`、Typst body、statement patch、resource patch：`Identity`，MMT/Typst 长度必须相同；
- template/function wrapper：`Synthetic`；
- text body：即使当前文本无需 escape，也保守标记为 `Escaped`；
- resource selector 展开：`MacroExpansion`。

只有完整位于单个 Identity segment 的 cursor/range/edit 可以反向映射。跨 segment 或落入其他 mapping
mode 的 edit 返回 `UnsafeEdit`，不得猜测。诊断不携带编辑语义：当其跨越 generated call wrapper 时，
可以唯一重叠的 authored patch segment 作为回射范围；无法唯一归属时仍丢弃。该结构第一版是 Rust
内部 API，不承诺跨语言稳定 ABI。
