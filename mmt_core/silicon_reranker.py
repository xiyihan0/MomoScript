from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from curl_cffi import requests as curl_requests


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
    return "https://api.siliconflow.cn/v1/rerank"


@dataclass(frozen=True)
class RerankResult:
    index: int
    relevance_score: float
    document: Optional[str] = None


@dataclass(frozen=True)
class SiliconFlowRerankerConfig:
    api_key_env: str = "SILICON_API_KEY"
    api_url: str = _default_rerank_url()
    model: str = "Qwen/Qwen3-Reranker-8B"
    timeout: float = 60.0
    instruction: str = "Please rerank the documents based on the query."


class SiliconFlowReranker:
    def __init__(self, config: SiliconFlowRerankerConfig | None = None) -> None:
        self.config = config or SiliconFlowRerankerConfig()
        api_key = os.getenv(self.config.api_key_env, "").strip()
        if not api_key:
            # Also accept a common alternate name.
            api_key = os.getenv("SILICON_API_KEY", "").strip()
        if not api_key:
            raise RerankError(
                f"Missing SiliconFlow API key env var: {self.config.api_key_env} (or SILICON_API_KEY)"
            )
        self._api_key = api_key

    async def rerank(
        self,
        *,
        query: str,
        documents: List[str],
        top_n: int = 1,
        return_documents: bool = True,
        max_chunks_per_doc: Optional[int] = None,
        overlap_tokens: Optional[int] = None,
    ) -> List[RerankResult]:
        payload: Dict[str, Any] = {
            "model": self.config.model,
            "query": query,
            "documents": documents,
            "instruction": self.config.instruction,
            "top_n": top_n,
            "return_documents": return_documents,
        }
        if max_chunks_per_doc is not None:
            payload["max_chunks_per_doc"] = max_chunks_per_doc
        if overlap_tokens is not None:
            payload["overlap_tokens"] = overlap_tokens

        headers = {"Authorization": f"Bearer {self._api_key}", "Content-Type": "application/json"}

        session = curl_requests.AsyncSession()
        try:
            resp = await session.post(
                self.config.api_url,
                headers=headers,
                data=json.dumps(payload, ensure_ascii=False),
                timeout=self.config.timeout,
            )
        except Exception as exc:
            raise RerankError(f"Rerank request failed: {exc}") from exc
        finally:
            await session.close()

        if resp.status_code >= 400:
            body = (getattr(resp, "text", "") or "")[:2000]
            raise RerankError(f"Rerank HTTP {resp.status_code}: {body}")

        try:
            data = resp.json()
        except Exception as exc:
            body = (getattr(resp, "text", "") or "")[:2000]
            raise RerankError(f"Rerank invalid JSON response: {body}") from exc

        results = data.get("results")
        if not isinstance(results, list):
            raise RerankError(f"Unexpected rerank response schema: {data}")

        parsed: List[RerankResult] = []
        for item in results:
            if not isinstance(item, dict):
                continue
            idx = item.get("index")
            score = item.get("relevance_score")
            doc = item.get("document") if return_documents else None
            if isinstance(idx, int) and isinstance(score, (int, float)):
                parsed.append(RerankResult(index=idx, relevance_score=float(score), document=doc))
        if not parsed:
            raise RerankError(f"Empty rerank results: {data}")
        return parsed
