from __future__ import annotations

import os
from typing import Any

from .base import extract_json


class AnthropicProvider:
    name = "anthropic"

    def __init__(self, model: str):
        self.model = model
        from anthropic import Anthropic

        self.client = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])

    def generate_json(
        self,
        system: str,
        user: str,
        temperature: float,
        images: list[str] | None = None,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        msg = self.client.messages.create(
            model=self.model,
            max_tokens=2000,
            temperature=temperature,
            system=system,
            messages=[{"role": "user", "content": user}],
        )
        text = "".join(block.text for block in msg.content if getattr(block, "type", "") == "text")
        usage = {
            "input": getattr(msg.usage, "input_tokens", None),
            "output": getattr(msg.usage, "output_tokens", None),
        }
        return extract_json(text), usage
