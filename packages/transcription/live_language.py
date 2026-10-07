"""Nonwarming registered model capabilities; support is separate from measured quality."""
import hashlib
import json

MULTILINGUAL = ("tiny", "base", "small", "medium", "large-v3")
ENGLISH_ONLY = ("tiny.en", "base.en", "small.en", "medium.en")
MLX_REPOS = {name: "mlx-community/whisper-" + name + "-mlx" for name in (*MULTILINGUAL, *ENGLISH_ONLY)}
MLX_REPOS["large-v3"] = "mlx-community/whisper-large-v3-mlx-4bit"
CT2_REPOS = {name: "Systran/faster-whisper-" + name for name in (*MULTILINGUAL, *ENGLISH_ONLY)}


def registered_identity(engine_kind, model_name):
    repository = (MLX_REPOS if engine_kind == "mlx" else CT2_REPOS if engine_kind == "ctranslate2" else {}).get(model_name)
    if repository:
        return engine_kind + ":" + repository
    if engine_kind == "parakeet" and model_name == "parakeet-v3":
        return "parakeet:FluidAudio/parakeet-tdt-0.6b-v3"
    return None


def model_supports_language(engine_kind, model_name, language):
    if language not in ("en", "pt") or registered_identity(engine_kind, model_name) is None:
        return False
    return language == "en" or model_name in MULTILINGUAL or engine_kind == "parakeet"


def path_capability(engine_kind, model_name, mode, loaded, model_revision=None, enabled=True):
    identity = registered_identity(engine_kind, model_name)
    valid = identity is not None and mode in ("chunk", "full", "stream") and (mode != "stream" or engine_kind == "parakeet")
    # Native streaming is only represented when selected explicitly; native final has an external detector.
    languages = [language for language in ("en", "pt") if valid and model_supports_language(engine_kind, model_name, language)]
    auto = valid and engine_kind in ("mlx", "ctranslate2") and model_name in MULTILINGUAL
    candidates = [name for name in (*MULTILINGUAL, *ENGLISH_ONLY) if registered_identity(engine_kind, name)] if valid and enabled and engine_kind != "parakeet" else []
    return {"engine": engine_kind if engine_kind in ("mlx", "ctranslate2", "parakeet") else None,
            "model": model_name if identity else None, "modelIdentity": identity, "modelRevision": model_revision if isinstance(model_revision, str) else None,
            "state": "unavailable" if not valid else "disabled" if not enabled else "loaded" if loaded else "lazy",
            "supportedLanguages": languages,
            "automatic": {"modelSupported": bool(auto), "pipelineAvailable": bool(auto or (valid and engine_kind == "parakeet" and mode == "full")), "offered": False},
            "mixedLanguage": "unverified", "mode": mode if valid else None,
            "adaptiveModels": [{"model": name, "modelIdentity": registered_identity(engine_kind, name),
                                "languages": [language for language in ("en", "pt") if model_supports_language(engine_kind, name, language)]} for name in candidates]}


def language_capabilities(live, final):
    descriptor = {"schemaVersion": 1, "live": live, "final": final}
    key = hashlib.sha256(json.dumps(descriptor, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return {**descriptor, "capabilityKey": key}


def validate_live_options(value, enabled):
    if not isinstance(value, dict) or value.get("realTimeTranscription") is not enabled or value.get("requestedLanguage") not in ("en", "pt"):
        raise ValueError("Invalid admitted live options")
    if not enabled:
        if any(value.get(key) is not None for key in ("effectiveLanguage", "engine", "mode", "initialModel", "initialModelIdentity")) or value.get("compatibleModels") != []:
            raise ValueError("Disabled preview cannot carry inference options")
        return dict(value)
    kind, model, language = value.get("engine"), value.get("initialModel"), value.get("effectiveLanguage")
    identity = registered_identity(kind, model)
    if language != value["requestedLanguage"] or not model_supports_language(kind, model, language) or identity != value.get("initialModelIdentity") or value.get("mode") not in ("chunk", "full", "stream") or ((kind == "parakeet") != (value.get("mode") == "stream")):
        raise ValueError("Unsupported admitted preview identity or language")
    key = value.get("capabilityKey")
    if not isinstance(key, str) or len(key) != 64 or any(char not in "0123456789abcdef" for char in key):
        raise ValueError("Invalid admitted capability key")
    models = value.get("compatibleModels")
    if not isinstance(models, list) or not models or len(models) > 20 or identity not in models:
        raise ValueError("Invalid compatible preview models")
    allowed = {registered_identity(kind, name) for name in (*MULTILINGUAL, *ENGLISH_ONLY, "parakeet-v3") if model_supports_language(kind, name, language)}
    if any(not isinstance(item, str) or item not in allowed for item in models):
        raise ValueError("Incompatible preview model family or language")
    return {**value, "compatibleModels": list(models)}
