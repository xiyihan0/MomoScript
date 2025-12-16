from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from curl_cffi import requests as curl_requests

try:
    from loguru import logger  # type: ignore
except Exception:  # pragma: no cover
    import logging

    _logger = logging.getLogger("mmt_embed")
    if not _logger.handlers:
        logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logger = _logger  # type: ignore


DEFAULT_EMBED_URL = "https://api.siliconflow.cn/v1/embeddings"
DEFAULT_MODEL = "Qwen/Qwen3-Embedding-8B"


class EmbedError(RuntimeError):
    pass


def _sha1(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()


def _get_api_key(env_name: str) -> str:
    token = os.getenv(env_name, "").strip()
    if not token:
        # Backward-compatible alternate name
        token = os.getenv("SILICONFLOW_API_KEY", "").strip()
    if not token:
        raise EmbedError(f"Missing API key env var: {env_name} (or SILICONFLOW_API_KEY)")
    return token


def _stable_json(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _cache_key(model: str, text: str) -> str:
    return _sha1(model + "\n" + text)


class SQLiteEmbeddingCache:
    def __init__(self, path: str):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = Lock()
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.execute(
            "CREATE TABLE IF NOT EXISTS embed_cache ("
            "cache_key TEXT PRIMARY KEY,"
            "created_at INTEGER NOT NULL,"
            "dims INTEGER NOT NULL,"
            "data BLOB NOT NULL"
            ")"
        )
        self._conn.commit()

    def get_many(self, keys: Sequence[str]) -> Dict[str, Tuple[int, bytes]]:
        if not keys:
            return {}
        out: Dict[str, Tuple[int, bytes]] = {}
        with self._lock:
            cur = self._conn.execute(
                f"SELECT cache_key, dims, data FROM embed_cache WHERE cache_key IN ({','.join(['?']*len(keys))})",
                tuple(keys),
            )
            rows = cur.fetchall()
        for k, dims, blob in rows:
            try:
                out[str(k)] = (int(dims), bytes(blob))
            except Exception:
                continue
        return out

    def set_many(self, rows: Iterable[Tuple[str, int, bytes]]) -> None:
        with self._lock:
            self._conn.executemany(
                "INSERT OR REPLACE INTO embed_cache(cache_key, created_at, dims, data) VALUES (?, ?, ?, ?)",
                [(k, int(time.time()), int(dims), sqlite3.Binary(blob)) for k, dims, blob in rows],
            )
            self._conn.commit()


@dataclass(frozen=True)
class SiliconFlowEmbedConfig:
    api_key_env: str = "SILICON_API_KEY"
    url: str = DEFAULT_EMBED_URL
    model: str = DEFAULT_MODEL
    timeout: float = 60.0
    cache_path: str = ".cache/siliconflow_embed.sqlite3"
    user_agent: str = "mmt-embed/0.1"
    batch_size: int = 64


def _normalize_embed_response(resp: Dict[str, Any]) -> List[List[float]]:
    data = resp.get("data")
    if not isinstance(data, list):
        raise EmbedError(f"Unexpected response schema: {resp}")
    items: List[Tuple[int, List[float]]] = []
    for it in data:
        if not isinstance(it, dict):
            continue
        idx = it.get("index")
        emb = it.get("embedding")
        if not isinstance(idx, int) or not isinstance(emb, list):
            continue
        vec: List[float] = []
        for x in emb:
            try:
                vec.append(float(x))
            except Exception:
                vec.append(0.0)
        items.append((idx, vec))
    items.sort(key=lambda x: x[0])
    return [v for _, v in items]


class SiliconFlowEmbedder:
    def __init__(self, config: Optional[SiliconFlowEmbedConfig] = None):
        self.config = config or SiliconFlowEmbedConfig()
        self._cache = SQLiteEmbeddingCache(self.config.cache_path)
        self._session: curl_requests.AsyncSession | None = None

    async def __aenter__(self) -> "SiliconFlowEmbedder":
        if self._session is None:
            self._session = curl_requests.AsyncSession()
            self._session.headers.update({"User-Agent": self.config.user_agent})
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        if self._session is not None:
            await self._session.close()
            self._session = None

    async def embed_texts(
        self,
        texts: Sequence[str],
        *,
        use_cache: bool = True,
    ) -> List[List[float]]:
        if self._session is None:
            raise RuntimeError("Use 'async with SiliconFlowEmbedder()' to initialize the session.")
        if not texts:
            return []

        model = self.config.model
        keys = [_cache_key(model, t) for t in texts]
        cached: Dict[str, Tuple[int, bytes]] = self._cache.get_many(keys) if use_cache else {}

        # Build result placeholders; fill from cache where possible.
        out: List[Optional[List[float]]] = [None] * len(texts)
        missing: List[Tuple[int, str]] = []
        for i, k in enumerate(keys):
            hit = cached.get(k)
            if hit is None:
                missing.append((i, texts[i]))
                continue
            dims, blob = hit
            # decode float32 bytes to python floats (avoid numpy dependency here)
            try:
                import struct

                cnt = len(blob) // 4
                if dims > 0 and cnt >= dims:
                    cnt = dims
                vec = list(struct.unpack(f"<{cnt}f", blob[: cnt * 4]))
                out[i] = [float(x) for x in vec]
            except Exception:
                missing.append((i, texts[i]))

        if not missing:
            return [x or [] for x in out]

        token = _get_api_key(self.config.api_key_env)

        def _chunks(seq: Sequence[Tuple[int, str]], n: int) -> Iterable[List[Tuple[int, str]]]:
            for j in range(0, len(seq), max(1, n)):
                yield list(seq[j : j + max(1, n)])

        new_cache_rows: List[Tuple[str, int, bytes]] = []
        for chunk in _chunks(missing, self.config.batch_size):
            started = time.time()
            inputs = [t for _, t in chunk]
            payload: Dict[str, Any] = {"model": model, "input": inputs}
            logger.info(f"embed request | model={model} batch={len(inputs)}")
            try:
                resp = await self._session.post(
                    self.config.url,
                    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                    data=_stable_json(payload),
                    timeout=self.config.timeout,
                )
            except Exception as exc:
                raise EmbedError(f"embed request failed: {exc}") from exc

            elapsed_ms = int((time.time() - started) * 1000)
            if resp.status_code >= 400:
                body = (getattr(resp, "text", "") or "")[:2000]
                raise EmbedError(f"embed HTTP {resp.status_code} ({elapsed_ms}ms): {body}")

            try:
                data = resp.json()
            except Exception as exc:
                body = (getattr(resp, "text", "") or "")[:2000]
                raise EmbedError(f"embed invalid JSON ({elapsed_ms}ms): {body}") from exc
            if not isinstance(data, dict):
                raise EmbedError(f"Unexpected response type: {type(data)}")

            vectors = _normalize_embed_response(data)
            if len(vectors) != len(chunk):
                raise EmbedError(f"embed: expected {len(chunk)} vectors, got {len(vectors)}")

            # Cache as float32 bytes
            try:
                import struct

                for (orig_idx, _), vec in zip(chunk, vectors):
                    out[orig_idx] = vec
                    dims = len(vec)
                    blob = struct.pack(f"<{dims}f", *[float(x) for x in vec])
                    new_cache_rows.append((keys[orig_idx], dims, blob))
            except Exception:
                # If packing fails, still return vectors but skip caching.
                for (orig_idx, _), vec in zip(chunk, vectors):
                    out[orig_idx] = vec

            logger.info(f"embed ok | elapsed_ms={elapsed_ms} cached={1 if new_cache_rows else 0}")

        if use_cache and new_cache_rows:
            self._cache.set_many(new_cache_rows)

        return [x or [] for x in out]
