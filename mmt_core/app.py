from __future__ import annotations

import json
import os
import subprocess
import threading
import time
from hashlib import sha1
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from mmt_core.mmt_text_to_json import convert_text
from mmt_core.typst_sandbox import TypstSandboxOptions, run_typst_sandboxed


REPO_ROOT = Path(__file__).resolve().parents[1]
SANDBOX_ROOT = REPO_ROOT / "typst_sandbox" / "mmt_render"
WEB_DIR = SANDBOX_ROOT / "web"
AVATAR_DIR = SANDBOX_ROOT / "avatar"
NAME_MAP_PATH = AVATAR_DIR / "name_to_id.json"
TYPST_TEMPLATE = SANDBOX_ROOT / "mmt_render.typ"
CACHE_DIR = SANDBOX_ROOT / ".cache"
TMP_DIR = SANDBOX_ROOT / ".tmp"
SAMPLE_TEXT_PATH = SANDBOX_ROOT / "mmt_format_test.txt"

MAX_TEXT_BYTES = 300_000
RATE_LIMIT_WINDOW_SECONDS = 60
RATE_LIMIT_MAX_REQUESTS = 30
PDF_CACHE_MAX_FILES = 200

_rate_lock = threading.Lock()
_rate_hits: Dict[str, list[float]] = {}


class ParseRequest(BaseModel):
    text: str = Field(default="")
    join: str = Field(default="newline", pattern="^(newline|space)$")
    name_map_path: Optional[str] = None
    avatar_dir: Optional[str] = None


app = FastAPI(title="MMT Viewer", version="0.1.0")

def _check_text_size(text: str) -> None:
    if len(text.encode("utf-8")) > MAX_TEXT_BYTES:
        raise HTTPException(status_code=413, detail=f"text too large (max {MAX_TEXT_BYTES} bytes)")


def _client_key(request: Request) -> str:
    host = request.client.host if request.client else "unknown"
    return host


def _rate_limit(request: Request) -> None:
    now = time.monotonic()
    key = _client_key(request)
    with _rate_lock:
        hits = _rate_hits.get(key, [])
        cutoff = now - RATE_LIMIT_WINDOW_SECONDS
        hits = [t for t in hits if t >= cutoff]
        if len(hits) >= RATE_LIMIT_MAX_REQUESTS:
            raise HTTPException(status_code=429, detail="rate limited")
        hits.append(now)
        _rate_hits[key] = hits


def _load_name_to_id() -> Dict[str, int]:
    if not NAME_MAP_PATH.exists():
        return {}
    data = json.loads(NAME_MAP_PATH.read_text(encoding="utf-8"))
    mapping = data.get("name_to_id") or {}
    return {str(k): int(v) for k, v in mapping.items()}


def _prune_pdf_cache(pdf_dir: Path) -> None:
    if not pdf_dir.exists():
        return
    files = [p for p in pdf_dir.glob("*.pdf") if p.is_file()]
    if len(files) <= PDF_CACHE_MAX_FILES:
        return
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    for p in files[PDF_CACHE_MAX_FILES:]:
        try:
            p.unlink()
        except OSError:
            pass


@app.get("/")
def index() -> FileResponse:
    path = WEB_DIR / "index.html"
    if not path.exists():
        raise HTTPException(status_code=500, detail="web/index.html not found")
    return FileResponse(path)


@app.get("/about")
def about() -> FileResponse:
    path = WEB_DIR / "about.html"
    if not path.exists():
        raise HTTPException(status_code=500, detail="web/about.html not found")
    return FileResponse(path)


@app.get("/api/health")
def health() -> Dict[str, Any]:
    return {"ok": True}


@app.get("/api/sample")
def sample() -> JSONResponse:
    if not SAMPLE_TEXT_PATH.exists():
        return JSONResponse({"text": ""})
    # Keep response JSON to avoid encoding issues in browsers.
    return JSONResponse({"text": SAMPLE_TEXT_PATH.read_text(encoding="utf-8")})


@app.post("/api/parse")
def parse(req: ParseRequest, request: Request) -> JSONResponse:
    _rate_limit(request)
    _check_text_size(req.text)
    if req.name_map_path is not None or req.avatar_dir is not None:
        raise HTTPException(status_code=400, detail="path overrides are disabled")
    try:
        name_to_id = _load_name_to_id()
        data, report = convert_text(
            req.text,
            name_to_id=name_to_id,
            avatar_dir=AVATAR_DIR,
            join_with_newline=req.join == "newline",
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return JSONResponse({"data": data, "report": report})


@app.post("/api/render_pdf")
def render_pdf(req: ParseRequest, request: Request) -> FileResponse:
    _rate_limit(request)
    _check_text_size(req.text)
    if req.name_map_path is not None or req.avatar_dir is not None:
        raise HTTPException(status_code=400, detail="path overrides are disabled")
    if not TYPST_TEMPLATE.exists():
        raise HTTPException(status_code=500, detail="mmt_render.typ not found")

    # Ensure directories exist inside project root (Typst file access is rooted).
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    pdf_dir = CACHE_DIR / "pdf"
    pdf_dir.mkdir(parents=True, exist_ok=True)
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    _prune_pdf_cache(pdf_dir)

    key = sha1((req.join + "\n" + req.text).encode("utf-8")).hexdigest()
    pdf_path = pdf_dir / f"{key}.pdf"
    json_path = TMP_DIR / f"{key}.json"

    if pdf_path.exists():
        return FileResponse(pdf_path, media_type="application/pdf", filename="mmt.pdf")

    try:
        name_to_id = _load_name_to_id()
        data, _report = convert_text(
            req.text,
            name_to_id=name_to_id,
            avatar_dir=AVATAR_DIR,
            join_with_newline=req.join == "newline",
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    json_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    try:
        cmd = [
            "typst",
            "compile",
            str(TYPST_TEMPLATE),
            str(pdf_path),
            "--root",
            str(ROOT),
            "--input",
            f"chat={json_path.relative_to(ROOT).as_posix()}",
        ]
        opts = TypstSandboxOptions(
            timeout_s=float(os.environ.get("MMT_TYPST_TIMEOUT_S", "30") or 30),
            max_mem_mb=int(float(os.environ.get("MMT_TYPST_MAXMEM_MB", "2048") or 2048)),
            rayon_threads=int(float(os.environ.get("MMT_TYPST_RAYON_THREADS", "4") or 4)),
            procgov_bin=os.environ.get("MMT_PROCGOV_BIN", "").strip() or None,
            enable_procgov=os.environ.get("MMT_TYPST_ENABLE_PROCGOV", "1").strip() not in {"0", "false", "False"},
        )
        result = run_typst_sandboxed(cmd, cwd=ROOT, options=opts)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=501, detail="typst CLI not found in PATH") from exc
    finally:
        try:
            json_path.unlink(missing_ok=True)
        except OSError:
            pass

    if result.returncode != 0 or not pdf_path.exists():
        detail = (result.stderr or result.stdout or "").strip() or "typst compile failed"
        raise HTTPException(status_code=500, detail=detail)

    return FileResponse(pdf_path, media_type="application/pdf", filename="mmt.pdf")


if WEB_DIR.exists():
    app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")
if AVATAR_DIR.exists():
    app.mount("/avatar", StaticFiles(directory=AVATAR_DIR), name="avatar")
