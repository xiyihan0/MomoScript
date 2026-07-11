# nonebot_plugin_mmt_pipe

NoneBot2 / OneBot v11 adapter for the Rust DSL v2 pipeline:

```text
MMT source
→ mmt-compile strict pipeline
→ pack-v3 resolve/materialize
→ self-contained Typst project
→ sandboxed Typst PNG/PDF
→ OneBot send/upload
```

## 前置条件

从仓库根目录构建 release compiler：

```bash
cargo build --release --manifest-path mmt_rs/Cargo.toml --bin mmt-compile
```

运行环境必须提供：

- `typst 0.15.x`
- `avifdec`，包含 dav1d decoder
- pack-v3 manifest 和对应 pack root
- `typst_sandbox/mmt_render/lib.typ` 及其模板资源

## Rust v2 配置

NoneBot 配置项可来自环境变量、`.env` 或项目配置：

- `mmt_compile_bin`：默认 `mmt_rs/target/release/mmt-compile`
- `mmt_pack_v3_manifests`：逗号分隔 manifest，默认 `typst_sandbox/pack-v3/ba_kivo/manifest.json`
- `mmt_template_v2_dir`：默认 `typst_sandbox/mmt_render`
- `mmt_materialize_cache_dir`：默认 `.cache/nonebot_mmt/materialized`
- `mmt_compile_timeout_s`：默认 `30`
- `mmt_workspace_root`：默认当前项目根目录
- `mmt_avifdec_bin`：默认 `avifdec`
- `mmt_decoder_profile`：默认 `avifdec-dav1d-png-v1`
- `mmt_work_dir`：每次请求的 self-contained project 根目录，默认 `.cache/nonebot_mmt`
- `mmt_typst_bin`：默认 `typst`
- `mmt_typst_timeout_s`：默认 `30`
- `mmt_typst_maxmem_mb`：默认 `2048`
- `mmt_typst_rayon_threads`：默认 `4`
- `mmt_procgov_bin` / `mmt_typst_enable_procgov`：Windows Typst 进程限制
- `mmt_png_ppi`：默认 `144`
- `mmt_send_delay_ms`：多图逐张发送间隔

Bot 当前监听端口为 `8190`。外部进程环境中的 `PORT` 优先于 `.env`，部署服务必须同步设置。

## 使用

```text
/mmt <Rust DSL v2 文本>           默认 PNG
/mmtpdf <Rust DSL v2 文本>        默认 PDF
/mmt --png <文本>
/mmt --pdf <文本>
/mmt --format png|pdf <文本>
/mmt --file                       读取回复的 UTF-8 .txt 文件
/mmt --verbose <文本>             返回 compile/render/send 用时
/mmt --help
```

确定性 sticker 示例：

```text
@title: 示例
@actor
preset: ba::星野
@end
> 星野: [:#1:](width: 3em)
> 连续消息
- 旁白
```

Rust v2 不提供 Python v1 的自然语言 `[图片]` reranker、`--resolve`、`--ctx-n`、`--typst` 或旧 inline target forms。正文模式使用 `t` / `T` / `rt` / `rT`，资源显示参数写在 marker patch 中。

`@title:` 和 `@author:` 由 Bot host 提取并传给 `mmt-compile`；缺少 `@author:` 时使用指令发起者昵称或群名片。

## 输出和清理

- PNG 多页按页排序后通过 OneBot image segments 发送
- PDF 使用 `upload_group_file` / `upload_private_file`
- 成功发送后删除单次请求导出的 Typst project
- `.cache/nonebot_mmt/materialized` 内容寻址 cache 保留，以复用 AVIFS frame decode
- 编译错误显示 Rust phase 和 MMT 行列位置
- 最终 Typst eval/layout 错误保留 Typst 原始诊断，并在命中 `main.typ` source map 时附加 MMT 行列

## 尚未迁移的独立命令

`/mmt-img`、`/mmt-imgmatch`、`/mmt-pack` 和 `/mmt-asset` 仍使用历史 pack-v2/asset 服务。它们不参与 `/mmt` 的 Rust v2 编译主链。

pack-v3 EULA metadata 与按用户授权尚未迁移到 Rust v2 registry。当前只应在
`mmt_pack_v3_manifests` 中配置允许 Bot 全局使用的资源包；需要逐用户接受 EULA 的扩展包
在该能力完成前不应加入 `/mmt` 默认 manifest 列表。
