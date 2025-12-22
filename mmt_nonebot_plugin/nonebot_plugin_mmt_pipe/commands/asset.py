from __future__ import annotations

from nonebot import on_command
from nonebot.adapters import Bot, Event
from nonebot.params import CommandArg
from nonebot.typing import T_State

from ..services.assets import handle_mmt_asset


mmt_asset = on_command("mmt-asset", aliases={"mmtasset", "mmt_asset"}, priority=10, block=True)


@mmt_asset.handle()
async def _(bot: Bot, event: Event, state: T_State, arg=CommandArg()):
    raw = arg.extract_plain_text().strip()
    await handle_mmt_asset(finish=mmt_asset.finish, bot=bot, event=event, raw=raw, arg_msg=arg)


__all__ = ["mmt_asset"]
