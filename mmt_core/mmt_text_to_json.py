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
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse


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


def _parse_asset_query(query: str) -> Optional[str]:
    q = (query or "").strip()
    if not q:
        return None
    if q.lower().startswith("asset:"):
        name = q.split(":", 1)[1].strip()
        return name or None
    return None


def _default_pack_v2_root() -> Optional[Path]:
    for cand in (Path("pack-v2"), Path("typst_sandbox") / "pack-v2"):
        if cand.exists():
            return cand
    return None

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
    pack_v2_root: Optional[Path] = None,
    dsl_engine: Optional[str] = None,
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """
    Returns: (json_data, report)
    """
    # DSL refactor toggle:
    # - Default to the new node-based pipeline on this branch.
    # - Force legacy via `dsl_engine="legacy"` or env `MMT_DSL_ENGINE=legacy`.
    engine = (dsl_engine or os.getenv("MMT_DSL_ENGINE") or "compiler_nodes").strip().lower()
    if engine not in ("legacy", "old"):
        effective_pack_v2_root: Optional[Path] = pack_v2_root
        if effective_pack_v2_root is None:
            env = os.getenv("MMT_PACK_V2_ROOT", "").strip()
            if env:
                effective_pack_v2_root = Path(env).expanduser()
            else:
                effective_pack_v2_root = _default_pack_v2_root()

        from mmt_core.dsl_compiler import CompileOptions, MMTCompiler

        compiler = MMTCompiler()
        options = CompileOptions(
            join_with_newline=bool(join_with_newline),
            context_window=max(0, int(context_window)),
            typst_mode=bool(typst_mode),
            pack_v2_root=effective_pack_v2_root,
        )
        if engine in ("compiler_nodes", "nodes", "node"):
            nodes = compiler.parse_nodes(text)
            return compiler.compile_nodes(nodes, name_to_id=name_to_id, avatar_dir=avatar_dir, options=options)
        if engine in ("compiler", "text"):
            return compiler.compile_text(text, name_to_id=name_to_id, avatar_dir=avatar_dir, options=options)
        raise ValueError(f"invalid dsl_engine: {dsl_engine!r} (or env MMT_DSL_ENGINE={engine!r})")
    else:
        raise NotImplementedError("Legacy DSL engine is no longer supported.")


def build_argparser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Convert MMT text DSL into JSON for mmt.typ.")
    p.add_argument("input", help="Input .txt")
    p.add_argument("-o", "--output", default=None, help="Output .json (default: alongside input)")
    p.add_argument(
        "--avatar-dir",
        default="typst_sandbox/mmt_render/avatar",
        help="Avatar folder (default: typst_sandbox/mmt_render/avatar)",
    )
    p.add_argument(
        "--name-map",
        default="typst_sandbox/mmt_render/avatar/name_to_id.json",
        help="Path to name_to_id.json from download_student_avatars.py (default: typst_sandbox/mmt_render/avatar/name_to_id.json)",
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

    # Convenience: when running from repo root with input under typst_sandbox/mmt_render/,
    # auto-resolve defaults relative to the input file directory.
    if not name_map_path.exists() and args.name_map == "typst_sandbox/mmt_render/avatar/name_to_id.json":
        candidate = in_path.parent / "avatar" / "name_to_id.json"
        if candidate.exists():
            name_map_path = candidate
    if not avatar_dir.exists() and args.avatar_dir == "typst_sandbox/mmt_render/avatar":
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
