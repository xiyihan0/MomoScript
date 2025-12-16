from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from openai import OpenAI


class LlmRequestError(RuntimeError):
    pass


def load_dotenv(path: str = ".env", *, override: bool = False) -> bool:
    """
    Minimal .env loader (no third-party dependency).

    Supports lines like:
      KEY=value
      KEY="value"
      KEY='value'
    Ignores empty lines and comments starting with '#'.
    """
    if not os.path.exists(path):
        return False

    def strip_quotes(val: str) -> str:
        val = val.strip()
        if len(val) >= 2 and ((val[0] == val[-1] == '"') or (val[0] == val[-1] == "'")):
            return val[1:-1]
        return val

    with open(path, "r", encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            key, val = line.split("=", 1)
            key = key.strip()
            if not key:
                continue
            # Remove inline comments: FOO=bar # comment
            if " #" in val:
                val = val.split(" #", 1)[0]
            val = strip_quotes(val)
            if override:
                os.environ[key] = val
            else:
                os.environ.setdefault(key, val)
    return True


@dataclass(frozen=True)
class OpenAIConfig:
    api_key: str
    model: str
    base_url: str
    timeout: float = 120.0
    max_tokens: int = 2048
    temperature: float = 0.2


class OpenAIChat:
    def __init__(self, config: OpenAIConfig):
        self.config = config
        self._client = OpenAI(
            api_key=self.config.api_key,
            base_url=self.config.base_url,
            timeout=self.config.timeout,
        )

    def chat(self, messages: List[Dict[str, Any]]) -> str:
        try:
            resp = self._client.chat.completions.create(
                model=self.config.model,
                messages=messages,  # type: ignore[arg-type]
                # temperature=self.config.temperature,
                # max_tokens=self.config.max_tokens,
            )
        except Exception as exc:
            raise LlmRequestError(f"LLM request failed: {exc}") from exc

        try:
            content = resp.choices[0].message.content
        except Exception as exc:
            raise LlmRequestError(f"LLM unexpected response schema: {resp}") from exc
        return content or ""


def load_openai_config(
    *,
    model: str,
    base_url: str = "https://gcli.ggchan.dev/v1",
    api_key_env: str = "GCLI_API_KEY",
    timeout: float = 120.0,
    max_tokens: int = 2048,
    temperature: float = 0.2,
) -> OpenAIConfig:
    api_key = os.getenv(api_key_env, "").strip()
    if not api_key:
        raise LlmRequestError(f"Missing API key env var: {api_key_env}")

    return OpenAIConfig(
        api_key=api_key,
        model=model,
        base_url=base_url.rstrip("/"),
        timeout=timeout,
        max_tokens=max_tokens,
        temperature=temperature,
    )
