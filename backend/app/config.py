"""Environment configuration. Keys come from the environment and are never hard-coded."""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[2]


class ProviderNotConfigured(RuntimeError):
    """A provider is unset, unknown, or missing its key."""


@dataclass(frozen=True)
class Settings:
    llm_provider: str = ""
    llm_api_key: str = field(default="", repr=False)
    llm_model: str = ""
    router_model: str = ""
    stt_provider: str = ""
    stt_api_key: str = field(default="", repr=False)
    tts_provider: str = ""
    tts_api_key: str = field(default="", repr=False)

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> Settings:
        """Read settings from `env`, or from the process environment plus the repo's .env."""
        if env is None:
            load_dotenv(REPO_ROOT / ".env", override=False)
            env = os.environ

        def get(name: str) -> str:
            return env.get(name, "").strip()

        return cls(
            llm_provider=get("LLM_PROVIDER").lower(),
            llm_api_key=get("LLM_API_KEY"),
            llm_model=get("LLM_MODEL"),
            router_model=get("ROUTER_MODEL"),
            stt_provider=get("STT_PROVIDER").lower(),
            stt_api_key=get("STT_API_KEY"),
            tts_provider=get("TTS_PROVIDER").lower(),
            tts_api_key=get("TTS_API_KEY"),
        )
