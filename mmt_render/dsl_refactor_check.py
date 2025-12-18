from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict

_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from mmt_render import mmt_text_to_json  # noqa: E402
from mmt_render.dsl_compiler import CompileOptions, MMTCompiler  # noqa: E402


def _repo_root() -> Path:
    # .../mmt_render/dsl_refactor_check.py -> repo root
    return _ROOT


def _canonical(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {k: _canonical(obj[k]) for k in sorted(obj.keys())}
    if isinstance(obj, list):
        return [_canonical(x) for x in obj]
    return obj


def _load_fixtures_cfg(fixtures_dir: Path) -> Dict[str, Dict[str, Any]]:
    cfg_path = fixtures_dir / "fixtures.json"
    raw = json.loads(cfg_path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise SystemExit("fixtures.json must be an object")
    out: Dict[str, Dict[str, Any]] = {}
    for k, v in raw.items():
        if not isinstance(k, str) or not isinstance(v, dict):
            continue
        out[k] = v
    return out


def _run_one(*, text: str, typst_mode: bool, engine: str) -> dict:
    if engine == "legacy":
        data, _report = mmt_text_to_json.convert_text(
            text,
            name_to_id={},
            avatar_dir=Path("avatar"),
            join_with_newline=True,
            context_window=2,
            typst_mode=bool(typst_mode),
            pack_v2_root=Path("pack-v2"),
        )
        return data

    if engine == "compiler":
        compiler = MMTCompiler()
        data, _report = compiler.compile_text(
            text,
            name_to_id={},
            avatar_dir=Path("avatar"),
            options=CompileOptions(
                join_with_newline=True,
                context_window=2,
                typst_mode=bool(typst_mode),
                pack_v2_root=Path("pack-v2"),
            ),
        )
        return data

    raise SystemExit(f"unknown engine: {engine} (expected: legacy|compiler)")


def main() -> int:
    p = argparse.ArgumentParser(description="DSL refactor fixture runner (v1 convert_text).")
    p.add_argument("--update", action="store_true", help="Regenerate golden JSON files.")
    p.add_argument("--only", default="", help="Only run a single fixture file.")
    p.add_argument("--engine", default="legacy", choices=["legacy", "compiler"], help="Which implementation to run.")
    args = p.parse_args()

    root = _repo_root()
    os.chdir(root)
    fixtures_dir = root / "mmt_render" / "dsl_fixtures"
    cfg = _load_fixtures_cfg(fixtures_dir)

    failures = 0
    for name, opt in cfg.items():
        if args.only and name != args.only:
            continue
        in_path = fixtures_dir / name
        out_path = fixtures_dir / (name + ".golden.json")
        text = in_path.read_text(encoding="utf-8")
        typst_mode = bool(opt.get("typst_mode"))
        data = _run_one(text=text, typst_mode=typst_mode, engine=str(args.engine))
        canon = _canonical(data)
        rendered = json.dumps(canon, ensure_ascii=False, indent=2) + "\n"

        if args.update or not out_path.exists():
            out_path.write_text(rendered, encoding="utf-8")
            print(f"[update] {out_path.relative_to(root)}")
            continue

        expected = out_path.read_text(encoding="utf-8")
        if expected != rendered:
            failures += 1
            print(f"[FAIL] {name} differs from golden: {out_path.name}")
        else:
            print(f"[ok] {name}")

    if failures:
        raise SystemExit(f"{failures} fixture(s) failed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
