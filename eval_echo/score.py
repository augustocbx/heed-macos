"""Scoring for the echo-removal eval. Given a processed MIC transcript, the clean SYSTEM transcript
(the foreign speech that must NOT be in the mic), and the RAW mic transcript (Junior + echo), compute:

  echo_in_mic    = fraction of the mic transcript that is foreign (system) echo   → want LOW (0)
  junior_kept    = fraction of Junior's own words retained in the processed mic    → want HIGH (1)
  score          = junior_kept * (1 - echo_in_mic)                                 → want HIGH (1)

Uses fuzzy trigram matching (the ASR garbles echo), pruned by a shared-word index for speed.
"""
from difflib import SequenceMatcher
import re

_STOP = set("de la el en y a que los las un una por con para se su lo le del al es e o u me mi tu".split())


def words(t):
    return [w for w in re.findall(r"[a-záéíóúñü0-9']+", (t or "").lower()) if w]


def trigrams(ws):
    return [tuple(ws[i:i+3]) for i in range(len(ws) - 2)]


def _index(grams):
    # word -> list of grams containing it (for pruning fuzzy comparisons)
    idx = {}
    for g in grams:
        for w in g:
            if w in _STOP:
                continue
            idx.setdefault(w, []).append(g)
    return idx


def _fuzzy_match(g, idx, thr=0.62):
    # candidate grams that share a non-stopword with g
    seen = set()
    cands = []
    for w in g:
        if w in _STOP:
            continue
        for cg in idx.get(w, ()):
            if cg not in seen:
                seen.add(cg); cands.append(cg)
    gs = " ".join(g)
    for cg in cands:
        if SequenceMatcher(None, gs, " ".join(cg)).ratio() >= thr:
            return True
    return False


def score(mic_proc, sys_txt, mic_raw):
    sys_g = trigrams(words(sys_txt))
    mic_g = trigrams(words(mic_proc))
    raw_g = trigrams(words(mic_raw))
    sys_idx = _index(sys_g)

    # echo_in_mic: fraction of processed-mic trigrams that match foreign speech
    if mic_g:
        echo = sum(1 for g in mic_g if _fuzzy_match(g, sys_idx)) / len(mic_g)
    else:
        echo = 0.0

    # Junior's own trigrams = raw-mic trigrams that are NOT foreign echo
    junior_g = [g for g in raw_g if not _fuzzy_match(g, sys_idx)]
    if junior_g:
        proc_idx = _index(mic_g)
        kept = sum(1 for g in junior_g if _fuzzy_match(g, proc_idx)) / len(junior_g)
    else:
        kept = 1.0  # nothing of Junior's to keep (e.g. he was silent)

    return {"echo_in_mic": round(echo, 3), "junior_kept": round(kept, 3),
            "score": round(kept * (1 - echo), 3),
            "n_sys": len(sys_g), "n_junior": len(junior_g)}
