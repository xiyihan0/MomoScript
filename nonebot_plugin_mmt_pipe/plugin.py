from __future__ import annotations

# Import command modules to register matchers on plugin load.
from .commands import asset as _asset  # noqa: F401
from .commands import img as _img  # noqa: F401
from .commands import mmt as _mmt  # noqa: F401
from .commands import pack as _pack  # noqa: F401

# Re-export for plugin metadata imports.
from .commands.mmt import mmtpdf  # noqa: F401
