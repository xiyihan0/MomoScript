from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple, Union


def _strip_bom(text: str) -> str:
    return (text or "").lstrip("\ufeff")


@dataclass(frozen=True)
class Span:
    start_line: int
    start_col: int
    end_line: int
    end_col: int


HEADER_DIRECTIVE_RE = re.compile(r"^@([A-Za-z_][\w.-]*)\s*:\s*(.*)$")
SPEAKER_BACKREF_RE = re.compile(r"^_(\d*)\s*:\s*(.*)$")
SPEAKER_INDEX_RE = re.compile(r"^~(\d*)\s*:\s*(.*)$")


def _first_non_space_col(raw: str) -> int:
    for idx, ch in enumerate(raw):
        if not ch.isspace():
            return idx + 1
    return 1


def _line_end_col(raw: str) -> int:
    return max(1, len(raw))


def _loc(line_no: int, col: Optional[int]) -> str:
    if col is None or col <= 0:
        return f"line {line_no}"
    return f"line {line_no}:{col}"


@dataclass(frozen=True)
class Node:
    line_no: int
    span: Span

    def to_dict(self, *, include_span: bool = True) -> Dict[str, Any]:
        d = asdict(self)
        if not include_span:
            d.pop("span", None)
        d["type"] = self.__class__.__name__
        return d


@dataclass(frozen=True)
class MetaKV(Node):
    key: str
    value: str


@dataclass(frozen=True)
class TypstGlobal(Node):
    value: str


@dataclass(frozen=True)
class UsePack(Node):
    pack_id: str
    alias: str


@dataclass(frozen=True)
class Alias(Node):
    name: str
    display: str


@dataclass(frozen=True)
class TmpAlias(Node):
    name: str
    display: str


@dataclass(frozen=True)
class AliasId(Node):
    alias_id: str
    name: str


@dataclass(frozen=True)
class UnaliasId(Node):
    alias_id: str


@dataclass(frozen=True)
class CharId(Node):
    char_id: str
    display: str


@dataclass(frozen=True)
class UncharId(Node):
    char_id: str


@dataclass(frozen=True)
class AvatarId(Node):
    char_id: str
    asset: str


@dataclass(frozen=True)
class UnavatarId(Node):
    char_id: str


@dataclass(frozen=True)
class AvatarOverride(Node):
    name: str
    asset: str


@dataclass(frozen=True)
class Directive(Node):
    name: str
    payload: str


@dataclass(frozen=True)
class PageBreak(Node):
    pass


@dataclass(frozen=True)
class BlankLine(Node):
    pass


@dataclass(frozen=True)
class Continuation(Node):
    text: str


@dataclass(frozen=True)
class MarkerExplicit:
    selector: str
    span: Span


@dataclass(frozen=True)
class MarkerBackref:
    n: int
    span: Span


@dataclass(frozen=True)
class MarkerIndex:
    n: int
    span: Span


Marker = Union[None, MarkerExplicit, MarkerBackref, MarkerIndex]


@dataclass(frozen=True)
class Statement(Node):
    kind: str  # "-", ">", "<"
    marker: Marker
    content: str


@dataclass(frozen=True)
class Block(Node):
    kind: str  # "-", ">", "<"
    marker: Marker
    content: str


@dataclass(frozen=True)
class Reply(Node):
    items: List[str]


@dataclass(frozen=True)
class Bond(Node):
    content: str


def _parse_triple_quote_block(
    *,
    head: str,
    all_lines: Sequence[str],
    start_index: int,
    start_line_no: int,
) -> Optional[Tuple[str, int, int, int]]:
    lstripped = head.lstrip()
    m = re.match(r'^("{3,})(.*)$', lstripped)
    if not m:
        return None
    delim = m.group(1)
    after = m.group(2)

    block_lines: List[str] = []
    if after != "":
        block_lines.append(after)

    j = start_index + 1
    while j < len(all_lines):
        raw_line = all_lines[j]
        if raw_line.strip() == delim:
            end_line = j + 1
            end_col = _line_end_col(raw_line)
            return "\n".join(block_lines), j + 1, end_line, end_col
        block_lines.append(raw_line)
        j += 1
    raise ValueError(
        f"line {start_line_no}: unterminated quote block (missing {delim!r} line)"
    )


def _parse_header_block(
    *,
    first_line_value: str,
    all_lines: Sequence[str],
    start_index: int,
    start_line_no: int,
) -> Tuple[str, int, int, int]:
    lstripped = first_line_value.lstrip()
    m = re.match(r'^("{3,})(.*)$', lstripped)
    if not m:
        raw_line = all_lines[start_index]
        end_line = start_index + 1
        end_col = _line_end_col(raw_line)
        return first_line_value.strip(), start_index + 1, end_line, end_col

    delim = m.group(1)
    after = m.group(2)
    block_lines: List[str] = []
    if after != "":
        block_lines.append(after)

    j = start_index + 1
    while j < len(all_lines):
        raw_line = all_lines[j]
        if raw_line.strip() == delim:
            end_line = j + 1
            end_col = _line_end_col(raw_line)
            return "\n".join(block_lines), j + 1, end_line, end_col
        block_lines.append(raw_line)
        j += 1
    raise ValueError(
        f"line {start_line_no}: unterminated header quote block (missing {delim!r} line)"
    )


def _parse_payload(payload: str, *, line_no: int, col_base: int) -> Tuple[Marker, str]:
    """
    Parses a '>'/'<' payload into (marker, content).

    Marker kinds:
      - ("explicit", "<selector>")
      - ("backref", <n>)
      - ("index", <n>)
      - None
    """
    payload = (payload or "").rstrip()

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
        head_raw, tail = split
        head = head_raw.strip()
        tail = tail.lstrip()

        head_left_trim = len(head_raw) - len(head_raw.lstrip())
        marker_start_col = col_base + head_left_trim
        marker_end_col = marker_start_col + max(0, len(head) - 1)
        marker_span = Span(
            start_line=line_no,
            start_col=marker_start_col,
            end_line=line_no,
            end_col=marker_end_col,
        )

        m = SPEAKER_BACKREF_RE.match(head + ":" + tail)  # allow "_:" without extra spaces
        if m:
            n_txt, content = m.group(1), m.group(2)
            n = int(n_txt) if n_txt else 1
            return MarkerBackref(n=n, span=marker_span), content

        m = SPEAKER_INDEX_RE.match(head + ":" + tail)  # allow "~:" without extra spaces
        if m:
            n_txt, content = m.group(1), m.group(2)
            n = int(n_txt) if n_txt else 1
            return MarkerIndex(n=n, span=marker_span), content

        if head:
            return MarkerExplicit(selector=head, span=marker_span), tail

    return None, payload


def _is_usepack_line(line: str) -> bool:
    return bool(re.match(r"^@usepack\b", line.strip(), flags=re.IGNORECASE))


def _parse_usepack_line(line: str, *, line_no: int, span: Span) -> UsePack:
    m = re.match(r"^@usepack\s+(.+)$", line.strip(), flags=re.IGNORECASE)
    if not m:
        raise ValueError(f"{_loc(line_no, span.start_col)}: invalid @usepack directive")
    rest = m.group(1).strip()
    m2 = re.match(r"^([A-Za-z0-9_]+)\s+as\s+([A-Za-z0-9_]+)$", rest, flags=re.IGNORECASE)
    if not m2:
        raise ValueError(
            f"{_loc(line_no, span.start_col)}: invalid @usepack directive (expected: @usepack <pack_id> as <alias>)"
        )
    return UsePack(line_no=line_no, span=span, pack_id=m2.group(1).strip(), alias=m2.group(2).strip())


def _parse_alias_line(line: str, *, line_no: int, span: Span) -> Alias:
    m = re.match(r"^@alias\s+(.+)$", line.strip(), flags=re.IGNORECASE)
    if not m:
        raise ValueError(f"{_loc(line_no, span.start_col)}: invalid @alias directive")
    rest = m.group(1).strip()
    if "=" not in rest:
        raise ValueError(f"{_loc(line_no, span.start_col)}: invalid @alias directive (missing '=')")
    base_name, override = rest.split("=", 1)
    base_name = base_name.strip()
    override = override.strip()
    if not base_name:
        raise ValueError(f"{_loc(line_no, span.start_col)}: invalid @alias directive (empty name)")
    return Alias(line_no=line_no, span=span, name=base_name, display=override)


def _parse_tmpalias_line(line: str, *, line_no: int, span: Span) -> TmpAlias:
    m = re.match(r"^@tmpalias\s+(.+)$", line.strip(), flags=re.IGNORECASE)
    if not m:
        raise ValueError(f"{_loc(line_no, span.start_col)}: invalid @tmpalias directive")
    rest = m.group(1).strip()
    if "=" not in rest:
        raise ValueError(f"{_loc(line_no, span.start_col)}: invalid @tmpalias directive (missing '=')")
    base_name, override = rest.split("=", 1)
    base_name = base_name.strip()
    override = override.strip()
    if not base_name:
        raise ValueError(f"{_loc(line_no, span.start_col)}: invalid @tmpalias directive (empty name)")
    return TmpAlias(line_no=line_no, span=span, name=base_name, display=override)


def _parse_aliasid_line(line: str, *, line_no: int, span: Span) -> AliasId:
    m = re.match(r"^@aliasid\s+(.+)$", line.strip(), flags=re.IGNORECASE)
    if not m:
        raise ValueError(f"{_loc(line_no, span.start_col)}: invalid @aliasid directive")
    rest = m.group(1).strip()
    parts = rest.split(None, 1)
    if len(parts) != 2:
        raise ValueError(f"{_loc(line_no, span.start_col)}: invalid @aliasid directive (expected: @aliasid <id> <name>)")
    alias_id, name = parts[0].strip(), parts[1].strip()
    if not alias_id or not name:
        raise ValueError(f"{_loc(line_no, span.start_col)}: invalid @aliasid directive")
    return AliasId(line_no=line_no, span=span, alias_id=alias_id, name=name)


def _parse_unaliasid_line(line: str, *, line_no: int, span: Span) -> UnaliasId:
    m = re.match(r"^@unaliasid\s+(.+)$", line.strip(), flags=re.IGNORECASE)
    if not m:
        raise ValueError(f"{_loc(line_no, span.start_col)}: invalid @unaliasid directive")
    alias_id = m.group(1).strip()
    if not alias_id:
        raise ValueError(f"{_loc(line_no, span.start_col)}: invalid @unaliasid directive (empty id)")
    return UnaliasId(line_no=line_no, span=span, alias_id=alias_id)


def _parse_charid_line(line: str, *, line_no: int, span: Span) -> CharId:
    m = re.match(r"^@charid\s+(.+)$", line.strip(), flags=re.IGNORECASE)
    if not m:
        raise ValueError(f"{_loc(line_no, span.start_col)}: invalid @charid directive")
    rest = m.group(1).strip()
    parts = rest.split(None, 1)
    if len(parts) != 2:
        raise ValueError(f"{_loc(line_no, span.start_col)}: invalid @charid directive (expected: @charid <id> <display>)")
    cid, display = parts[0].strip(), parts[1].strip()
    if not cid or not display:
        raise ValueError(f"{_loc(line_no, span.start_col)}: invalid @charid directive")
    return CharId(line_no=line_no, span=span, char_id=cid, display=display)


def _parse_uncharid_line(line: str, *, line_no: int, span: Span) -> UncharId:
    m = re.match(r"^@uncharid\s+(.+)$", line.strip(), flags=re.IGNORECASE)
    if not m:
        raise ValueError(f"{_loc(line_no, span.start_col)}: invalid @uncharid directive")
    cid = m.group(1).strip()
    if not cid:
        raise ValueError(f"{_loc(line_no, span.start_col)}: invalid @uncharid directive (empty id)")
    return UncharId(line_no=line_no, span=span, char_id=cid)


def _parse_avatarid_line(line: str, *, line_no: int, span: Span) -> AvatarId:
    m = re.match(r"^@avatarid\s+(.+)$", line.strip(), flags=re.IGNORECASE)
    if not m:
        raise ValueError(f"{_loc(line_no, span.start_col)}: invalid @avatarid directive")
    rest = m.group(1).strip()
    parts = rest.split(None, 1)
    if len(parts) != 2:
        raise ValueError(f"{_loc(line_no, span.start_col)}: invalid @avatarid directive (expected: @avatarid <id> <asset_name>)")
    cid, asset_name = parts[0].strip(), parts[1].strip()
    if not cid:
        raise ValueError(f"{_loc(line_no, span.start_col)}: invalid @avatarid directive (empty id)")
    if not asset_name:
        raise ValueError(f"{_loc(line_no, span.start_col)}: invalid @avatarid directive (empty asset name)")
    return AvatarId(line_no=line_no, span=span, char_id=cid, asset=asset_name)


def _parse_unavatarid_line(line: str, *, line_no: int, span: Span) -> UnavatarId:
    m = re.match(r"^@unavatarid\s+(.+)$", line.strip(), flags=re.IGNORECASE)
    if not m:
        raise ValueError(f"{_loc(line_no, span.start_col)}: invalid @unavatarid directive")
    cid = m.group(1).strip()
    if not cid:
        raise ValueError(f"{_loc(line_no, span.start_col)}: invalid @unavatarid directive (empty id)")
    return UnavatarId(line_no=line_no, span=span, char_id=cid)


def _parse_avatar_line(line: str, *, line_no: int, span: Span) -> AvatarOverride:
    m = re.match(r"^@avatar\s+(.+)$", line.strip(), flags=re.IGNORECASE)
    if not m:
        raise ValueError(f"{_loc(line_no, span.start_col)}: invalid @avatar directive")
    rest = m.group(1).strip()
    if "=" not in rest:
        raise ValueError(f"{_loc(line_no, span.start_col)}: invalid @avatar directive (missing '=')")
    base_name, asset_name = rest.split("=", 1)
    base_name = base_name.strip()
    asset_name = asset_name.strip()
    if not base_name:
        raise ValueError(f"{_loc(line_no, span.start_col)}: invalid @avatar directive (empty character name)")
    return AvatarOverride(line_no=line_no, span=span, name=base_name, asset=asset_name)


def _parse_known_directive_line(token: str, line: str, *, line_no: int, span: Span) -> Node:
    token_l = token.lower()
    if token_l == "@usepack":
        return _parse_usepack_line(line, line_no=line_no, span=span)
    if token_l == "@alias":
        return _parse_alias_line(line, line_no=line_no, span=span)
    if token_l == "@tmpalias":
        return _parse_tmpalias_line(line, line_no=line_no, span=span)
    if token_l == "@aliasid":
        return _parse_aliasid_line(line, line_no=line_no, span=span)
    if token_l == "@unaliasid":
        return _parse_unaliasid_line(line, line_no=line_no, span=span)
    if token_l == "@charid":
        return _parse_charid_line(line, line_no=line_no, span=span)
    if token_l == "@uncharid":
        return _parse_uncharid_line(line, line_no=line_no, span=span)
    if token_l == "@avatarid":
        return _parse_avatarid_line(line, line_no=line_no, span=span)
    if token_l == "@unavatarid":
        return _parse_unavatarid_line(line, line_no=line_no, span=span)
    if token_l == "@avatar":
        return _parse_avatar_line(line, line_no=line_no, span=span)
    raise ValueError(f"{_loc(line_no, span.start_col)}: unsupported directive token: {token}")


def _split_reply_items(raw: str) -> List[str]:
    items = [part.strip() for part in (raw or "").split("|")]
    return [it for it in items if it]


def _parse_reply_block(
    *,
    all_lines: Sequence[str],
    start_index: int,
    start_line_no: int,
) -> Tuple[List[str], int, int, int]:
    items: List[str] = []
    j = start_index + 1
    while j < len(all_lines):
        raw = all_lines[j]
        line_no = j + 1
        stripped = raw.strip()
        if stripped == "" or stripped.startswith("#"):
            j += 1
            continue
        if re.match(r"^@end\b", stripped, flags=re.IGNORECASE):
            if stripped.lower() != "@end":
                col = _first_non_space_col(raw)
                raise ValueError(f"{_loc(line_no, col)}: invalid @end directive (expected: @end)")
            end_line = line_no
            end_col = _line_end_col(raw)
            return items, j + 1, end_line, end_col
        if stripped.startswith("@"):
            col = _first_non_space_col(raw)
            raise ValueError(f"{_loc(line_no, col)}: unexpected directive inside @reply block (use @end to close)")

        item = stripped
        if item.startswith("- "):
            item = item[2:].strip()
        block = _parse_triple_quote_block(head=item, all_lines=all_lines, start_index=j, start_line_no=line_no)
        if block is not None:
            block_text, next_j, _end_line, _end_col = block
            if block_text.strip():
                items.append(block_text)
            j = next_j
            continue
        if item:
            items.append(item)
        j += 1
    raise ValueError(f"line {start_line_no}: unterminated @reply block (missing @end)")


def _is_known_directive_token(token: str) -> bool:
    return token.lower() in {
        "@alias",
        "@tmpalias",
        "@aliasid",
        "@unaliasid",
        "@charid",
        "@uncharid",
        "@avatarid",
        "@unavatarid",
        "@avatar",
        "@usepack",
    }


class MMTLineParser:
    def __init__(self) -> None:
        self._nodes: List[Node] = []

    @staticmethod
    def _match_statement(line: str) -> Optional[Tuple[str, str, int, int]]:
        m = re.match(r"^(\s*)([\-<>])(\s+)(.*)$", line)
        if not m:
            return None
        indent, kind, spaces, payload = m.group(1), m.group(2), m.group(3), m.group(4)
        kind_col = len(indent) + 1
        payload_col = len(indent) + len(kind) + len(spaces) + 1
        return kind, payload, kind_col, payload_col

    def parse(self, text: str) -> List[Node]:
        self._nodes = []
        lines = _strip_bom(text).splitlines()

        i = 0
        while i < len(lines):
            raw = lines[i]
            stripped = raw.strip()
            if stripped == "" or stripped.startswith("#"):
                i += 1
                continue

            lstripped = raw.lstrip()
            token = (lstripped.split(None, 1)[0] if lstripped.strip() else "").strip()
            if token.startswith("@") and _is_known_directive_token(token):
                line_no = i + 1
                start_col = _first_non_space_col(raw)
                span = Span(line_no, start_col, line_no, _line_end_col(raw))
                self._nodes.append(_parse_known_directive_line(token, lstripped, line_no=line_no, span=span))
                i += 1
                continue

            if self._match_statement(raw) is not None:
                break

            if re.match(r"^@reply\b", lstripped, flags=re.IGNORECASE) or re.match(
                r"^@bond\b", lstripped, flags=re.IGNORECASE
            ):
                break

            m = HEADER_DIRECTIVE_RE.match(stripped)
            if not m:
                break
            key = m.group(1).strip().lower()
            value = m.group(2) or ""
            line_no = i + 1
            start_col = _first_non_space_col(raw)
            if key == "typst_global":
                block_text, next_i, end_line, end_col = _parse_header_block(
                    first_line_value=value, all_lines=lines, start_index=i, start_line_no=line_no
                )
                span = Span(line_no, start_col, end_line, end_col)
                self._nodes.append(TypstGlobal(line_no=line_no, span=span, value=block_text))
                i = next_i
                continue
            block_text, next_i, end_line, end_col = _parse_header_block(
                first_line_value=value, all_lines=lines, start_index=i, start_line_no=line_no
            )
            span = Span(line_no, start_col, end_line, end_col)
            self._nodes.append(MetaKV(line_no=line_no, span=span, key=key, value=block_text))
            i = next_i

        while i < len(lines):
            raw = lines[i]
            line_no = i + 1
            stripped = raw.lstrip()

            if stripped == "":
                span = Span(line_no, 1, line_no, _line_end_col(raw))
                self._nodes.append(BlankLine(line_no=line_no, span=span))
                i += 1
                continue

            if re.match(r"^@reply\s*:", stripped, flags=re.IGNORECASE):
                m = re.match(r"^@reply\s*:\s*(.*)$", stripped, flags=re.IGNORECASE)
                payload = m.group(1) if m else ""
                items = _split_reply_items(payload)
                if not items:
                    col = _first_non_space_col(raw)
                    raise ValueError(f"{_loc(line_no, col)}: @reply requires at least one option")
                start_col = _first_non_space_col(raw)
                span = Span(line_no, start_col, line_no, _line_end_col(raw))
                self._nodes.append(Reply(line_no=line_no, span=span, items=items))
                i += 1
                continue

            if re.match(r"^@reply\b", stripped, flags=re.IGNORECASE):
                if stripped.lower() != "@reply":
                    col = _first_non_space_col(raw)
                    raise ValueError(f"{_loc(line_no, col)}: invalid @reply directive (expected: @reply or @reply: ...)")
                items, next_i, end_line, end_col = _parse_reply_block(
                    all_lines=lines,
                    start_index=i,
                    start_line_no=line_no,
                )
                if not items:
                    col = _first_non_space_col(raw)
                    raise ValueError(f"{_loc(line_no, col)}: @reply block cannot be empty")
                start_col = _first_non_space_col(raw)
                span = Span(line_no, start_col, end_line, end_col)
                self._nodes.append(Reply(line_no=line_no, span=span, items=items))
                i = next_i
                continue

            if re.match(r"^@end\b", stripped, flags=re.IGNORECASE):
                col = _first_non_space_col(raw)
                raise ValueError(f"{_loc(line_no, col)}: unexpected @end without @reply")

            if re.match(r"^@bond\b", stripped, flags=re.IGNORECASE):
                m = re.match(r"^@bond(?:\s*:\s*(.*))?$", stripped, flags=re.IGNORECASE)
                if not m:
                    col = _first_non_space_col(raw)
                    raise ValueError(f"{_loc(line_no, col)}: invalid @bond directive (expected: @bond or @bond: text)")
                content_raw = m.group(1) or ""
                start_col = _first_non_space_col(raw)
                if content_raw:
                    block_text, next_i, end_line, end_col = _parse_header_block(
                        first_line_value=content_raw, all_lines=lines, start_index=i, start_line_no=line_no
                    )
                    span = Span(line_no, start_col, end_line, end_col)
                    self._nodes.append(Bond(line_no=line_no, span=span, content=block_text))
                    i = next_i
                    continue
                if i + 1 < len(lines):
                    next_line = lines[i + 1].strip()
                    block = _parse_triple_quote_block(
                        head=next_line, all_lines=lines, start_index=i + 1, start_line_no=line_no + 1
                    )
                    if block is not None:
                        block_text, next_i, end_line, end_col = block
                        span = Span(line_no, start_col, end_line, end_col)
                        self._nodes.append(Bond(line_no=line_no, span=span, content=block_text))
                        i = next_i
                        continue
                span = Span(line_no, start_col, line_no, _line_end_col(raw))
                self._nodes.append(Bond(line_no=line_no, span=span, content=""))
                i += 1
                continue

            if re.match(r"^@pagebreak\b", stripped, flags=re.IGNORECASE):
                if stripped.strip().lower() != "@pagebreak":
                    col = _first_non_space_col(raw)
                    raise ValueError(f"{_loc(line_no, col)}: invalid @pagebreak directive (expected: @pagebreak)")
                start_col = _first_non_space_col(raw)
                span = Span(line_no, start_col, line_no, _line_end_col(raw))
                self._nodes.append(PageBreak(line_no=line_no, span=span))
                i += 1
                continue

            if stripped.startswith("@"):
                token = (stripped.split(None, 1)[0] if stripped.strip() else "").strip()
                if _is_known_directive_token(token):
                    start_col = _first_non_space_col(raw)
                    span = Span(line_no, start_col, line_no, _line_end_col(raw))
                    self._nodes.append(_parse_known_directive_line(token, stripped, line_no=line_no, span=span))
                    i += 1
                    continue

                m = HEADER_DIRECTIVE_RE.match(stripped.strip())
                if m:
                    key = m.group(1).strip().lower()
                    value = m.group(2) or ""
                    if key == "typst_global":
                        block_text, next_i, end_line, end_col = _parse_header_block(
                            first_line_value=value, all_lines=lines, start_index=i, start_line_no=line_no
                        )
                        start_col = _first_non_space_col(raw)
                        span = Span(line_no, start_col, end_line, end_col)
                        self._nodes.append(TypstGlobal(line_no=line_no, span=span, value=block_text))
                        i = next_i
                        continue
                    block_text, next_i, end_line, end_col = _parse_header_block(
                        first_line_value=value, all_lines=lines, start_index=i, start_line_no=line_no
                    )
                    start_col = _first_non_space_col(raw)
                    span = Span(line_no, start_col, end_line, end_col)
                    self._nodes.append(MetaKV(line_no=line_no, span=span, key=key, value=block_text))
                    i = next_i
                    continue

            stmt = self._match_statement(raw)
            if stmt is not None and stmt[0] == "-":
                kind, payload, kind_col, payload_col = stmt
                head = payload.rstrip()
                block = _parse_triple_quote_block(head=head, all_lines=lines, start_index=i, start_line_no=line_no)
                if block is not None:
                    block_text, next_i, end_line, end_col = block
                    span = Span(line_no, kind_col, end_line, end_col)
                    self._nodes.append(Block(line_no=line_no, span=span, kind="-", marker=None, content=block_text))
                    i = next_i
                    continue
                span = Span(line_no, kind_col, line_no, _line_end_col(raw))
                self._nodes.append(Statement(line_no=line_no, span=span, kind="-", marker=None, content=head))
                i += 1
                continue

            if stmt is not None and stmt[0] in {">", "<"}:
                kind, payload, kind_col, payload_col = stmt
                marker, head = _parse_payload(payload, line_no=line_no, col_base=payload_col)
                block = _parse_triple_quote_block(head=head, all_lines=lines, start_index=i, start_line_no=line_no)
                if block is not None:
                    block_text, next_i, end_line, end_col = block
                    span = Span(line_no, kind_col, end_line, end_col)
                    self._nodes.append(Block(line_no=line_no, span=span, kind=kind, marker=marker, content=block_text))
                    i = next_i
                    continue
                span = Span(line_no, kind_col, line_no, _line_end_col(raw))
                self._nodes.append(Statement(line_no=line_no, span=span, kind=kind, marker=marker, content=head))
                i += 1
                continue

            start_col = _first_non_space_col(raw)
            span = Span(line_no, start_col, line_no, _line_end_col(raw))
            self._nodes.append(Continuation(line_no=line_no, span=span, text=stripped.rstrip()))
            i += 1

        return list(self._nodes)


def parse_to_json(text: str, *, include_span: bool = True) -> str:
    nodes = MMTLineParser().parse(text)
    return json.dumps([n.to_dict(include_span=include_span) for n in nodes], ensure_ascii=False, indent=2)


def main(argv: Optional[Sequence[str]] = None) -> int:
    import argparse
    from pathlib import Path

    p = argparse.ArgumentParser(description="Parse MomoScript DSL into a node list (experimental, no evaluation).")
    p.add_argument("input", help="Input .txt")
    p.add_argument("-o", "--output", default="", help="Output .json (optional)")
    p.add_argument("--no-span", action="store_true", help="Omit span info in JSON output")
    args = p.parse_args(list(argv) if argv is not None else None)

    in_path = Path(args.input)
    text = in_path.read_text(encoding="utf-8")
    out = parse_to_json(text, include_span=not bool(args.no_span))
    if args.output:
        Path(args.output).write_text(out, encoding="utf-8")
    else:
        print(out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
