from __future__ import annotations

import hashlib
import re
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from typing import Iterable, Optional
from urllib.parse import urlparse

from curl_cffi import requests as curl_requests


class AssetError(RuntimeError):
    pass


_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_CT_TO_EXT = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/bmp": "bmp",
    "image/svg+xml": "svg",
}


def validate_asset_name(name: str) -> str:
    n = (name or "").strip()
    if not _NAME_RE.match(n):
        raise AssetError("invalid name: only [A-Za-z0-9_-], length 1-64")
    return n


def _sha1_bytes(data: bytes) -> str:
    h = hashlib.sha1()
    h.update(data)
    return h.hexdigest()


def _guess_ext(content_type: str) -> str:
    ct = (content_type or "").split(";", 1)[0].strip().lower()
    return _CT_TO_EXT.get(ct, "bin")


def _is_http_url(url: str) -> bool:
    try:
        u = urlparse(url)
        return u.scheme in {"http", "https"} and bool(u.netloc)
    except Exception:
        return False


def _safe_basename(name: str) -> str:
    s = (name or "").strip()
    if not s or "/" in s or "\\" in s or ".." in s:
        raise AssetError("unsafe filename")
    return s


@dataclass(frozen=True)
class AssetRecord:
    scope: str  # "p" or "g"
    scope_id: str
    name: str
    filename: str  # "<sha1>.<ext>" stored under asset_dir


class AssetDB:
    def __init__(self, db_path: Path):
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = Lock()
        self._conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self._conn.execute(
            "CREATE TABLE IF NOT EXISTS asset_blob ("
            "blob_id TEXT PRIMARY KEY,"
            "ext TEXT NOT NULL,"
            "size INTEGER NOT NULL,"
            "created_at INTEGER NOT NULL"
            ")"
        )
        self._conn.execute(
            "CREATE TABLE IF NOT EXISTS asset_name ("
            "scope TEXT NOT NULL,"
            "scope_id TEXT NOT NULL,"
            "name TEXT NOT NULL,"
            "blob_id TEXT NOT NULL,"
            "uploader_id TEXT NOT NULL,"
            "created_at INTEGER NOT NULL,"
            "PRIMARY KEY(scope, scope_id, name)"
            ")"
        )
        self._conn.execute("CREATE INDEX IF NOT EXISTS idx_asset_name_blob ON asset_name(blob_id)")
        self._conn.commit()

    def upsert(
        self,
        *,
        scope: str,
        scope_id: str,
        name: str,
        blob_id: str,
        ext: str,
        size: int,
        uploader_id: str,
        replace: bool,
    ) -> None:
        if scope not in {"p", "g"}:
            raise AssetError("invalid scope")
        if not scope_id:
            raise AssetError("missing scope_id")
        validate_asset_name(name)
        ts = int(time.time())
        with self._lock:
            self._conn.execute(
                "INSERT OR IGNORE INTO asset_blob(blob_id, ext, size, created_at) VALUES (?, ?, ?, ?)",
                (blob_id, ext, int(size), ts),
            )
            if replace:
                self._conn.execute(
                    "INSERT OR REPLACE INTO asset_name(scope, scope_id, name, blob_id, uploader_id, created_at) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (scope, scope_id, name, blob_id, uploader_id, ts),
                )
            else:
                cur = self._conn.execute(
                    "SELECT 1 FROM asset_name WHERE scope = ? AND scope_id = ? AND name = ?",
                    (scope, scope_id, name),
                )
                if cur.fetchone():
                    raise AssetError(f"name already exists: {scope}.{name}")
                self._conn.execute(
                    "INSERT INTO asset_name(scope, scope_id, name, blob_id, uploader_id, created_at) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (scope, scope_id, name, blob_id, uploader_id, ts),
                )
            self._conn.commit()

    def list_names(self, *, scope: str, scope_id: str) -> list[AssetRecord]:
        if scope not in {"p", "g"}:
            raise AssetError("invalid scope")
        with self._lock:
            cur = self._conn.execute(
                "SELECT name, blob_id, (SELECT ext FROM asset_blob WHERE blob_id = asset_name.blob_id) "
                "FROM asset_name WHERE scope = ? AND scope_id = ? ORDER BY name",
                (scope, scope_id),
            )
            rows = cur.fetchall()
        out: list[AssetRecord] = []
        for name, blob_id, ext in rows:
            if not ext:
                continue
            out.append(AssetRecord(scope=scope, scope_id=scope_id, name=str(name), filename=f"{blob_id}.{ext}"))
        return out

    def get_filename(self, *, scope: str, scope_id: str, name: str) -> Optional[str]:
        validate_asset_name(name)
        if scope not in {"p", "g"}:
            raise AssetError("invalid scope")
        with self._lock:
            cur = self._conn.execute(
                "SELECT blob_id, (SELECT ext FROM asset_blob WHERE blob_id = asset_name.blob_id) "
                "FROM asset_name WHERE scope = ? AND scope_id = ? AND name = ?",
                (scope, scope_id, name),
            )
            row = cur.fetchone()
        if not row:
            return None
        blob_id, ext = row
        if not ext:
            return None
        return f"{blob_id}.{ext}"

    def delete_name(self, *, scope: str, scope_id: str, name: str) -> Optional[str]:
        validate_asset_name(name)
        if scope not in {"p", "g"}:
            raise AssetError("invalid scope")
        with self._lock:
            cur = self._conn.execute(
                "SELECT blob_id FROM asset_name WHERE scope = ? AND scope_id = ? AND name = ?",
                (scope, scope_id, name),
            )
            row = cur.fetchone()
            if not row:
                return None
            (blob_id,) = row
            self._conn.execute(
                "DELETE FROM asset_name WHERE scope = ? AND scope_id = ? AND name = ?",
                (scope, scope_id, name),
            )
            # If blob is unreferenced, delete it too.
            cur2 = self._conn.execute("SELECT 1 FROM asset_name WHERE blob_id = ? LIMIT 1", (blob_id,))
            still_ref = cur2.fetchone() is not None
            if not still_ref:
                self._conn.execute("DELETE FROM asset_blob WHERE blob_id = ?", (blob_id,))
            self._conn.commit()
        return str(blob_id)

    def blob_is_referenced(self, blob_id: str) -> bool:
        with self._lock:
            cur = self._conn.execute("SELECT 1 FROM asset_name WHERE blob_id = ? LIMIT 1", (blob_id,))
            return cur.fetchone() is not None


class AssetDownloader:
    def __init__(self, *, timeout_s: float, max_bytes: int):
        self.timeout_s = float(timeout_s)
        self.max_bytes = int(max_bytes)
        self._session: curl_requests.AsyncSession | None = None

    async def __aenter__(self) -> "AssetDownloader":
        if self._session is None:
            self._session = curl_requests.AsyncSession()
            self._session.headers.update({"User-Agent": "mmt-asset/0.1"})
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        if self._session is not None:
            await self._session.close()
            self._session = None

    async def download(self, url: str) -> tuple[bytes, str]:
        if self._session is None:
            raise RuntimeError("use as async context manager")
        u = (url or "").strip()
        if not _is_http_url(u):
            raise AssetError("only http/https url is allowed")
        resp = await self._session.get(u, timeout=self.timeout_s)
        if resp.status_code >= 400:
            raise AssetError(f"download HTTP {resp.status_code}")
        ct = ""
        try:
            ct = (resp.headers.get("content-type") or "").strip()
        except Exception:
            ct = ""
        if ct and not ct.lower().startswith("image/"):
            raise AssetError(f"unexpected content-type: {ct}")
        data = resp.content or b""
        if self.max_bytes > 0 and len(data) > self.max_bytes:
            raise AssetError(f"asset too large: {len(data)} bytes (max {self.max_bytes})")
        return data, ct


def write_blob(asset_dir: Path, *, data: bytes, ext: str) -> tuple[str, str, Path]:
    asset_dir.mkdir(parents=True, exist_ok=True)
    blob_id = _sha1_bytes(data)
    ext2 = (ext or "bin").lower().strip(".")
    filename = f"{blob_id}.{ext2}"
    out_path = asset_dir / filename
    if not out_path.exists():
        tmp = out_path.with_suffix(out_path.suffix + ".tmp")
        tmp.write_bytes(data)
        tmp.replace(out_path)
    return blob_id, filename, out_path


def make_cache_ref(filename: str) -> str:
    fn = _safe_basename(filename)
    return f"cache:{fn}"


def parse_cache_ref(ref: str) -> Optional[str]:
    s = (ref or "").strip()
    if not s.lower().startswith("cache:"):
        return None
    fn = s.split(":", 1)[1].strip()
    return _safe_basename(fn)


def merge_asset_meta(
    *,
    meta: dict,
    private_assets: Iterable[AssetRecord],
    group_assets: Iterable[AssetRecord],
    prefer_private: bool = True,
) -> dict:
    """
    Inject asset mappings into meta:
      - asset.p.<name> / asset.g.<name> -> cache:<filename>
      - asset.<name> -> cache:<filename> chosen by prefer_private (p > g)
    Does not override keys already present in meta.
    """
    out = dict(meta or {})
    p_map: dict[str, str] = {a.name: a.filename for a in private_assets}
    g_map: dict[str, str] = {a.name: a.filename for a in group_assets}

    for n, fn in p_map.items():
        k = f"asset.p.{n}"
        if k not in out:
            out[k] = make_cache_ref(fn)
    for n, fn in g_map.items():
        k = f"asset.g.{n}"
        if k not in out:
            out[k] = make_cache_ref(fn)

    # Default (un-namespaced) mapping.
    for n in sorted(set(p_map) | set(g_map)):
        k = f"asset.{n}"
        if k in out:
            continue
        if prefer_private and n in p_map:
            out[k] = make_cache_ref(p_map[n])
        elif n in g_map:
            out[k] = make_cache_ref(g_map[n])
        elif n in p_map:
            out[k] = make_cache_ref(p_map[n])

    return out

