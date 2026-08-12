from __future__ import annotations

import os
import re
import threading
import time
from typing import Any

import httpx

from .base import extract_json

# NVIDIA NIM (build.nvidia.com free APIs) via the OpenAI-compatible REST
# endpoint — no extra SDK dependency. Models: meta/llama-3.3-70b-instruct,
# meta/llama-3.1-8b-instruct, meta/llama-3.2-11b-vision-instruct (vision), …
# Key: NVIDIA_API_KEY (free at build.nvidia.com).

_DEFAULT_BASE = "https://integrate.api.nvidia.com/v1"

# Reasoning models (e.g. deepseek-r1) emit <think>…</think> blocks; strip them
# so extract_json sees only the answer.
_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL)

# The free tier is per-key rate-limited (~40 RPM). Cap in-flight requests
# across the FastAPI threadpool; sustained 429s raise → the Ollama fallback
# tier in graphs/base.py takes over.
_SEM = threading.Semaphore(int(os.getenv("NVIDIA_MAX_CONCURRENCY", "2")))


class NvidiaProvider:
    """NVIDIA NIM — OpenAI-compatible chat completions, free tier."""

    name = "nvidia"

    def __init__(self, model: str):
        self.model = model or "meta/llama-3.3-70b-instruct"
        self.base = os.getenv("NVIDIA_BASE_URL", _DEFAULT_BASE).rstrip("/")
        self.key = os.getenv("NVIDIA_API_KEY")
        if not self.key:
            raise RuntimeError("NVIDIA_API_KEY not set")

    def generate_json(
        self,
        system: str,
        user: str,
        temperature: float,
        images: list[str] | None = None,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        image_data = [image.strip() for image in (images or []) if image.strip()]
        user_content: str | list[dict[str, Any]] = user
        model = self.model
        if image_data:
            # 11b-vision answers in ~1s on the free tier; 90b-vision consistently
            # times out. Override with NVIDIA_VISION_MODEL for higher accuracy.
            model = os.getenv("NVIDIA_VISION_MODEL") or "meta/llama-3.2-11b-vision-instruct"
            user_content = [
                {"type": "text", "text": user},
                *[
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/jpeg;base64,{image}"},
                    }
                    for image in image_data
                ],
            ]

        payload: dict[str, Any] = {
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user_content},
            ],
            "temperature": temperature,
            # Long structured drafts (project briefs, syntheses) overflow 2048
            # and produce truncated JSON → fallback. NIM models handle 4k fine.
            "max_tokens": int(os.getenv("NVIDIA_MAX_TOKENS", "4096")),
            "response_format": {"type": "json_object"},
        }
        resp = self._post(payload)
        # json_object support is model-dependent on NIM → retry without it.
        if resp.status_code == 400 and "response_format" in resp.text.lower():
            payload.pop("response_format", None)
            resp = self._post(payload)
        resp.raise_for_status()
        data = resp.json()
        choice = (data.get("choices") or [{}])[0]
        text = (choice.get("message") or {}).get("content") or "{}"
        text = _THINK_RE.sub("", text)
        um = data.get("usage") or {}
        usage = {
            "input": um.get("prompt_tokens"),
            "output": um.get("completion_tokens"),
        }
        return extract_json(text), usage

    def _post(self, payload: dict[str, Any]) -> httpx.Response:
        with _SEM:
            resp: httpx.Response | None = None
            for attempt in range(3):
                resp = httpx.post(
                    f"{self.base}/chat/completions",
                    json=payload,
                    headers={"content-type": "application/json", "authorization": f"Bearer {self.key}"},
                    # Free-tier throughput is ~20-30 tok/s — a 3-4k-token draft
                    # (training docs, syntheses) legitimately takes minutes.
                    timeout=float(os.getenv("NVIDIA_TIMEOUT_S", "420")),
                )
                if resp.status_code == 429 and attempt < 2:
                    retry_after = resp.headers.get("retry-after")
                    try:
                        delay = float(retry_after) if retry_after else float(2**attempt * 3)
                    except ValueError:
                        delay = float(2**attempt * 3)
                    time.sleep(min(delay, 30))
                    continue
                # Free-tier gateway congestion surfaces as 502/503/504 — one
                # spaced retry often lands on a free worker.
                if resp.status_code >= 500 and attempt < 2:
                    time.sleep(8)
                    continue
                return resp
            return resp  # type: ignore[return-value]
