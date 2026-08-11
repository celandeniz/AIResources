from __future__ import annotations

import os
from typing import Any

import httpx

from .base import extract_json

# Google Gemini (Generative Language API) via REST — no extra SDK dependency.
# Models: gemini-2.5-pro, gemini-2.5-flash, gemini-2.0-flash, …
# Key: GEMINI_API_KEY (preferred) or GOOGLE_API_KEY.

_DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta"


def gemini_key() -> str | None:
    return os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")


class GeminiProvider:
    """Google Gemini. Native JSON mode via responseMimeType=application/json."""

    name = "gemini"

    def __init__(self, model: str):
        # Allow callers to pass either "gemini-2.5-flash" or "models/gemini-2.5-flash".
        self.model = model.split("/")[-1] if model else "gemini-2.5-flash"
        self.base = os.getenv("GEMINI_BASE_URL", _DEFAULT_BASE).rstrip("/")
        self.key = gemini_key()
        if not self.key:
            raise RuntimeError("GEMINI_API_KEY/GOOGLE_API_KEY not set")

    def generate_json(
        self,
        system: str,
        user: str,
        temperature: float,
        images: list[str] | None = None,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        url = f"{self.base}/models/{self.model}:generateContent"
        payload: dict[str, Any] = {
            "system_instruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": user}]}],
            "generationConfig": {
                "temperature": temperature,
                "responseMimeType": "application/json",
                "maxOutputTokens": 2048,
            },
        }
        # Send the key in a header (not the query string) so it can't leak into
        # request logs / proxy access logs. Gemini accepts x-goog-api-key.
        resp = httpx.post(
            url,
            json=payload,
            headers={"content-type": "application/json", "x-goog-api-key": self.key},
            timeout=180,
        )
        resp.raise_for_status()
        data = resp.json()
        candidates = data.get("candidates") or []
        text = "{}"
        if candidates:
            parts = ((candidates[0].get("content") or {}).get("parts")) or []
            text = "".join(p.get("text", "") for p in parts) or "{}"
        um = data.get("usageMetadata") or {}
        usage = {
            "input": um.get("promptTokenCount"),
            "output": um.get("candidatesTokenCount"),
        }
        return extract_json(text), usage
