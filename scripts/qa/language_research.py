#!/usr/bin/env python3
"""Offline FR/DE research using existing Heed adapters, never product language admission.

Public/licensed PCM only. Run serially on each Mac with existing cached models.
This evaluator does not edit installed settings, accepted meetings or ASR policy.
"""
import argparse
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import platform
import subprocess
import sys
import time
import wave
from live_language_metrics import error_metrics

ROOT = Path(__file__).resolve().parents[2]
LANGUAGES = ('en', 'pt', 'fr', 'de')


def digest(path):
    with open(path, 'rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def research_decision(probabilities, threshold=.8):
    """Proposed research threshold uses all model languages, without renormalizing EN/PT."""
    if not probabilities:
        return {'language': None, 'confidence': 0., 'samples': 0, 'outcome': 'no-speech'}
    scores = {}
    for probability in probabilities:
        if not isinstance(probability, dict):
            raise ValueError('Invalid detection scores')
        for language, value in probability.items():
            if not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 1:
                raise ValueError('Invalid detection scores')
            scores[language] = scores.get(language, 0.) + value / len(probabilities)
    winner = max(scores, key=scores.get) if scores else None
    confidence = scores.get(winner, 0.)
    admitted = winner in LANGUAGES and confidence >= threshold
    return {'language': winner if admitted else None, 'confidence': confidence,
            'samples': len(probabilities), 'outcome': 'supported' if admitted else 'explicit-choice-required'}


def load_cohort(path):
    path = Path(path).resolve()
    data = json.loads(path.read_text())
    if data.get('schemaVersion') != 1 or not data.get('fixtures'):
        raise ValueError('Unsupported research cohort')
    identities = set()
    for entry in data['fixtures']:
        audio = (path.parent / entry['file']).resolve()
        if not audio.is_relative_to(path.parent):
            raise ValueError('Audio must stay in the cohort directory')
        if entry['id'] in identities:
            raise ValueError('Duplicate cohort identity')
        identities.add(entry['id'])
        if entry['language'] not in (*LANGUAGES, 'mixed', 'silence') or not isinstance(entry['reference'], str):
            raise ValueError('Invalid cohort language/reference')
        if not entry.get('license') or digest(audio) != entry['sha256']:
            raise ValueError('Cohort license/integrity mismatch')
        with wave.open(str(audio)) as source:
            duration = source.getnframes() / source.getframerate()
            if source.getnchannels() != 1 or source.getsampwidth() != 2 or source.getframerate() != 16000:
                raise ValueError('Expected mono PCM16 16kHz research audio')
            if abs(duration - entry['seconds']) > .0001:
                raise ValueError('Cohort duration mismatch')
    return data


def cached_weights(model):
    from huggingface_hub import snapshot_download
    from live_language import MLX_REPOS
    snapshot = Path(snapshot_download(MLX_REPOS[model], local_files_only=True))
    files = {str(p.relative_to(snapshot)): {'bytes': p.stat().st_size, 'sha256': digest(p)}
             for p in snapshot.rglob('*') if p.is_file() and p.suffix in ('.npz', '.safetensors', '.json')}
    if not any(name.endswith(('.npz', '.safetensors')) for name in files):
        raise RuntimeError('Selected weights are not cached; no downloads allowed')
    return {'repository': MLX_REPOS[model], 'revision': snapshot.name,
            'bytes': sum(item['bytes'] for item in files.values()), 'files': files,
            'snapshotPath': str(snapshot.resolve())}


def supervise(child, measure, replay, timeout):
    """Every completion path, including startup failure/deadline, audits owned retirement."""
    samples, owned = [], {}
    deadline = time.monotonic() + timeout
    try:
        owned.update(replay.owned_identities(child.pid))
        while child.poll() is None:
            owned.update(replay.owned_identities(child.pid))
            if time.monotonic() > deadline:
                raise TimeoutError('Research worker deadline exceeded')
            samples.append(measure.process_sample(child.pid))
            time.sleep(.25)
        if child.returncode:
            raise RuntimeError('Research worker failed; see public diagnostics')
    finally:
        try:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=5)
        finally:
            if replay.surviving_owned(owned, replay.process_identities()):
                raise RuntimeError('Research worker did not retire every owned process')
    return samples


def worker(args):
    sys.path.insert(0, str(ROOT / 'packages/transcription'))
    import engines
    from worker_lifecycle import registry
    cohort = load_cohort(args.manifest)
    entries = cohort['fixtures']
    engine = None
    metadata = {'model': args.worker, 'python': sys.version}
    if args.worker == 'parakeet-v3':
        engines._SIDECAR_BIN = str(Path(args.native_binary).resolve())
        metadata['nativeBinarySha256'] = digest(engines._SIDECAR_BIN)
        engine = engines.ParakeetEngine(role='asr')
    elif args.worker != 'detection':
        metadata['weights'] = cached_weights(args.worker)
        engine = engines.MLXEngine(args.worker)
    else:
        metadata['weights'] = cached_weights('tiny')
        import numpy as np
        import mlx.core as mx
        from mlx_whisper.load_models import load_model
        from mlx_whisper.audio import log_mel_spectrogram, pad_or_trim
        detector = load_model(metadata['weights']['snapshotPath'], dtype=mx.float16)
        mx.eval(detector.parameters())
    results = []
    try:
        for repeat in range(args.repeats):
            for entry in entries:
                audio = Path(args.manifest).resolve().parent / entry['file']
                requested = entry['language'] if entry['language'] in LANGUAGES else 'fr'
                started = time.monotonic()
                if args.worker == 'detection':
                    with wave.open(str(audio)) as source:
                        samples = np.frombuffer(source.readframes(source.getnframes()), dtype=np.int16).astype(np.float32) / 32768
                    probabilities = []
                    duration = entry['seconds']
                    for offset in sorted({0., max(0., duration / 2 - 15), max(0., duration - 30)}):
                        chunk = samples[int(offset * 16000):int((offset + 30) * 16000)]
                        if chunk.size and float(np.sqrt(np.mean(chunk ** 2))) >= .001:
                            mel = log_mel_spectrogram(pad_or_trim(mx.array(chunk)), n_mels=detector.dims.n_mels)
                            _, probability = detector.detect_language(mel)
                            probabilities.append(probability)
                    decision = research_decision(probabilities)
                    from meeting_language import choose_language
                    result = {'decision': decision, 'currentEnPtDecision': choose_language(probabilities)}
                else:
                    if args.worker == 'parakeet-v3':
                        raw = engine.transcribe_ts(str(audio), requested)
                        segments = engines.tokens_to_segments(raw['tokens'])
                        text = raw['text']
                    else:
                        segments, info = engine.transcribe(str(audio), language=requested, task='transcribe',
                                                           temperature=0., condition_on_previous_text=False)
                        segments = [{'text': s.text, 'start': s.start, 'end': s.end} for s in segments]
                        text = ' '.join(s['text'] for s in segments)
                    timestamps = all(math.isfinite(s['start']) and math.isfinite(s['end']) and
                                     0 <= s['start'] <= s['end'] <= entry['seconds'] + .05 for s in segments)
                    result = {'requestedLanguage': requested, 'task': 'transcribe',
                              'metrics': error_metrics(entry['reference'], text),
                              'timestampsInBounds': timestamps, 'segments': segments, 'text': text,
                              'silenceHallucination': entry['language'] == 'silence' and bool(text.strip())}
                results.append({'id': entry['id'], 'language': entry['language'], 'repeat': repeat,
                                'duration': entry['seconds'], 'latencySeconds': time.monotonic() - started, **result})
    finally:
        if engine is not None and hasattr(engine, 'close'):
            engine.close()
        registry.shutdown()
    Path(args.output).write_text(json.dumps({'identity': metadata, 'results': results}, ensure_ascii=False, indent=2) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--native-binary')
    parser.add_argument('--python', default=sys.executable)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--repeats', type=int, choices=range(1, 4), default=2)
    parser.add_argument('--models', nargs='+', choices=['base', 'small', 'parakeet-v3', 'detection'],
                        default=['base', 'small', 'parakeet-v3', 'detection'])
    parser.add_argument('--worker', choices=['base', 'small', 'parakeet-v3', 'detection'])
    parser.add_argument('--validate-only', action='store_true')
    args = parser.parse_args()
    load_cohort(args.manifest)
    if args.output.resolve().is_relative_to(ROOT):
        parser.error('Generated evidence must stay outside the checkout')
    if args.validate_only:
        print(json.dumps({'cohortValidated': True, 'sha256': digest(args.manifest)}))
        return
    if args.worker:
        sys.path.insert(0, str(ROOT / 'packages/transcription'))
        from worker_lifecycle import worker_entrypoint
        with worker_entrypoint():
            worker(args)
        return
    if sys.platform != 'darwin' or platform.machine() != 'arm64':
        parser.error('Research cohort requires Apple Silicon and macOS outbound sandbox')
    if 'parakeet-v3' in args.models and (not args.native_binary or not Path(args.native_binary).is_file()):
        parser.error('Provide the existing native binary; no implicit fallback')
    args.output.mkdir(parents=True, exist_ok=True)
    spec = importlib.util.spec_from_file_location('measure', ROOT / 'scripts/check-real-time-resources.py')
    measure = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(measure)
    replay_spec = importlib.util.spec_from_file_location('replay', Path(__file__).with_name('evaluate-live-languages.py'))
    replay = importlib.util.module_from_spec(replay_spec)
    replay_spec.loader.exec_module(replay)
    reports = []
    for model in args.models:
        output = args.output / (model + '.json')
        command = ['/usr/bin/sandbox-exec', '-p', '(version 1) (allow default) (deny network-outbound)',
                   args.python, str(Path(__file__).resolve()), '--worker', model, '--manifest', str(args.manifest.resolve()),
                   '--output', str(output), '--repeats', str(args.repeats)]
        if args.native_binary:
            command += ['--native-binary', args.native_binary]
        env = dict(os.environ, HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', TOKENIZERS_PARALLELISM='false')
        with (args.output / (model + '.stderr.log')).open('wb') as diagnostics:
            child = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=diagnostics, env=env)
            samples = supervise(child, measure, replay, 1800)
        report = json.loads(output.read_text())
        report['resources'] = {'peakAggregateRssMiB': max((s['aggregateRssKiB'] / 1024 for s in samples), default=0),
                               'peakAggregateCpuPercent': max((s['aggregateCpuPercent'] for s in samples), default=0),
                               'sampleIntervalSeconds': .25, 'sharedMemoryDoubleCountingPossible': True,
                               'ownedProcessShutdownVerified': True}
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        reports.append({'model': model, 'file': output.name, 'sha256': digest(output)})
        print(json.dumps({'model': model, 'runs': len(report['results']), 'output': str(output)}), flush=True)
    (args.output / 'manifest.json').write_text(json.dumps({'hardware': measure.command_output(['sysctl', '-n', 'hw.model']),
        'memoryBytes': measure.command_output(['sysctl', '-n', 'hw.memsize']), 'macOS': platform.mac_ver()[0],
        'sourceCommit': measure.command_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD']),
        'evaluatorSha256': digest(__file__), 'cohortSha256': digest(args.manifest),
        'productionFileHashes': {name: digest(ROOT / 'packages/transcription' / name)
                                 for name in ['engines.py', 'native_worker.py', 'worker_lifecycle.py', 'meeting_language.py', 'live_language.py']},
        'physicalCapture': False, 'outboundNetworkDenied': True, 'reports': reports}, indent=2) + '\n')


if __name__ == '__main__':
    main()
