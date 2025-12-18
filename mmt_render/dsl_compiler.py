from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple


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

    # --- New pipeline (WIP) ---

    @dataclass
    class _State:
        meta: Dict[str, Any] = field(default_factory=dict)
        typst_global: str = ""
        packs_aliases: Dict[str, str] = field(default_factory=dict)
        packs_order: List[str] = field(default_factory=list)
        # Nodes to be compiled into chat later
        body: List[Any] = field(default_factory=list)

    def __init__(self) -> None:
        self._directive_handlers: Dict[str, Callable[[MMTCompiler._State, Any], None]] = {
            "@alias": self._handle_alias,
            "@tmpalias": self._handle_tmpalias,
            "@aliasid": self._handle_aliasid,
            "@unaliasid": self._handle_unaliasid,
            "@charid": self._handle_charid,
            "@uncharid": self._handle_uncharid,
            "@avatarid": self._handle_avatarid,
            "@unavatarid": self._handle_unavatarid,
            "@avatar": self._handle_avatar,
        }

    def parse_nodes(self, text: str) -> List[Any]:
        from mmt_render.dsl_parser import MMTLineParser

        return MMTLineParser().parse(text)

    def compile_nodes(self, nodes: List[Any], *, options: CompileOptions) -> Tuple[dict, dict]:
        """
        Experimental compiler entrypoint.
        Not wired into production yet.
        """
        st = self._State()
        for node in nodes:
            self._handle_node(st, node)
        data = {
            "meta": st.meta,
            "typst_global": st.typst_global,
            "packs": {"aliases": st.packs_aliases, "order": st.packs_order},
            "chars": [],
            "custom_chars": [],
            "chat": [],
        }
        report = {"note": "dsl_compiler.compile_nodes is not implemented yet"}
        return data, report

    def _handle_node(self, st: _State, node: Any) -> None:
        t = node.__class__.__name__
        if t == "MetaKV":
            st.meta[str(getattr(node, "key"))] = str(getattr(node, "value"))
            return
        if t == "TypstGlobal":
            st.typst_global = str(getattr(node, "value"))
            return
        if t == "UsePack":
            alias = str(getattr(node, "alias"))
            pack_id = str(getattr(node, "pack_id"))
            st.packs_aliases[alias] = pack_id
            if alias not in st.packs_order:
                st.packs_order.append(alias)
            return
        if t == "Directive":
            name = str(getattr(node, "name") or "").lower()
            h = self._directive_handlers.get(name)
            if h is None:
                st.body.append(node)
                return
            h(st, node)
            return
        st.body.append(node)

    def _handle_alias(self, st: _State, node: Any) -> None:
        st.body.append(node)

    def _handle_tmpalias(self, st: _State, node: Any) -> None:
        st.body.append(node)

    def _handle_aliasid(self, st: _State, node: Any) -> None:
        st.body.append(node)

    def _handle_unaliasid(self, st: _State, node: Any) -> None:
        st.body.append(node)

    def _handle_charid(self, st: _State, node: Any) -> None:
        st.body.append(node)

    def _handle_uncharid(self, st: _State, node: Any) -> None:
        st.body.append(node)

    def _handle_avatarid(self, st: _State, node: Any) -> None:
        st.body.append(node)

    def _handle_unavatarid(self, st: _State, node: Any) -> None:
        st.body.append(node)

    def _handle_avatar(self, st: _State, node: Any) -> None:
        st.body.append(node)
