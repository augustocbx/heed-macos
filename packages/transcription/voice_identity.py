"""Preserve identities by voice and source; speaker indices are not identities."""
import math


def _cosine(left, right):
    if not left or not right or len(left) != len(right):
        return None
    try:
        a, b = [float(x) for x in left], [float(x) for x in right]
        if not all(math.isfinite(x) for x in a + b):
            return None
        denominator = math.sqrt(sum(x * x for x in a) * sum(x * x for x in b))
        return sum(x * y for x, y in zip(a, b)) / denominator if denominator else None
    except (TypeError, ValueError, OverflowError):
        return None


def reconcile_names(embeddings, recognized, live_voices, backend, channels=None,
                    mic_name=None, threshold=0.70, margin=0.08):
    """Final recognition takes precedence; recover live names only when unambiguous."""
    names = {key: name for key, name in recognized.items() if name and key in embeddings}
    for key, embedding in embeddings.items():
        if key in names:
            continue
        scores = {}
        for voice in live_voices:
            name = voice.get('name')
            if not name or voice.get('backend') != backend:
                continue
            score = _cosine(embedding, voice.get('emb'))
            if score is not None:
                scores[name] = max(scores.get(name, -1), score)
        ranked = sorted(scores.items(), key=lambda item: item[1], reverse=True)
        if ranked:
            name, score = ranked[0]
            runner_up = ranked[1][1] if len(ranked) > 1 else 0.0
            if score >= threshold and score - runner_up >= margin:
                names[key] = name
    # The channel alone identifies its owner only when a single voice is exclusive to the microphone.
    pure_mic = [key for key in embeddings if (channels or {}).get(key) == {'mic'}]
    if mic_name and mic_name.strip() and len(pure_mic) == 1 and pure_mic[0] not in names:
        names[pure_mic[0]] = mic_name.strip()
    return names
