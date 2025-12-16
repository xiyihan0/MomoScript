from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import time
from pathlib import Path
from typing import Optional

from nonebot import get_driver, logger, on_command
from nonebot.adapters import Bot, Event
from nonebot.params import CommandArg
from nonebot.plugin import PluginMetadata
from nonebot.typing import T_State

from .config import MMTPipeConfig

try:
    from nonebot.adapters.onebot.v11 import MessageSegment as V11MessageSegment
    from nonebot.adapters.onebot.v11 import Message as V11Message
    from nonebot.adapters.onebot.v11.exception import ActionFailed as V11ActionFailed
except Exception:  # pragma: no cover
    V11MessageSegment = None  # type: ignore
    V11Message = None  # type: ignore
    V11ActionFailed = None  # type: ignore

try:
    from mmt_render import mmt_text_to_json
except Exception:  # pragma: no cover
    mmt_text_to_json = None  # type: ignore

try:
    from mmt_render.typst_sandbox import TypstSandboxOptions, run_typst_sandboxed
except Exception:  # pragma: no cover
    TypstSandboxOptions = None  # type: ignore
    run_typst_sandboxed = None  # type: ignore

try:
    from mmt_render.resolve_expressions import resolve_file
except Exception:  # pragma: no cover
    resolve_file = None  # type: ignore

try:
    from mmt_render.siliconflow_rerank import SiliconFlowRerankConfig, SiliconFlowReranker
except Exception:  # pragma: no cover
    SiliconFlowRerankConfig = None  # type: ignore
    SiliconFlowReranker = None  # type: ignore


driver = get_driver()
raw_cfg = driver.config
try:
    # nonebot uses pydantic settings (v1/v2) depending on version
    cfg_dict = raw_cfg.model_dump()  # type: ignore[attr-defined]
except Exception:
    try:
        cfg_dict = raw_cfg.dict()  # type: ignore[attr-defined]
    except Exception:
        cfg_dict = dict(raw_cfg)  # type: ignore[arg-type]

plugin_config = MMTPipeConfig.model_validate(cfg_dict)

def _find_name_map_and_avatar_dir() -> tuple[Path, Path]:
    name_map_path = Path("avatar/name_to_id.json")
    avatar_dir = Path("avatar")
    if not name_map_path.exists():
        candidate = Path.cwd() / "mmt_render" / "avatar" / "name_to_id.json"
        if candidate.exists():
            name_map_path = candidate
    if not avatar_dir.exists():
        candidate = Path.cwd() / "mmt_render" / "avatar"
        if candidate.exists():
            avatar_dir = candidate
    return name_map_path, avatar_dir


async def _send_onebot_images(bot: Bot, event: Event, png_paths: list[Path]) -> None:
    if V11MessageSegment is None or V11Message is None:
        raise RuntimeError("onebot v11 adapter is not available")

    def _img_seg(p: Path, *, use_uri: bool) -> object:
        if use_uri:
            return V11MessageSegment.image(file=p.resolve().as_uri())  # type: ignore[misc]
        return V11MessageSegment.image(file=str(p.resolve()))  # type: ignore[misc]

    async def _send_once(*, use_uri: bool) -> None:
        msg = V11Message()  # type: ignore[call-arg]
        for p in png_paths:
            msg.append(_img_seg(p, use_uri=use_uri))  # type: ignore[attr-defined]
        await bot.send(event=event, message=msg)

    async def _send_with_retry(*, use_uri: bool) -> None:
        try:
            await _send_once(use_uri=use_uri)
            return
        except Exception as exc:
            if V11ActionFailed is not None and isinstance(exc, V11ActionFailed):
                ret = getattr(exc, "retcode", None)
                if ret == 1200 or "Timeout" in str(exc):
                    await asyncio.sleep(0.8)
                    await _send_once(use_uri=use_uri)
                    return
            raise

    async def _send_seg_with_retry(seg: object) -> None:
        try:
            await bot.send(event=event, message=seg)
            return
        except Exception as exc:
            if V11ActionFailed is not None and isinstance(exc, V11ActionFailed):
                ret = getattr(exc, "retcode", None)
                if ret == 1200 or "Timeout" in str(exc):
                    await asyncio.sleep(0.8)
                    await bot.send(event=event, message=seg)
                    return
            raise

    try:
        await _send_with_retry(use_uri=True)
        return
    except Exception as exc1:
        try:
            await _send_with_retry(use_uri=False)
            return
        except Exception as exc2:
            logger.warning("send images failed (batch), fallback to sequential: %s | %s", exc1, exc2)

    delay = max(0, int(getattr(plugin_config, "mmt_send_delay_ms", 0) or 0)) / 1000.0
    for p in png_paths:
        try:
            await _send_seg_with_retry(_img_seg(p, use_uri=False))
        except Exception:
            await _send_seg_with_retry(_img_seg(p, use_uri=True))
        if delay:
            await asyncio.sleep(delay)

async def _upload_onebot_file(
    bot: Bot,
    event: Event,
    file_path: Path,
    *,
    file_name: Optional[str] = None,
    folder_id: Optional[str] = None,
) -> dict:
    p = file_path.resolve()
    if not p.exists():
        raise FileNotFoundError(f"file not found: {p}")
    name = (file_name or p.name).strip() or p.name

    group_id = getattr(event, "group_id", None)
    user_id = getattr(event, "user_id", None)
    if group_id is not None:
        return await bot.call_api(
            "upload_group_file",
            group_id=int(group_id),
            file=str(p),
            name=name,
            folder=folder_id,
        )
    if user_id is not None:
        return await bot.call_api(
            "upload_private_file",
            user_id=int(user_id),
            file=str(p),
            name=name,
        )
    raise ValueError("event type not supported for file upload")


def _sanitize_filename_component(s: str) -> str:
    s = (s or "").strip()
    if not s:
        return ""
    # Windows forbidden chars: \ / : * ? " < > | and control chars.
    s = re.sub(r'[\x00-\x1f<>:"/\\\\|?*]+', "_", s)
    s = re.sub(r"\s+", " ", s).strip()
    s = s.strip(". ")
    return s


def _format_pdf_name(*, meta: dict, compiled_at: str, fallback: str) -> str:
    title = _sanitize_filename_component(str(meta.get("title") or "无题"))
    author = _sanitize_filename_component(str(meta.get("author") or ""))
    # Always include a time part to avoid unreadable random stems.
    ts = compiled_at.strip() or time.strftime("%Y-%m-%d %H:%M:%S")
    ts = _sanitize_filename_component(ts)

    parts = [p for p in (title, author, ts) if p]
    if not parts:
        parts = [_sanitize_filename_component(fallback) or "mmt"]
    name = "-".join(parts) + ".pdf"
    if len(name) > 160:
        name = name[:156] + ".pdf"
    return name


def _common_root(*paths: Path) -> Path:
    import os

    # Typst checks project root against the real/canonical file paths. If any of
    # these paths are symlinks, using `.absolute()` can yield a root that doesn't
    # actually contain the resolved targets and will trigger "outside of project root".
    resolved: list[str] = []
    for p in paths:
        try:
            resolved.append(str(p.resolve()))
        except Exception:
            resolved.append(str(p.absolute()))
    common = os.path.commonpath(resolved)
    return Path(common)


def _run_typst(
    *,
    typst_bin: str,
    template: Path,
    input_json: Path,
    out_path: Path,
    tags_root: Path,
    out_format: str,
    input_key: str = "chat",
    extra_inputs: Optional[dict[str, str]] = None,
) -> None:
    root = _common_root(template, input_json, out_path, tags_root)
    cwd = template.parent
    rel_in = Path(os.path.relpath(input_json.absolute(), start=cwd.absolute()))
    rel_out = Path(os.path.relpath(out_path.absolute(), start=cwd.absolute()))
    rel_tpl = Path(os.path.relpath(template.absolute(), start=cwd.absolute()))

    cmd = [
        typst_bin,
        "compile",
        str(rel_tpl).replace("\\", "/"),
        str(rel_out).replace("\\", "/"),
        "--format",
        out_format,
        *(
            ["--ppi", str(int(plugin_config.mmt_png_ppi))]
            if out_format.lower() == "png" and int(getattr(plugin_config, "mmt_png_ppi", 0) or 0) > 0
            else []
        ),
        "--root",
        str(root.absolute()).replace("\\", "/"),
        "--input",
        f"{input_key}={str(rel_in).replace('\\', '/')}",
    ]
    if extra_inputs:
        for k, v in extra_inputs.items():
            cmd.extend(["--input", f"{k}={v}"])

    if run_typst_sandboxed is not None and TypstSandboxOptions is not None:
        procgov_bin = (plugin_config.mmt_procgov_bin or "").strip() or None
        opts = TypstSandboxOptions(
            timeout_s=float(getattr(plugin_config, "mmt_typst_timeout_s", 30.0) or 30.0),
            max_mem_mb=int(getattr(plugin_config, "mmt_typst_maxmem_mb", 0) or 0) or None,
            rayon_threads=int(getattr(plugin_config, "mmt_typst_rayon_threads", 0) or 0) or None,
            procgov_bin=procgov_bin,
            enable_procgov=bool(getattr(plugin_config, "mmt_typst_enable_procgov", True)),
        )
        proc = run_typst_sandboxed(cmd, cwd=cwd, options=opts)
    else:
        proc = subprocess.run(cmd, cwd=str(cwd), capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"typst failed ({proc.returncode}):\n{proc.stderr or proc.stdout}")


def _safe_stem(text: str) -> str:
    return str(int(time.time() * 1000))


async def _render_syntax_help_pngs(*, out_dir: Path) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = _safe_stem("mmt-help-syntax")
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
                r"== 别名 ID（\@aliasid / \@unaliasid）",
                "- 为说话人标记添加短 id，并映射到真实角色名（不影响头像/名称刷新）",
                "- 语法：`@aliasid <id> <角色名>` / `@unaliasid <id>`",
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
                '当内容以 `"""` 开头时进入多行块，直到遇到“单独一行”的 `"""` 结束。',
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
                "",
                "Typst 模式（`--typst`）：",
                "- 只识别 `[:描述]` / `[:角色:描述]` / `(角色)[:描述]`",
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
        _run_typst,
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


async def _pipe_to_outputs(
    *,
    text: str,
    resolve: bool,
    strict: bool,
    ctx_n: int,
    image_scale: Optional[float],
    typst: bool,
    disable_heading: bool,
    no_time: bool,
    out_format: str,
    redownload_assets: bool,
    out_dir: Path,
) -> tuple[list[Path], dict, dict, str]:
    if mmt_text_to_json is None:
        raise RuntimeError("mmt_render.mmt_text_to_json is not importable in this environment")

    out_dir.mkdir(parents=True, exist_ok=True)
    stem = _safe_stem(text)
    json_path = out_dir / f"{stem}.json"
    resolved_path = out_dir / f"{stem}.resolved.json"
    out_format_norm = (out_format or "png").strip().lower()
    if out_format_norm not in {"png", "pdf"}:
        raise ValueError(f"unsupported format: {out_format}")
    out_path: Path = (
        (out_dir / f"{stem}-{{0p}}.png") if out_format_norm == "png" else (out_dir / f"{stem}.pdf")
    )

    # Parse text -> json
    name_map_path, avatar_dir = _find_name_map_and_avatar_dir()

    name_map = mmt_text_to_json._load_name_to_id(name_map_path)
    data, _report = mmt_text_to_json.convert_text(
        text,
        name_to_id=name_map,
        avatar_dir=avatar_dir,
        join_with_newline=True,
        context_window=max(0, int(ctx_n)),
        typst_mode=bool(typst),
    )
    json_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    meta = data.get("meta") if isinstance(data, dict) else None
    meta = meta if isinstance(meta, dict) else {}

    chat_for_render = json_path
    resolve_stats: dict = {"unresolved": 0, "errors": []}
    if resolve:
        if resolve_file is None:
            raise RuntimeError("mmt_render.resolve_expressions.resolve_file is not importable in this environment")
        tags_root = plugin_config.tags_root_path()
        template = plugin_config.typst_template_path()
        await resolve_file(
            input_path=json_path,
            output_path=resolved_path,
            tags_root=tags_root,
            ref_root=template.parent,
            model=plugin_config.mmt_rerank_model,
            api_key_env=plugin_config.mmt_rerank_key_env,
            concurrency=plugin_config.mmt_rerank_concurrency,
            strict=bool(strict),
            asset_cache_dir=plugin_config.asset_cache_dir_path(),
            redownload_assets=bool(redownload_assets or getattr(plugin_config, "mmt_asset_redownload", False)),
            asset_max_mb=int(getattr(plugin_config, "mmt_asset_max_mb", 10) or 10),
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
        except Exception:
            pass

    # Render png(s) via typst (blocking)
    tags_root = plugin_config.tags_root_path()
    template = plugin_config.typst_template_path()
    if not template.is_absolute():
        template = (Path.cwd() / template).resolve()
    if not template.exists():
        # Fallback: common locations in a repo checkout
        for cand in (
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
    await asyncio.to_thread(
        _run_typst,
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

    if out_format_norm == "pdf":
        if out_path.exists():
            return [out_path], resolve_stats, meta, compiled_at
        raise RuntimeError("typst succeeded but no pdf output found")

    pngs = sorted(out_dir.glob(f"{stem}-*.png"), key=lambda p: p.name)
    if not pngs:
        single = out_dir / f"{stem}.png"
        if single.exists():
            return [single], resolve_stats, meta, compiled_at
        raise RuntimeError("typst succeeded but no png output found")
    return pngs, resolve_stats, meta, compiled_at


def _parse_flags(text: str, *, default_format: str) -> tuple[dict, str]:
    # Keep user's newlines in body; only strip leading CLI flags.
    s = text.strip()
    resolve = True
    strict = False
    ctx_n: Optional[int] = None
    image_scale: Optional[float] = None
    typst: bool = False
    disable_heading: bool = False
    no_time: bool = False
    out_format: str = (default_format or "png").strip().lower()
    redownload_assets: bool = False
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
        if s.startswith("--redownload-assets"):
            redownload_assets = True
            s = s[len("--redownload-assets") :]
            continue
        if s.startswith("--redownload_assets"):
            redownload_assets = True
            s = s[len("--redownload_assets") :]
            continue
        if s.startswith("--pdf"):
            out_format = "pdf"
            s = s[len("--pdf") :]
            continue
        if s.startswith("--png"):
            out_format = "png"
            s = s[len("--png") :]
            continue
        m = re.match(r"^--format(?:=|\s+)(png|pdf)(?=\s|$)", s, flags=re.IGNORECASE)
        if m:
            out_format = m.group(1).lower()
            s = s[m.end() :]
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
        break

    if show_help:
        ss = s.lstrip()
        m = re.match(r"^(syntax|dsl)(?:\\s+|$)", ss, flags=re.IGNORECASE)
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
        "help": show_help,
        "help_mode": help_mode,
    }
    return cfg, s.lstrip("\r\n ")


def _extract_invoker_name(event: Event) -> Optional[str]:
    try:
        fn = getattr(event, "get_user_name", None)
        if callable(fn):
            name = fn()
            if isinstance(name, str) and name.strip():
                return name.strip()
    except Exception:
        pass

    sender = getattr(event, "sender", None)
    if isinstance(sender, dict):
        name = (sender.get("card") or sender.get("nickname") or "").strip()
        if name:
            return name
    elif sender is not None:
        try:
            card = getattr(sender, "card", None)
            nickname = getattr(sender, "nickname", None)
            name = (str(card or nickname or "")).strip()
            if name:
                return name
        except Exception:
            pass

    try:
        fn = getattr(event, "get_user_id", None)
        if callable(fn):
            uid = fn()
            if isinstance(uid, str) and uid.strip():
                return uid.strip()
    except Exception:
        pass

    uid = getattr(event, "user_id", None)
    if uid is not None:
        s = str(uid).strip()
        if s:
            return s

    return None


def _inject_author_if_missing(text: str, author: Optional[str]) -> str:
    if not author:
        return text

    # Only consider the header region (before the first statement line).
    for line in text.splitlines():
        s = line.lstrip()
        if s.startswith(("- ", "> ", "< ")):
            break
        if re.match(r"^@author\\s*:", s):
            return text

    return f"@author: {author}\n{text}"


mmt = on_command("mmt", priority=10, block=True)
mmtpdf = on_command("mmtpdf", priority=10, block=True)
mmt_img = on_command("mmt-img", aliases={"mmtimg", "mmt_img"}, priority=10, block=True)
mmt_imgmatch = on_command("mmt-imgmatch", aliases={"mmtimgmatch", "mmt_imgmatch"}, priority=10, block=True)

async def _handle_mmt_common(
    *,
    matcher_name: str,
    bot: Bot,
    event: Event,
    raw: str,
    default_format: str,
) -> None:
    if not raw:
        if matcher_name == "mmtpdf":
            await mmtpdf.finish("请在指令后粘贴 MMT 文本，例如：/mmtpdf <内容>（默认会 resolve；默认输出 pdf）")
        await mmt.finish("请在指令后粘贴 MMT 文本，例如：/mmt <内容>（默认会 resolve）")

    flags, content = _parse_flags(raw, default_format=default_format)
    if flags.get("help"):
        if flags.get("help_mode") == "syntax":
            out_dir = plugin_config.work_dir_path()
            try:
                png_paths = await _render_syntax_help_pngs(out_dir=out_dir)
            except Exception as exc:
                logger.exception("render syntax help failed: %s", exc)
                if matcher_name == "mmtpdf":
                    await mmtpdf.finish(f"生成语法帮助失败：{exc}")
                await mmt.finish(f"生成语法帮助失败：{exc}")

            if V11MessageSegment is None or V11Message is None:
                if matcher_name == "mmtpdf":
                    await mmtpdf.finish(f"已生成：{png_paths[0]}")
                await mmt.finish(f"已生成：{png_paths[0]}")

            await _send_onebot_images(bot, event, png_paths)
            if matcher_name == "mmtpdf":
                await mmtpdf.finish()
            await mmt.finish()

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
                "- --typst：文本按 Typst markup 渲染（表情标记仅识别 '[:...]'）",
                "- --image-scale <0.1-1.0>：气泡内图片缩放",
                f"- --ctx-n <N>：'[图片]' 使用的上下文窗口大小（默认 {plugin_config.mmt_ctx_n}）",
                "- --disable-heading：关闭标题栏",
                "- --no-time：不自动填充编译时间",
                "",
                "其他指令：",
                "- /mmt-img <角色名>：列出该角色库内所有表情",
                "- /mmt-imgmatch <角色名> [--top-n=5] <描述>：语义匹配表情",
                "- /mmt -h syntax：渲染 DSL 语法速览图",
            ]
        )
        if matcher_name == "mmtpdf":
            await mmtpdf.finish(help_text)
        await mmt.finish(help_text)

    if not content:
        if matcher_name == "mmtpdf":
            await mmtpdf.finish("未检测到正文内容（参数后需要跟 MMT 文本）。")
        await mmt.finish("未检测到正文内容（参数后需要跟 MMT 文本）。")

    content = _inject_author_if_missing(content, _extract_invoker_name(event))

    out_dir = plugin_config.work_dir_path()
    try:
        out_paths, resolve_stats, meta, compiled_at = await _pipe_to_outputs(
            text=content,
            resolve=flags["resolve"],
            strict=flags["strict"],
            ctx_n=flags["ctx_n"],
            image_scale=flags.get("image_scale"),
            typst=bool(flags.get("typst")),
            disable_heading=bool(flags.get("disable_heading")),
            no_time=bool(flags.get("no_time")),
            out_format=str(flags.get("out_format") or default_format),
            redownload_assets=bool(flags.get("redownload_assets")),
            out_dir=out_dir,
        )
    except subprocess.CalledProcessError as exc:
        logger.exception("typst failed: %s", exc)
        if matcher_name == "mmtpdf":
            await mmtpdf.finish(f"Typst 渲染失败：{exc}")
        await mmt.finish(f"Typst 渲染失败：{exc}")
    except Exception as exc:
        logger.exception("mmt pipe failed: %s", exc)
        if matcher_name == "mmtpdf":
            await mmtpdf.finish(f"处理失败：{exc}")
        await mmt.finish(f"处理失败：{exc}")

    out_format_norm = str(flags.get("out_format") or default_format).strip().lower()
    if out_format_norm == "pdf":
        pdf_path = out_paths[0]
        upload_name = _format_pdf_name(meta=meta, compiled_at=compiled_at, fallback=pdf_path.stem)
        try:
            await _upload_onebot_file(bot, event, pdf_path, file_name=upload_name)
        except Exception as exc:
            logger.warning("upload pdf failed: %s", exc)
            if matcher_name == "mmtpdf":
                await mmtpdf.finish(f"已生成：{pdf_path}（上传失败：{exc}）")
            await mmt.finish(f"已生成：{pdf_path}（上传失败：{exc}）")

        msg = ""
        if flags["resolve"] and int(resolve_stats.get("unresolved") or 0) > 0:
            msg += f"\n注意：仍有 {resolve_stats['unresolved']} 处表情未解析（通常是找不到对应学生的 tags.json 或图片文件）。"
            errs = resolve_stats.get("errors") or []
            if errs:
                msg += "\n示例错误：" + "; ".join(str(x) for x in errs)
            msg += "\n可用 `--strict` 让其直接报错定位。"
        if matcher_name == "mmtpdf":
            await mmtpdf.finish(msg if msg else None)
        await mmt.finish(msg if msg else None)

    # PNG: For OneBot v11/NapCat, sending images is more compatible than sending PDFs.
    if V11MessageSegment is None or V11Message is None:
        if matcher_name == "mmtpdf":
            await mmtpdf.finish(f"已生成图片：{out_paths[0]}")
        await mmt.finish(f"已生成图片：{out_paths[0]}")

    await _send_onebot_images(bot, event, out_paths)
    msg = ""
    if flags["resolve"] and int(resolve_stats.get("unresolved") or 0) > 0:
        msg += f"\n注意：仍有 {resolve_stats['unresolved']} 处表情未解析（通常是找不到对应学生的 tags.json 或图片文件）。"
        errs = resolve_stats.get("errors") or []
        if errs:
            msg += "\n示例错误：" + "; ".join(str(x) for x in errs)
        msg += "\n可用 `--strict` 让其直接报错定位。"
    if matcher_name == "mmtpdf":
        await mmtpdf.finish(msg if msg else None)
    await mmt.finish(msg if msg else None)


@mmtpdf.handle()
async def _(bot: Bot, event: Event, state: T_State, arg=CommandArg()):
    raw = arg.extract_plain_text().strip()
    await _handle_mmt_common(matcher_name="mmtpdf", bot=bot, event=event, raw=raw, default_format="pdf")


@mmt.handle()
async def _(bot: Bot, event: Event, state: T_State, arg=CommandArg()):
    raw = arg.extract_plain_text().strip()
    await _handle_mmt_common(matcher_name="mmt", bot=bot, event=event, raw=raw, default_format="png")


@mmt_img.handle()
async def _(bot: Bot, event: Event, state: T_State, arg=CommandArg()):
    name = arg.extract_plain_text().strip()
    if not name:
        await mmt_img.finish("用法：/mmt-img <角色名>")

    if mmt_text_to_json is None:
        await mmt_img.finish("mmt_render.mmt_text_to_json 无法导入，无法解析角色名。")

    name_map_path, _avatar_dir = _find_name_map_and_avatar_dir()
    name_map = mmt_text_to_json._load_name_to_id(name_map_path)
    base_index = mmt_text_to_json._build_base_index(name_map)
    sid = mmt_text_to_json._resolve_student_id(name, name_map, base_index)
    if sid is None:
        await mmt_img.finish(f"未找到角色：{name}")

    tags_root = plugin_config.tags_root_path()
    tags_file = tags_root / str(sid) / "tags.json"
    if not tags_file.exists():
        await mmt_img.finish(f"该角色没有 tags.json：{tags_file}")

    try:
        raw = json.loads(tags_file.read_text(encoding="utf-8"))
    except Exception as exc:
        await mmt_img.finish(f"tags.json 解析失败：{exc}")
    if not isinstance(raw, list) or not raw:
        await mmt_img.finish("tags.json 为空。")

    out_dir = plugin_config.work_dir_path()
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = _safe_stem(name)
    data_json = out_dir / f"{stem}.mmt_img.json"
    png_out_tpl = out_dir / f"{stem}.mmt_img-{{0p}}.png"

    template = Path(__file__).with_name("mmt_img.typ").resolve()
    if not template.exists():
        await mmt_img.finish(f"typst 模板不存在：{template}")

    items = []
    # Use project-root absolute paths (`/...`) so Typst resolves them against `--root`
    # instead of relative to the template directory. This avoids `..` escaping issues.
    root_for_paths = _common_root(template, data_json, png_out_tpl, tags_root)
    for it in raw:
        if not isinstance(it, dict):
            continue
        image_name = str(it.get("image_name") or "")
        if not image_name:
            continue
        img_abs = (tags_root / str(sid) / image_name)
        try:
            img_abs_resolved = img_abs.resolve()
        except Exception:
            img_abs_resolved = img_abs.absolute()
        try:
            rel_from_root = Path(os.path.relpath(img_abs_resolved, start=root_for_paths.resolve())).as_posix()
            img_rel = f"/{rel_from_root.lstrip('/')}"
        except Exception:
            img_rel = str(img_abs_resolved).replace("\\", "/")
        tags = it.get("tags") if isinstance(it.get("tags"), list) else []
        tags = [str(x) for x in tags if isinstance(x, str)]
        desc = str(it.get("description") or "")
        items.append({"img_path": img_rel, "tags": tags, "description": desc})

    data_json.write_text(
        json.dumps({"character": name, "student_id": int(sid), "items": items}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    try:
        await asyncio.to_thread(
            _run_typst,
            typst_bin=plugin_config.mmt_typst_bin,
            template=template,
            input_json=data_json,
            out_path=png_out_tpl,
            tags_root=tags_root,
            out_format="png",
            input_key="data",
        )
    except Exception as exc:
        def _p(p: Path) -> str:
            try:
                return p.resolve().as_posix()
            except Exception:
                return p.absolute().as_posix()

        examples = ", ".join((it.get("img_path") or "") for it in items[:3])
        await mmt_img.finish(
            "Typst 渲染失败。\n"
            f"- error: {exc}\n"
            f"- data_json: {_p(data_json)}\n"
            f"- template: {_p(template)}\n"
            f"- tags_root: {_p(tags_root)}\n"
            f"- img_path examples: {examples}"
        )

    pngs = sorted(out_dir.glob(f"{stem}.mmt_img-*.png"), key=lambda p: p.name)
    if not pngs:
        single = out_dir / f"{stem}.mmt_img.png"
        if single.exists():
            pngs = [single]
    if not pngs:
        await mmt_img.finish("Typst 渲染成功但没找到输出图片。")

    try:
        await _send_onebot_images(bot, event, pngs)
    except Exception as exc:
        await mmt_img.finish(f"已生成：{pngs[0]}（发送失败：{exc}）")

    await mmt_img.finish(f"已发送 {len(pngs)} 张表格图（共 {len(items)} 条记录）。")


def _doc_text_for_rerank(item: dict) -> str:
    tags = item.get("tags") if isinstance(item.get("tags"), list) else []
    tags = [str(x) for x in tags if isinstance(x, str)]
    desc = str(item.get("description") or "")
    img = str(item.get("image_name") or "")
    tags_txt = ", ".join(tags[:32])
    if tags_txt:
        return f"{desc}\nTags: {tags_txt}\nFile: {img}"
    return f"{desc}\nFile: {img}"


def _parse_imgmatch_args(text: str) -> tuple[str, int, str]:
    """
    Parses: "<character_name> [--top-n=5] description..."
    Returns: (character_name, top_n, description)
    """
    s = text.strip()
    if not s:
        raise ValueError("missing args")
    # First token = name
    parts = s.split(None, 1)
    name = parts[0].strip()
    rest = parts[1] if len(parts) == 2 else ""

    top_n = 5
    # allow --top-n=5 or --top-n 5
    m = re.search(r"(?:^|\s)--top-n(?:=|\s+)(\d+)(?=\s|$)", rest)
    if m:
        top_n = max(1, int(m.group(1)))
        rest = (rest[: m.start()] + " " + rest[m.end() :]).strip()

    desc = rest.strip()
    if not desc:
        raise ValueError("missing description")
    return name, top_n, desc


@mmt_imgmatch.handle()
async def _(bot: Bot, event: Event, state: T_State, arg=CommandArg()):
    raw = arg.extract_plain_text().strip()
    try:
        name, top_n, query = _parse_imgmatch_args(raw)
    except Exception:
        await mmt_imgmatch.finish("用法：/mmt-imgmatch <角色名> [--top-n=5] <描述>")

    if mmt_text_to_json is None:
        await mmt_imgmatch.finish("mmt_render.mmt_text_to_json 无法导入，无法解析角色名。")
    if SiliconFlowRerankConfig is None or SiliconFlowReranker is None:
        await mmt_imgmatch.finish("mmt_render.siliconflow_rerank 无法导入，无法使用 reranker。")

    name_map_path, _avatar_dir = _find_name_map_and_avatar_dir()
    name_map = mmt_text_to_json._load_name_to_id(name_map_path)
    base_index = mmt_text_to_json._build_base_index(name_map)
    sid = mmt_text_to_json._resolve_student_id(name, name_map, base_index)
    if sid is None:
        await mmt_imgmatch.finish(f"未找到角色：{name}")

    tags_root = plugin_config.tags_root_path()
    tags_file = tags_root / str(sid) / "tags.json"
    if not tags_file.exists():
        await mmt_imgmatch.finish(f"该角色没有 tags.json：{tags_file}")

    try:
        raw_items = json.loads(tags_file.read_text(encoding="utf-8"))
    except Exception as exc:
        await mmt_imgmatch.finish(f"tags.json 解析失败：{exc}")
    if not isinstance(raw_items, list) or not raw_items:
        await mmt_imgmatch.finish("tags.json 为空。")

    docs: list[str] = []
    cleaned: list[dict] = []
    for it in raw_items:
        if not isinstance(it, dict):
            continue
        if not it.get("image_name"):
            continue
        cleaned.append(it)
        docs.append(_doc_text_for_rerank(it))
    if not cleaned:
        await mmt_imgmatch.finish("tags.json 没有有效条目（缺 image_name）。")

    cfg = SiliconFlowRerankConfig(api_key_env=plugin_config.mmt_rerank_key_env, model=plugin_config.mmt_rerank_model)
    try:
        async with SiliconFlowReranker(cfg) as reranker:
            results = await reranker.rerank(query=query, documents=docs, top_n=min(top_n, len(docs)), return_documents=False)
    except Exception as exc:
        await mmt_imgmatch.finish(f"rerank 失败：{exc}")

    # Prepare typst data
    out_dir = plugin_config.work_dir_path()
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = _safe_stem(name + query)
    data_json = out_dir / f"{stem}.mmt_imgmatch.json"
    png_out_tpl = out_dir / f"{stem}.mmt_imgmatch-{{0p}}.png"

    template = Path(__file__).with_name("mmt_imgmatch.typ").resolve()
    if not template.exists():
        await mmt_imgmatch.finish(f"typst 模板不存在：{template}")

    root_for_paths = _common_root(template, data_json, png_out_tpl, tags_root)
    items: list[dict] = []
    for r in results:
        idx = r.get("index")
        if not isinstance(idx, int) or not (0 <= idx < len(cleaned)):
            continue
        base = cleaned[idx]
        image_name = str(base.get("image_name") or "")
        img_abs = tags_root / str(sid) / image_name
        try:
            img_abs_resolved = img_abs.resolve()
        except Exception:
            img_abs_resolved = img_abs.absolute()
        try:
            rel_from_root = Path(os.path.relpath(img_abs_resolved, start=root_for_paths.resolve())).as_posix()
            img_path = f"/{rel_from_root.lstrip('/')}"
        except Exception:
            img_path = str(img_abs_resolved).replace("\\", "/")
        tags = base.get("tags") if isinstance(base.get("tags"), list) else []
        tags = [str(x) for x in tags if isinstance(x, str)]
        desc = str(base.get("description") or "")
        score = float(r.get("score") or 0.0)
        items.append(
            {
                "img_path": img_path,
                "image_name": image_name,
                "tags": tags,
                "description": desc,
                "score": round(score, 6),
            }
        )

    data_json.write_text(
        json.dumps({"character": name, "student_id": int(sid), "query": query, "items": items}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    try:
        await asyncio.to_thread(
            _run_typst,
            typst_bin=plugin_config.mmt_typst_bin,
            template=template,
            input_json=data_json,
            out_path=png_out_tpl,
            tags_root=tags_root,
            out_format="png",
            input_key="data",
        )
    except Exception as exc:
        await mmt_imgmatch.finish(f"Typst 渲染失败：{exc}\n- data_json: {data_json}")

    pngs = sorted(out_dir.glob(f"{stem}.mmt_imgmatch-*.png"), key=lambda p: p.name)
    if not pngs:
        single = out_dir / f"{stem}.mmt_imgmatch.png"
        if single.exists():
            pngs = [single]
    if not pngs:
        await mmt_imgmatch.finish("Typst 渲染成功但没找到输出图片。")

    try:
        await _send_onebot_images(bot, event, pngs)
    except Exception as exc:
        await mmt_imgmatch.finish(f"已生成：{pngs[0]}（发送失败：{exc}）")

    await mmt_imgmatch.finish(f"已发送 {len(pngs)} 张匹配结果（top_n={top_n}）。")
