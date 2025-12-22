from __future__ import annotations

from nonebot.plugin import PluginMetadata

try:
    from nonebot import require
except Exception:  # pragma: no cover
    require = None  # type: ignore

if require is not None:
    try:
        require("nonebot_plugin_alconna")
    except Exception:
        pass

from .plugin import mmtpdf  # noqa: F401

__plugin_meta__ = PluginMetadata(
    name="MMT Pipe",
    description="Parse MMT DSL and render to PDF (optional rerank resolve).",
    usage=(
        "/mmtpdf <MMT文本>\n"
        "/mmtpdf --resolve <MMT文本>\n"
        "也可发送指令后分行粘贴文本。"
    ),
)
