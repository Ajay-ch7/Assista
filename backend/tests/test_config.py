from app.config import Settings


def test_settings_read_from_mapping():
    settings = Settings.from_env(
        {"LLM_PROVIDER": " Mock ", "LLM_MODEL": "some-model", "LLM_API_KEY": "secret-key"}
    )
    assert settings.llm_provider == "mock"
    assert settings.llm_model == "some-model"
    assert settings.llm_api_key == "secret-key"


def test_unset_values_are_empty():
    settings = Settings.from_env({})
    assert settings.stt_provider == ""
    assert settings.tts_provider == ""
    assert settings.router_model == ""


def test_keys_do_not_appear_in_repr():
    settings = Settings.from_env(
        {"LLM_API_KEY": "secret-key", "STT_API_KEY": "stt-secret", "TTS_API_KEY": "tts-secret"}
    )
    assert "secret" not in repr(settings)
