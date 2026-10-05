"""Fast param sweep of the PRODUCTION DiarSession over the cached windows of the 4 recordings.
No sidecar (uses cache) + numpy cosine → hundreds of configs in seconds. Objective: 0 phantoms (man
NOT split), low under-count, low churn, over all 4 recordings. Logs every config to results.jsonl."""
import json, os, sys, itertools
import numpy as np

sys.path.insert(0, "../packages/transcription")
import transcription_server as T

# fast cosine for L2-normalized 256-dim vectors (patch the pure-python one used by DiarSession)
def _fast_cos(a, b):
    if not a or not b or len(a) != len(b):
        return 0.0
    va = np.asarray(a, dtype=np.float32); vb = np.asarray(b, dtype=np.float32)
    d = float(np.dot(va, vb)); na = float(np.linalg.norm(va)); nb = float(np.linalg.norm(vb))
    return d / (na * nb) if na and nb else 0.0
T.cosine_similarity = _fast_cos

CACHE = os.path.join(os.path.dirname(__file__), "cache")
RECS = [f for f in sorted(os.listdir(CACHE)) if f.endswith(".json")]
DATA = {f: json.load(open(os.path.join(CACHE, f))) for f in RECS}


def gt_count(d):
    durs = {}
    for s in d["gt_full"]["segments"]:
        durs[s["speaker"]] = durs.get(s["speaker"], 0.0) + (s["end"] - s["start"])
    tot = sum(durs.values()) or 1.0
    return sum(1 for v in durs.values() if v >= 3.0 and v / tot >= 0.12)


def run_rec(d, cfg, step):
    sess = T.DiarSession()
    for k, v in cfg.items():
        setattr(sess, k, v)
    ticks, seq = {}, []
    last_t = -999
    for w in d["windows"]:
        if w["t"] - last_t < step - 0.001:
            continue
        last_t = w["t"]
        res = sess.feed(w["segments"], w["embeddings"], window_s=w["window_s"])
        lab = res.get("label")
        if lab:
            ticks[lab] = ticks.get(lab, 0) + 1
            seq.append(lab)
    real = {k: n * step for k, n in ticks.items()}
    tot = sum(real.values()) or 1.0
    kept = [k for k, v in real.items() if v >= 3.0 and v / tot >= 0.12]
    names = {}
    for sp in sess.speakers:
        if sp.get("name"):
            names[sp["name"]] = round(sp["name_score"], 3)
    churn = sum(1 for i in range(1, len(seq)) if seq[i] != seq[i - 1])
    return len(kept), names, churn, len(seq)


def score_cfg(cfg, step):
    tot_ph = tot_under = tot_churn = 0
    detail = []
    for f, d in DATA.items():
        gt = gt_count(d)
        live, names, churn, n = run_rec(d, cfg, step)
        ph = max(0, live - gt); under = max(0, gt - live)
        tot_ph += ph; tot_under += under; tot_churn += churn
        detail.append({"rec": f[13:26], "gt": gt, "live": live, "ph": ph, "under": under,
                       "churn": churn, "names": names})
    composite = tot_ph * 10 + tot_under * 3 + tot_churn * 0.03
    return {"phantom": tot_ph, "under": tot_under, "churn": tot_churn,
            "score": round(composite, 2), "detail": detail}


GRID = {
    "MERGE": [0.45, 0.5, 0.55, 0.6],
    "RECON": [0.4, 0.45, 0.5, 0.55],
    "CONSOLIDATE": [0.4, 0.45, 0.5],
    "CUR_SLICE": [1.5, 2.0],
}
STEPS = [1.0, 2.0]

results = []
keys = list(GRID.keys())
for combo in itertools.product(*[GRID[k] for k in keys]):
    cfg = dict(zip(keys, combo))
    for step in STEPS:
        r = score_cfg(cfg, step)
        r["cfg"] = cfg; r["step"] = step
        results.append(r)

results.sort(key=lambda r: r["score"])
with open("results.jsonl", "w") as fo:
    for r in results:
        fo.write(json.dumps(r) + "\n")

print(f"swept {len(results)} configs. TOP 12 (lower score better; phantom weighted heaviest):\n")
print(f"{'score':>6} {'ph':>3} {'und':>4} {'chn':>4} step  MERGE RECON CONS CUR")
for r in results[:12]:
    c = r["cfg"]
    print(f"{r['score']:>6} {r['phantom']:>3} {r['under']:>4} {r['churn']:>4} {r['step']:>4}  "
          f"{c['MERGE']:>5} {c['RECON']:>5} {c['CONSOLIDATE']:>4} {c['CUR_SLICE']:>3}")
print("\nBest config detail:")
for d in results[0]["detail"]:
    print(f"  {d['rec']}: GT={d['gt']} live={d['live']} ph={d['ph']} under={d['under']} churn={d['churn']} names={d['names']}")
