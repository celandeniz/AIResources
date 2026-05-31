"""Provider abstraction. No global default — provider is chosen per AI Resource.

Each provider exposes generate_json(system, user, temperature) -> (dict, usage).
If a provider is unconfigured (no API key), the factory falls back to the
deterministic StubProvider so the platform runs with zero credentials.
"""
from __future__ import annotations

import json
import os
from typing import Any, Protocol


class LLMProvider(Protocol):
    name: str

    def generate_json(self, system: str, user: str, temperature: float) -> tuple[dict[str, Any], dict[str, Any]]:
        ...


def extract_json(text: str) -> dict[str, Any]:
    """Best-effort JSON extraction from an LLM response."""
    text = text.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lstrip().lower().startswith("json"):
            text = text.lstrip()[4:]
    try:
        return json.loads(text)
    except Exception:
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end != -1 and end > start:
            try:
                return json.loads(text[start : end + 1])
            except Exception:
                pass
    raise ValueError("could not parse JSON from model output")


def get_provider(provider: str, model: str) -> LLMProvider:
    from .stub_provider import StubProvider

    # Free/open-weight local models via Ollama — the default for most resources.
    if provider == "ollama":
        from .ollama_provider import OllamaProvider

        return OllamaProvider(model)
    if provider == "anthropic" and os.getenv("ANTHROPIC_API_KEY"):
        from .anthropic_provider import AnthropicProvider

        return AnthropicProvider(model)
    if provider == "openai" and os.getenv("OPENAI_API_KEY"):
        from .openai_provider import OpenAIProvider

        return OpenAIProvider(model)
    if provider == "azure_openai" and os.getenv("AZURE_OPENAI_API_KEY"):
        from .azure_openai_provider import AzureOpenAIProvider

        return AzureOpenAIProvider(model)
    # No credentials configured → deterministic stub (keeps the platform runnable).
    return StubProvider(requested=provider, model=model)
