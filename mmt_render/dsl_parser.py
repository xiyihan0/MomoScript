from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple, Union


def _strip_bom(text: str) -> str:
    return (text or "").lstrip("\ufeff")


HEADER_DIRECTIVE_RE = re.compile(r"^@([A-Za-z_][\w.-]*)\s*:\s*(.*)$")
SPEAKER_BACKREF_RE = re.compile(r"^_(\d*)\s*:\s*(.*)$")
SPEAKER_INDEX_RE = re.compile(r"^~(\d*)\s*:\s*(.*)$")


@dataclass(frozen=True)
class Node:
    line_no: int

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
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


Marker = Union[None, Tuple[str, Any]]


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


def _parse_triple_quote_block(
    *,
    head: str,
    all_lines: Sequence[str],
    start_index: int,
    start_line_no: int,
) -> Optional[Tuple[str, int]]:
    lstripped = head.lstrip()
    if not lstripped.startswith('"""'):
        return None
    prefix_len = len(head) - len(lstripped)
    after = head[prefix_len + 3 :]

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


def _parse_header_block(
    *,
    first_line_value: str,
    all_lines: Sequence[str],
    start_index: int,
    start_line_no: int,
) -> Tuple[str, int]:
    lstripped = first_line_value.lstrip()
    if not lstripped.startswith('"""'):
        return first_line_value.strip(), start_index + 1

    after = lstripped[3:]
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
    raise ValueError(f"line {start_line_no}: unterminated header triple-quote block (missing \"\"\" line)")


def _parse_payload(payload: str) -> Tuple[Marker, str]:
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


def _is_usepack_line(line: str) -> bool:
    return bool(re.match(r"^@usepack\b", line.strip(), flags=re.IGNORECASE))


def _parse_usepack_line(line: str, *, line_no: int) -> UsePack:
    m = re.match(r"^@usepack\s+(.+)$", line.strip(), flags=re.IGNORECASE)
    if not m:
        raise ValueError(f"line {line_no}: invalid @usepack directive")
    rest = m.group(1).strip()
    m2 = re.match(r"^([A-Za-z0-9_]+)\s+as\s+([A-Za-z0-9_]+)$", rest, flags=re.IGNORECASE)
    if not m2:
        raise ValueError(f"line {line_no}: invalid @usepack directive (expected: @usepack <pack_id> as <alias>)")
    return UsePack(line_no=line_no, pack_id=m2.group(1).strip(), alias=m2.group(2).strip())


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
    def _match_statement(line: str) -> Optional[Tuple[str, str]]:
        m = re.match(r"^([\-<>])\s+(.*)$", line)
        if not m:
            return None
        return m.group(1), m.group(2)

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
                if token.lower() == "@usepack":
                    self._nodes.append(_parse_usepack_line(lstripped, line_no=i + 1))
                else:
                    self._nodes.append(Directive(line_no=i + 1, name=token.lower(), payload=lstripped))
                i += 1
                continue

            if self._match_statement(lstripped) is not None:
                break

            m = HEADER_DIRECTIVE_RE.match(stripped)
            if not m:
                break
            key = m.group(1).strip().lower()
            value = m.group(2) or ""
            line_no = i + 1
            if key == "typst_global":
                block_text, next_i = _parse_header_block(
                    first_line_value=value, all_lines=lines, start_index=i, start_line_no=line_no
                )
                self._nodes.append(TypstGlobal(line_no=line_no, value=block_text))
                i = next_i
                continue
            block_text, next_i = _parse_header_block(
                first_line_value=value, all_lines=lines, start_index=i, start_line_no=line_no
            )
            self._nodes.append(MetaKV(line_no=line_no, key=key, value=block_text))
            i = next_i

        while i < len(lines):
            raw = lines[i]
            line_no = i + 1
            stripped = raw.lstrip()

            if stripped == "":
                self._nodes.append(BlankLine(line_no=line_no))
                i += 1
                continue

            if re.match(r"^@pagebreak\b", stripped, flags=re.IGNORECASE):
                if stripped.strip().lower() != "@pagebreak":
                    raise ValueError(f"line {line_no}: invalid @pagebreak directive (expected: @pagebreak)")
                self._nodes.append(PageBreak(line_no=line_no))
                i += 1
                continue

            if stripped.startswith("@"):
                token = (stripped.split(None, 1)[0] if stripped.strip() else "").strip()
                if _is_known_directive_token(token):
                    if token.lower() == "@usepack":
                        self._nodes.append(_parse_usepack_line(stripped, line_no=line_no))
                    else:
                        self._nodes.append(Directive(line_no=line_no, name=token.lower(), payload=stripped))
                    i += 1
                    continue

                m = HEADER_DIRECTIVE_RE.match(stripped.strip())
                if m:
                    key = m.group(1).strip().lower()
                    value = m.group(2) or ""
                    if key == "typst_global":
                        block_text, next_i = _parse_header_block(
                            first_line_value=value, all_lines=lines, start_index=i, start_line_no=line_no
                        )
                        self._nodes.append(TypstGlobal(line_no=line_no, value=block_text))
                        i = next_i
                        continue
                    block_text, next_i = _parse_header_block(
                        first_line_value=value, all_lines=lines, start_index=i, start_line_no=line_no
                    )
                    self._nodes.append(MetaKV(line_no=line_no, key=key, value=block_text))
                    i = next_i
                    continue

            stmt = self._match_statement(stripped)
            if stmt is not None and stmt[0] == "-":
                head = stmt[1].rstrip()
                block = _parse_triple_quote_block(head=head, all_lines=lines, start_index=i, start_line_no=line_no)
                if block is not None:
                    block_text, next_i = block
                    self._nodes.append(Block(line_no=line_no, kind="-", marker=None, content=block_text))
                    i = next_i
                    continue
                self._nodes.append(Statement(line_no=line_no, kind="-", marker=None, content=head))
                i += 1
                continue

            if stmt is not None and stmt[0] in {">", "<"}:
                kind = stmt[0]
                payload = stmt[1]
                marker, head = _parse_payload(payload)
                block = _parse_triple_quote_block(head=head, all_lines=lines, start_index=i, start_line_no=line_no)
                if block is not None:
                    block_text, next_i = block
                    self._nodes.append(Block(line_no=line_no, kind=kind, marker=marker, content=block_text))
                    i = next_i
                    continue
                self._nodes.append(Statement(line_no=line_no, kind=kind, marker=marker, content=head))
                i += 1
                continue

            self._nodes.append(Continuation(line_no=line_no, text=stripped.rstrip()))
            i += 1

        return list(self._nodes)


def parse_to_json(text: str) -> str:
    nodes = MMTLineParser().parse(text)
    return json.dumps([n.to_dict() for n in nodes], ensure_ascii=False, indent=2)


def main(argv: Optional[Sequence[str]] = None) -> int:
    import argparse
    from pathlib import Path

    p = argparse.ArgumentParser(description="Parse MomoScript DSL into a node list (experimental, no evaluation).")
    p.add_argument("input", help="Input .txt")
    p.add_argument("-o", "--output", default="", help="Output .json (optional)")
    args = p.parse_args(list(argv) if argv is not None else None)

    in_path = Path(args.input)
    text = in_path.read_text(encoding="utf-8")
    out = parse_to_json(text)
    if args.output:
        Path(args.output).write_text(out, encoding="utf-8")
    else:
        print(out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
