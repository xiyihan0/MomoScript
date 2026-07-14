# MomoScript
[![Netlify Status](https://api.netlify.com/api/v1/badges/1b48c1c1-6c02-424b-bb3c-0304c500b741/deploy-status)](https://app.netlify.com/projects/momoscript/deploys)


MomoScript 是一个正在开发中的，专为编写《蔚蓝档案》的 Momotalk 样式文档设计的领域特定语言（DSL）和渲染器。它能够将简单的文本脚本转换成类似 Momotalk/MoeTalk 风格的可视化对话图片或 PDF 示例文档，借助 Typst 本身的强大排版能力进行高级样式设置，并可以集成到 NoneBot 机器人框架中。

- 本项目仍处于早期开发阶段，DSL 语法和文档生成管线在未来可能发生较大变动。

---

## 仓库结构

```text
.
├── mmt_rs/               # Rust DSL v2 parser、语义、资源解析与 Typst 投影
├── mmt_lsp/              # Native/WASM 共用的 MMT language server
├── editors/vscode/       # VS Code Desktop/Web 扩展、Worker 与固定 Tinymist 产物
├── editors/vscode-web/   # 当前生产 Web 编辑器（Monaco VS Code API）
├── mmt_core/             # Legacy Python DSL v1
├── mmt_nonebot_plugin/   # NoneBot 适配器
├── typst_sandbox/        # Typst 模板与 pack-v3 资源
├── openspec/             # 当前能力规格与变更设计
└── tools/                # 构建与回归工具
```

`web/` 是已废弃的旧 React 编辑器，不再扩展；浏览器端工作统一进入 `editors/vscode-web/`。

---

## 快速开始

Python 历史工具使用 [uv](https://github.com/astral-sh/uv)；Rust DSL v2/LSP 使用 Cargo，两个编辑器目录分别是独立 npm project。

### 1) 验证 Rust DSL v2 core

```bash
cargo test --manifest-path mmt_rs/Cargo.toml --all-targets
```

### 2) 运行 legacy Python v1 文本 → JSON 编译

```bash
uv sync
uv run tools/mmt_pipeline.py mmt_core/dsl_fixtures/basic.mmt.txt --out-json /tmp/mmt-basic.json
```

该命令生成 `/tmp/mmt-basic.json`；不修改 fixture，也不执行资源解析、Typst 编译或 PDF 渲染。

### 3) 启动 NoneBot 机器人

```bash
# 如需使用机器人功能，请先准备 .env 配置
uv run bot.py
```

### 4) 启动当前 Web 编辑器

```bash
cd editors/vscode-web
npm install
npm run dev
```

---

## DSL 语法速览

Rust v2 当前行为以 `mmt_rs/` 测试和
`openspec/changes/redesign-dsl-syntax-v2/specs/dsl-syntax/spec.md` 为真源；parser/source-map 约束见同一
change 下的 `specs/dsl-parser-architecture/spec.md`。

`typst_sandbox/mmt_render/mmt_help_syntax.typ` 与 `openspec/specs/dsl-syntax/spec.md` 记录 legacy Python
v1，不应用来判断 Rust v2 selector 或 directive 语法。

## OpenSpec

仓库已加入一个轻量的 OpenSpec 目录用于记录能力规格和变更提案：

- 项目上下文：`openspec/project.md`
- 当前能力规格：`openspec/specs/`
- 变更提案：`openspec/changes/`

推荐在修改 DSL 语义、渲染流程、资源解析、Web 编辑器行为或跨模块工作流之前，先写对应的 OpenSpec 变更提案，再开始实现。

---

## Rust v2 编译与编辑器流程

1. DSL source → recoverable syntax AST 与 UTF-8 ranges
2. body mode、actor、asset、resource marker semantic lowering
3. 使用 pack-v3 registry 执行 deterministic resource resolve 与 planning
4. native build：平台 materializer → Typst façade emission → 自包含 Typst project
5. editor language path：placeholder Typst projection → Tinymist language intelligence
6. Web preview path：revision-bound resource fetch/decode → typst.ts SVG render

---

## 当前 Web 编辑器

`editors/vscode-web/` 复用 VS Code Web API、`mmt_lsp` WASM Worker 和固定版本
Tinymist 0.15.2 Worker。当前实现包括：

- 当前直接发布 syntax 与 actor diagnostics；mode、asset、resource、pack resolve/planning 与 emitter diagnostic 的统一 live 发布已记录为未完成 OpenSpec 里程碑；
- 人物/资源包 completion、symbols 和 folding；
- MMT → placeholder Typst 全文投影，以及 completion、hover、signature help 和 diagnostics 映射；
- Tinymist 官方 Typst TextMate grammar；`T` 区域继续识别 MMT inline marker，`rT` 保持 raw；
- typst.ts SVG 预览、IndexedDB 工作区/资源缓存和刷新恢复；
- HTTPS pack-v3 同步、image-dir 与 AVIFS image-sequence 浏览器物化。

Ordinal sticker selector 写作 `[:#1:]`；不是 `[:sticker#1:]`。例如：

```text
> 花子: T"""#strong[你好] [:#1:]"""
- rT"""raw [:#1:]"""
```

### 验证

```bash
cargo test --manifest-path mmt_rs/Cargo.toml --all-targets
cargo test --manifest-path mmt_lsp/Cargo.toml

cd editors/vscode
npm run check
npm run test:grammar
npm run test:worker
TINYMIST_BIN=/path/to/tinymist npm run test:tinymist-process
TINYMIST_WEB_PKG="$PWD/vendor/tinymist-0.15.2" npm run test:tinymist-worker
TINYMIST_WEB_PKG="$PWD/vendor/tinymist-0.15.2" npm run test:web

cd ../vscode-web
npx playwright install chromium
npm run check
npm run test:avifs-worker
```

`test:grammar` 锁定 inline/multiline `T`/`rT`、MMT marker overlay 与长 fence；
`test:avifs-worker` 在 Chromium 中验证 SHA-256、透明度、多帧选择和 PNG 输出。
首次运行浏览器测试需安装与 lockfile 匹配的 Chromium；Linux CI 使用
`npx playwright install --with-deps chromium`。

### Netlify 部署

仓库根目录的 `netlify.toml` 已固定 Node 22.12、`editors/vscode-web` base、`npm run build`
和 `dist` publish。预览与生产部署分别执行：

```bash
npx netlify deploy --build
npx netlify deploy --build --prod
```

当前 pack manifest 固定为 HTTPS 地址，不需要旧 `VITE_MMT_*` 环境变量。

---

## 📄 License

MPL 2.0 License（注意素材包可能受各自 EULA 约束）
