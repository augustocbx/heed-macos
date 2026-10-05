"""Driver for the heed-parakeet sidecar: run the OFFLINE diarizer (`diarize` cmd) on a WAV and get
back precise segments + per-speaker 256-dim WeSpeaker embeddings. Robust to the CoreML warnings the
sidecar interleaves on stdout. One persistent process per Sidecar() instance."""
import json, os, subprocess, tempfile

BIN = "/Users/junrod/heed-v3/packages/transcription/native/heed-parakeet/.build/release/heed-parakeet"


class Sidecar:
    def __init__(self):
        self.p = subprocess.Popen([BIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
        self._read()  # ready line

    def _read(self):
        while True:
            ln = self.p.stdout.readline()
            if not ln:
                raise RuntimeError("sidecar closed stdout")
            b = ln.find("{")
            if b < 0:
                continue
            try:
                return json.loads(ln[b:])
            except json.JSONDecodeError:
                continue

    def _send(self, obj):
        self.p.stdin.write(json.dumps(obj) + "\n")
        self.p.stdin.flush()
        return self._read()

    def diarize(self, wav):
        """-> {"speakers":[...], "segments":[{speaker,start,end}], "embeddings":{sid:[float]}}"""
        return self._send({"cmd": "diarize", "wav": wav})

    def close(self):
        try:
            self.p.stdin.close(); self.p.terminate()
        except Exception:
            pass


def extract_sys(src, out=None):
    """Extract the SYSTEM channel (right, index 1) of a dual-capture stereo wav to mono 16k."""
    if out is None:
        out = tempfile.mktemp(suffix="_sys.wav")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", src, "-af", "pan=mono|c0=c1",
                    "-ar", "16000", "-ac", "1", out], check=True)
    return out


def slice_wav(src, start, dur, out=None):
    if out is None:
        out = tempfile.mktemp(suffix="_slice.wav")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", str(start), "-t", str(dur),
                    "-i", src, "-ar", "16000", "-ac", "1", out], check=True)
    return out


def wav_dur(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                          "-of", "csv=p=0", path], capture_output=True, text=True).stdout.strip()
    return float(out)
