from __future__ import annotations

import os
from typing import Any

from .base import extract_json


class OpenAIProvider:
    """ChatGPT (OpenAI API). Reserved for the highest-stakes resources."""

    name = "openai"

    def __init__(self, model: str):
        self.model = model
        from openai import OpenAI

        self.client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])

    def generate_json(
        self,
        system: str,
        user: str,
        temperature: float,
        images: list[str] | None = None,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        resp = self.client.chat.completions.create(
            model=self.model,
            temperature=temperature,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        )
        text = resp.choices[0].message.content or "{}"
        usage = {
            "input": getattr(resp.usage, "prompt_tokens", None),
            "output": getattr(resp.usage, "completion_tokens", None),
        }
        return extract_json(text), usage
