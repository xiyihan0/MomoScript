# nonebot_plugin_mmt_pipe

把本仓库的 MMT DSL pipeline（解析 -> 可选 rerank resolve -> Typst 渲染）封装成 NoneBot2 插件。

## 安装
- 复制 `nonebot_plugin_mmt_pipe/` 到你的 NoneBot2 项目下（或做成包安装）
- 确保运行环境可 `import mmt_render`，并且已安装 `typst` 命令
- 确保有 `images/students/{id}`（图片）与 `images/students/{id}/tags.json`（打标结果）

## 配置（可选）
NoneBot 配置项（环境变量/`.env`/`pyproject.toml` 均可）：
- `mmt_tags_root`：默认 `images/students`
- `mmt_typst_template`：默认 `mmt_render/mmt_render.typ`（建议配置成绝对路径或相对 NoneBot 项目根目录）
- `mmt_work_dir`：默认 `.cache/nonebot_mmt`
- `mmt_typst_bin`：默认 `typst`
- `mmt_png_ppi`：默认 `144`（PNG 导出分辨率，调小可减少发送体积）
- `mmt_send_delay_ms`：默认 `0`（发送多张图片失败时的逐张发送间隔）
- `mmt_ctx_n`：默认 `2`
- `mmt_rerank_key_env`：默认 `SILICON_API_KEY`
- `mmt_rerank_model`：默认 `Qwen/Qwen3-Reranker-8B`
- `mmt_rerank_concurrency`：默认 `10`

## 使用
在聊天里对 bot 说（不需要 @）：

- `/mmt <MMT文本>`（默认 `--resolve`）
- `/mmtpdf <MMT文本>`（同上，别名）
- `/mmt --help`（查看参数与用法）
- `/mmt -h syntax`（渲染 DSL 语法速览图）
- `/mmt-img <角色名>`（把该角色库内所有表情渲染成表格图）
- `/mmt-imgmatch <角色名> [--top-n=5] <描述>`（对该角色表情库做语义匹配并输出 top-n 表格图）
- `/mmt --image-scale 0.7 <MMT文本>`（调整图片/表情在气泡内的缩放，0.1–1.0）
- `/mmt --typst <MMT文本>`（把所有文本内容按 Typst markup 渲染；表情标记仅识别 `[:...]`）
- `/mmt --disable-heading <MMT文本>`（不渲染标题栏）
- `/mmt --no-time <MMT文本>`（不自动填充编译时间）
- `/mmt --no-resolve <MMT文本>`（只渲染文本/占位符，不做 rerank）
- `/mmt --ctx-n 2 <MMT文本>`

默认使用 Typst 导出 PNG（多页会按页拆成多张），并用 OneBot v11 的 `image` 段发送；若当前适配器不可用则返回生成路径。

Tip：Typst markup 中 `[` / `]` 等字符有语法含义，纯文本需要转义；`eval` 的定义不会跨气泡持久化，建议用 `@typst_global` 放全局定义，或把定义和使用写在同一个气泡（例如三引号多行块）。

默认行为：若文本头部没有写 `@author: ...`，插件会自动用“指令发起者昵称/群名片”注入 `@author`，用于标题栏显示。

头部指令：`@key: value` 只在文件开头解析（例如 `@title` / `@author` / `@typst_global`）；文档里的 `...` 仅表示“任意内容占位”。

动态别名：`@alias 角色名=显示名` 可出现在任意位置，仅修改渲染显示名（不影响 id 查找）。

临时别名：`@tmpalias 角色名=显示名` 可出现在任意位置，作用于下方同方向的连续对话段，切换到其它说话人后自动回退。

别名 ID：`@aliasid <id> <角色名>` / `@unaliasid <id>` 用短 id 映射到真实角色名（多个 id 指向同角色不会刷新头像/名称）。
