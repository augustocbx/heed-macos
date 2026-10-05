"""Session speaker registry + embedding reconciliation + conservative naming — the pure logic that
turns per-window offline-diarizer output into STABLE, correctly-named live speaker labels. No I/O
here (testable in isolation); the harness and, later, transcription_server.py use the same rules."""
import json, math, os

VOICES_PATH = os.path.expanduser("~/.heed-app/voices.json")


def cosine(a, b):
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def _avg(vecs, weights):
    n = len(vecs[0])
    out = [0.0] * n
    tw = sum(weights) or 1.0
    for v, w in zip(vecs, weights):
        for i in range(n):
            out[i] += v[i] * w
    return [x / tw for x in out]


def merge_within_window(embs, durs, thr):
    """Collapse window-speakers whose voiceprints are nearly identical (a single speaker the short
    window split). embs/durs keyed by window speaker id. Returns list of groups:
    [{"ids":[...], "emb":avg, "dur":sum}]."""
    ids = list(embs.keys())
    groups = []
    for sid in sorted(ids, key=lambda k: -durs.get(k, 0)):  # seed with longest
        placed = False
        for g in groups:
            if cosine(embs[sid], g["emb"]) >= thr:
                g["ids"].append(sid)
                g["emb"] = _avg([g["emb"], embs[sid]], [g["dur"], durs[sid]])
                g["dur"] += durs[sid]
                placed = True
                break
        if not placed:
            groups.append({"ids": [sid], "emb": list(embs[sid]), "dur": durs[sid]})
    return groups


class Registry:
    """Persistent session speakers. Reconciles each window's (merged) speakers to stable labels by
    cosine against the running-averaged voiceprint; unknown -> new label."""

    def __init__(self, recon_thr=0.55, voices=None):
        self.recon_thr = recon_thr
        self.speakers = []  # {label, emb, dur, name, name_score}
        self._alias = {}    # merged-away label -> surviving label (for display)
        self._n = 0
        self.voices = voices if voices is not None else load_voices()

    def _match_session(self, emb):
        best, bs = None, 0.0
        for sp in self.speakers:
            c = cosine(emb, sp["emb"])
            if c > bs:
                bs, best = c, sp
        return (best, bs) if (best and bs >= self.recon_thr) else (None, bs)

    def update(self, groups):
        """groups: output of merge_within_window. Returns {group_index: session_label}."""
        mapping = {}
        for gi, g in enumerate(groups):
            sp, _ = self._match_session(g["emb"])
            if sp is None:
                self._n += 1
                sp = {"label": f"Speaker {self._n}", "emb": list(g["emb"]), "dur": 0.0,
                      "name": None, "name_score": 0.0}
                self.speakers.append(sp)
            else:
                sp["emb"] = _avg([sp["emb"], g["emb"]], [sp["dur"], g["dur"]])
            sp["dur"] += g["dur"]
            mapping[gi] = sp["label"]
        return mapping

    def consolidate(self, thr):
        """Merge session speakers whose voiceprints are the same person (a short noisy window created
        an accidental 2nd label). Same voice ≈0.7+, different ≈0.0 → a mid threshold collapses splits
        without merging distinct people. Longest-lived speaker wins the label/name."""
        order = sorted(self.speakers, key=lambda s: -s["dur"])
        merged = []
        for sp in order:
            hit = None
            for m in merged:
                if cosine(sp["emb"], m["emb"]) >= thr:
                    hit = m
                    break
            if hit is None:
                merged.append(sp)
            else:
                hit["emb"] = _avg([hit["emb"], sp["emb"]], [hit["dur"], sp["dur"]])
                hit["dur"] += sp["dur"]
                if sp["name"] and sp["name_score"] > hit["name_score"]:
                    hit["name"], hit["name_score"] = sp["name"], sp["name_score"]
                self._alias[sp["label"]] = hit["label"]
        self.speakers = merged

    def resolve(self, label):
        """Follow the alias chain to the surviving session label."""
        seen = set()
        while label in self._alias and label not in seen:
            seen.add(label)
            label = self._alias[label]
        return label

    def _get(self, label):
        label = self.resolve(label)
        for sp in self.speakers:
            if sp["label"] == label:
                return sp
        return None

    def name_of(self, label):
        sp = self._get(label)
        return sp["name"] if sp else None

    def score_of(self, label):
        sp = self._get(label)
        return sp["name_score"] if sp else 0.0

    def display_of(self, label):
        sp = self._get(label)
        return (sp["name"] or sp["label"]) if sp else self.resolve(label)

    def display(self, label):
        return self.display_of(label)


# ---- conservative naming ----------------------------------------------------------------
def load_voices(path=VOICES_PATH):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return {}


def name_speakers(reg, wespeaker_thr=0.62, margin=0.08, min_dur=4.0, backend="wespeaker"):
    """Assign a saved voice name to a session speaker ONLY when highly confident: enough accumulated
    audio, top match >= threshold, AND a clear margin over the 2nd-best saved voice. Otherwise leave
    the generic 'Speaker N'. Names never flip to a different name once set unless a stronger match."""
    voices = [(n, e) for n, e in reg.voices.items() if e.get("backend") == backend]
    for sp in reg.speakers:
        if sp["dur"] < min_dur:
            continue
        scored = sorted(((cosine(sp["emb"], e.get("embedding", [])), n) for n, e in voices), reverse=True)
        if not scored:
            continue
        top_s, top_n = scored[0]
        second_s = scored[1][0] if len(scored) > 1 else 0.0
        if top_s >= wespeaker_thr and (top_s - second_s) >= margin:
            if top_s > sp["name_score"]:
                sp["name"], sp["name_score"] = top_n, top_s
    return reg
