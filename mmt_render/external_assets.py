from __future__ import annotations

import hashlib
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Optional
from urllib.parse import urlparse

from curl_cffi import requests as curl_requests

try:
    from loguru import logger  # type: ignore
except Exception:  # pragma: no cover
    import logging

    _logger = logging.getLogger("mmt_assets")
    if not _logger.handlers:
        logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logger = _logger  # type: ignore


class ExternalAssetError(RuntimeError):
    pass


def is_url_like(s: str) -> bool:
    s = (s or "").strip()
    if not s:
        return False
    if s.startswith("data:image/"):
        return True
    if s.startswith("://"):
        # Shorthand used by some users; treat as https://
        return True
    if s.startswith("//"):
        return True
    try:
        u = urlparse(s)
        if u.scheme in {"http", "https"} and u.netloc:
            return True
    except Exception:
        return False
    return False


def normalize_url(s: str) -> str:
    s = (s or "").strip()
    if s.startswith("://"):
        return "https" + s
    if s.startswith("//"):
        return "https:" + s
    return s


def _sha1(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()


_CT_TO_EXT = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/bmp": "bmp",
    "image/svg+xml": "svg",
}


def _guess_ext(url: str, content_type: str) -> str:
    # Prefer url suffix if it looks like an image extension.
    try:
        path = urlparse(url).path
        m = re.search(r"\.([A-Za-z0-9]{2,5})$", path)
        if m:
            ext = m.group(1).lower()
            if ext in {"png", "jpg", "jpeg", "webp", "gif", "bmp", "svg"}:
                return "jpg" if ext == "jpeg" else ext
    except Exception:
        pass
    ct = (content_type or "").split(";", 1)[0].strip().lower()
    return _CT_TO_EXT.get(ct, "bin")


@dataclass(frozen=True)
class ExternalAssetConfig:
    cache_dir: Path
    timeout_s: float = 20.0
    max_bytes: int = 10 * 1024 * 1024
    user_agent: str = "mmt-assets/0.1"


class ExternalAssetDownloader:
    def __init__(self, config: ExternalAssetConfig):
        self.config = config
        self.config.cache_dir.mkdir(parents=True, exist_ok=True)
        self._session: curl_requests.AsyncSession | None = None
        self._locks: Dict[str, object] = {}

    async def __aenter__(self) -> "ExternalAssetDownloader":
        if self._session is None:
            self._session = curl_requests.AsyncSession()
            self._session.headers.update({"User-Agent": self.config.user_agent})
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        if self._session is not None:
            await self._session.close()
            self._session = None

    def _path_for(self, url: str, *, ext: str) -> Path:
        h = _sha1(url)
        return self.config.cache_dir / f"{h}.{ext}"

    async def fetch(self, url: str, *, force: bool = False) -> Path:
        if self._session is None:
            raise RuntimeError("Use 'async with ExternalAssetDownloader(...)' to initialize the session.")
        url = normalize_url(url)
        if url.startswith("data:image/"):
            # Keep data URLs as-is (Typst side can handle them via parse_custom_img).
            raise ExternalAssetError("data url should not be fetched")
        if not is_url_like(url):
            raise ExternalAssetError(f"not a url: {url}")

        # Lock by url-hash to avoid duplicate downloads under concurrency.
        key = _sha1(url)
        lock = self._locks.get(key)
        if lock is None:
            import asyncio

            lock = asyncio.Lock()
            self._locks[key] = lock

        import asyncio

        async with lock:  # type: ignore[arg-type]
            # If already downloaded, reuse the existing file (any extension).
            existing = list(self.config.cache_dir.glob(f"{key}.*"))
            if existing and not force:
                return sorted(existing, key=lambda p: p.name)[0]

            started = time.time()
            logger.info(f"asset fetch | url={url}")
            try:
                req_headers: Optional[dict] = None
                try:
                    host = (urlparse(url).netloc or "").lower()
                    # Pixiv's image CDN requires a Referer to be set, otherwise returns 403.
                    if host.endswith("pximg.net"):
                        req_headers = {"Referer": "https://www.pixiv.net/"}
                except Exception:
                    req_headers = None

                resp = await self._session.get(url, timeout=self.config.timeout_s, headers=req_headers)
            except Exception as exc:
                raise ExternalAssetError(f"download failed: {exc}") from exc

            elapsed_ms = int((time.time() - started) * 1000)
            if resp.status_code >= 400:
                body = (getattr(resp, "text", "") or "")[:300]
                raise ExternalAssetError(f"download HTTP {resp.status_code} ({elapsed_ms}ms): {body}")

            ct = (resp.headers.get("content-type") or "").strip().lower() if hasattr(resp, "headers") else ""
            if ct and not ct.startswith("image/"):
                raise ExternalAssetError(f"unexpected content-type: {ct}")

            data = resp.content or b""
            if int(self.config.max_bytes) > 0 and len(data) > int(self.config.max_bytes):
                raise ExternalAssetError(f"asset too large: {len(data)} bytes (max {self.config.max_bytes})")

            ext = _guess_ext(url, ct)
            out_path = self._path_for(url, ext=ext)
            tmp = out_path.with_suffix(out_path.suffix + ".tmp")
            tmp.write_bytes(data)
            tmp.replace(out_path)

            # Cleanup other variants after success (keep one file per URL).
            for p in self.config.cache_dir.glob(f"{key}.*"):
                if p.name != out_path.name:
                    try:
                        p.unlink(missing_ok=True)
                    except Exception:
                        pass

            logger.info(f"asset ok | elapsed_ms={elapsed_ms} path={out_path.name}")
            return out_path
