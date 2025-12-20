from __future__ import annotations

from nonebot import on_command
from nonebot.adapters import Bot, Event
from nonebot.params import CommandArg
from nonebot.typing import T_State

from .registry import ALCONNA_AVAILABLE, Alconna, Args, CommandResult, MultiVar, Option, on_alconna
from ..services.common import join_tokens, parse_pack_csv
from ..services.img import handle_imgmatch, handle_mmt_img


# if ALCONNA_AVAILABLE:
_alc_mmt_img = Alconna(
    "mmt-img",
    Option("--pack", Args["packs", str]),
    Option("--page", Args["page", int]),
    Args["name", MultiVar(str)],
)
_alc_mmt_imgmatch = Alconna(
    "mmt-imgmatch",
    Option("--pack", Args["packs", str]),
    Option("--top-n", Args["top_n", int]),
    Args["name", str]["query", MultiVar(str)],
)
mmt_img = on_alconna(_alc_mmt_img, aliases={"mmtimg", "mmt_img"}, priority=10, block=True, use_cmd_start=True, skip_for_unmatch=False)
mmt_imgmatch = on_alconna(
    _alc_mmt_imgmatch,
    aliases={"mmtimgmatch", "mmt_imgmatch"},
    priority=10,
    block=True,
    use_cmd_start=True,
    skip_for_unmatch=False
)

# if ALCONNA_AVAILABLE:
@mmt_img.handle()
async def _(bot: Bot, event: Event, state: T_State, result: CommandResult):
    arp = result.result
    args = arp.all_matched_args if arp else {}
    name = join_tokens(args.get("name"))
    packs_raw = join_tokens(args.get("packs"))
    packs = parse_pack_csv(packs_raw) if packs_raw else None
    page = int(args.get("page") or 1)
    await handle_mmt_img(finish=mmt_img.finish, bot=bot, event=event, name=name, packs=packs, page=page)

@mmt_imgmatch.handle()
async def _(bot: Bot, event: Event, state: T_State, result: CommandResult):
    arp = result.result
    args = arp.all_matched_args if arp else {}
    name = join_tokens(args.get("name"))
    query = join_tokens(args.get("query"))
    packs_raw = join_tokens(args.get("packs"))
    packs = parse_pack_csv(packs_raw) if packs_raw else None
    top_n = int(args.get("top_n") or 5)
    await handle_imgmatch(
        finish=mmt_imgmatch.finish,
        bot=bot,
        event=event,
        packs=packs,
        name=name,
        top_n=top_n,
        query=query,
    )


__all__ = ["mmt_img", "mmt_imgmatch"]
