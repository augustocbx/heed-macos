"""Foundation of the echo-eval harness: for each sample recording, split the dual channels,
transcribe the SYSTEM channel (the OTHER speaker = the foreign speech that must NOT end up in the
mic transcript) and the RAW mic (Junior + echo). Cache everything so config iterations are fast.
Config-independent → run once."""
import json, os, subprocess, urllib.request

ROOT = os.path.dirname(__file__)
CACHE = os.path.join(ROOT, "cache")
REC = os.path.join(ROOT, "..", "recordings")
os.makedirs(CACHE, exist_ok=True)


def tx(wav, lang="es"):
    r = urllib.request.Request("http://127.0.0.1:5002/transcribe",
        data=json.dumps({"wav_path": wav, "language": lang}).encode(),
        headers={"Content-Type": "application/json"})
    return (json.load(urllib.request.urlopen(r, timeout=180)).get("text") or "").strip()


def split(src, mic, sys):
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", src,
        "-filter_complex", "[0:a]pan=mono|c0=c0[m];[0:a]pan=mono|c0=c1[s]",
        "-map", "[m]", "-ar", "16000", mic, "-map", "[s]", "-ar", "16000", sys], check=True)


def main():
    samples = [l.strip() for l in open(os.path.join(ROOT, "samples.txt")) if l.strip()]
    gt = {}
    gtpath = os.path.join(CACHE, "groundtruth.json")
    if os.path.exists(gtpath):
        gt = json.load(open(gtpath))
    for i, rel in enumerate(samples):
        name = os.path.basename(rel).replace(".wav", "")
        if name in gt:
            print(f"[{i+1}/{len(samples)}] {name} (cached)")
            continue
        src = os.path.join(ROOT, "..", rel)
        mic = os.path.join(CACHE, name + "_mic.wav")
        sysw = os.path.join(CACHE, name + "_sys.wav")
        split(src, mic, sysw)
        sys_txt = tx(sysw)
        mic_raw = tx(mic)
        gt[name] = {"mic": mic, "sys": sysw, "sys_txt": sys_txt, "mic_raw": mic_raw}
        json.dump(gt, open(gtpath, "w"), ensure_ascii=False, indent=1)
        print(f"[{i+1}/{len(samples)}] {name}: sys={len(sys_txt.split())}w mic_raw={len(mic_raw.split())}w")
    print(f"\nground truth cached for {len(gt)} samples -> {gtpath}")


if __name__ == "__main__":
    main()
