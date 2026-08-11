from __future__ import annotations

import os
from typing import Any

import httpx

from .base import extract_json


class OllamaProvider:
    """Local/open-weight models via Ollama (qwen3, deepseek-r1, llama4, gemma3,
    mistral-small, …). The default for most AI Resources. If Ollama or the model
    is unreachable the reason node falls back to the deterministic stub."""

    name = "ollama"

    def __init__(self, model: str):
        self.model = model
        self.base = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434").rstrip("/")

    def generate_json(
        self,
        system: str,
        user: str,
        temperature: float,
        images: list[str] | None = None,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "stream": False,
            "format": "json",
            # Disable "thinking" (qwen3 / deepseek-r1) so structured JSON is fast
            # and the token budget isn't spent on internal reasoning; cap output.
            "think": False,
            "options": {"temperature": temperature, "num_predict": 2048},
        }
        resp = httpx.post(f"{self.base}/api/chat", json=payload, timeout=180)
        if resp.status_code >= 400 and "think" in resp.text.lower():
            payload.pop("think", None)  # model doesn't support think flag → retry
            resp = httpx.post(f"{self.base}/api/chat", json=payload, timeout=180)
        resp.raise_for_status()
        data = resp.json()
        text = (data.get("message") or {}).get("content", "{}")
        usage = {
            "input": data.get("prompt_eval_count"),
            "output": data.get("eval_count"),
            "provider": "ollama",
            "model": self.model,
        }
        return extract_json(text), usage
