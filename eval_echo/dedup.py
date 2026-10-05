"""Layer 3 — text dedup. Remove from the mic transcript any span that matches what the OTHER
speaker said (the clean system transcript). We know exactly what they said, so residual echo that
the signal layers missed can be stripped at the text level. Conservative: only removes runs of
words whose trigram fuzzy-matches foreign speech, keeping Junior's own words."""
from score import words, trigrams, _index, _fuzzy_match


def dedup(mic_txt, sys_txt, thr=0.62):
    mw = words(mic_txt)
    if len(mw) < 3:
        return mic_txt
    sys_idx = _index(trigrams(words(sys_txt)))
    flag = [False] * len(mw)
    for i in range(len(mw) - 2):
        g = tuple(mw[i:i+3])
        if _fuzzy_match(g, sys_idx, thr):
            flag[i] = flag[i+1] = flag[i+2] = True
    return " ".join(w for w, f in zip(mw, flag) if not f)
