from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Optional, Sequence


SegmentType = Literal["text", "expr", "image"]


@dataclass(frozen=True)
class InlineSegment:
    type: SegmentType
    text: str = ""
    query: str = ""
    target: str = ""  # name / "_" / "_2" / etc, resolved later


def parse_inline_segments(content: str, *, require_colon_prefix: bool = False) -> Sequence[InlineSegment]:
    """
    Parse inline expressions:
      - [natural_language_description](character_name_or__n)
      - (character_name_or__n)[natural_language_description]
      - [natural_language_description]

    Escapes:
      - \\[ \\] \\( \\) \\\\

    This is a minimal tokenizer: no nesting for now.
    """
    out: list[InlineSegment] = []
    buf: list[str] = []

    def flush_text() -> None:
        if buf:
            out.append(InlineSegment(type="text", text="".join(buf)))
            buf.clear()

    i = 0
    n = len(content)
    while i < n:
        ch = content[i]
        if ch == "\\" and i + 1 < n:
            buf.append(content[i + 1])
            i += 2
            continue

        # Parse (target)[query]
        if ch == "(":
            j = i + 1
            target_chars: list[str] = []
            while j < n:
                c = content[j]
                if c == "\\" and j + 1 < n:
                    target_chars.append(content[j + 1])
                    j += 2
                    continue
                if c == ")":
                    break
                target_chars.append(c)
                j += 1
            if j < n and content[j] == ")" and (j + 1) < n and content[j + 1] == "[":
                target = "".join(target_chars).strip()
                # Parse [query]
                k = j + 2
                query_chars: list[str] = []
                while k < n:
                    c = content[k]
                    if c == "\\" and k + 1 < n:
                        query_chars.append(content[k + 1])
                        k += 2
                        continue
                    if c == "]":
                        break
                    query_chars.append(c)
                    k += 1
                if k < n and content[k] == "]":
                    query = "".join(query_chars).strip()
                    end = k + 1
                    if require_colon_prefix and not query.startswith(":"):
                        buf.append(content[i:end])
                        i = end
                        continue
                    flush_text()
                    out.append(InlineSegment(type="expr", query=query, target=target))
                    i = end
                    continue
            # Not a valid marker; treat as plain text
            buf.append(ch)
            i += 1
            continue

        if ch != "[":
            buf.append(ch)
            i += 1
            continue

        # Parse [query]
        j = i + 1
        query_chars: list[str] = []
        while j < n:
            c = content[j]
            if c == "\\" and j + 1 < n:
                query_chars.append(content[j + 1])
                j += 2
                continue
            if c == "]":
                break
            query_chars.append(c)
            j += 1
        if j >= n or content[j] != "]":
            # Not a valid bracket; treat as plain text.
            buf.append(ch)
            i += 1
            continue

        query = "".join(query_chars).strip()
        k = j + 1
        target = ""
        if k < n and content[k] == "(":
            # Parse (target)
            k += 1
            target_chars: list[str] = []
            while k < n:
                c = content[k]
                if c == "\\" and k + 1 < n:
                    target_chars.append(content[k + 1])
                    k += 2
                    continue
                if c == ")":
                    break
                target_chars.append(c)
                k += 1
            if k < n and content[k] == ")":
                target = "".join(target_chars).strip()
                end = k + 1
            else:
                # No closing ')', treat as plain text.
                buf.append(ch)
                i += 1
                continue
        else:
            end = j + 1

        if require_colon_prefix and not query.startswith(":"):
            # Keep original slice for Typst markup compatibility.
            buf.append(content[i:end])
            i = end
            continue

        flush_text()
        out.append(InlineSegment(type="expr", query=query, target=target))
        i = end

    flush_text()
    return out


def is_backref_target(target: str) -> bool:
    t = target.strip()
    return t == "_" or (t.startswith("_") and t[1:].isdigit())


def parse_backref_n(target: str) -> Optional[int]:
    t = target.strip()
    if t == "_":
        return 1
    if t.startswith("_") and t[1:].isdigit():
        return int(t[1:])
    return None
