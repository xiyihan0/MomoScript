# MomoScript
[![Netlify Status](https://api.netlify.com/api/v1/badges/1b48c1c1-6c02-424b-bb3c-0304c500b741/deploy-status)](https://app.netlify.com/projects/momoscript/deploys)


MomoScript 是一个正在开发中的，专为编写《蔚蓝档案》的 Momotalk 样式文档设计的领域特定语言（DSL）和渲染器。它能够将简单的文本脚本转换成类似 Momotalk/MoeTalk 风格的可视化对话图片或 PDF 示例文档，借助 Typst 本身的强大排版能力进行高级样式设置，并可以集成到 NoneBot 机器人框架中。

- 本项目仍处于早期开发阶段，DSL 语法和文档生成管线在未来可能发生较大变动。

---

## 仓库结构

```text
.
├── mmt_core/             # 核心 DSL 解析器、编译器和资源解析器
├── mmt_nonebot_plugin/   # NoneBot 适配器和插件逻辑
├── web/                  # Vite + React Web 编辑器
├── typst_sandbox/        # Typst 模板与资产包
├── tools/                # 构建流水线与回归测试
├── examples/             # 示例脚本与输出
├── bot.py                # NoneBot 启动入口
└── pyproject.toml        # uv 工作区定义
```

---

## 快速开始

本项目使用 [uv](https://github.com/astral-sh/uv) 管理 Python 环境。

### 1) 安装依赖

```bash
uv sync
```

### 2) 运行渲染流水线

```bash
uv run tools/mmt_pipeline.py examples/example_t.mmt.txt
```

### 3) 启动 NoneBot 机器人

```bash
# 如需使用机器人功能，请先准备 .env 配置
uv run bot.py
```

### 4) 启动 Web 编辑器

```bash
cd web
npm install
npm run dev
```

---

## DSL 语法速览

语法文档见：`typst_sandbox/mmt_render/mmt_help_syntax.typ`

---

## 渲染流程

1. 解析 DSL → AST
2. 编译 AST → JSON
3. 资源解析（表情/头像/外链）
4. Typst 渲染（SVG/PDF）

---

## Web 编辑器（Developing）

纯前端的 Web 编辑器位于 `web/`，采用：

- Vite + React + Tailwind
- typst.ts 进行浏览器渲染
- mmt_rs wasm 解析 DSL

最小环境变量（部署用）：

```env
VITE_MMT_TYPST_ROOT=https://eo.xiyihan.cn/typst_sandbox
VITE_MMT_PACK_FETCH_URL=https://eo.xiyihan.cn/typst_sandbox/pack-v2/ba
VITE_MMT_PACK_BASE=https://eo.xiyihan.cn/typst_sandbox
```

---

## 📄 License

MPL 2.0 License（注意素材包可能受各自 EULA 约束）
