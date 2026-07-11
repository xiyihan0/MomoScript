# services/

NoneBot 命令的服务层。命令模块只负责 Alconna 参数和 matcher 注册，编译、渲染及 OneBot I/O 位于这里。

## 模块

- `mmt.py`：`/mmt` 与 `/mmtpdf` 的 Rust DSL v2 主链
- `typst.py`：legacy JSON renderer 和 Rust v2 self-contained project 两类 Typst sandbox runner
- `io.py`：OneBot 图片发送、文件上传及回复消息文件读取
- `common.py`：命名、事件用户信息和历史 pack 工具
- `pack.py`、`img.py`、`assets.py`：尚未迁移的 pack-v2 浏览、匹配和用户资产命令
- `core.py`：旧 import 路径的兼容 re-export；新代码应直接 import 对应服务模块

## `/mmt` 主链

1. `commands/mmt.py` 解析 `--png`、`--pdf`、`--format`、`--file` 和 `--verbose`
2. `services/mmt.py` 调用 release `mmt-compile`，通过 stdin 传入 Rust DSL v2
3. `mmt-compile` 严格编译 pack-v3、物化头像/AVIFS sticker，并导出 `main.typ`、`template/` 和 `assets/`
4. `services/typst.run_typst_project` 在导出目录内以该目录为 `--root` 沙箱编译 PNG/PDF
5. `services/io` 发送分页 PNG 或上传 PDF
6. 成功发送后删除 request project；内容寻址 materialization cache 保留复用

`/mmt` 不再调用 Python v1 parser、reranker resolve、pack-v2 JSON renderer 或旧 `@asset.*` 注入。`/mmt-img`、`/mmt-imgmatch`、`/mmt-pack` 和 `/mmt-asset` 仍是独立 legacy 表面，后续迁移不能把其语义重新塞回 Rust v2 编译主链。
