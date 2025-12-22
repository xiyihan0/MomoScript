from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def _load_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise RuntimeError(f"failed to read json: {path} ({exc})")
    if not isinstance(data, dict):
        raise RuntimeError(f"json is not an object: {path}")
    return data


def _load_char_ids(base_pack: Path) -> set[str]:
    path = base_pack / "char_id.json"
    if not path.exists():
        raise RuntimeError(f"missing char_id.json: {path}")
    data = _load_json(path)
    ids = {str(v).strip() for v in data.values() if str(v).strip()}
    if not ids:
        raise RuntimeError(f"no ids found in {path}")
    return ids


def _list_image_dirs(pack_dir: Path) -> list[Path]:
    images_dir = pack_dir / "images"
    if not images_dir.exists():
        raise RuntimeError(f"missing images dir: {images_dir}")
    return sorted([p for p in images_dir.iterdir() if p.is_dir()], key=lambda p: p.name)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Update asset_mapping.json from images/<id> folders.",
    )
    parser.add_argument("pack", help="extension pack path, e.g. typst_sandbox/pack-v2/ba_extpack")
    parser.add_argument("--base", default="typst_sandbox/pack-v2/ba", help="base pack path (for char_id.json)")
    parser.add_argument(
        "--allow-new-ids",
        action="store_true",
        help="allow ids missing in base pack (requires avatar/<id>.* and updates pack char_id.json)",
    )
    parser.add_argument("--dry-run", action="store_true", help="only show planned changes")
    args = parser.parse_args()

    pack_dir = Path(args.pack).resolve()
    base_pack = Path(args.base).resolve()
    if not pack_dir.exists():
        raise SystemExit(f"pack not found: {pack_dir}")
    if not base_pack.exists():
        raise SystemExit(f"base pack not found: {base_pack}")

    valid_ids = _load_char_ids(base_pack)
    img_dirs = _list_image_dirs(pack_dir)
    if not img_dirs:
        raise SystemExit("no image folders found")

    missing: list[str] = []
    for p in img_dirs:
        if p.name not in valid_ids:
            missing.append(p.name)
    if missing and not args.allow_new_ids:
        lines = ["unknown ids (not in base pack char_id.json):"]
        lines.extend([f"- {x}" for x in missing])
        raise SystemExit("\n".join(lines))

    mapping_path = pack_dir / "asset_mapping.json"
    existing = _load_json(mapping_path) if mapping_path.exists() else {}

    char_id_path = pack_dir / "char_id.json"
    char_id_map = _load_json(char_id_path) if char_id_path.exists() else {}
    if not isinstance(char_id_map, dict):
        raise SystemExit(f"char_id.json is not an object: {char_id_path}")

    updated: dict[str, dict] = {}
    for p in img_dirs:
        key = p.name
        tags_path = p / "tags.json"
        if not tags_path.exists():
            raise SystemExit(f"missing tags.json: {tags_path}")
        if key in missing:
            avatar_dir = pack_dir / "avatar"
            if not avatar_dir.exists():
                raise SystemExit(f"missing avatar dir for new id: {avatar_dir}")
            matches = list(avatar_dir.glob(f"{key}.*"))
            if not matches:
                raise SystemExit(f"missing avatar for new id: {avatar_dir / (key + '.*')}")
            char_id_map.setdefault(key, key)
        base_entry = dict(existing.get(key, {}))
        base_entry["expressions_dir"] = f"images/{key}"
        base_entry["tags"] = "tags.json"
        updated[key] = base_entry

    if args.dry_run:
        print(f"pack: {pack_dir}")
        print(f"entries: {len(updated)}")
        if missing:
            print(f"new ids: {len(missing)} (will update pack char_id.json)")
        print("dry-run: no changes made")
        return 0

    mapping_path.write_text(
        json.dumps(updated, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    if missing:
        char_id_path.write_text(
            json.dumps(char_id_map, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    print(f"updated: {mapping_path} ({len(updated)} entries)")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
