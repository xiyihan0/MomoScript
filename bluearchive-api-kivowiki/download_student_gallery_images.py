from __future__ import annotations

import argparse
import asyncio
import json
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Callable, Awaitable, TypeVar
from urllib.parse import unquote, urlparse

from curl_cffi import requests as curl_requests

import kivowiki_api


DEFAULT_BASE_URL = "https://api.kivo.wiki/api/v1"
DEFAULT_STATIC_SCHEME = "https:"

# Windows filename invalid chars: <>:"/\|?* and control chars (0x00-0x1F)
_INVALID_FILENAME_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1F]')
_RESERVED_NAMES = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


@dataclass(frozen=True)
class Failure:
    student_id: int
    url: str
    stage: str
    status_code: int
    error: str


T = TypeVar("T")


def _now_ms() -> int:
    return int(time.time() * 1000)


async def _sleep(seconds: float) -> None:
    if seconds and seconds > 0:
        await asyncio.sleep(seconds)


def _absolute_url(url: str) -> str:
    if url.startswith("//"):
        return f"{DEFAULT_STATIC_SCHEME}{url}"
    return url


def _safe_filename(name: str) -> str:
    name = _INVALID_FILENAME_CHARS.sub("_", name).strip().rstrip(". ")
    if not name:
        name = "file"
    stem = Path(name).stem
    suffix = Path(name).suffix
    if stem.upper() in _RESERVED_NAMES:
        stem = f"_{stem}"
    return f"{stem}{suffix}"


def _pick_filename_from_url(url: str) -> str:
    parsed = urlparse(url)
    base = parsed.path.rsplit("/", 1)[-1]
    base = unquote(base)
    return _safe_filename(base or "file")


async def _get_json_with_retries(
    fn: Callable[[], Awaitable[T]],
    *,
    max_retries: int = 3,
    backoff: float = 0.6,
) -> T:
    last_error = ""
    for attempt in range(max_retries + 1):
        try:
            return await fn()
        except Exception as exc:
            last_error = str(exc)
            if attempt < max_retries:
                await _sleep(backoff * (2**attempt))
                continue
            raise RuntimeError(f"Request failed after retries: {last_error}") from exc
    raise RuntimeError(f"Request failed: {last_error}")


async def fetch_all_student_ids(
    client: kivowiki_api.KivoWikiClient,
    *,
    page_size: int,
    list_concurrency: int,
    limit: Optional[int],
    max_retries: int,
    backoff: float,
) -> List[int]:
    first = await _get_json_with_retries(
        lambda: client.get_students_raw(page=1, page_size=page_size),
        max_retries=max_retries,
        backoff=backoff,
    )
    data = first.get("data") or {}
    max_page = int(data.get("max_page") or 0)
    ids: List[int] = []

    def consume(payload: Dict[str, Any]) -> None:
        nonlocal ids, limit
        students = ((payload.get("data") or {}).get("students")) or []
        for item in students:
            if limit is not None and limit <= 0:
                return
            sid = item.get("id")
            if isinstance(sid, int):
                ids.append(sid)
                if limit is not None:
                    limit -= 1

    consume(first)
    if limit is not None and limit <= 0:
        return ids

    sem = asyncio.Semaphore(max(1, list_concurrency))

    async def fetch_page(page: int) -> Dict[str, Any]:
        async with sem:
            return await _get_json_with_retries(
                lambda: client.get_students_raw(page=page, page_size=page_size),
                max_retries=max_retries,
                backoff=backoff,
            )

    tasks = []
    for page in range(2, max_page + 1):
        if limit is not None and limit <= 0:
            break
        tasks.append(asyncio.create_task(fetch_page(page)))

    for coro in asyncio.as_completed(tasks):
        if limit is not None and limit <= 0:
            break
        payload = await coro
        consume(payload)

    return ids


async def fetch_student_gallery_image_urls(
    client: kivowiki_api.KivoWikiClient,
    *,
    student_id: int,
    gallery_title: str,
    max_retries: int,
    backoff: float,
) -> Tuple[int, List[str]]:
    payload = await _get_json_with_retries(
        lambda: client.get_student_raw(student_id),
        max_retries=max_retries,
        backoff=backoff,
    )
    data = payload.get("data") or {}
    sid = int(data.get("id") or student_id)
    galleries = data.get("gallery") or []
    urls: List[str] = []
    for g in galleries:
        if not isinstance(g, dict):
            continue
        if str(g.get("title") or "") != gallery_title:
            continue
        images = g.get("images") or []
        for u in images:
            if isinstance(u, str) and u:
                urls.append(_absolute_url(u))
    return sid, urls


async def download_file(
    session: curl_requests.AsyncSession,
    *,
    url: str,
    dest: Path,
    timeout: float,
    max_retries: int,
    backoff: float,
) -> None:
    last_error = ""
    for attempt in range(max_retries + 1):
        try:
            resp = await session.get(url, timeout=timeout)
            if resp.status_code in (429, 500, 502, 503, 504) and attempt < max_retries:
                await _sleep(backoff * (2**attempt))
                continue
            if resp.status_code >= 400:
                text = (getattr(resp, "text", "") or "")[:200]
                raise RuntimeError(f"HTTP {resp.status_code}: {text}")
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(resp.content)
            return
        except Exception as exc:
            last_error = str(exc)
            if attempt < max_retries:
                await _sleep(backoff * (2**attempt))
                continue
            raise RuntimeError(last_error) from exc


def _unique_path(path: Path) -> Path:
    if not path.exists():
        return path
    stem = path.stem
    suffix = path.suffix
    parent = path.parent
    for i in range(1, 10_000):
        candidate = parent / f"{stem}__{i}{suffix}"
        if not candidate.exists():
            return candidate
    raise RuntimeError(f"Could not find unique filename for {path}")


async def run(args: argparse.Namespace) -> int:
    base_url = args.base_url.rstrip("/")
    out_root = Path(args.out_root)
    report_path = Path(args.report)
    gallery_title = args.gallery_title
    limit_students = args.limit_students if args.limit_students and args.limit_students > 0 else None
    max_per_student = args.max_per_student if args.max_per_student and args.max_per_student > 0 else None

    started_ms = _now_ms()
    api_client = kivowiki_api.KivoWikiClient(
        base_url=base_url,
        timeout=args.timeout,
        user_agent="kivowiki-api-wrapper/downloader",
    )
    download_session = curl_requests.AsyncSession()
    download_session.headers.update({"User-Agent": "kivowiki-api-wrapper/downloader"})

    failures: List[Failure] = []
    downloaded = 0
    skipped = 0
    discovered = 0

    try:
        async with api_client as client:
            student_ids = await fetch_all_student_ids(
                client,
                page_size=args.page_size,
                list_concurrency=args.list_concurrency,
                limit=limit_students,
                max_retries=args.max_retries,
                backoff=args.backoff,
            )
            total_students = len(student_ids)
            print(f"fetched {total_students} student ids")

            detail_sem = asyncio.Semaphore(max(1, args.detail_concurrency))
            download_sem = asyncio.Semaphore(max(1, args.download_concurrency))

            async def handle_student(student_id: int) -> None:
                nonlocal discovered, downloaded, skipped
                try:
                    async with detail_sem:
                        sid, urls = await fetch_student_gallery_image_urls(
                            client,
                            student_id=student_id,
                            gallery_title=gallery_title,
                            max_retries=args.max_retries,
                            backoff=args.backoff,
                        )
                except Exception as exc:
                    failures.append(
                        Failure(student_id=student_id, url="", stage="detail", status_code=0, error=str(exc))
                    )
                    return

                if max_per_student is not None:
                    urls = urls[:max_per_student]

                discovered += len(urls)
                if args.dry_run:
                    return

                student_dir = out_root / "students" / str(sid)
                for url in urls:
                    filename = _pick_filename_from_url(url)
                    dest = student_dir / filename
                    if dest.exists() and dest.stat().st_size > 0 and not args.force:
                        skipped += 1
                        continue
                    try:
                        async with download_sem:
                            final_dest = _unique_path(dest) if (dest.exists() and args.force) else dest
                            await download_file(
                                download_session,
                                url=url,
                                dest=final_dest,
                                timeout=args.timeout,
                                max_retries=args.max_retries,
                                backoff=args.backoff,
                            )
                        downloaded += 1
                    except Exception as exc:
                        failures.append(
                            Failure(student_id=sid, url=url, stage="download", status_code=0, error=str(exc))
                        )
                    if args.sleep > 0:
                        await _sleep(args.sleep)

            tasks = [asyncio.create_task(handle_student(sid)) for sid in student_ids]
            done = 0
            for coro in asyncio.as_completed(tasks):
                await coro
                done += 1
                if done % args.progress_every == 0 or done == total_students:
                    print(
                        f"{done}/{total_students} students processed | "
                        f"discovered={discovered} downloaded={downloaded} skipped={skipped} failures={len(failures)}"
                    )

        report = {
            "base_url": base_url,
            "gallery_title": gallery_title,
            "students_total": total_students,
            "images_discovered": discovered,
            "downloaded": downloaded,
            "skipped": skipped,
            "failure_count": len(failures),
            "failures": [f.__dict__ for f in failures],
            "out_root": str(out_root),
            "detail_concurrency": args.detail_concurrency,
            "download_concurrency": args.download_concurrency,
            "timeout": args.timeout,
            "max_retries": args.max_retries,
            "backoff": args.backoff,
            "sleep": args.sleep,
            "dry_run": bool(args.dry_run),
            "force": bool(args.force),
            "ts_ms": int(time.time() * 1000),
            "duration_ms": _now_ms() - started_ms,
        }
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"report written: {report_path}")
        return 0 if len(failures) == 0 else 2
    finally:
        await download_session.close()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Download student gallery images into /images/students/{id}/{filename}."
    )
    parser.add_argument("--base-url", type=str, default=DEFAULT_BASE_URL)
    parser.add_argument("--gallery-title", type=str, default="初始立绘差分")
    parser.add_argument("--out-root", type=str, default="images")
    parser.add_argument("--report", type=str, default="bluearchive-api-kivowiki/download_report.json")

    parser.add_argument("--page-size", type=int, default=100)
    parser.add_argument("--limit-students", type=int, default=0, help="Only process first N students (0 = all).")
    parser.add_argument("--max-per-student", type=int, default=0, help="Max images per student (0 = all).")

    parser.add_argument("--detail-concurrency", type=int, default=15)
    parser.add_argument("--download-concurrency", type=int, default=25)
    parser.add_argument("--list-concurrency", type=int, default=5)

    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--max-retries", type=int, default=3)
    parser.add_argument("--backoff", type=float, default=0.6)
    parser.add_argument("--sleep", type=float, default=0.0, help="Optional delay per download request (seconds).")
    parser.add_argument("--progress-every", type=int, default=20)

    parser.add_argument("--dry-run", action="store_true", help="Only count/collect URLs; do not download.")
    parser.add_argument("--force", action="store_true", help="Re-download even if file exists (adds suffix).")

    args = parser.parse_args()
    return asyncio.run(run(args))


if __name__ == "__main__":
    raise SystemExit(main())
