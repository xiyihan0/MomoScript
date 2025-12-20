from __future__ import annotations

from nonebot import on_command
from nonebot.adapters import Bot, Event
from nonebot.params import CommandArg
from nonebot.typing import T_State

from arclet.alconna import store_true

from .registry import (
    ALCONNA_AVAILABLE,
    Alconna,
    AllParam,
    Args,
    CommandResult,
    Option,
    on_alconna,
    _ALCONNA_NAMESPACE,
)
from ..services.common import join_tokens
from ..services.io import event_message_or_empty
from ..services.mmt import handle_mmt_common


def _build_mmt_flags_override(arp) -> dict:
    if not arp:
        return {}
    try:
        arp.unpack()
    except Exception:
        pass
    opts = arp.options or {}
    args = arp.all_matched_args or {}

    def _has(opt_name: str) -> bool:
        return opt_name in opts

    flags: dict = {}
    if _has("help"):
        flags["help"] = True
    if _has("typst"):
        flags["typst"] = True
    if _has("no_resolve"):
        flags["resolve"] = False
    if _has("resolve"):
        flags["resolve"] = True
    if _has("strict"):
        flags["strict"] = True
    if _has("disable_heading"):
        flags["disable_heading"] = True
    if _has("no_time"):
        flags["no_time"] = True
    if _has("from_file"):
        flags["from_file"] = True
    if _has("verbose"):
        flags["verbose"] = True
    if _has("redownload_assets"):
        flags["redownload_assets"] = True
    if _has("allow_local_assets"):
        flags["allow_local_assets"] = True
    if _has("out_png"):
        flags["out_format"] = "png"
    if _has("out_pdf"):
        flags["out_format"] = "pdf"

    if args.get("image_scale") is not None:
        try:
            flags["image_scale"] = float(args.get("image_scale"))
        except Exception:
            flags["image_scale"] = None
    if args.get("ctx_n") is not None:
        try:
            flags["ctx_n"] = int(args.get("ctx_n"))
        except Exception:
            flags["ctx_n"] = None
    if args.get("asset_local_prefixes"):
        flags["asset_local_prefixes"] = str(args.get("asset_local_prefixes"))
    if args.get("out_format"):
        flags["out_format"] = str(args.get("out_format")).strip().lower()

    return flags


if ALCONNA_AVAILABLE:
    _mmt_options = (
        Option("--help", alias=["-h"], action=store_true, dest="help"),
        Option("--typst", alias=["-t"], action=store_true, dest="typst"),
        Option("--no-resolve", alias=["--noresolve"], action=store_true, dest="no_resolve"),
        Option("--resolve", action=store_true, dest="resolve"),
        Option("--strict", action=store_true, dest="strict"),
        Option("--disable-heading", alias=["--disable_heading"], action=store_true, dest="disable_heading"),
        Option("--no-time", alias=["--no_time"], action=store_true, dest="no_time"),
        Option("--file", action=store_true, dest="from_file"),
        Option("--verbose", alias=["-v"], action=store_true, dest="verbose"),
        Option("--redownload-assets", action=store_true, dest="redownload_assets"),
        Option("--allow-local-assets", action=store_true, dest="allow_local_assets"),
        Option("--asset-local-prefixes", Args["asset_local_prefixes", str], dest="asset_local_prefixes"),
        Option("--image-scale", Args["image_scale", float], alias=["--image_scale"], dest="image_scale"),
        Option("--ctx-n", Args["ctx_n", int], alias=["--ctx_n"], dest="ctx_n"),
        Option("--png", action=store_true, dest="out_png"),
        Option("--pdf", action=store_true, dest="out_pdf"),
        Option("--format", Args["out_format", str], dest="out_format"),
    )
    _alc_mmt = Alconna(
        "mmt",
        *_mmt_options,
        Args["text?", AllParam],
        namespace=_ALCONNA_NAMESPACE,
    )
    _alc_mmtpdf = Alconna(
        "mmtpdf",
        *_mmt_options,
        Args["text?", AllParam],
        namespace=_ALCONNA_NAMESPACE,
    )
    mmt = on_alconna(
        _alc_mmt,
        priority=10,
        block=True,
        use_cmd_start=True,
    )
    mmtpdf = on_alconna(
        _alc_mmtpdf,
        priority=10,
        block=True,
        use_cmd_start=True,
    )
else:
    mmt = on_command("mmt", priority=10, block=True, force_whitespace=True)
    mmtpdf = on_command("mmtpdf", priority=10, block=True, force_whitespace=True)


if ALCONNA_AVAILABLE:
    @mmtpdf.handle()
    async def _(bot: Bot, event: Event, state: T_State, result: CommandResult):
        arp = result.result
        flags_override = _build_mmt_flags_override(arp)
        args = arp.all_matched_args if arp else {}
        raw_val = args.get("text")
        raw = raw_val if isinstance(raw_val, str) else join_tokens(raw_val)
        await handle_mmt_common(
            finish=mmtpdf.finish,
            matcher_name="mmtpdf",
            bot=bot,
            event=event,
            raw=raw,
            arg_msg=event_message_or_empty(event),
            default_format="pdf",
            flags_override=flags_override,
        )

    @mmt.handle()
    async def _(bot: Bot, event: Event, state: T_State, result: CommandResult):
        arp = result.result
        flags_override = _build_mmt_flags_override(arp)
        args = arp.all_matched_args if arp else {}
        raw_val = args.get("text")
        raw = raw_val if isinstance(raw_val, str) else join_tokens(raw_val)
        await handle_mmt_common(
            finish=mmt.finish,
            matcher_name="mmt",
            bot=bot,
            event=event,
            raw=raw,
            arg_msg=event_message_or_empty(event),
            default_format="png",
            flags_override=flags_override,
        )
else:
    @mmtpdf.handle()
    async def _(bot: Bot, event: Event, state: T_State, arg=CommandArg()):
        raw = arg.extract_plain_text().strip()
        await handle_mmt_common(
            finish=mmtpdf.finish,
            matcher_name="mmtpdf",
            bot=bot,
            event=event,
            raw=raw,
            arg_msg=arg,
            default_format="pdf",
        )

    @mmt.handle()
    async def _(bot: Bot, event: Event, state: T_State, arg=CommandArg()):
        raw = arg.extract_plain_text().strip()
        await handle_mmt_common(
            finish=mmt.finish,
            matcher_name="mmt",
            bot=bot,
            event=event,
            raw=raw,
            arg_msg=arg,
            default_format="png",
        )


__all__ = ["mmt", "mmtpdf"]
