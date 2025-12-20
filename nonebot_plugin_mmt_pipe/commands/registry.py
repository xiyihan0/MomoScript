from __future__ import annotations

# try:
from nonebot_plugin_alconna import (
    Alconna,
    Args,
    CommandResult,
    MultiVar,
    Option,
    Subcommand,
    on_alconna,
)
from arclet.alconna import AllParam, Namespace
from arclet.alconna.config import config as _ALCONNA_CONFIG

_ALCONNA_NAMESPACE = _ALCONNA_CONFIG.namespaces.get("mmt_pipe")
if _ALCONNA_NAMESPACE is None:
    _ALCONNA_NAMESPACE = Namespace("mmt_pipe")
    _ALCONNA_CONFIG.namespaces["mmt_pipe"] = _ALCONNA_NAMESPACE
_ALCONNA_NAMESPACE.disable_builtin_options.add("help")

ALCONNA_AVAILABLE = True
# except Exception:  # pragma: no cover
#     Alconna = None  # type: ignore
#     Args = None  # type: ignore
#     CommandResult = None  # type: ignore
#     MultiVar = None  # type: ignore
#     Option = None  # type: ignore
#     Subcommand = None  # type: ignore
#     on_alconna = None  # type: ignore
#     AllParam = None  # type: ignore
#     _ALCONNA_NAMESPACE = None  # type: ignore
#     ALCONNA_AVAILABLE = False


__all__ = [
    "ALCONNA_AVAILABLE",
    "Alconna",
    "Args",
    "AllParam",
    "CommandResult",
    "MultiVar",
    "Option",
    "Subcommand",
    "_ALCONNA_NAMESPACE",
    "on_alconna",
]
