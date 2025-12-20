from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path
from typing import Any


def _load_tags(path: Path) -> list[dict]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise RuntimeError(f"failed to read tags.json: {path} ({exc})")
    if not isinstance(data, list):
        raise RuntimeError(f"tags.json is not a list: {path}")
    items: list[dict] = []
    for i, it in enumerate(data, start=1):
        if not isinstance(it, dict):
            raise RuntimeError(f"tags.json item {i} is not an object: {path}")
        image_name = str(it.get("image_name") or "").strip()
        if not image_name:
            raise RuntimeError(f"tags.json item {i} missing image_name: {path}")
        items.append(it)
    return items


def _collect_files(dir_path: Path) -> list[Path]:
    return [p for p in dir_path.iterdir() if p.is_file() and p.name != "tags.json"]


def _check_conflicts(dirs: list[Path]) -> None:
    file_map: dict[str, list[Path]] = {}
    tag_map: dict[str, list[Path]] = {}
    for d in dirs:
        tags_path = d / "tags.json"
        if not tags_path.exists():
            raise RuntimeError(f"missing tags.json: {tags_path}")
        for p in _collect_files(d):
            file_map.setdefault(p.name, []).append(p)
        for it in _load_tags(tags_path):
            image_name = str(it.get("image_name") or "").strip()
            tag_map.setdefault(image_name, []).append(tags_path)
            img_path = d / image_name
            if not img_path.exists():
                raise RuntimeError(f"tags.json references missing file: {img_path}")

    dup_files = {k: v for k, v in file_map.items() if len(v) > 1}
    if dup_files:
        lines = ["duplicate file names found:"]
        for name, paths in sorted(dup_files.items()):
            lines.append(f"- {name}: " + ", ".join(str(p) for p in paths))
        raise RuntimeError("\n".join(lines))

    dup_tags = {k: v for k, v in tag_map.items() if len(v) > 1}
    if dup_tags:
        lines = ["duplicate image_name in tags.json:"]
        for name, paths in sorted(dup_tags.items()):
            lines.append(f"- {name}: " + ", ".join(str(p) for p in paths))
        raise RuntimeError("\n".join(lines))


def _merge_tags(paths: list[Path]) -> list[dict]:
    merged: list[dict[str, Any]] = []
    for p in paths:
        merged.extend(_load_tags(p))
    return merged


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Merge image dirs into the first dir and merge tags.json.",
    )
    parser.add_argument("dirs", nargs="+", help="dir1 dir2 ... dirN")
    parser.add_argument("--dry-run", action="store_true", help="only show planned operations")
    args = parser.parse_args()

    dirs = [Path(x).resolve() for x in args.dirs]
    if len(dirs) < 2:
        raise SystemExit("need at least 2 directories")
    for d in dirs:
        if not d.exists() or not d.is_dir():
            raise SystemExit(f"not a directory: {d}")

    target = dirs[0]
    sources = dirs[1:]

    _check_conflicts(dirs)

    merge_paths = [d / "tags.json" for d in dirs]
    merged = _merge_tags(merge_paths)

    if args.dry_run:
        print(f"target: {target}")
        for src in sources:
            files = _collect_files(src)
            print(f"move from {src}: {len(files)} files")
        print(f"tags.json merged items: {len(merged)}")
        print("dry-run: no changes made")
        return 0

    for src in sources:
        for p in _collect_files(src):
            shutil.move(str(p), str(target / p.name))

    (target / "tags.json").write_text(
        json.dumps(merged, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    for src in sources:
        shutil.rmtree(src)

    print(f"done: merged {len(sources)} dirs into {target}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
