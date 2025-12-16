"""
Convert the MMT text DSL into the JSON structure consumed by `mmt.typ`.

Input DSL (pure text):
- `- ` narration
- `> ` other side bubble
- `< ` sensei/self bubble
- Continuation lines (not starting with -/>/<) append to previous message (with newline).

Speaker markers for `>` / `<`:
- Explicit: `> 星野: 内容`
- Backref:  `> _: 内容` (previous speaker), `> _2: 内容` (2 speakers back)
- Index:    `> ~1: 内容` (1st newly appeared speaker since start)
- If no marker, reuse current speaker for that side.

Avatar resolution:
- Reads `avatar/name_to_id.json` created by `download_student_avatars.py`
- Resolves speaker name to Kivo student id and uses local avatar file under `avatar/{id}.*`
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

try:
    # When executed as a module: `python -m mmt_render.mmt_text_to_json ...`
    from mmt_render.inline_expr import is_backref_target, parse_backref_n, parse_inline_segments
except ModuleNotFoundError:
    # When executed as a script: `python mmt_render/mmt_text_to_json.py ...`
    from inline_expr import is_backref_target, parse_backref_n, parse_inline_segments


SPEAKER_BACKREF_RE = re.compile(r"^_(\d*)\s*:\s*(.*)$")
SPEAKER_INDEX_RE = re.compile(r"^~(\d*)\s*:\s*(.*)$")
# Allow dotted keys for meta namespaces (e.g. @asset.hero: ...).
HEADER_DIRECTIVE_RE = re.compile(r"^@([A-Za-z_][\w.-]*)\s*:\s*(.*)$")


def _strip_bom(text: str) -> str:
    return text.lstrip("\ufeff")


def _base_name(name: str) -> str:
    name = name.strip()
    # Handle both ASCII and full-width parentheses.
    for sep in ("(", "（"):
        if sep in name:
            return name.split(sep, 1)[0].strip()
    return name


def _hash_id(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:10]


def _is_url_like(s: str) -> bool:
    s = (s or "").strip()
    if not s:
        return False
    if s.startswith("data:image/"):
        return True
    if s.startswith("://"):
        return True
    if s.startswith("//"):
        return True
    try:
        u = urlparse(s)
        return u.scheme in ("http", "https") and bool(u.netloc)
    except Exception:
        return False

def _posix(path: Path) -> str:
    return path.as_posix()

def _avatar_ref(avatar_path: Path, avatar_dir: Path) -> str:
    # Keep refs project-relative so they work in both Typst and the web app.
    # For the web app, /avatar is mounted to `avatar_dir`.
    return f"{avatar_dir.name}/{avatar_path.name}".replace("\\", "/")


@dataclass
class SpeakerState:
    current: Optional[str] = None
    history: List[str] = None  # resolved speaker history (includes backrefs)
    unique_first_seen: List[str] = None  # in order of first explicit appearance

    def __post_init__(self) -> None:
        if self.history is None:
            self.history = []
        if self.unique_first_seen is None:
            self.unique_first_seen = []

    def set_explicit(self, name: str) -> str:
        name = name.strip()
        self.current = name
        if not self.history or self.history[-1] != name:
            self.history.append(name)
        if name not in self.unique_first_seen:
            self.unique_first_seen.append(name)
        return name

    def set_backref(self, n: int) -> str:
        if n <= 0:
            raise ValueError("backref n must be a positive integer")
        # _1 means "previous speaker", so we need at least 2 speakers in history.
        idx = -(n + 1)
        if len(self.history) < (n + 1):
            raise ValueError(f"not enough speaker history for _{n}:")
        self.current = self.history[idx]
        # Append resolved speaker so repeated backrefs like `_: ...` can alternate naturally
        # after seeding two explicit speakers (e.g. A, B, _, _, _ ... -> A, B, A, B, A ...).
        if not self.history or self.history[-1] != self.current:
            self.history.append(self.current)
        return self.current

    def set_index(self, n: int) -> str:
        if n <= 0:
            raise ValueError("index n must be a positive integer")
        if len(self.unique_first_seen) < n:
            raise ValueError(f"not enough unique speakers for ~{n}:")
        self.current = self.unique_first_seen[n - 1]
        # Treat as an explicit selection, but avoid duplicating the last entry.
        # This makes `~n` both a stable reference and friendly with subsequent `_` toggling.
        if not self.history or self.history[-1] != self.current:
            self.history.append(self.current)
        return self.current


def _parse_payload(payload: str) -> Tuple[Optional[Tuple[str, Any]], str]:
    """
    Returns: (marker, content)
    marker:
      - ("explicit", name)
      - ("backref", n)
      - ("index", n)
      - None (no marker)
    """
    payload = payload.rstrip()

    def split_top_level_colon(s: str) -> Optional[Tuple[str, str]]:
        depth_sq = 0
        depth_par = 0
        escaped = False
        for idx, ch in enumerate(s):
            if escaped:
                escaped = False
                continue
            if ch == "\\":
                escaped = True
                continue
            if ch == "[":
                depth_sq += 1
                continue
            if ch == "]" and depth_sq > 0:
                depth_sq -= 1
                continue
            if ch == "(":
                depth_par += 1
                continue
            if ch == ")" and depth_par > 0:
                depth_par -= 1
                continue
            if ch == ":" and depth_sq == 0 and depth_par == 0:
                return s[:idx], s[idx + 1 :]
        return None

    split = split_top_level_colon(payload)
    if split is not None:
        head, tail = split
        head = head.strip()
        tail = tail.lstrip()
        m = SPEAKER_BACKREF_RE.match(head + ":" + tail)  # allow "_:" without extra spaces
        if m:
            n_txt, content = m.group(1), m.group(2)
            n = int(n_txt) if n_txt else 1
            return ("backref", n), content
        m = SPEAKER_INDEX_RE.match(head + ":" + tail)  # allow "~:" without extra spaces
        if m:
            n_txt, content = m.group(1), m.group(2)
            n = int(n_txt) if n_txt else 1
            return ("index", n), content
        if head:
            return ("explicit", head), tail
    return None, payload


def _load_name_to_id(path: Path) -> Dict[str, int]:
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    mapping = data.get("name_to_id") or {}
    return {str(k): int(v) for k, v in mapping.items()}


def _build_base_index(name_to_id: Dict[str, int]) -> Dict[str, List[int]]:
    base: Dict[str, List[int]] = {}
    for k, sid in name_to_id.items():
        base.setdefault(_base_name(k), []).append(int(sid))
    for ids in base.values():
        ids.sort()
    return base


def _find_avatar_file(avatar_dir: Path, student_id: int) -> Optional[Path]:
    for ext in (".png", ".webp", ".jpg", ".jpeg"):
        p = avatar_dir / f"{student_id}{ext}"
        if p.exists():
            return p
    return None


def _resolve_student_id(name: str, name_to_id: Dict[str, int], base_index: Dict[str, List[int]]) -> Optional[int]:
    name = name.strip()
    if not name:
        return None
    if name in name_to_id:
        return int(name_to_id[name])
    base = _base_name(name)
    ids = base_index.get(base, [])
    if len(ids) == 1:
        return int(ids[0])
    return None


def convert_text(
    text: str,
    *,
    name_to_id: Dict[str, int],
    avatar_dir: Path,
    join_with_newline: bool = True,
    context_window: int = 2,
    typst_mode: bool = False,
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """
    Returns: (json_data, report)
    """
    speaker_state = {
        ">": SpeakerState(),
        "<": SpeakerState(),
    }

    messages: List[Dict[str, Any]] = []
    last_kind: Optional[str] = None  # "-", ">", "<"

    unresolved_speakers: Dict[str, int] = {}
    ambiguous_speakers: Dict[str, int] = {}
    char_id_to_display_name: Dict[str, str] = {}

    # Dynamic aliasing for display name only (does NOT affect id lookup / speaker identity):
    # - @alias 星野=星野(一年级)
    # - Later implicit messages from that character will carry `yuzutalk.nameOverride` for rendering.
    alias_char_id_to_override: Dict[str, str] = {}
    # Alias-id: map an identifier token to a character name (used for id lookup and speaker identity).
    # - @aliasid yz 柚子
    # - @unaliasid yz
    alias_id_to_name: Dict[str, str] = {}
    # Temporary aliasing for display name (scoped):
    # - @tmpalias 星野=星野(临战)
    # Activates on the next TEXT line whose resolved speaker is 星野 (explicit or implicit) and stays active
    # until this side switches to a different speaker (explicit or implicit). Narration does not affect it.
    pending_tmpalias: Dict[str, Dict[str, str]] = {">": {}, "<": {}}
    active_tmpalias: Dict[str, Optional[Tuple[str, str]]] = {">": None, "<": None}  # kind -> (char_id, override)

    base_index = _build_base_index(name_to_id)

    def flush_continuation() -> None:
        return

    def append_continuation(line: str) -> None:
        if not messages:
            raise ValueError("continuation line before any statement")
        sep = "\n" if join_with_newline else " "
        messages[-1]["content"] = f"{messages[-1]['content']}{sep}{line}"

    def _maybe_parse_triple_quote_block(
        *,
        head: str,
        all_lines: List[str],
        start_index: int,
        start_line_no: int,
    ) -> Optional[Tuple[str, int]]:
        """
        Detect and parse a triple-quoted block starting at `head` (the already-parsed inline content).

        Returns (block_text, next_index) where next_index is the index of the line after the closing delimiter.
        The closing delimiter must be a line whose `.strip()` equals `\"\"\"`.
        """
        # Only treat as block if the first non-space chars are """, e.g. """abc or """.
        lstripped = head.lstrip()
        if not lstripped.startswith('"""'):
            return None
        prefix_len = len(head) - len(lstripped)
        after = head[prefix_len + 3 :]  # keep remainder of the opener line as first content line (may be empty)

        block_lines: List[str] = []
        if after != "":
            block_lines.append(after)

        j = start_index + 1
        while j < len(all_lines):
            raw_line = all_lines[j]
            if raw_line.strip() == '"""':
                return "\n".join(block_lines), j + 1
            block_lines.append(raw_line)
            j += 1

        raise ValueError(f"line {start_line_no}: unterminated triple-quote block (missing \"\"\" line)")

    lines = _strip_bom(text).splitlines()

    # Header directives (only allowed before the first statement line)
    meta: Dict[str, Any] = {}
    typst_global = ""

    def _is_reserved_aliasid(alias_id: str) -> bool:
        s = alias_id.strip()
        if not s:
            return True
        if s == "__Sensei":
            return True
        # If it already resolves as a student name, treat it as reserved ("original id").
        if _resolve_student_id(s, name_to_id, base_index) is not None:
            return True
        base = _base_name(s)
        # Base name used by any student mapping is also reserved.
        if base in base_index and len(base_index[base]) > 0:
            return True
        return False

    def _parse_alias_line(line: str, *, line_no: int) -> None:
        # Allow optional spaces after @alias, and spaces around '='.
        m = re.match(r"^@alias\s+(.+)$", line.strip(), flags=re.IGNORECASE)
        if not m:
            raise ValueError(f"line {line_no}: invalid @alias directive")
        rest = m.group(1).strip()
        if "=" not in rest:
            raise ValueError(f"line {line_no}: invalid @alias directive (missing '=')")
        base_name, override_name = rest.split("=", 1)
        base_name = base_name.strip()
        override_name = override_name.strip()
        if not base_name:
            raise ValueError(f"line {line_no}: invalid @alias directive (empty base name)")

        sid = _resolve_student_id(base_name, name_to_id, base_index)
        if sid is None:
            base = _base_name(base_name)
            if base in base_index and len(base_index[base]) > 1:
                ambiguous_speakers[base_name] = ambiguous_speakers.get(base_name, 0) + 1
            else:
                unresolved_speakers[base_name] = unresolved_speakers.get(base_name, 0) + 1
            char_id = f"custom-{_hash_id(base_name)}"
        else:
            char_id = f"kivo-{sid}"

        if override_name == "":
            alias_char_id_to_override.pop(char_id, None)
            return
        alias_char_id_to_override[char_id] = override_name

    def _parse_tmpalias_line(line: str, *, line_no: int) -> None:
        m = re.match(r"^@tmpalias\s+(.+)$", line.strip(), flags=re.IGNORECASE)
        if not m:
            raise ValueError(f"line {line_no}: invalid @tmpalias directive")
        rest = m.group(1).strip()
        if "=" not in rest:
            raise ValueError(f"line {line_no}: invalid @tmpalias directive (missing '=')")
        base_name, override_name = rest.split("=", 1)
        base_name = base_name.strip()
        override_name = override_name.strip()
        if not base_name:
            raise ValueError(f"line {line_no}: invalid @tmpalias directive (empty base name)")

        sid = _resolve_student_id(base_name, name_to_id, base_index)
        if sid is None:
            base = _base_name(base_name)
            if base in base_index and len(base_index[base]) > 1:
                ambiguous_speakers[base_name] = ambiguous_speakers.get(base_name, 0) + 1
            else:
                unresolved_speakers[base_name] = unresolved_speakers.get(base_name, 0) + 1
            char_id = f"custom-{_hash_id(base_name)}"
        else:
            char_id = f"kivo-{sid}"

        # Set as pending for both directions; it will only activate when that direction next speaks as this char_id.
        if override_name == "":
            pending_tmpalias[">"].pop(char_id, None)
            pending_tmpalias["<"].pop(char_id, None)
            return
        pending_tmpalias[">"][char_id] = override_name
        pending_tmpalias["<"][char_id] = override_name

    def _parse_aliasid_line(line: str, *, line_no: int) -> None:
        # Syntax: @aliasid <id> <character_name>
        m = re.match(r"^@aliasid\s+(.+)$", line.strip(), flags=re.IGNORECASE)
        if not m:
            raise ValueError(f"line {line_no}: invalid @aliasid directive")
        rest = m.group(1).strip()
        parts = rest.split(None, 1)
        if len(parts) != 2:
            raise ValueError(f"line {line_no}: invalid @aliasid directive (expected: @aliasid <id> <name>)")
        alias_id, name = parts[0].strip(), parts[1].strip()
        if not alias_id:
            raise ValueError(f"line {line_no}: invalid @aliasid directive (empty id)")
        if not name:
            raise ValueError(f"line {line_no}: invalid @aliasid directive (empty name)")
        if _is_reserved_aliasid(alias_id):
            raise ValueError(f"line {line_no}: @aliasid cannot override reserved/original id: {alias_id}")

        # Validate the target name early so users get a clear error.
        if _resolve_student_id(name, name_to_id, base_index) is None:
            # allow custom speakers too, but still keep the name as-is
            base = _base_name(name)
            if base in base_index and len(base_index[base]) > 1:
                ambiguous_speakers[name] = ambiguous_speakers.get(name, 0) + 1
            elif base not in base_index:
                unresolved_speakers[name] = unresolved_speakers.get(name, 0) + 1

        alias_id_to_name[alias_id] = name

    def _parse_unaliasid_line(line: str, *, line_no: int) -> None:
        m = re.match(r"^@unaliasid\s+(.+)$", line.strip(), flags=re.IGNORECASE)
        if not m:
            raise ValueError(f"line {line_no}: invalid @unaliasid directive")
        alias_id = m.group(1).strip()
        if not alias_id:
            raise ValueError(f"line {line_no}: invalid @unaliasid directive (empty id)")
        if _is_reserved_aliasid(alias_id):
            raise ValueError(f"line {line_no}: @unaliasid cannot target reserved/original id: {alias_id}")
        if alias_id not in alias_id_to_name:
            raise ValueError(f"line {line_no}: @unaliasid id not found: {alias_id}")
        del alias_id_to_name[alias_id]

    def _parse_header_block(start_i: int, first_line_value: str, start_line_no: int) -> Tuple[str, int]:
        """
        Parse a triple-quoted block that starts in a header directive value.
        Returns (block_text, next_index).
        """
        lstripped = first_line_value.lstrip()
        if not lstripped.startswith('"""'):
            return first_line_value.strip(), start_i + 1
        # keep remainder after opening delimiter as first content line (may be empty)
        after = lstripped[3:]
        block_lines: List[str] = []
        if after != "":
            block_lines.append(after)
        j = start_i + 1
        while j < len(lines):
            raw_line = lines[j]
            if raw_line.strip() == '"""':
                return "\n".join(block_lines), j + 1
            block_lines.append(raw_line)
            j += 1
        raise ValueError(f"line {start_line_no}: unterminated header triple-quote block (missing \"\"\" line)")

    i = 0
    while i < len(lines):
        raw = lines[i]
        stripped = raw.strip()
        if stripped == "" or stripped.startswith("#"):
            i += 1
            continue
        lstripped = raw.lstrip()
        if re.match(r"^@alias\b", lstripped, flags=re.IGNORECASE):
            _parse_alias_line(lstripped, line_no=i + 1)
            i += 1
            continue
        if re.match(r"^@tmpalias\b", lstripped, flags=re.IGNORECASE):
            _parse_tmpalias_line(lstripped, line_no=i + 1)
            i += 1
            continue
        if re.match(r"^@aliasid\b", lstripped, flags=re.IGNORECASE):
            _parse_aliasid_line(lstripped, line_no=i + 1)
            i += 1
            continue
        if re.match(r"^@unaliasid\b", lstripped, flags=re.IGNORECASE):
            _parse_unaliasid_line(lstripped, line_no=i + 1)
            i += 1
            continue
        if lstripped.startswith("- ") or lstripped.startswith("> ") or lstripped.startswith("< "):
            break
        m = HEADER_DIRECTIVE_RE.match(stripped)
        if not m:
            # Not a header directive; leave it to the main parser (it will likely be treated as invalid continuation)
            break
        key = m.group(1).strip().lower()
        value = m.group(2) or ""
        line_no = i + 1
        if key == "typst_global":
            typst_global, i = _parse_header_block(i, value, line_no)
            continue
        if key == "typst":
            v = value.strip().lower()
            if v in ("1", "true", "yes", "on"):
                meta[key] = True
            elif v in ("0", "false", "no", "off"):
                meta[key] = False
            else:
                meta[key] = value.strip()
            i += 1
            continue
        meta[key] = value.strip()
        i += 1

    while i < len(lines):
        line_no = i + 1
        raw = lines[i]
        stripped = raw.lstrip()
        if stripped == "":
            # In typst-mode, blank lines are meaningful (paragraph breaks). Preserve them inside the current statement.
            # In plain mode, keep ignoring blank lines for backward compatibility.
            if typst_mode and last_kind is not None and messages:
                append_continuation("")
            i += 1
            continue

        # Page break directive (allowed anywhere; not a continuation line).
        if re.match(r"^@pagebreak\b", stripped, flags=re.IGNORECASE):
            # no args for now; trailing content is considered an error to avoid silent mistakes
            if stripped.strip().lower() != "@pagebreak":
                raise ValueError(f"line {line_no}: invalid @pagebreak directive (expected: @pagebreak)")
            messages.append(
                {
                    "yuzutalk": {"type": "PAGEBREAK", "avatarState": "AUTO", "nameOverride": ""},
                    "content": "",
                    "line_no": line_no,
                }
            )
            i += 1
            continue

        # Dynamic alias directive (allowed anywhere; not a continuation line).
        if re.match(r"^@alias\b", stripped, flags=re.IGNORECASE):
            _parse_alias_line(stripped, line_no=line_no)
            i += 1
            continue
        if re.match(r"^@tmpalias\b", stripped, flags=re.IGNORECASE):
            _parse_tmpalias_line(stripped, line_no=line_no)
            i += 1
            continue
        if re.match(r"^@aliasid\b", stripped, flags=re.IGNORECASE):
            _parse_aliasid_line(stripped, line_no=line_no)
            i += 1
            continue
        if re.match(r"^@unaliasid\b", stripped, flags=re.IGNORECASE):
            _parse_unaliasid_line(stripped, line_no=line_no)
            i += 1
            continue

        if stripped.startswith("- "):
            flush_continuation()
            last_kind = "-"
            content = stripped[2:].rstrip()
            block = _maybe_parse_triple_quote_block(head=content, all_lines=lines, start_index=i, start_line_no=line_no)
            if block is not None:
                block_text, next_i = block
                messages.append(
                    {
                        "yuzutalk": {"type": "NARRATION", "avatarState": "AUTO", "nameOverride": ""},
                        "content": block_text,
                        "no_inline_expr": True,
                        "line_no": line_no,
                    }
                )
                i = next_i
                continue
            messages.append(
                {
                    "yuzutalk": {"type": "NARRATION", "avatarState": "AUTO", "nameOverride": ""},
                    "content": content,
                    "line_no": line_no,
                }
            )
            i += 1
            continue

        if stripped.startswith("> ") or stripped.startswith("< "):
            flush_continuation()
            kind = stripped[0]
            last_kind = kind
            payload = stripped[2:]

            marker, content = _parse_payload(payload)
            state = speaker_state[kind]

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
                    canonical = alias_id_to_name.get(raw_name, raw_name)
                    speaker = state.set_explicit(canonical)
                    # If this is an alias-id, do not show the alias token; show the canonical name.
                    speaker_raw_for_display = canonical if canonical != raw_name else raw_name
                elif mtype == "backref":
                    speaker = state.set_backref(int(mval))
                elif mtype == "index":
                    speaker = state.set_index(int(mval))
                else:
                    raise ValueError(f"line {line_no}: unknown marker type {mtype}")

            side = "right" if kind == "<" else "left"

            # '<' defaults to Sensei, but allows explicit speakers (e.g. "< 优香: ...") to render a right-side character.
            if speaker is None:
                char_id = "__Sensei"
            else:
                sid = _resolve_student_id(speaker, name_to_id, base_index)
                if sid is None:
                    base = _base_name(speaker)
                    if base in base_index and len(base_index[base]) > 1:
                        ambiguous_speakers[speaker] = ambiguous_speakers.get(speaker, 0) + 1
                    else:
                        unresolved_speakers[speaker] = unresolved_speakers.get(speaker, 0) + 1
                    char_id = f"custom-{_hash_id(speaker)}"
                else:
                    char_id = f"kivo-{sid}"

            # Manage tmpalias scope for this side.
            if char_id != "__Sensei":
                active = active_tmpalias[kind]
                if active is not None and active[0] != char_id:
                    active_tmpalias[kind] = None
                if char_id in pending_tmpalias[kind]:
                    active_tmpalias[kind] = (char_id, pending_tmpalias[kind].pop(char_id))

            name_override = ""
            if char_id != "__Sensei":
                display = (speaker_raw_for_display or speaker or "").strip()
                existing = char_id_to_display_name.get(char_id)
                active = active_tmpalias[kind]
                tmpalias = active[1] if active is not None and active[0] == char_id else ""
                alias = tmpalias or alias_char_id_to_override.get(char_id, "")
                if alias:
                    name_override = alias

            if speaker and char_id != "__Sensei":
                char_id_to_display_name.setdefault(char_id, speaker)

            content = content.rstrip()
            block = _maybe_parse_triple_quote_block(head=content, all_lines=lines, start_index=i, start_line_no=line_no)
            if block is not None:
                block_text, next_i = block
                messages.append(
                    {
                        "yuzutalk": {"type": "TEXT", "avatarState": "AUTO", "nameOverride": name_override},
                        "char_id": char_id,
                        "side": side,
                        "content": block_text,
                        "no_inline_expr": True,
                        "line_no": line_no,
                    }
                )
                i = next_i
                continue

            messages.append(
                {
                    "yuzutalk": {"type": "TEXT", "avatarState": "AUTO", "nameOverride": name_override},
                    "char_id": char_id,
                    "side": side,
                    "content": content,
                    "line_no": line_no,
                }
            )
            i += 1
            continue

        # Continuation line
        if last_kind is None:
            raise ValueError(f"line {line_no}: continuation before any statement")
        append_continuation(stripped.rstrip())
        i += 1

    # Second pass: build segments with a global context window.
    def context_text(idx: int) -> str:
        parts: List[str] = []
        start = max(0, idx - max(0, context_window))
        end = min(len(messages), idx + max(0, context_window) + 1)
        for j in range(start, end):
            if j == idx:
                continue
            m = messages[j]
            c = str(m.get("content") or "").strip()
            if not c:
                continue
            # Skip other placeholders to reduce noise
            if c == "[图片]":
                continue
            parts.append(c)
        return "\n".join(parts[: (context_window * 2)])  # cap

    global_current_char_id: Optional[str] = None
    global_history: List[str] = []

    for idx, msg in enumerate(messages):
        yuzutalk = (msg.get("yuzutalk") or {})
        if not isinstance(yuzutalk, dict):
            continue
        if yuzutalk.get("type") != "TEXT":
            continue

        line_no = int(msg.get("line_no") or 0)
        char_id = str(msg.get("char_id") or "__Sensei")
        global_current_char_id = char_id
        global_history.append(char_id)

        if msg.get("no_inline_expr"):
            content_clean = str(msg.get("content") or "")
            msg["segments"] = [{"type": "text", "text": content_clean}]
            continue

        content_clean = str(msg.get("content") or "")
        segments_out: List[Dict[str, Any]] = []

        for seg in parse_inline_segments(content_clean, require_colon_prefix=bool(typst_mode)):
            if seg.type == "text":
                if seg.text:
                    segments_out.append({"type": "text", "text": seg.text})
                continue

            if seg.type != "expr":
                continue

            query = seg.query.strip()
            # In typst-mode, expression markers must be written as `[:...]` to avoid conflicting with Typst's `[...]`.
            # For compatibility, we also accept this prefix in non-typst mode.
            if query.startswith(":"):
                query = query[1:].lstrip()
            target = (seg.target or "").strip()
            if not query:
                segments_out.append({"type": "text", "text": "[]"})
                continue

            # External image URLs can be used directly without a character context, even on Sensei side.
            if _is_url_like(query) and target == "":
                segments_out.append({"type": "image", "ref": query, "alt": query})
                continue

            # Backward-compatible: treat `[{...}]`-style placeholders as plain text.
            if target == "" and query.lstrip().startswith("{") and query.rstrip().endswith("}"):
                segments_out.append({"type": "text", "text": f"[{query}]"})
                continue

            is_image_placeholder = target == "" and query == "图片"

            resolved_char_id: Optional[str] = None
            if target == "":
                # Implicit: use global current speaker. Sensei is forbidden.
                if global_current_char_id is None or global_current_char_id == "__Sensei":
                    raise ValueError(
                        f"line {line_no}: implicit expression '[{query}]' requires a non-sensei current character; "
                        f"use '[{query}](角色)'"
                    )
                # If current speaker is not a kivo student (e.g. custom speaker), keep as plain text.
                if not global_current_char_id.startswith("kivo-"):
                    segments_out.append({"type": "text", "text": f"[{query}]"})
                    continue
                resolved_char_id = global_current_char_id
            elif is_backref_target(target):
                n = parse_backref_n(target)
                if n is None or n <= 0:
                    raise ValueError(f"line {line_no}: invalid backref target: {target}")
                idx2 = -(n + 1)
                if len(global_history) < (n + 1):
                    raise ValueError(f"line {line_no}: not enough global speaker history for {target}")
                resolved_char_id = global_history[idx2]
            else:
                # Explicit name: resolve to student id.
                sid = _resolve_student_id(target, name_to_id, base_index)
                if sid is None:
                    raise ValueError(f"line {line_no}: unknown character name in expression: {target}")
                resolved_char_id = f"kivo-{sid}"

            if resolved_char_id == "__Sensei":
                raise ValueError(f"line {line_no}: expression target cannot be Sensei")
            if not resolved_char_id.startswith("kivo-"):
                raise ValueError(
                    f"line {line_no}: expression target '{resolved_char_id}' has no student id; only kivo characters are supported"
                )
            student_id = int(resolved_char_id.split("-", 1)[1])

            final_query = query
            if is_image_placeholder:
                display = char_id_to_display_name.get(resolved_char_id, str(student_id))
                ctx = context_text(idx)
                if ctx:
                    final_query = f"{display} 的反应图/表情图。上下文：{ctx}"
                else:
                    final_query = f"{display} 的反应图/表情图"

            segments_out.append(
                {
                    "type": "expr",
                    "text": f"[{query}]",
                    "query": final_query,
                    "student_id": student_id,
                }
            )

        msg["segments"] = segments_out if segments_out else [{"type": "text", "text": content_clean}]

    # Build custom_chars table for all non-sensei speakers present in messages.
    custom_chars: List[List[Any]] = []
    seen: set[str] = set()
    for msg in messages:
        char_id = msg.get("char_id")
        if not char_id or char_id == "__Sensei":
            continue
        if char_id in seen:
            continue
        seen.add(char_id)

        if char_id.startswith("kivo-"):
            sid = int(char_id.split("-", 1)[1])
            avatar_path = _find_avatar_file(avatar_dir, sid)
            avatar_ref = _avatar_ref(avatar_path, avatar_dir) if avatar_path else "uploaded"
            display_name = _base_name(char_id_to_display_name.get(char_id, str(sid)))
            custom_chars.append([char_id, avatar_ref, display_name])
        else:
            # custom speaker without resolved avatar
            display_name = char_id_to_display_name.get(char_id, char_id)
            custom_chars.append([char_id, "uploaded", display_name])

    data = {
        "meta": meta,
        "typst_global": typst_global,
        "chars": [],
        "custom_chars": custom_chars,
        "chat": messages,
    }

    report = {
        "unresolved_speakers": unresolved_speakers,
        "ambiguous_speakers": ambiguous_speakers,
        "custom_char_count": len(custom_chars),
        "message_count": len(messages),
    }
    return data, report


def build_argparser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Convert MMT text DSL into JSON for mmt.typ.")
    p.add_argument("input", help="Input .txt")
    p.add_argument("-o", "--output", default=None, help="Output .json (default: alongside input)")
    p.add_argument("--avatar-dir", default="avatar", help="Avatar folder (default: avatar)")
    p.add_argument(
        "--name-map",
        default="avatar/name_to_id.json",
        help="Path to name_to_id.json from download_student_avatars.py (default: avatar/name_to_id.json)",
    )
    p.add_argument(
        "--join",
        choices=["newline", "space"],
        default="newline",
        help="How to join continuation lines (default: newline)",
    )
    p.add_argument("--ctx-n", type=int, default=2, help="Global context window size for '[图片]' (default: 2)")
    p.add_argument(
        "--typst",
        action="store_true",
        help="Typst markup mode: only parse expression markers written as '[:...]', leaving other '[...]' for Typst.",
    )
    p.add_argument("--report", default=None, help="Write a conversion report JSON (optional)")
    return p


def main() -> int:
    args = build_argparser().parse_args()
    in_path = Path(args.input)
    if args.output:
        out_path = Path(args.output)
    else:
        out_path = in_path.with_suffix(".json")

    name_map_path = Path(args.name_map)
    avatar_dir = Path(args.avatar_dir)

    # Convenience: when running from repo root with input under mmt_render/,
    # auto-resolve defaults relative to the input file directory.
    if not name_map_path.exists() and args.name_map == "avatar/name_to_id.json":
        candidate = in_path.parent / "avatar" / "name_to_id.json"
        if candidate.exists():
            name_map_path = candidate
    if not avatar_dir.exists() and args.avatar_dir == "avatar":
        candidate = in_path.parent / "avatar"
        if candidate.exists():
            avatar_dir = candidate

    name_map = _load_name_to_id(name_map_path)

    text = in_path.read_text(encoding="utf-8")
    data, report = convert_text(
        text,
        name_to_id=name_map,
        avatar_dir=avatar_dir,
        join_with_newline=args.join == "newline",
        context_window=max(0, int(args.ctx_n)),
        typst_mode=bool(args.typst),
    )

    out_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    if args.report:
        Path(args.report).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    else:
        # Print a tiny summary for interactive use.
        unresolved = sum(report["unresolved_speakers"].values())
        ambiguous = sum(report["ambiguous_speakers"].values())
        print(f"[ok] messages={report['message_count']} custom_chars={report['custom_char_count']} unresolved={unresolved} ambiguous={ambiguous}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
