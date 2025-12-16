from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from typing import Any, Dict, List, Optional

from curl_cffi import requests as curl_requests

try:
    from loguru import logger  # type: ignore
except Exception:  # pragma: no cover
    import logging

    _logger = logging.getLogger("mmt_rerank")
    if not _logger.handlers:
        logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logger = _logger  # type: ignore


_DEFAULT_RERANK_URL = "https://api.siliconflow.cn/v1/rerank"
DEFAULT_MODEL = "Qwen/Qwen3-Reranker-8B"

# Relaxed instruction: semantic relevance first, mild preference for facial-expression cues.
DEFAULT_INSTRUCTION = (
    "请根据 query 与 documents 的语义相关性重新排序。"
    "优先匹配描述中的关键表情特征（如眼睛/嘴型、情绪倾向、是否有汗滴/泪等）。"
    "不需要过度联想剧情或设定。"
)


class RerankError(RuntimeError):
    pass


def _env_first(*names: str) -> str:
    for n in names:
        v = os.getenv(n, "").strip()
        if v:
            return v
    return ""


def _default_rerank_url() -> str:
    direct = _env_first("SILICONFLOW_RERANK_URL", "SILICON_RERANK_URL")
    if direct:
        return direct
    base = _env_first("SILICONFLOW_BASE_URL", "SILICON_API_BASE_URL", "SILICON_API_BASE")
    if base:
        return base.rstrip("/") + "/v1/rerank"
    return _DEFAULT_RERANK_URL


DEFAULT_RERANK_URL = _default_rerank_url()


def _sha1(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()


def _stable_json(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _cache_key(payload: Dict[str, Any]) -> str:
    slim = dict(payload)
    documents = slim.get("documents") or []
    slim["documents"] = _sha1(_stable_json(documents))
    return _sha1(_stable_json(slim))


@dataclass(frozen=True)
class SiliconFlowRerankConfig:
    api_key_env: str = "SILICON_API_KEY"
    url: str = DEFAULT_RERANK_URL
    model: str = DEFAULT_MODEL
    instruction: str = DEFAULT_INSTRUCTION
    timeout: float = 60.0
    cache_path: str = ".cache/siliconflow_rerank.sqlite3"
    user_agent: str = "mmt-rerank/0.1"


class SQLiteCache:
    def __init__(self, path: str):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = Lock()
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.execute(
            "CREATE TABLE IF NOT EXISTS rerank_cache ("
            "cache_key TEXT PRIMARY KEY,"
            "created_at INTEGER NOT NULL,"
            "response_json TEXT NOT NULL"
            ")"
        )
        self._conn.commit()

    def get(self, key: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            cur = self._conn.execute("SELECT response_json FROM rerank_cache WHERE cache_key = ?", (key,))
            row = cur.fetchone()
        if not row:
            return None
        try:
            return json.loads(row[0])
        except Exception:
            return None

    def set(self, key: str, response: Dict[str, Any]) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO rerank_cache(cache_key, created_at, response_json) VALUES (?, ?, ?)",
                (key, int(time.time()), _stable_json(response)),
            )
            self._conn.commit()


def _get_api_key(env_name: str) -> str:
    token = os.getenv(env_name, "").strip()
    if not token:
        # Backward-compatible alternate name
        token = os.getenv("SILICONFLOW_API_KEY", "").strip()
    if not token:
        raise RerankError(f"Missing API key env var: {env_name} (or SILICONFLOW_API_KEY)")
    return token


def _normalize_results(response: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Normalize SiliconFlow rerank response to:
      [{ "index": int, "score": float, "document"?: Any }, ...] (sorted desc)
    """
    results = response.get("results")
    if not isinstance(results, list):
        raise RerankError(f"Unexpected response schema: {response}")

    out: List[Dict[str, Any]] = []
    for item in results:
        if not isinstance(item, dict):
            continue
        idx = item.get("index")
        score = item.get("relevance_score", item.get("score", item.get("relevance", 0.0)))
        if not isinstance(idx, int):
            continue
        row: Dict[str, Any] = {"index": idx, "score": float(score or 0.0)}
        if "document" in item:
            row["document"] = item.get("document")
        out.append(row)
    out.sort(key=lambda x: x["score"], reverse=True)
    return out


class SiliconFlowReranker:
    def __init__(self, config: Optional[SiliconFlowRerankConfig] = None):
        self.config = config or SiliconFlowRerankConfig()
        self._cache = SQLiteCache(self.config.cache_path)
        self._session: curl_requests.AsyncSession | None = None

    async def __aenter__(self) -> "SiliconFlowReranker":
        if self._session is None:
            self._session = curl_requests.AsyncSession()
            self._session.headers.update({"User-Agent": self.config.user_agent})
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        if self._session is not None:
            await self._session.close()
            self._session = None

    async def rerank(
        self,
        *,
        query: str,
        documents: List[str],
        top_n: Optional[int] = None,
        return_documents: bool = True,
        max_chunks_per_doc: Optional[int] = None,
        overlap_tokens: Optional[int] = None,
        use_cache: bool = True,
    ) -> List[Dict[str, Any]]:
        if self._session is None:
            raise RuntimeError("Use 'async with SiliconFlowReranker()' to initialize the session.")

        payload: Dict[str, Any] = {
            "model": self.config.model,
            "query": query,
            "documents": documents,
            "instruction": self.config.instruction,
            "return_documents": bool(return_documents),
        }
        if top_n is not None:
            payload["top_n"] = int(top_n)
        if max_chunks_per_doc is not None:
            payload["max_chunks_per_doc"] = int(max_chunks_per_doc)
        if overlap_tokens is not None:
            payload["overlap_tokens"] = int(overlap_tokens)

        key = _cache_key(payload)
        if use_cache:
            cached = self._cache.get(key)
            if cached is not None:
                logger.info(f"rerank cache hit | model={self.config.model} docs={len(documents)} top_n={top_n}")
                return _normalize_results(cached)

        token = _get_api_key(self.config.api_key_env)
        started = time.time()
        logger.info(f"rerank request | model={self.config.model} docs={len(documents)} top_n={top_n}")
        try:
            resp = await self._session.post(
                self.config.url,
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                data=json.dumps(payload, ensure_ascii=False),
                timeout=self.config.timeout,
            )
        except Exception as exc:
            raise RerankError(f"rerank request failed: {exc}") from exc

        elapsed_ms = int((time.time() - started) * 1000)
        if resp.status_code >= 400:
            body = (getattr(resp, "text", "") or "")[:2000]
            raise RerankError(f"rerank HTTP {resp.status_code} ({elapsed_ms}ms): {body}")

        try:
            data = resp.json()
        except Exception as exc:
            body = (getattr(resp, "text", "") or "")[:2000]
            raise RerankError(f"rerank invalid JSON ({elapsed_ms}ms): {body}") from exc

        if not isinstance(data, dict):
            raise RerankError(f"Unexpected response type: {type(data)}")

        self._cache.set(key, data)
        logger.info(f"rerank ok | elapsed_ms={elapsed_ms} cached=1")
        return _normalize_results(data)
