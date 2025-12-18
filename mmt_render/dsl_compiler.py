from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional, Tuple


@dataclass(frozen=True)
class CompileOptions:
    join_with_newline: bool = True
    context_window: int = 2
    typst_mode: bool = False
    pack_v2_root: Optional[Path] = None


class MMTCompiler:
    """
    Compiler skeleton for the DSL refactor.

    Current behavior: delegates to legacy `mmt_text_to_json.convert_text` to keep output stable.
    Subsequent commits will migrate logic from the legacy implementation into this class.
    """

    def compile_text(
        self,
        text: str,
        *,
        name_to_id: Dict[str, int],
        avatar_dir: Optional[Path],
        options: CompileOptions,
    ) -> Tuple[dict, dict]:
        # Defer import to avoid future circular dependencies when we start moving code.
        from mmt_render import mmt_text_to_json

        return mmt_text_to_json.convert_text(
            text,
            name_to_id=name_to_id,
            avatar_dir=avatar_dir,
            join_with_newline=bool(options.join_with_newline),
            context_window=max(0, int(options.context_window)),
            typst_mode=bool(options.typst_mode),
            pack_v2_root=options.pack_v2_root,
        )

    def compile_nodes(self, nodes: list[Any], *, options: CompileOptions) -> Tuple[dict, dict]:
        raise NotImplementedError("compile_nodes is not implemented yet; use compile_text() for now.")

