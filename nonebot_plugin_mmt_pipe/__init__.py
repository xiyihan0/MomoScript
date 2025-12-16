from __future__ import annotations

from nonebot.plugin import PluginMetadata

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
