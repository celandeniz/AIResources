from __future__ import annotations

import os
from typing import Any

from .base import extract_json


class AzureOpenAIProvider:
    name = "azure_openai"

    def __init__(self, model: str):
        self.model = model  # Azure deployment name
        from openai import AzureOpenAI

        self.client = AzureOpenAI(
            api_key=os.environ["AZURE_OPENAI_API_KEY"],
            azure_endpoint=os.environ["AZURE_OPENAI_ENDPOINT"],
            api_version=os.getenv("AZURE_OPENAI_API_VERSION", "2024-10-21"),
        )

    def generate_json(self, system: str, user: str, temperature: float) -> tuple[dict[str, Any], dict[str, Any]]:
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
