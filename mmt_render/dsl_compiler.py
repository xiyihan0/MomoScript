from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from mmt_render.inline_expr import is_backref_target, parse_backref_n, parse_inline_segments


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
            dsl_engine="legacy",
        )

    # --- New pipeline (WIP) ---

    @dataclass
    class _State:
        meta: Dict[str, Any] = field(default_factory=dict)
        typst_global: str = ""
        packs_aliases: Dict[str, str] = field(default_factory=dict)
        packs_order: List[str] = field(default_factory=list)
        # Parse-time state (copied from legacy convert_text)
        messages: List[Dict[str, Any]] = field(default_factory=list)
        last_kind: Optional[str] = None
        # Nodes we don't understand yet (kept for debugging)
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

        # Legacy-like runtime fields (initialized in compile_nodes)
        self._name_to_id: Dict[str, int] = {}
        self._avatar_dir: Optional[Path] = None
        self._options: CompileOptions = CompileOptions()
        self._base_index: Dict[str, List[int]] = {}

        self._pack_v2_ba: Any = None

        # Namespace importing order for bare selectors
        self._using_namespaces: List[str] = ["ba", "custom"]

        # Speaker state for each side
        from mmt_render.mmt_text_to_json import SpeakerState  # reuse exact behavior

        self._speaker_state = {">": SpeakerState(), "<": SpeakerState()}

        # Alias state
        self._alias_char_id_to_override: Dict[str, str] = {}
        self._alias_id_to_name: Dict[str, str] = {}
        self._custom_id_to_display: Dict[str, str] = {}
        self._current_avatar_override_by_char_id: Dict[str, str] = {}

        self._pending_tmpalias: Dict[str, Dict[str, str]] = {">": {}, "<": {}}
        self._active_tmpalias: Dict[str, Optional[Tuple[str, str]]] = {">": None, "<": None}

        self._char_id_to_display_name: Dict[str, str] = {}

    def parse_nodes(self, text: str) -> List[Any]:
        from mmt_render.dsl_parser import MMTLineParser

        return MMTLineParser().parse(text)

    def compile_nodes(
        self,
        nodes: List[Any],
        *,
        name_to_id: Dict[str, int],
        avatar_dir: Optional[Path],
        options: CompileOptions,
    ) -> Tuple[dict, dict]:
        """
        Experimental compiler entrypoint.
        Goal: match legacy convert_text output, but with code split into parse/eval stages.
        """
        self._name_to_id = dict(name_to_id or {})
        self._avatar_dir = avatar_dir
        self._options = options

        from mmt_render.mmt_text_to_json import _build_base_index, _load_name_to_id  # noqa: F401

        self._base_index = _build_base_index(self._name_to_id)

        # Load pack-v2 ba if available.
        self._pack_v2_ba = None
        try:
            from mmt_render.pack_v2 import load_pack_v2
        except Exception:  # pragma: no cover
            load_pack_v2 = None  # type: ignore
        if load_pack_v2 is not None and options.pack_v2_root is not None:
            ba_root = (Path(options.pack_v2_root).expanduser() / "ba").resolve()
            if ba_root.exists():
                try:
                    self._pack_v2_ba = load_pack_v2(ba_root)
                except Exception:
                    self._pack_v2_ba = None

        st = self._State()
        for node in nodes:
            self._handle_node(st, node)

        # Post-process: segments
        self._attach_segments(st)
        custom_chars = self._build_custom_chars(st)
        data = {
            "meta": st.meta,
            "typst_global": st.typst_global,
            "packs": {"aliases": st.packs_aliases, "order": st.packs_order},
            "chars": [],
            "custom_chars": custom_chars,
            "chat": st.messages,
        }
        report = {"note": "dsl_compiler experimental", "message_count": len(st.messages)}
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
        if t == "PageBreak":
            st.messages.append(
                {
                    "yuzutalk": {"type": "PAGEBREAK", "avatarState": "AUTO", "nameOverride": ""},
                    "content": "",
                    "line_no": int(getattr(node, "line_no")),
                }
            )
            st.last_kind = "-"
            return
        if t == "BlankLine":
            # typst-mode: blank line is meaningful as continuation within a statement
            if bool(self._options.typst_mode) and st.last_kind is not None and st.messages:
                self._append_continuation(st, "")
            return
        if t == "Continuation":
            self._append_continuation(st, str(getattr(node, "text")))
            return
        if t == "Statement" or t == "Block":
            self._emit_statement(st, node, is_block=(t == "Block"))
            return
        st.body.append(node)

    def _append_continuation(self, st: _State, text: str) -> None:
        if not st.messages:
            raise ValueError("continuation line before any statement")
        sep = "\n" if bool(self._options.join_with_newline) else " "
        st.messages[-1]["content"] = f"{st.messages[-1].get('content','')}{sep}{text}"

    def _emit_statement(self, st: _State, node: Any, *, is_block: bool) -> None:
        kind = str(getattr(node, "kind"))
        line_no = int(getattr(node, "line_no"))
        marker = getattr(node, "marker")
        content = str(getattr(node, "content") or "")

        st.last_kind = kind

        if kind == "-":
            msg: Dict[str, Any] = {
                "yuzutalk": {"type": "NARRATION", "avatarState": "AUTO", "nameOverride": ""},
                "content": content,
                "line_no": line_no,
            }
            if is_block:
                msg["no_inline_expr"] = True
            st.messages.append(msg)
            return

        if kind not in {">", "<"}:
            st.body.append(node)
            return

        # Resolve speaker for this side.
        state = self._speaker_state[kind]
        speaker: Optional[str] = None
        speaker_raw_for_display: Optional[str] = None
        if marker is None:
            speaker = state.current
            if speaker is None and kind != "<":
                raise ValueError(f"line {line_no}: missing speaker for '{kind}'")
        else:
            mtype, mval = marker
            if mtype == "explicit":
                raw_name = str(mval)
                canonical = self._alias_id_to_name.get(raw_name, raw_name)
                char_id_resolved, disp_guess = self._resolve_char_id_from_selector(
                    canonical, line_no=line_no, allow_custom_fallback=True
                )
                speaker = state.set_explicit(char_id_resolved)
                speaker_raw_for_display = disp_guess
            elif mtype == "backref":
                speaker = state.set_backref(int(mval))
            elif mtype == "index":
                speaker = state.set_index(int(mval))
            else:
                raise ValueError(f"line {line_no}: unknown marker type {mtype}")

        side = "right" if kind == "<" else "left"

        if speaker is None:
            char_id = "__Sensei"
        else:
            char_id = speaker

        # tmpalias lifecycle: speaker change clears the active tmpalias for this side.
        active = self._active_tmpalias[kind]
        if active is not None and active[0] != char_id:
            self._active_tmpalias[kind] = None
            active = None

        # Activate pending tmpalias on the next matching TEXT line
        if char_id in self._pending_tmpalias[kind]:
            override = self._pending_tmpalias[kind].pop(char_id)
            self._active_tmpalias[kind] = (char_id, override)
            active = self._active_tmpalias[kind]

        name_override = ""
        if active is not None and active[0] == char_id:
            name_override = active[1]
        elif char_id in self._alias_char_id_to_override:
            name_override = self._alias_char_id_to_override[char_id]

        msg2: Dict[str, Any] = {
            "yuzutalk": {"type": "TEXT", "avatarState": "AUTO", "nameOverride": name_override or ""},
            "side": side,
            "content": content,
            "line_no": line_no,
        }

        if char_id != "__Sensei":
            msg2["char_id"] = char_id

        if speaker_raw_for_display:
            self._char_id_to_display_name[char_id] = speaker_raw_for_display

        if char_id in self._current_avatar_override_by_char_id:
            msg2["avatar_override"] = self._current_avatar_override_by_char_id[char_id]

        if is_block:
            msg2["no_inline_expr"] = True

        st.messages.append(msg2)

    def _handle_alias(self, st: _State, node: Any) -> None:
        # Syntax: @alias <name>=<override>
        payload = str(getattr(node, "payload") or "").strip()
        m = re.match(r"^@alias\s+(.+)$", payload, flags=re.IGNORECASE)
        if not m:
            raise ValueError(f"line {getattr(node,'line_no')}: invalid @alias directive")
        rest = m.group(1).strip()
        if "=" not in rest:
            raise ValueError(f"line {getattr(node,'line_no')}: invalid @alias directive (missing '=')")
        base_name, override = rest.split("=", 1)
        base_name = base_name.strip()
        override = override.strip()
        if not base_name:
            raise ValueError(f"line {getattr(node,'line_no')}: invalid @alias directive (empty name)")
        char_id, _disp = self._resolve_char_id_from_selector(base_name, line_no=int(getattr(node, "line_no")), allow_custom_fallback=False)
        if char_id == "__Sensei":
            raise ValueError(f"line {getattr(node,'line_no')}: @alias cannot target Sensei")
        if override == "":
            self._alias_char_id_to_override.pop(char_id, None)
            return
        self._alias_char_id_to_override[char_id] = override

    def _handle_tmpalias(self, st: _State, node: Any) -> None:
        # Syntax: @tmpalias <name>=<override>
        payload = str(getattr(node, "payload") or "").strip()
        m = re.match(r"^@tmpalias\s+(.+)$", payload, flags=re.IGNORECASE)
        if not m:
            raise ValueError(f"line {getattr(node,'line_no')}: invalid @tmpalias directive")
        rest = m.group(1).strip()
        if "=" not in rest:
            raise ValueError(f"line {getattr(node,'line_no')}: invalid @tmpalias directive (missing '=')")
        base_name, override = rest.split("=", 1)
        base_name = base_name.strip()
        override = override.strip()
        if not base_name:
            raise ValueError(f"line {getattr(node,'line_no')}: invalid @tmpalias directive (empty name)")
        char_id, _disp = self._resolve_char_id_from_selector(base_name, line_no=int(getattr(node, "line_no")), allow_custom_fallback=False)
        if char_id == "__Sensei":
            raise ValueError(f"line {getattr(node,'line_no')}: @tmpalias cannot target Sensei")
        # Set pending override for both sides (legacy: directive is global, but activates on a side when that side speaks)
        for k in (">", "<"):
            if override == "":
                self._pending_tmpalias[k].pop(char_id, None)
                if self._active_tmpalias[k] is not None and self._active_tmpalias[k][0] == char_id:
                    self._active_tmpalias[k] = None
            else:
                self._pending_tmpalias[k][char_id] = override

    def _handle_aliasid(self, st: _State, node: Any) -> None:
        payload = str(getattr(node, "payload") or "").strip()
        m = re.match(r"^@aliasid\s+(.+)$", payload, flags=re.IGNORECASE)
        if not m:
            raise ValueError(f"line {getattr(node,'line_no')}: invalid @aliasid directive")
        rest = m.group(1).strip()
        parts = rest.split(None, 1)
        if len(parts) != 2:
            raise ValueError(f"line {getattr(node,'line_no')}: invalid @aliasid directive (expected: @aliasid <id> <name>)")
        alias_id, name = parts[0].strip(), parts[1].strip()
        if not alias_id or not name:
            raise ValueError(f"line {getattr(node,'line_no')}: invalid @aliasid directive")
        self._alias_id_to_name[alias_id] = name

    def _handle_unaliasid(self, st: _State, node: Any) -> None:
        payload = str(getattr(node, "payload") or "").strip()
        m = re.match(r"^@unaliasid\s+(.+)$", payload, flags=re.IGNORECASE)
        if not m:
            raise ValueError(f"line {getattr(node,'line_no')}: invalid @unaliasid directive")
        alias_id = m.group(1).strip()
        if not alias_id:
            raise ValueError(f"line {getattr(node,'line_no')}: invalid @unaliasid directive (empty id)")
        if alias_id in self._alias_id_to_name:
            del self._alias_id_to_name[alias_id]

    def _handle_charid(self, st: _State, node: Any) -> None:
        payload = str(getattr(node, "payload") or "").strip()
        m = re.match(r"^@charid\s+(.+)$", payload, flags=re.IGNORECASE)
        if not m:
            raise ValueError(f"line {getattr(node,'line_no')}: invalid @charid directive")
        rest = m.group(1).strip()
        parts = rest.split(None, 1)
        if len(parts) != 2:
            raise ValueError(f"line {getattr(node,'line_no')}: invalid @charid directive (expected: @charid <id> <display>)")
        cid, display = parts[0].strip(), parts[1].strip()
        if not cid or not display:
            raise ValueError(f"line {getattr(node,'line_no')}: invalid @charid directive")
        if not re.match(r"^[\w][\w\-]*$", cid):
            raise ValueError(f"line {getattr(node,'line_no')}: invalid @charid id: {cid}")
        self._custom_id_to_display[cid] = display

    def _handle_uncharid(self, st: _State, node: Any) -> None:
        payload = str(getattr(node, "payload") or "").strip()
        m = re.match(r"^@uncharid\s+(.+)$", payload, flags=re.IGNORECASE)
        if not m:
            raise ValueError(f"line {getattr(node,'line_no')}: invalid @uncharid directive")
        cid = m.group(1).strip()
        if not cid:
            raise ValueError(f"line {getattr(node,'line_no')}: invalid @uncharid directive (empty id)")
        if cid in self._custom_id_to_display:
            del self._custom_id_to_display[cid]
        self._current_avatar_override_by_char_id.pop(f"custom-{cid}", None)

    def _handle_avatarid(self, st: _State, node: Any) -> None:
        # Not needed for fixtures yet.
        st.body.append(node)

    def _handle_unavatarid(self, st: _State, node: Any) -> None:
        # Not needed for fixtures yet.
        st.body.append(node)

    def _handle_avatar(self, st: _State, node: Any) -> None:
        payload = str(getattr(node, "payload") or "").strip()
        m = re.match(r"^@avatar\s+(.+)$", payload, flags=re.IGNORECASE)
        if not m:
            raise ValueError(f"line {getattr(node,'line_no')}: invalid @avatar directive")
        rest = m.group(1).strip()
        if "=" not in rest:
            raise ValueError(f"line {getattr(node,'line_no')}: invalid @avatar directive (missing '=')")
        base_name, asset_name = rest.split("=", 1)
        base_name = base_name.strip()
        asset_name = asset_name.strip()
        if not base_name:
            raise ValueError(f"line {getattr(node,'line_no')}: invalid @avatar directive (empty character name)")
        char_id, _disp = self._resolve_char_id_from_selector(base_name, line_no=int(getattr(node, "line_no")), allow_custom_fallback=False)
        if char_id == "__Sensei":
            raise ValueError(f"line {getattr(node,'line_no')}: @avatar cannot target Sensei")
        if asset_name == "":
            self._current_avatar_override_by_char_id.pop(char_id, None)
            return
        if asset_name.lower().startswith("asset:"):
            asset_name = asset_name.split(":", 1)[1].strip()
        self._current_avatar_override_by_char_id[char_id] = f"asset:{asset_name}"

    # ---- Helpers copied from legacy convert_text ----

    def _split_namespace(self, token: str) -> Tuple[Optional[str], str]:
        s = (token or "").strip()
        if "." in s:
            ns, rest = s.split(".", 1)
            ns = ns.strip()
            rest = rest.strip()
            if ns and rest:
                return ns, rest
        return None, s

    def _resolve_char_id_from_selector(
        self,
        selector: str,
        *,
        line_no: int,
        allow_custom_fallback: bool,
    ) -> Tuple[str, str]:
        s = (selector or "").strip()
        if not s:
            raise ValueError(f"line {line_no}: empty selector")

        if s == "__Sensei":
            return "__Sensei", "Sensei"
        if s.startswith("kivo-") and s.split("-", 1)[1].isdigit():
            sid = int(s.split("-", 1)[1])
            return f"kivo-{sid}", str(sid)
        if s.startswith("custom-") and len(s) > len("custom-"):
            return s, s.split("-", 1)[1]

        ns, name = self._split_namespace(s)
        if ns is not None:
            ns_l = ns.lower()
            if ns_l in {"ba", "kivo"}:
                if self._pack_v2_ba is not None and ns_l == "ba":
                    cid = self._pack_v2_ba.resolve_char_id(name)
                    if cid is None:
                        raise ValueError(f"line {line_no}: unknown ba character: {name}")
                    return f"ba.{cid}", self._base_name(cid)
                sid = self._resolve_student_id(name)
                if sid is None:
                    raise ValueError(f"line {line_no}: unknown ba character: {name}")
                return f"kivo-{sid}", name
            if ns_l == "custom":
                if re.match(r"^[\w][\w\-]*$", name):
                    disp = self._custom_id_to_display.get(name, name)
                    return f"custom-{name}", disp
                return f"custom-{self._hash_id(name)}", name
            raise ValueError(f"line {line_no}: unknown namespace: {ns}")

        # Bare name: resolve by imported namespaces
        for ns_try in self._using_namespaces:
            if ns_try == "custom":
                if s in self._custom_id_to_display:
                    return f"custom-{s}", self._custom_id_to_display.get(s, s)
            elif ns_try == "ba":
                if self._pack_v2_ba is not None:
                    cid = self._pack_v2_ba.resolve_char_id(s)
                    if cid is not None:
                        return f"ba.{cid}", self._base_name(cid)
                sid = self._resolve_student_id(s)
                if sid is not None:
                    return f"kivo-{sid}", s

        if not allow_custom_fallback:
            raise ValueError(f"line {line_no}: unknown speaker: {s}")
        return f"custom-{self._hash_id(s)}", s

    def _base_name(self, name: str) -> str:
        name = (name or "").strip()
        for sep in ("(", "（"):
            if sep in name:
                return name.split(sep, 1)[0].strip()
        return name

    def _hash_id(self, text: str) -> str:
        import hashlib

        h = hashlib.sha1()
        h.update((text or "").encode("utf-8"))
        return h.hexdigest()[:10]

    def _resolve_student_id(self, name: str) -> Optional[int]:
        n = (name or "").strip()
        if not n:
            return None
        # base index by base name
        base = self._base_name(n)
        ids = self._base_index.get(base) or []
        if not ids:
            return None
        if len(ids) == 1:
            return int(ids[0])
        # if ambiguous, only accept exact key matches from name_to_id
        if n in self._name_to_id:
            return int(self._name_to_id[n])
        return None

    def _attach_segments(self, st: _State) -> None:
        # mirror legacy segment parsing for expr/text
        typst_mode = bool(self._options.typst_mode)

        global_current_char_id: Optional[str] = None
        global_history: List[str] = []

        from mmt_render.mmt_text_to_json import _is_url_like, _parse_asset_query  # reuse behavior

        def context_text(_idx: int) -> str:
            # fixtures use ctx_n=2; implement minimal placeholder support
            return ""

        for idx, msg in enumerate(st.messages):
            t = msg.get("yuzutalk", {}).get("type") if isinstance(msg.get("yuzutalk"), dict) else None
            if t == "PAGEBREAK":
                # Legacy output does not include `segments` on PAGEBREAK entries.
                continue
            if t == "TEXT":
                char_id = str(msg.get("char_id") or "__Sensei")
                global_current_char_id = char_id
                global_history.append(char_id)

            if msg.get("no_inline_expr"):
                content_clean = str(msg.get("content") or "")
                msg["segments"] = [{"type": "text", "text": content_clean}]
                continue

            content_clean = str(msg.get("content") or "")
            segments_out: List[Dict[str, Any]] = []

            for seg in parse_inline_segments(
                content_clean,
                require_colon_prefix=bool(typst_mode),
                preserve_backslash=bool(typst_mode),
            ):
                if seg.type == "text":
                    if seg.text:
                        segments_out.append({"type": "text", "text": seg.text})
                    continue
                if seg.type != "expr":
                    continue

                query = seg.query.strip()
                if query.startswith(":"):
                    query = query[1:].lstrip()
                target = (seg.target or "").strip()
                if not query:
                    segments_out.append({"type": "text", "text": "[]"})
                    continue

                if _is_url_like(query) and target == "":
                    segments_out.append({"type": "image", "ref": query, "alt": query})
                    continue

                if target == "":
                    asset_name = _parse_asset_query(query)
                    if asset_name:
                        segments_out.append({"type": "asset", "name": asset_name, "text": f"[asset:{asset_name}]"})
                        continue

                if target == "" and query.lstrip().startswith("{") and query.rstrip().endswith("}"):
                    segments_out.append({"type": "text", "text": f"[{query}]"})
                    continue

                is_image_placeholder = target == "" and query == "图片"

                resolved_char_id: Optional[str] = None
                if target == "":
                    if global_current_char_id is None or global_current_char_id == "__Sensei":
                        raise ValueError(
                            f"line {msg.get('line_no')}: implicit expression '[{query}]' requires a non-sensei current character; "
                            f"use '[{query}](角色)'"
                        )
                    if not (
                        global_current_char_id.startswith("kivo-")
                        or (global_current_char_id.startswith("ba.") and self._pack_v2_ba is not None)
                    ):
                        segments_out.append({"type": "text", "text": f"[{query}]"})
                        continue
                    resolved_char_id = global_current_char_id
                elif is_backref_target(target):
                    n = parse_backref_n(target)
                    if n is None or n <= 0:
                        raise ValueError(f"line {msg.get('line_no')}: invalid backref target: {target}")
                    idx2 = -(n + 1)
                    if len(global_history) < (n + 1):
                        raise ValueError(f"line {msg.get('line_no')}: not enough global speaker history for {target}")
                    resolved_char_id = global_history[idx2]
                else:
                    tsel = target.strip()
                    if tsel.startswith("kivo-") and tsel.split("-", 1)[1].isdigit():
                        resolved_char_id = f"kivo-{int(tsel.split('-', 1)[1])}"
                    else:
                        ns, rest = self._split_namespace(tsel)
                        if ns is not None:
                            if ns.lower() == "ba":
                                if self._pack_v2_ba is None:
                                    raise ValueError(f"line {msg.get('line_no')}: ba pack-v2 is not available for expression: {tsel}")
                                cid = self._pack_v2_ba.resolve_char_id(rest)
                                if cid is None:
                                    raise ValueError(f"line {msg.get('line_no')}: unknown ba character in expression: {tsel}")
                                resolved_char_id = f"ba.{cid}"
                            elif ns.lower() == "kivo":
                                sid = self._resolve_student_id(rest)
                                if sid is None:
                                    raise ValueError(f"line {msg.get('line_no')}: unknown character name in expression: {tsel}")
                                resolved_char_id = f"kivo-{sid}"
                            else:
                                raise ValueError(f"line {msg.get('line_no')}: unknown expression namespace: {tsel}")
                        else:
                            if self._pack_v2_ba is not None:
                                cid = self._pack_v2_ba.resolve_char_id(tsel)
                                if cid is not None:
                                    resolved_char_id = f"ba.{cid}"
                            if resolved_char_id is None:
                                sid = self._resolve_student_id(tsel)
                                if sid is None:
                                    raise ValueError(f"line {msg.get('line_no')}: unknown character name in expression: {target}")
                                resolved_char_id = f"kivo-{sid}"

                if resolved_char_id == "__Sensei":
                    raise ValueError(f"line {msg.get('line_no')}: expression target cannot be Sensei")

                student_id: Optional[int] = None
                if resolved_char_id.startswith("kivo-"):
                    student_id = int(resolved_char_id.split("-", 1)[1])

                final_query = query
                if is_image_placeholder:
                    display_default = resolved_char_id.split(".", 1)[1] if resolved_char_id.startswith("ba.") else str(student_id or "")
                    display = self._base_name(self._char_id_to_display_name.get(resolved_char_id, display_default))
                    ctx = context_text(idx)
                    if ctx:
                        final_query = f"{display} 的反应图/表情图。上下文：{ctx}"
                    else:
                        final_query = f"{display} 的反应图/表情图"

                payload2: Dict[str, Any] = {
                    "type": "expr",
                    "text": f"[{query}]",
                    "query": final_query,
                    "target_char_id": resolved_char_id,
                }
                if student_id is not None:
                    payload2["student_id"] = student_id
                segments_out.append(payload2)

            msg["segments"] = segments_out if segments_out else [{"type": "text", "text": content_clean}]

    def _build_custom_chars(self, st: _State) -> List[List[Any]]:
        custom_chars: List[List[Any]] = []
        seen: set[str] = set()
        for msg in st.messages:
            char_id = msg.get("char_id")
            if not char_id or char_id == "__Sensei":
                continue
            if char_id in seen:
                continue
            seen.add(char_id)

            if isinstance(char_id, str) and char_id.startswith("ba.") and self._pack_v2_ba is not None:
                cid = char_id.split(".", 1)[1]
                avatar_ref = "uploaded"
                try:
                    pack_root = Path(self._pack_v2_ba.root).resolve()
                    rel_pack = pack_root
                    try:
                        rel_pack = pack_root.relative_to(Path.cwd().resolve())
                    except Exception:
                        rel_pack = pack_root
                    avatar_rel = self._pack_v2_ba.id_to_assets[cid].avatar
                    avatar_ref = "/" + (rel_pack / avatar_rel).as_posix().lstrip("/")
                except Exception:
                    avatar_ref = "uploaded"
                display_name = self._base_name(self._char_id_to_display_name.get(char_id, cid))
                custom_chars.append([char_id, avatar_ref, display_name])
            elif isinstance(char_id, str) and char_id.startswith("custom-"):
                raw = char_id.split("-", 1)[1]
                display = self._custom_id_to_display.get(raw, raw)
                custom_chars.append([char_id, "uploaded", display])
            else:
                custom_chars.append([char_id, "uploaded", char_id])
        return custom_chars
