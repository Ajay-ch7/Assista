"""Model gateway: picks the model adapter named in the environment. The rest of the
backend only sees LLMClient, so the provider can be swapped."""

from __future__ import annotations

from collections.abc import Callable

from app.config import ProviderNotConfigured, Settings
from app.llm.base import LLMClient
from app.llm.gemini import GeminiLLM
from app.llm.mock import MockLLM

# Provider name -> factory. Adapters take their model names from settings, never
# from code.
LLM_PROVIDERS: dict[str, Callable[[Settings], LLMClient]] = {
    "gemini": lambda settings: GeminiLLM(settings.llm_api_key, settings.llm_model),
    "mock": lambda settings: MockLLM(),
}


def create_llm(settings: Settings) -> LLMClient:
    name = settings.llm_provider
    if not name:
        raise ProviderNotConfigured("LLM_PROVIDER is not set")
    if name not in LLM_PROVIDERS:
        known = ", ".join(sorted(LLM_PROVIDERS))
        raise ProviderNotConfigured(f"LLM_PROVIDER={name!r} is not supported (known: {known})")
    return LLM_PROVIDERS[name](settings)
