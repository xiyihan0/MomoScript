from __future__ import annotations

import asyncio
import json
import re
import subprocess
import time
from pathlib import Path
from typing import Optional

from nonebot import logger
from nonebot.adapters import Bot, Event

from ..assets_store import AssetDB, merge_asset_meta
from ..context import plugin_config
from .assets import asset_db_and_dir
from .common import (
    extract_invoker_name,
    format_pdf_name,
    inject_author_if_missing,
    safe_stem,
)
from .io import (
    decode_text_file,
    download_text_file,
    extract_text_file_url,
    onebot_available,
    send_onebot_images,
    upload_onebot_file,
)
from .pack import enforce_pack_eulas_or_raise
from .typst import run_typst
from .common import event_scope_ids, find_name_map_and_avatar_dir


from mmt_core import mmt_text_to_json
from mmt_core.resolve_expressions import resolve_file



async def render_syntax_help_pngs(*, out_dir: Path) -> list[Path]:
    # Build a standalone Typst doc for syntax help and render it to PNG pages.
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = safe_stem("mmt-help-syntax")
    typ_path = out_dir / f"{stem}.mmt_help_syntax.typ"
    dummy_json = out_dir / f"{stem}.dummy.json"
    png_out_tpl = out_dir / f"{stem}-{{0p}}.png"

    dummy_json.write_text("{}", encoding="utf-8")
    typ_path.write_text(
        "\n".join(
            [
                """\
#show raw: set text(font: ("Cascadia Code","FZLanTingYuanGBK"))
#show raw.where(block: true): it => block(
  fill: luma(240),
  inset: 6pt,
  radius: 4pt,
  text(fill: black, it)
)""",
                "#set page(width: 168mm, height: auto, margin: (x: 10mm, y: 10mm))",
                "#set text(size: 10.5pt, font: \"FZLanTingYuanGBK\",lang:\"zh\")",
                "#set par(first-line-indent: (amount: 2em, all: true))",
                "",
                "= MomoScript",
                "MMT DSL 语法速览",
                "",
                r"== 头部指令（\@）",
                "- 只在文件开头解析，用于填写元信息或 Typst 全局代码",
                "- 形式：`@key: value`（value 为任意文本）",
                "- 常用：`@title` / `@author` / `@created_at`（会写入输出 JSON 的 `meta`）",
                "- 其它 `@key` 也会写入 `meta`（不与保留字段冲突即可）",
                "- Typst：`@typst_global: ...`（可配合 `\"\"\"...\"\"\"` 写多行块）",
                """- 备注：
  - `@typst: on|off` 只写入 `meta.typst`，实际解析模式以 `--typst` 为准
  - 文档中的 `...` 仅表示“任意内容占位”，不是语法的一部分；实际写法是 `@key: value`""",
                "",
                r"== 动态别名（\@alias）",
                "- 可出现在任意位置，仅修改显示名（不影响 id 查找；对后续气泡持续生效）",
                "- 语法：`@alias 角色名=显示名`（清空：`@alias 角色名=`）",
                "",
                r"== 临时别名（\@tmpalias）",
                "- 局部作用域显示名覆盖（切换到其它说话人后自动回退）",
                "- 语法：`@tmpalias 角色名=显示名`（清空：`@tmpalias 角色名=`）",
                "",
                "== 语句行",
                "- `- `：旁白（居中系统文本）",
                "- `> `：对方气泡（默认左侧）",
                "- `< `：自己气泡（默认右侧；也可以写成其它角色的右侧气泡）",
                "",
                "== 续行",
                "不以 `- ` / `> ` / `< ` 开头的行会被视为上一条语句的续行（一般用 `\\\\n` 连接）。",
                "",
                '== 多行块（`"""..."""`）',
                '当内容以 `"""`（或更多连续引号，如 `""""`）开头时进入多行块，直到遇到“单独一行”的同样引号长度结束。',
                "块内内容原样保留（推荐用于列表/公式/代码）。",
                "",
                "== 说话人",
                "`>` 与 `<` 可携带“说话人切换”标记：",
                "",
                "- 显式指定：`> {name}: {content}` 或 `< {name}: {content}`",
                "- 方向内回溯：`> _:` / `> _2:`（回到该方向历史的第 1/2 个说话人）",
                "- “第 i 个出现的人物”：`> ~1:`（从对话开始以来第 1 个新出现的说话人）",
                "",
                "== 表情/图片标记",
                "普通模式（未开启 `--typst`）：",
                "- `[描述]` / `[角色:描述]` / `(角色)[描述]`（会进入 rerank 解析）",
                "- `[asset:xxx]`（引用头部 `@asset.xxx`；需要 resolve 才能下载外链）",
                "",
                "Typst 模式（`--typst`）：",
                "- 只识别 `[:描述]` / `[:角色:描述]` / `(角色)[:描述]`",
                "- `[:asset:xxx]`（引用头部 `@asset.xxx`；需要 resolve 才能下载外链）",
                "- 其它 `[...]` 会原样交给 Typst（因此纯文本里的 `[`/`]` 可能需要转义）",
                "",
                "== 示例",
                "```text",
                "@title: 测试",
                "@author: (可省略，插件会自动填充)",
                "",
                "> 星野: 早上好",
                "> 续行（仍然是星野）",
                "@alias 星野=星野(一年级)",
                "> 1!",
                "@alias 星野=星野(临战)",
                "> 2!",
                "",
                "- \"\"\"",
                "#let fib(n) = if n <= 2 { 1 } else { fib(n - 1) + fib(n - 2) }",
                "#fib(10)",
                "\"\"\"",
                "",
                "> [:期待]",
                "```",
                "",
                'Tip：若开启 `--typst`，可以用 ``` """...""" ``` 在气泡里写 Typst 的原始代码块。',
            ]
        ),
        encoding="utf-8",
    )

    await asyncio.to_thread(
        run_typst,
        typst_bin=plugin_config.mmt_typst_bin,
        template=typ_path,
        input_json=dummy_json,
        out_path=png_out_tpl,
        tags_root=out_dir,
        out_format="png",
        input_key="dummy",
        extra_inputs=None,
    )

    pngs = sorted(out_dir.glob(f"{stem}-*.png"), key=lambda p: p.name)
    if not pngs:
        single = out_dir / f"{stem}.png"
        if single.exists():
            return [single]
        raise RuntimeError("typst succeeded but no png output found")
    return pngs


async def pipe_to_outputs(
    *,
    text: str,
    bot: Bot,
    event: Event,
    resolve: bool,
    strict: bool,
    ctx_n: int,
    image_scale: Optional[float],
    typst: bool,
    disable_heading: bool,
    no_time: bool,
    out_format: str,
    redownload_assets: bool,
    allow_local_assets: bool,
    asset_local_prefixes: Optional[str],
    out_dir: Path,
) -> tuple[list[Path], dict, dict, str, dict]:
    # End-to-end pipeline: parse -> resolve -> render -> return outputs + stats.
    if mmt_text_to_json is None:
        raise RuntimeError("mmt_core.mmt_text_to_json is not importable in this environment")

    out_dir.mkdir(parents=True, exist_ok=True)
    stem = safe_stem(text)
    json_path = out_dir / f"{stem}.json"
    resolved_path = out_dir / f"{stem}.resolved.json"
    out_format_norm = (out_format or "png").strip().lower()
    if out_format_norm not in {"png", "pdf"}:
        raise ValueError(f"unsupported format: {out_format}")
    out_path: Path = (
        (out_dir / f"{stem}-{{0p}}.png") if out_format_norm == "png" else (out_dir / f"{stem}.pdf")
    )

    # Parse text -> json
    t_start = time.perf_counter()
    t_parse0 = time.perf_counter()
    name_map_path, avatar_dir = find_name_map_and_avatar_dir()

    name_map = mmt_text_to_json._load_name_to_id(name_map_path)
    data, _report = mmt_text_to_json.convert_text(
        text,
        name_to_id=name_map,
        avatar_dir=avatar_dir,
        join_with_newline=True,
        context_window=max(0, int(ctx_n)),
        typst_mode=bool(typst),
        pack_v2_root=plugin_config.pack_v2_root_path(),
    )
    t_parse1 = time.perf_counter()

    # Inject per-user/private and per-group assets into meta (default lookup order: p > g).
    t_inj0 = time.perf_counter()
    try:
        private_id, group_id = event_scope_ids(event)
        if private_id or group_id:
            db_path, _asset_dir = asset_db_and_dir()
            db = AssetDB(db_path)
            p_assets = db.list_names(scope="p", scope_id=private_id) if private_id else []
            g_assets = db.list_names(scope="g", scope_id=group_id) if group_id else []
            if isinstance(data, dict):
                meta0 = data.get("meta")
                meta0 = meta0 if isinstance(meta0, dict) else {}
                data["meta"] = merge_asset_meta(
                    meta=meta0, private_assets=p_assets, group_assets=g_assets, prefer_private=True
                )
    except Exception:
        # Asset injection is best-effort; do not fail rendering.
        pass
    t_inj1 = time.perf_counter()

    # Enforce EULA for @usepack packs (per-user acceptance).
    if isinstance(data, dict):
        enforce_pack_eulas_or_raise(data=data, event=event)

    json_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    meta = data.get("meta") if isinstance(data, dict) else None
    meta = meta if isinstance(meta, dict) else {}

    chat_for_render = json_path
    resolve_stats: dict = {"unresolved": 0, "errors": [], "asset_errors": 0, "avatar_errors": 0, "asset_error_examples": []}
    if resolve:
        t_resolve0 = time.perf_counter()
        if resolve_file is None:
            raise RuntimeError("mmt_core.resolve_expressions.resolve_file is not importable in this environment")
        tags_root = plugin_config.tags_root_path()
        template = plugin_config.typst_template_path()
        await resolve_file(
            input_path=json_path,
            output_path=resolved_path,
            tags_root=tags_root,
            pack_v2_root=plugin_config.pack_v2_root_path(),
            ref_root=template.parent,
            model=plugin_config.mmt_rerank_model,
            api_key_env=plugin_config.mmt_rerank_key_env,
            concurrency=plugin_config.mmt_rerank_concurrency,
            strict=bool(strict),
            asset_cache_dir=plugin_config.asset_cache_dir_path(),
            redownload_assets=bool(redownload_assets or getattr(plugin_config, "mmt_asset_redownload", False)),
            asset_max_mb=int(getattr(plugin_config, "mmt_asset_max_mb", 10) or 10),
            allow_local_assets=bool(allow_local_assets or getattr(plugin_config, "mmt_asset_allow_local", False)),
            asset_local_prefixes=(
                [x.strip() for x in str(asset_local_prefixes or "").split(",") if x.strip()]
                if asset_local_prefixes
                else plugin_config.asset_local_prefixes_list()
            ),
        )
        chat_for_render = resolved_path
        try:
            resolved_data = json.loads(resolved_path.read_text(encoding="utf-8"))
            chat = resolved_data.get("chat") if isinstance(resolved_data, dict) else None
            if isinstance(chat, list):
                for line in chat:
                    if not isinstance(line, dict):
                        continue
                    segs = line.get("segments")
                    if not isinstance(segs, list):
                        continue
                    for seg in segs:
                        if not isinstance(seg, dict):
                            continue
                        if seg.get("type") == "expr":
                            resolve_stats["unresolved"] += 1
                            err = seg.get("error")
                            if isinstance(err, str) and err and len(resolve_stats["errors"]) < 5:
                                resolve_stats["errors"].append(err)
                        if seg.get("type") == "asset":
                            err = seg.get("error")
                            if isinstance(err, str) and err:
                                resolve_stats["asset_errors"] += 1
                                if len(resolve_stats["asset_error_examples"]) < 5:
                                    resolve_stats["asset_error_examples"].append(err)
                    if isinstance(line.get("avatar_override_error"), str) and line.get("avatar_override_error"):
                        resolve_stats["avatar_errors"] += 1
        except Exception:
            pass
        t_resolve1 = time.perf_counter()
    else:
        t_resolve0 = t_resolve1 = time.perf_counter()

    # Render png(s) via typst (blocking)
    tags_root = plugin_config.tags_root_path()
    template = plugin_config.typst_template_path()
    if not template.is_absolute():
        template = (Path.cwd() / template).resolve()
    if not template.exists():
        # Fallback: common locations in a repo checkout
        for cand in (
            Path.cwd() / "typst_sandbox" / "mmt_render" / "mmt_render.typ",
            Path.cwd() / "mmt_render" / "mmt_render.typ",
            Path.cwd() / "mmt_render.typ",
        ):
            if cand.exists():
                template = cand.resolve()
                break
    if not template.exists():
        raise RuntimeError(f"typst template not found: {template}")

    if not tags_root.is_absolute():
        tags_root = (Path.cwd() / tags_root).resolve()
    compiled_at = "" if no_time else time.strftime("%Y-%m-%d %H:%M:%S")
    t_render0 = time.perf_counter()
    await asyncio.to_thread(
        run_typst,
        typst_bin=plugin_config.mmt_typst_bin,
        template=template,
        input_json=chat_for_render,
        out_path=out_path,
        tags_root=tags_root,
        out_format=out_format_norm,
        input_key="chat",
        extra_inputs={
            **(
                {"image_scale": str(float(image_scale))}
                if image_scale is not None and image_scale > 0
                else {}
            ),
            **({"typst_mode": "1"} if typst else {}),
            **({"disable_heading": "1"} if disable_heading else {}),
            **({} if no_time else {"compiled_at": compiled_at}),
        }
        or None,
    )
    t_render1 = time.perf_counter()

    timings: dict = {
        "parse_ms": int((t_parse1 - t_parse0) * 1000),
        "asset_inject_ms": int((t_inj1 - t_inj0) * 1000),
        "resolve_ms": int((t_resolve1 - t_resolve0) * 1000),
        "render_ms": int((t_render1 - t_render0) * 1000),
        "total_ms": int((t_render1 - t_start) * 1000),
    }

    if out_format_norm == "pdf":
        if out_path.exists():
            return [out_path], resolve_stats, meta, compiled_at, timings
        raise RuntimeError("typst succeeded but no pdf output found")

    pngs = sorted(out_dir.glob(f"{stem}-*.png"), key=lambda p: p.name)
    if not pngs:
        single = out_dir / f"{stem}.png"
        if single.exists():
            return [single], resolve_stats, meta, compiled_at, timings
        raise RuntimeError("typst succeeded but no png output found")
    return pngs, resolve_stats, meta, compiled_at, timings


def parse_flags(text: str, *, default_format: str) -> tuple[dict, str]:
    # Parse CLI-style flags from a raw text payload, keep the remaining body.
    # Keep user's newlines in body; only strip leading CLI flags.
    s = (text or "")
    s = re.sub(r"^[\s\u200b\u200c\u200d\ufeff\u2060]+", "", s)
    s = s.rstrip()
    resolve = True
    strict = False
    ctx_n: Optional[int] = None
    image_scale: Optional[float] = None
    typst: bool = False
    disable_heading: bool = False
    no_time: bool = False
    out_format: str = (default_format or "png").strip().lower()
    redownload_assets: bool = False
    allow_local_assets: bool = False
    asset_local_prefixes: Optional[str] = None
    from_file: bool = False
    verbose: bool = False
    show_help: bool = False
    help_mode: Optional[str] = None

    while True:
        s = s.lstrip()
        if s == "help" or s.startswith("help "):
            show_help = True
            s = s[len("help") :]
            continue
        if s == "--help" or s.startswith("--help "):
            show_help = True
            s = s[len("--help") :]
            continue
        if s == "-h" or s.startswith("-h "):
            show_help = True
            s = s[len("-h") :]
            continue
        if s == "-t" or s.startswith("-t "):
            typst = True
            s = s[len("-t") :]
            continue
        if s.startswith("--typst"):
            typst = True
            s = s[len("--typst") :]
            continue
        if s.startswith("--disable-heading"):
            disable_heading = True
            s = s[len("--disable-heading") :]
            continue
        if s.startswith("--disable_heading"):
            disable_heading = True
            s = s[len("--disable_heading") :]
            continue
        if s.startswith("--no-time"):
            no_time = True
            s = s[len("--no-time") :]
            continue
        if s.startswith("--no_time"):
            no_time = True
            s = s[len("--no_time") :]
            continue
        if s.startswith("--no-resolve"):
            resolve = False
            s = s[len("--no-resolve") :]
            continue
        if s.startswith("--noresolve"):
            resolve = False
            s = s[len("--noresolve") :]
            continue
        if s.startswith("--resolve"):
            resolve = True
            s = s[len("--resolve") :]
            continue
        if s.startswith("--strict"):
            strict = True
            s = s[len("--strict") :]
            continue
        if s.startswith("--file"):
            from_file = True
            s = s[len("--file") :]
            continue
        if s.startswith("--verbose"):
            verbose = True
            s = s[len("--verbose") :]
            continue
        if s == "-v" or s.startswith("-v "):
            verbose = True
            s = s[len("-v") :]
            continue
        if s.startswith("--redownload-assets"):
            redownload_assets = True
            s = s[len("--redownload-assets") :]
            continue
        if s.startswith("--allow-local-assets"):
            allow_local_assets = True
            s = s[len("--allow-local-assets") :]
            continue
        m = re.match(r"^--asset-local-prefixes(?:=|\s+)([^\s]+)", s)
        if m:
            asset_local_prefixes = m.group(1)
            s = s[m.end() :]
            continue
        m = re.match(r"^--image(?:_|-)scale(?:=|\s+)([0-9]*\.?[0-9]+)", s)
        if m:
            try:
                image_scale = float(m.group(1))
            except Exception:
                image_scale = None
            s = s[m.end() :]
            continue
        m = re.match(r"^--ctx-n(?:=|\s+)(\d+)", s)
        if m:
            ctx_n = int(m.group(1))
            s = s[m.end() :]
            continue
        if s.startswith("--png"):
            out_format = "png"
            s = s[len("--png") :]
            continue
        if s.startswith("--pdf"):
            out_format = "pdf"
            s = s[len("--pdf") :]
            continue
        m = re.match(r"^--format(?:=|\s+)(\w+)", s)
        if m:
            out_format = m.group(1).strip().lower()
            s = s[m.end() :]
            continue
        break

    if show_help:
        ss = s.lstrip()
        m = re.match(r"^(syntax|dsl)(?:\s+|$)", ss, flags=re.IGNORECASE)
        if m:
            help_mode = "syntax"
            s = ss[m.end() :]

    cfg = {
        "resolve": resolve,
        "strict": strict,
        "ctx_n": plugin_config.mmt_ctx_n if ctx_n is None else int(ctx_n),
        "image_scale": image_scale,
        "typst": typst,
        "disable_heading": disable_heading,
        "no_time": no_time,
        "out_format": out_format,
        "redownload_assets": redownload_assets,
        "allow_local_assets": allow_local_assets,
        "asset_local_prefixes": asset_local_prefixes,
        "from_file": from_file,
        "verbose": verbose,
        "help": show_help,
        "help_mode": help_mode,
    }
    return cfg, s.lstrip("\r\n ")


async def handle_mmt_common(
    *,
    finish,
    matcher_name: str,
    bot: Bot,
    event: Event,
    raw: str,
    arg_msg: object,
    default_format: str,
    flags_override: Optional[dict] = None,
) -> None:
    # Command entrypoint for /mmt and /mmtpdf: parse flags, render, and send.
    t_total0 = time.perf_counter()

    if flags_override is not None:
        flags, _ = parse_flags("", default_format=default_format)
        for k, v in flags_override.items():
            if v is None:
                continue
            flags[k] = v
        content = raw
        if flags.get("help"):
            ss = content.lstrip()
            m = re.match(r"^(syntax|dsl)(?:\s+|$)", ss, flags=re.IGNORECASE)
            if m:
                flags["help_mode"] = "syntax"
                content = ss[m.end() :]
    else:
        flags, content = parse_flags(raw, default_format=default_format)
    if flags.get("help"):
        if flags.get("help_mode") == "syntax":
            out_dir = plugin_config.work_dir_path()
            try:
                png_paths = await render_syntax_help_pngs(out_dir=out_dir)
            except Exception as exc:
                logger.exception("render syntax help failed: %s", exc)
                await finish(f"生成语法帮助失败：{exc}")

            if not onebot_available():
                await finish(f"已生成：{png_paths[0]}")

            await send_onebot_images(bot, event, png_paths)
            await finish()

        help_text = "\n".join(
            [
                f"用法：/{matcher_name} [flags] <MMT文本>（默认会 resolve）",
                "",
                "输出格式：",
                f"- --png：输出 PNG（默认：/mmt）",
                f"- --pdf：输出 PDF（默认：/mmtpdf）",
                "- --format <png|pdf>：同上",
                "- --redownload-assets：外链图片/asset 强制重新下载",
                "",
                "常用 flags：",
                "- --no-resolve：不做表情/图片推断",
                "- --resolve：强制开启 resolve",
                "- --strict：resolve 失败直接报错",
                "- --verbose / -v：输出各阶段用时信息",
                "- --typst / -t：文本按 Typst markup 渲染（表情标记仅识别 '[:...]'）",
                "- --image-scale <0.1-1.0>：气泡内图片缩放",
                f"- --ctx-n <N>：'[图片]' 使用的上下文窗口大小（默认 {plugin_config.mmt_ctx_n}）",
                "- --disable-heading：关闭标题栏",
                "- --no-time：不自动填充编译时间",
                "- --redownload-assets：强制重新下载外链图片",
                "- --allow-local-assets：允许 @asset.* 引用本地图片（受前缀白名单限制）",
                "- --asset-local-prefixes <a,b,c>：本地 @asset.* 允许的一级目录（默认 mmt_assets）",
                "",
                "其他指令：",
                "- /mmt-img [--pack ba,ba_extpack] [--page 1] <角色名>：列出该角色库内所有表情",
                "- /mmt-imgmatch [--pack ba,ba_extpack] <角色名> [--top-n=5] <描述>：语义匹配表情",
                "- /mmt -h syntax：渲染 DSL 语法速览图",
                "- /mmt --file：从“回复的 .txt 文件”读取 MMT 文本（解决超长输入）",
            ]
        )
        await finish(help_text)

    if not content and not bool(flags.get("from_file")) and not bool(flags.get("help")):
        msg = "未检测到正文内容（参数后需要跟 MMT 文本）。"
        if matcher_name == "mmtpdf":
            msg = "未检测到正文内容（参数后需要跟 MMT 文本；默认输出 PDF）。"
        await finish(msg)

    file_read_ms = 0
    if bool(flags.get("from_file")):
        t_file0 = time.perf_counter()
        try:
            url, fname = await extract_text_file_url(bot, event, arg_msg)
            data = await download_text_file(url, max_bytes=2 * 1024 * 1024)
            file_text = decode_text_file(data)
        except Exception as exc:
            await finish(f"读取文本文件失败：{exc}")
        file_read_ms = int((time.perf_counter() - t_file0) * 1000)
        # Allow optional prefix content after flags (useful for overriding @title/@author etc).
        content = (content.rstrip() + "\n" + file_text) if content.strip() else file_text

    content = inject_author_if_missing(content, extract_invoker_name(event))

    out_dir = plugin_config.work_dir_path()
    try:
        out_paths, resolve_stats, meta, compiled_at, timings = await pipe_to_outputs(
            text=content,
            bot=bot,
            event=event,
            resolve=flags["resolve"],
            strict=flags["strict"],
            ctx_n=flags["ctx_n"],
            image_scale=flags.get("image_scale"),
            typst=bool(flags.get("typst")),
            disable_heading=bool(flags.get("disable_heading")),
            no_time=bool(flags.get("no_time")),
            out_format=str(flags.get("out_format") or default_format),
            redownload_assets=bool(flags.get("redownload_assets")),
            allow_local_assets=bool(flags.get("allow_local_assets")),
            asset_local_prefixes=flags.get("asset_local_prefixes"),
            out_dir=out_dir,
        )
    except subprocess.CalledProcessError as exc:
        logger.exception("typst failed: %s", exc)
        await finish(f"Typst 渲染失败：{exc}")
    except Exception as exc:
        logger.exception("mmt pipe failed: %s", exc)
        await finish(f"处理失败：{exc}")

    out_format_norm = str(flags.get("out_format") or default_format).strip().lower()
    if out_format_norm == "pdf":
        pdf_path = out_paths[0]
        upload_name = format_pdf_name(meta=meta, compiled_at=compiled_at, fallback=pdf_path.stem)
        upload_ms = 0
        try:
            t_up0 = time.perf_counter()
            await upload_onebot_file(bot, event, pdf_path, file_name=upload_name)
            upload_ms = int((time.perf_counter() - t_up0) * 1000)
        except Exception as exc:
            logger.warning("upload pdf failed: %s", exc)
            await finish(f"已生成：{pdf_path}（上传失败：{exc}）")

        msg = ""
        if flags["resolve"] and int(resolve_stats.get("unresolved") or 0) > 0:
            msg += f"\n注意：仍有 {resolve_stats['unresolved']} 处表情未解析（通常是找不到对应学生的 tags.json 或图片文件）。"
            errs = resolve_stats.get("errors") or []
            if errs:
                msg += "\n示例错误：" + "; ".join(str(x) for x in errs)
            msg += "\n可用 `--strict` 让其直接报错定位。"
        if bool(flags.get("verbose")) and isinstance(timings, dict):
            parts = []
            if file_read_ms:
                parts.append(f"file={file_read_ms}ms")
            parts.extend(
                [
                    f"parse={timings.get('parse_ms', 0)}ms",
                    f"asset_inject={timings.get('asset_inject_ms', 0)}ms",
                    f"resolve={timings.get('resolve_ms', 0)}ms",
                    f"render={timings.get('render_ms', 0)}ms",
                ]
            )
            if upload_ms:
                parts.append(f"upload={upload_ms}ms")
            parts.append(f"total={int((time.perf_counter() - t_total0) * 1000)}ms")
            msg += ("\n" if msg else "") + "用时：" + ", ".join(parts)
        await finish(msg if msg else None)

    # PNG: For OneBot v11/NapCat, sending images is more compatible than sending PDFs.
    if not onebot_available():
        await finish(f"已生成图片：{out_paths[0]}")

    t_send0 = time.perf_counter()
    await send_onebot_images(bot, event, out_paths)
    send_ms = int((time.perf_counter() - t_send0) * 1000)
    msg = ""
    if flags["resolve"] and int(resolve_stats.get("unresolved") or 0) > 0:
        msg += f"\n注意：仍有 {resolve_stats['unresolved']} 处表情未解析（通常是找不到对应学生的 tags.json 或图片文件）。"
        errs = resolve_stats.get("errors") or []
        if errs:
            msg += "\n示例错误：" + "; ".join(str(x) for x in errs)
        msg += "\n可用 `--strict` 让其直接报错定位。"
    if flags["resolve"] and int(resolve_stats.get("asset_errors") or 0) > 0:
        msg += f"\n注意：有 {resolve_stats['asset_errors']} 处资源未找到（通常是 asset 名写错或未上传）。"
        ex = resolve_stats.get("asset_error_examples") or []
        if ex:
            msg += "\n示例错误：" + "; ".join(str(x) for x in ex)
    if flags["resolve"] and int(resolve_stats.get("avatar_errors") or 0) > 0:
        msg += f"\n注意：有 {resolve_stats['avatar_errors']} 处头像覆盖未生效（asset 名可能写错）。"
    if bool(flags.get("verbose")) and isinstance(timings, dict):
        parts = []
        if file_read_ms:
            parts.append(f"file={file_read_ms}ms")
        parts.extend(
            [
                f"parse={timings.get('parse_ms', 0)}ms",
                f"asset_inject={timings.get('asset_inject_ms', 0)}ms",
                f"resolve={timings.get('resolve_ms', 0)}ms",
                f"render={timings.get('render_ms', 0)}ms",
                f"send={send_ms}ms",
                f"total={int((time.perf_counter() - t_total0) * 1000)}ms",
            ]
        )
        msg += ("\n" if msg else "") + "用时：" + ", ".join(parts)
    await finish(msg if msg else None)


__all__ = ["handle_mmt_common", "parse_flags", "pipe_to_outputs", "render_syntax_help_pngs"]
