#!/usr/bin/env python3
"""Speaker diarization using pyannote-audio.
Usage: python3 diarize.py <wav_path> [<srt_path>]
Outputs JSON with speaker segments, or merged transcript if SRT provided.
"""
import sys
import json
import re
import warnings
warnings.filterwarnings("ignore")

def parse_srt(srt_path):
    """Parse SRT into list of {start, end, text}"""
    with open(srt_path, "r") as f:
        content = f.read()

    blocks = re.split(r"\n\n+", content.strip())
    segments = []
    for block in blocks:
        lines = block.strip().split("\n")
        if len(lines) < 2:
            continue
        # Find timestamp line
        ts_line = None
        for l in lines:
            if "-->" in l:
                ts_line = l
                break
        if not ts_line:
            continue

        # Parse timestamps [HH:MM:SS.mmm --> HH:MM:SS.mmm] or HH:MM:SS,mmm --> HH:MM:SS,mmm
        ts_line = ts_line.replace(",", ".").strip("[] ")
        match = re.match(r"(\d+):(\d+):([\d.]+)\s*-->\s*(\d+):(\d+):([\d.]+)", ts_line)
        if not match:
            continue
        start = int(match[1]) * 3600 + int(match[2]) * 60 + float(match[3])
        end = int(match[4]) * 3600 + int(match[5]) * 60 + float(match[6])

        # Text is everything after timestamp line
        text_lines = []
        found_ts = False
        for l in lines:
            if "-->" in l:
                found_ts = True
                continue
            if found_ts:
                text_lines.append(l.strip())
        text = " ".join(text_lines).strip()
        if text:
            segments.append({"start": start, "end": end, "text": text})

    return segments


def assign_speakers(diarization_segments, srt_segments):
    """Assign speaker labels to SRT segments based on overlap."""
    result = []
    for seg in srt_segments:
        mid = (seg["start"] + seg["end"]) / 2
        best_speaker = "Speaker ?"
        best_overlap = 0

        for d in diarization_segments:
            overlap_start = max(seg["start"], d["start"])
            overlap_end = min(seg["end"], d["end"])
            overlap = max(0, overlap_end - overlap_start)
            if overlap > best_overlap:
                best_overlap = overlap
                best_speaker = d["speaker"]

        # Also check midpoint
        if best_overlap == 0:
            for d in diarization_segments:
                if d["start"] <= mid <= d["end"]:
                    best_speaker = d["speaker"]
                    break

        result.append({
            "speaker": best_speaker,
            "start": seg["start"],
            "end": seg["end"],
            "text": seg["text"],
        })

    return result


def main():
    if len(sys.argv) < 2:
        print("Usage: diarize.py <wav_path> [<srt_path>]", file=sys.stderr)
        sys.exit(1)

    wav_path = sys.argv[1]
    srt_path = sys.argv[2] if len(sys.argv) > 2 else None
    # Optional: --min-speakers N --max-speakers N
    min_speakers = None
    max_speakers = None
    for i, arg in enumerate(sys.argv):
        if arg == "--min-speakers" and i + 1 < len(sys.argv):
            min_speakers = int(sys.argv[i + 1])
        if arg == "--max-speakers" and i + 1 < len(sys.argv):
            max_speakers = int(sys.argv[i + 1])

    import os
    import torch
    from pyannote.audio import Pipeline

    # Force offline mode — never call HuggingFace servers
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"

    pipeline = Pipeline.from_pretrained("pyannote/speaker-diarization-3.1")

    if torch.cuda.is_available():
        pipeline.to(torch.device("cuda"))

    # Tune clustering to reduce false speaker splits:
    # Higher threshold = fewer speakers (less aggressive splitting)
    params = pipeline.parameters(instantiated=True)
    params["clustering"]["threshold"] = 0.8  # default ~0.7, higher = merge more aggressively

    # Run with optional speaker count hints
    diarize_args = {}
    if min_speakers is not None:
        diarize_args["min_speakers"] = min_speakers
    if max_speakers is not None:
        diarize_args["max_speakers"] = max_speakers

    result = pipeline(wav_path, **diarize_args)
    annotation = result.speaker_diarization

    # Collect speaker segments
    speakers_seen = {}
    speaker_counter = 0
    diar_segments = []
    for turn, _, speaker in annotation.itertracks(yield_label=True):
        if speaker not in speakers_seen:
            speaker_counter += 1
            speakers_seen[speaker] = f"Speaker {speaker_counter}"
        diar_segments.append({
            "start": round(turn.start, 2),
            "end": round(turn.end, 2),
            "speaker": speakers_seen[speaker],
        })

    if srt_path:
        srt_segments = parse_srt(srt_path)
        merged = assign_speakers(diar_segments, srt_segments)

        # Format as readable text
        lines = []
        last_speaker = None
        for seg in merged:
            if seg["speaker"] != last_speaker:
                lines.append(f"\n{seg['speaker']}:")
                last_speaker = seg["speaker"]
            lines.append(f"  {seg['text']}")

        output = {
            "speakers": list(speakers_seen.values()),
            "speaker_count": len(speakers_seen),
            "segments": merged,
            "text": "\n".join(lines).strip(),
        }
    else:
        output = {
            "speakers": list(speakers_seen.values()),
            "speaker_count": len(speakers_seen),
            "segments": diar_segments,
        }

    print(json.dumps(output))


if __name__ == "__main__":
    main()
