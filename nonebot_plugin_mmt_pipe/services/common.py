from __future__ import annotations

import re
import time
from pathlib import Path
from typing import Optional

from nonebot.adapters import Event

from ..pack_store import validate_pack_id


def join_tokens(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        return " ".join(str(x) for x in value if str(x).strip()).strip()
    return str(value).strip()


def safe_stem(_: str) -> str:
    return str(int(time.time() * 1000))


def image_order_key(image_name: str) -> tuple[int, str]:
    s = (image_name or "").strip()
    stem = s.rsplit(".", 1)[0]
    nums = re.findall(r"\d+", stem)
    n = int(nums[-1]) if nums else -1
    return (n, s.lower())


def sanitize_filename_component(s: str) -> str:
    s = (s or "").strip()
    if not s:
        return ""
    # Windows forbidden chars: \ / : * ? " < > | and control chars.
    s = re.sub(r'[\x00-\x1f<>:"/\\\\|?*]+', "_", s)
    s = re.sub(r"\s+", " ", s).strip()
    s = s.strip(". ")
    return s


def format_pdf_name(*, meta: dict, compiled_at: str, fallback: str) -> str:
    title = sanitize_filename_component(str(meta.get("title") or "无题"))
    author = sanitize_filename_component(str(meta.get("author") or ""))
    # Always include a time part to avoid unreadable random stems.
    ts = compiled_at.strip() or time.strftime("%Y-%m-%d %H:%M:%S")
    ts = sanitize_filename_component(ts)

    parts = [p for p in (title, author, ts) if p]
    if not parts:
        parts = [sanitize_filename_component(fallback) or "mmt"]
    name = "-".join(parts) + ".pdf"
    if len(name) > 160:
        name = name[:156] + ".pdf"
    return name


def parse_pack_csv(value: str) -> list[str]:
    raw = (value or "").strip()
    if not raw:
        return []
    out: list[str] = []
    for part in raw.split(","):
        p = part.strip()
        if not p:
            continue
        out.append(validate_pack_id(p))
    # de-dup, preserve order
    seen: set[str] = set()
    uniq: list[str] = []
    for p in out:
        if p in seen:
            continue
        seen.add(p)
        uniq.append(p)
    return uniq


def parse_opts_tokens(tokens: list[str]) -> tuple[dict, list[str]]:
    """
    Extracts known options from tokens (any position).
    Returns: (opts, remaining_tokens)
    opts:
      - packs: list[str] | None
      - top_n: int | None
    """
    packs: list[str] | None = None
    top_n: int | None = None

    remain: list[str] = []
    i = 0
    while i < len(tokens):
        t = tokens[i]
        if t == "--pack" and i + 1 < len(tokens):
            packs = parse_pack_csv(tokens[i + 1])
            i += 2
            continue
        if t.startswith("--pack="):
            packs = parse_pack_csv(t.split("=", 1)[1])
            i += 1
            continue
        if t == "--top-n" and i + 1 < len(tokens):
            try:
                top_n = max(1, int(tokens[i + 1]))
            except Exception:
                top_n = None
            i += 2
            continue
        if t.startswith("--top-n="):
            try:
                top_n = max(1, int(t.split("=", 1)[1]))
            except Exception:
                top_n = None
            i += 1
            continue
        remain.append(t)
        i += 1

    return {"packs": packs, "top_n": top_n}, remain


def find_name_map_and_avatar_dir() -> tuple[Path, Path]:
    name_map_path = Path("avatar/name_to_id.json")
    avatar_dir = Path("avatar")
    if not name_map_path.exists():
        candidate = Path.cwd() / "mmt_render" / "avatar" / "name_to_id.json"
        if candidate.exists():
            name_map_path = candidate
    if not avatar_dir.exists():
        candidate = Path.cwd() / "mmt_render" / "avatar"
        if candidate.exists():
            avatar_dir = candidate
    return name_map_path, avatar_dir


def event_scope_ids(event: Event) -> tuple[Optional[str], Optional[str]]:
    # private scope: always available if user_id exists
    uid = getattr(event, "user_id", None)
    private_id = str(uid) if uid is not None else None
    gid = getattr(event, "group_id", None)
    group_id = str(gid) if gid is not None else None
    return private_id, group_id


def extract_invoker_name(event: Event) -> Optional[str]:
    try:
        fn = getattr(event, "get_user_name", None)
        if callable(fn):
            name = fn()
            if isinstance(name, str) and name.strip():
                return name.strip()
    except Exception:
        pass

    sender = getattr(event, "sender", None)
    if isinstance(sender, dict):
        name = (sender.get("card") or sender.get("nickname") or "").strip()
        if name:
            return name
    elif sender is not None:
        try:
            card = getattr(sender, "card", None)
            nickname = getattr(sender, "nickname", None)
            name = (str(card or nickname or "")).strip()
            if name:
                return name
        except Exception:
            pass

    try:
        fn = getattr(event, "get_user_id", None)
        if callable(fn):
            uid = fn()
            if isinstance(uid, str) and uid.strip():
                return uid.strip()
    except Exception:
        pass

    uid = getattr(event, "user_id", None)
    if uid is not None:
        s = str(uid).strip()
        if s:
            return s

    return None


def inject_author_if_missing(text: str, author: Optional[str]) -> str:
    if not author:
        return text

    # Only consider the header region (before the first statement line).
    for line in text.splitlines():
        s = line.lstrip()
        if s.startswith(("- ", "> ", "< ")):
            break
        if re.match(r"^@author\\s*:", s):
            return text

    return f"@author: {author}\n{text}"


__all__ = [
    "event_scope_ids",
    "extract_invoker_name",
    "find_name_map_and_avatar_dir",
    "format_pdf_name",
    "image_order_key",
    "inject_author_if_missing",
    "join_tokens",
    "parse_opts_tokens",
    "parse_pack_csv",
    "safe_stem",
    "sanitize_filename_component",
]
