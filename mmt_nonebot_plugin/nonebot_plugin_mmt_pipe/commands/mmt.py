from __future__ import annotations

from nonebot.adapters import Bot, Event
from nonebot.typing import T_State

from arclet.alconna import store_true

from .registry import (
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
    flags: dict = {
        "help": "help" in opts,
        "from_file": "from_file" in opts,
        "verbose": "verbose" in opts,
    }
    if "out_png" in opts:
        flags["out_format"] = "png"
    if "out_pdf" in opts:
        flags["out_format"] = "pdf"
    if args.get("out_format"):
        flags["out_format"] = str(args["out_format"]).strip().lower()
    return flags


_mmt_options = (
    Option("--help", alias=["-h"], action=store_true, dest="help"),
    Option("--file", action=store_true, dest="from_file"),
    Option("--verbose", alias=["-v"], action=store_true, dest="verbose"),
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


__all__ = ["mmt", "mmtpdf"]
