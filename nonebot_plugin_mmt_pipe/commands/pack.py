from __future__ import annotations

from nonebot import on_command
from nonebot.adapters import Bot, Event
from nonebot.params import CommandArg
from nonebot.typing import T_State

from .registry import ALCONNA_AVAILABLE, Alconna, Args, CommandResult, Subcommand, on_alconna
from ..services.common import join_tokens
from ..services.pack import handle_mmt_pack


_alc_mmt_pack = Alconna("mmt-pack", Subcommand("list"), Subcommand("accept", Args["pack_id", str]))
mmt_pack = on_alconna(
    _alc_mmt_pack,
    aliases={"mmtpack", "mmt_pack"},
    priority=10,
    block=True,
    use_cmd_start=True,
    skip_for_unmatch=False
)

@mmt_pack.handle()
async def _(bot: Bot, event: Event, state: T_State, result: CommandResult):
    arp = result.result
    cmd = ""
    pack_id = None
    acc = arp.query("accept") if arp else None
    if acc is not None:
        cmd = "accept"
        pack_id = join_tokens(acc.args.get("pack_id"))
    elif arp.query("list") is not None:
        cmd = "list"
    await handle_mmt_pack(finish=mmt_pack.finish, bot=bot, event=event, cmd=cmd, pack_id=pack_id)



__all__ = ["mmt_pack"]
