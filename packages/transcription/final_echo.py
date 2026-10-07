"""Conservative transcript evidence for microphone copies of system speech.

Speaker clusters are intentionally absent: a shared or uncertain speaker label
does not establish that a particular microphone phrase is an echo.
"""

import math
import re
import unicodedata


def _tokens(text):
    if not isinstance(text, str):
        return []
    normalized = unicodedata.normalize("NFKD", text.casefold())
    normalized = "".join(c for c in normalized if not unicodedata.combining(c))
    return re.findall(r"[^\W_]+", normalized)


def _segment(segment):
    try:
        start, end = float(segment["start"]), float(segment["end"])
        tokens = _tokens(segment.get("text", ""))
    except (KeyError, TypeError, ValueError, OverflowError):
        return None
    if not math.isfinite(start) or not math.isfinite(end) or end <= start or not tokens:
        return None
    return start, end, tokens


def _coverage(start, end, segments):
    """Measure the union of actual overlap, rather than filling silent gaps."""
    covered, previous_end = 0.0, start
    for left, right, _ in segments:
        left, right = max(start, left, previous_end), min(end, right)
        if right > left:
            covered += right - left
            previous_end = right
    return covered


def _matching_phrase(mic, group):
    mic_start, mic_end, mic_tokens = mic
    group_start = group[0][0]
    group_end = max(segment[1] for segment in group)
    mic_duration = mic_end - mic_start
    group_duration = group_end - group_start
    if not 0.45 <= group_duration / mic_duration <= 2.25:
        return False
    if _coverage(mic_start, mic_end, group) < 0.8 * mic_duration:
        return False

    system_tokens = [token for _, _, tokens in group for token in tokens]
    if len(system_tokens) < len(mic_tokens):
        return False
    # A very long remote utterance provides weak evidence for a short local one.
    if len(system_tokens) > 2.5 * len(mic_tokens):
        return False

    count = len(mic_tokens)
    for position in range(len(system_tokens) - count + 1):
        if system_tokens[position:position + count] != mic_tokens:
            continue
        if position == 0 and count == len(system_tokens):
            return (abs(group_start - mic_start) <= 0.75
                    and abs(group_end - mic_end) <= 0.75)

        # ASR can merge two phrases on the system channel and split them on the
        # microphone. Approximate word placement only narrows the candidate;
        # it never substitutes for complete text equality and actual overlap.
        # Reject large merged windows whose word locations would be speculative.
        if max(mic_start - group_start, group_end - mic_end) > 2.25:
            continue
        phrase_start = group_start + group_duration * position / len(system_tokens)
        phrase_end = group_start + group_duration * (position + count) / len(system_tokens)
        if (abs(phrase_start - mic_start) <= 0.75
                and abs(phrase_end - mic_end) <= 0.75):
            return True
    return False


def is_microphone_echo(microphone_segment, system_segments):
    """Return true only for a whole phrase with strong text and timing evidence.

    Case, accents and punctuation differences are equivalent. A phrase needs at
    least three words and twelve alphanumeric characters. Short acknowledgments,
    ASR disagreements and mixed echo/local phrases are retained, even if that
    leaves some residual echo. This filter cannot distinguish two people saying
    the exact same substantial phrase at the same time.
    """
    mic = _segment(microphone_segment)
    if mic is None:
        return False
    if len(mic[2]) < 3 or sum(len(token) for token in mic[2]) < 12:
        return False

    candidates = []
    for segment in system_segments:
        parsed = _segment(segment)
        if parsed is not None and min(mic[1], parsed[1]) > max(mic[0], parsed[0]):
            candidates.append(parsed)
    candidates.sort(key=lambda segment: (segment[0], segment[1]))

    # Only adjacent, overlapping ASR segments are joined. A distant phrase or a
    # large silence cannot supply missing words for the microphone utterance.
    for index in range(len(candidates)):
        group = []
        for candidate in candidates[index:]:
            if group and candidate[0] - max(segment[1] for segment in group) > 0.35:
                break
            group.append(candidate)
            if _matching_phrase(mic, group):
                return True
    return False
