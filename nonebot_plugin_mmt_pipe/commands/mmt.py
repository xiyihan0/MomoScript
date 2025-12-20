from __future__ import annotations

from nonebot import on_command
from nonebot.adapters import Bot, Event
from nonebot.params import CommandArg
from nonebot.typing import T_State

from .registry import ALCONNA_AVAILABLE, Alconna, AllParam, Args, CommandResult, on_alconna, _ALCONNA_NAMESPACE
from ..services.common import join_tokens
from ..services.io import event_message_or_empty
from ..services.mmt import handle_mmt_common


if ALCONNA_AVAILABLE:
    _alc_mmt = Alconna(
        "mmt",
        Args["text?", AllParam],
        namespace=_ALCONNA_NAMESPACE,
    )
    _alc_mmtpdf = Alconna(
        "mmtpdf",
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
        args = arp.all_matched_args if arp else {}
        raw = join_tokens(args.get("text"))
        await handle_mmt_common(
            finish=mmtpdf.finish,
            matcher_name="mmtpdf",
            bot=bot,
            event=event,
            raw=raw,
            arg_msg=event_message_or_empty(event),
            default_format="pdf",
        )

    @mmt.handle()
    async def _(bot: Bot, event: Event, state: T_State, result: CommandResult):
        arp = result.result
        args = arp.all_matched_args if arp else {}
        raw = join_tokens(args.get("text"))
        await handle_mmt_common(
            finish=mmt.finish,
            matcher_name="mmt",
            bot=bot,
            event=event,
            raw=raw,
            arg_msg=event_message_or_empty(event),
            default_format="png",
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
