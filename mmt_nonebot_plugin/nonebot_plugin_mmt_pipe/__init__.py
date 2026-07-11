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
    description="Compile Rust DSL v2 with pack-v3 and render PNG/PDF via Typst.",
    usage=(
        "/mmt <Rust DSL v2 文本>\n"
        "/mmtpdf <Rust DSL v2 文本>\n"
        "支持 --file、--png、--pdf 与 --verbose。"
    ),
)
