"""
Download Blue Archive student avatars from https://api.kivo.wiki.

Outputs:
- avatar/{id}.png by default (best-effort PNG conversion if Pillow is installed; otherwise saves original suffix)
- avatar/name_to_id.json: mapping from "{given_name_cn}(skin_cn)" -> id

This script is async and uses the existing `kivowiki_api.py` wrapper (curl-cffi).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from kivowiki_api import ApiError, KivoWikiClient, parse_student_list_response


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _make_key(given_name_cn: str, skin_cn: str) -> str:
    given_name_cn = _safe_text(given_name_cn)
    skin_cn = _safe_text(skin_cn)
    if skin_cn:
        return f"{given_name_cn}({skin_cn})"
    return given_name_cn


def _try_import_pillow():
    try:
        from PIL import Image  # type: ignore

        return Image
    except Exception:
        return None


def _guess_ext_from_content_type(content_type: str) -> str:
    ct = (content_type or "").split(";", 1)[0].strip().lower()
    if ct == "image/png":
        return ".png"
    if ct == "image/jpeg":
        return ".jpg"
    if ct == "image/webp":
        return ".webp"
    return ""


def _normalize_avatar_url(url: str) -> str:
    return _safe_text(url)


@dataclass(frozen=True)
class AvatarTask:
    student_id: int
    url: str


async def _fetch_all_students(
    client: KivoWikiClient,
    *,
    page_size: int,
    include_npc: bool,
    limit: Optional[int],
) -> List[Dict[str, Any]]:
    page = 1
    raw = await client.get_students_raw(page=page, page_size=page_size, is_npc=None if include_npc else False)
    parsed = parse_student_list_response(raw)
    students = [s.model_dump() for s in parsed.data.students]
    max_page = int(parsed.data.max_page or 1)

    if limit is not None and len(students) >= limit:
        return students[:limit]

    for page in range(2, max_page + 1):
        raw = await client.get_students_raw(page=page, page_size=page_size, is_npc=None if include_npc else False)
        parsed = parse_student_list_response(raw)
        students.extend(s.model_dump() for s in parsed.data.students)
        if limit is not None and len(students) >= limit:
            return students[:limit]

    return students


async def _download_one(
    client: KivoWikiClient,
    task: AvatarTask,
    *,
    out_dir: Path,
    resume: bool,
    prefer_png: bool,
    semaphore: asyncio.Semaphore,
    pillow_image,
) -> Tuple[int, Optional[Path], Optional[str], Optional[str]]:
    async with semaphore:
        target_png = out_dir / f"{task.student_id}.png"
        if resume and target_png.exists():
            return task.student_id, target_png, None, None

        try:
            status_code, headers, content = await client.get_bytes(task.url, timeout=30.0)
        except ApiError as exc:
            return task.student_id, None, f"download failed: {exc}", None

        if status_code >= 400:
            return task.student_id, None, f"download failed: {status_code}", None

        content_type = headers.get("content-type", "")

        ext = _guess_ext_from_content_type(content_type)
        if not ext:
            url_ext = os.path.splitext(task.url.split("?", 1)[0])[1].lower()
            ext = url_ext if url_ext else ".bin"

        conversion_warning: Optional[str] = None
        if prefer_png and ext != ".png" and pillow_image is not None:
            try:
                img = pillow_image.open(BytesIO(content))
                img.save(target_png, format="PNG")
                return task.student_id, target_png, None, None
            except Exception as exc:
                conversion_warning = f"png convert failed, saved original: {exc}"

        if ext == ".png":
            target = target_png
        else:
            target = out_dir / f"{task.student_id}{ext}"
            if resume and target.exists():
                return task.student_id, target, None, conversion_warning

        try:
            target.write_bytes(content)
            return task.student_id, target, None, conversion_warning
        except Exception as exc:
            return task.student_id, None, f"write failed: {exc}", None


async def main_async(args: argparse.Namespace) -> int:
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    pillow_image = _try_import_pillow() if args.prefer_png else None

    async with KivoWikiClient(timeout=float(args.timeout)) as client:
        try:
            students = await _fetch_all_students(
                client,
                page_size=int(args.page_size),
                include_npc=bool(args.include_npc),
                limit=int(args.limit) if args.limit is not None else None,
            )
        except ApiError as exc:
            print(f"[error] failed to fetch student list: {exc}")
            return 2

        name_to_id: Dict[str, int] = {}
        collisions: Dict[str, List[int]] = {}
        missing_avatar: List[int] = []
        tasks: List[AvatarTask] = []

        for s in students:
            student_id = int(s.get("id") or 0)
            key = _make_key(_safe_text(s.get("given_name_cn") or s.get("given_name")), _safe_text(s.get("skin_cn") or s.get("skin")))
            if key:
                if key in name_to_id and name_to_id[key] != student_id:
                    collisions.setdefault(key, [name_to_id[key]]).append(student_id)
                else:
                    name_to_id[key] = student_id

            avatar_url = _normalize_avatar_url(s.get("avatar"))
            if not avatar_url:
                missing_avatar.append(student_id)
                continue
            tasks.append(AvatarTask(student_id=student_id, url=avatar_url))

        index = {
            "generated_at": _utc_now_iso(),
            "source": "https://api.kivo.wiki/api/v1/data/students",
            "key_format": '{given_name_cn} + ("(" + skin_cn + ")" if skin_cn else "")',
            "name_to_id": dict(sorted(name_to_id.items(), key=lambda kv: kv[0])),
            "collisions": [{"key": k, "ids": v} for k, v in sorted(collisions.items(), key=lambda kv: kv[0])],
            "missing_avatar": sorted({i for i in missing_avatar if i}),
            "prefer_png": bool(args.prefer_png),
            "png_conversion_available": pillow_image is not None,
        }
        (out_dir / "name_to_id.json").write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")

        if args.dry_run:
            print(f"[ok] wrote {out_dir / 'name_to_id.json'} (dry-run, no downloads)")
            return 0

        if not tasks:
            print("[ok] no avatar tasks to download")
            return 0

        semaphore = asyncio.Semaphore(int(args.concurrency))
        results = await asyncio.gather(
            *[
                _download_one(
                    client,
                    t,
                    out_dir=out_dir,
                    resume=bool(args.resume),
                    prefer_png=bool(args.prefer_png),
                    semaphore=semaphore,
                    pillow_image=pillow_image,
                )
                for t in tasks
            ]
        )

        ok = 0
        failed: List[Tuple[int, str, str]] = []
        warnings: List[Tuple[int, str]] = []
        for (student_id, path, err, warn), t in zip(results, tasks):
            if path is not None and err is None:
                ok += 1
                if warn:
                    warnings.append((student_id, warn))
            elif err is not None:
                failed.append((student_id, t.url, err))

        if warnings:
            (out_dir / "download_warnings.json").write_text(
                json.dumps(
                    {"generated_at": _utc_now_iso(), "warnings": [{"id": i, "warning": w} for i, w in warnings]},
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )

        if failed:
            report_path = out_dir / "download_errors.json"
            report_path.write_text(
                json.dumps(
                    {
                        "generated_at": _utc_now_iso(),
                        "failed": [{"id": i, "url": u, "error": e} for i, u, e in failed],
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )
            print(f"[warn] downloaded {ok}/{len(tasks)}; failures: {len(failed)} (see {report_path})")
            return 1

        print(f"[ok] downloaded {ok}/{len(tasks)} avatars to {out_dir}")
        return 0


def build_argparser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Download Kivo Wiki student avatars to a local folder.")
    p.add_argument("--out-dir", default="avatar", help="Output folder (default: avatar)")
    p.add_argument("--page-size", type=int, default=100, help="List page size (default: 100)")
    p.add_argument("--concurrency", type=int, default=20, help="Concurrent downloads (default: 20)")
    p.add_argument("--timeout", type=float, default=15.0, help="API timeout seconds (default: 15)")
    p.add_argument("--limit", type=int, default=None, help="Only process first N students")
    p.add_argument("--include-npc", action="store_true", help="Include NPC students (default: exclude)")
    p.add_argument("--resume", action="store_true", help="Skip files that already exist")
    p.add_argument(
        "--prefer-png",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Prefer saving as PNG; needs Pillow to convert non-PNG avatars (default: enabled)",
    )
    p.add_argument("--dry-run", action="store_true", help="Only write name_to_id.json; do not download avatars")
    return p


def main() -> int:
    parser = build_argparser()
    args = parser.parse_args()
    return asyncio.run(main_async(args))


if __name__ == "__main__":
    raise SystemExit(main())
