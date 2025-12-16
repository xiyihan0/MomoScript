from __future__ import annotations

import argparse
import asyncio
import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Callable, Awaitable, TypeVar

import kivowiki_api


DEFAULT_BASE_URL = "https://api.kivo.wiki/api/v1"

T = TypeVar("T")


@dataclass(frozen=True)
class Failure:
    student_id: int
    status_code: int
    error: str


def _now_ms() -> int:
    return int(time.time() * 1000)


async def _sleep(seconds: float) -> None:
    if seconds and seconds > 0:
        await asyncio.sleep(seconds)


async def _call_with_retries(
    fn: Callable[[], Awaitable[T]],
    *,
    max_retries: int,
    backoff: float,
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
    first = await _call_with_retries(
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
            return await _call_with_retries(
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


async def validate_student_detail(
    client: kivowiki_api.KivoWikiClient,
    *,
    student_id: int,
    max_retries: int,
    backoff: float,
) -> Tuple[bool, int, str]:
    try:
        payload = await _call_with_retries(
            lambda: client.get_student_raw(student_id),
            max_retries=max_retries,
            backoff=backoff,
        )
        data = (payload.get("data") or {}) if isinstance(payload, dict) else {}
        got_id = int(data.get("id") or 0)
        if got_id not in (0, student_id):
            return False, 0, f"ID mismatch: got {got_id} expected {student_id}"
        return True, 200, ""
    except Exception as exc:
        return False, 0, str(exc)


async def run(args: argparse.Namespace) -> int:
    base_url = args.base_url.rstrip("/")
    limit = args.limit if args.limit and args.limit > 0 else None

    started_ms = _now_ms()
    async with kivowiki_api.KivoWikiClient(
        base_url=base_url,
        timeout=args.timeout,
        user_agent="kivowiki-api-wrapper/validate",
    ) as client:
        ids = await fetch_all_student_ids(
            client,
            page_size=args.page_size,
            list_concurrency=args.list_concurrency,
            limit=limit,
            max_retries=args.max_retries,
            backoff=args.backoff,
        )
        total = len(ids)
        print(f"fetched {total} student ids")

        sem = asyncio.Semaphore(max(1, args.concurrency))
        failures: List[Failure] = []
        ok_count = 0

        async def check_one(sid: int) -> None:
            nonlocal ok_count
            async with sem:
                ok, status, err = await validate_student_detail(
                    client,
                    student_id=sid,
                    max_retries=args.max_retries,
                    backoff=args.backoff,
                )
            if ok:
                ok_count += 1
            else:
                failures.append(Failure(student_id=sid, status_code=status, error=err))
            if args.sleep > 0:
                await _sleep(args.sleep)

        tasks = [asyncio.create_task(check_one(sid)) for sid in ids]
        completed = 0
        for coro in asyncio.as_completed(tasks):
            await coro
            completed += 1
            if completed % args.progress_every == 0 or completed == total:
                print(f"{completed}/{total} checked, ok={ok_count}, failures={len(failures)}")

        report = {
            "base_url": base_url,
            "checked": total,
            "ok_count": ok_count,
            "failure_count": len(failures),
            "failures": [f.__dict__ for f in sorted(failures, key=lambda x: x.student_id)],
            "concurrency": args.concurrency,
            "page_size": args.page_size,
            "timeout": args.timeout,
            "max_retries": args.max_retries,
            "backoff": args.backoff,
            "sleep": args.sleep,
            "ts_ms": int(time.time() * 1000),
            "duration_ms": _now_ms() - started_ms,
            "ok": len(failures) == 0,
        }
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"report written: {out_path}")
        return 0 if report["ok"] else 2


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate all /data/students/{id} endpoints asynchronously.")
    parser.add_argument("--base-url", type=str, default=DEFAULT_BASE_URL)
    parser.add_argument("--page-size", type=int, default=100)
    parser.add_argument("--limit", type=int, default=0, help="Only validate first N ids (0 = all).")
    parser.add_argument("--concurrency", type=int, default=25)
    parser.add_argument("--list-concurrency", type=int, default=5)
    parser.add_argument("--timeout", type=float, default=20.0)
    parser.add_argument("--max-retries", type=int, default=3)
    parser.add_argument("--backoff", type=float, default=0.6)
    parser.add_argument("--sleep", type=float, default=0.0, help="Optional delay per request (seconds).")
    parser.add_argument("--progress-every", type=int, default=50)
    parser.add_argument("--out", type=str, default="bluearchive-api-kivowiki/validate_report.json")
    args = parser.parse_args()
    return asyncio.run(run(args))


if __name__ == "__main__":
    raise SystemExit(main())
