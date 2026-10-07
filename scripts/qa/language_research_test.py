import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import wave
import hashlib
import subprocess
import sys
import types
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('research', Path(__file__).with_name('language_research.py'))


class LanguageResearchTests(unittest.TestCase):
    def module(self):
        self.assertTrue(SPEC.origin and Path(SPEC.origin).exists(), 'Research evaluator is missing')
        module = importlib.util.module_from_spec(SPEC)
        SPEC.loader.exec_module(module)
        return module

    def test_uncertain_detection_does_not_invent_an_english_fallback(self):
        module = self.module()
        self.assertEqual(module.research_decision([])['language'], None)
        self.assertEqual(module.research_decision([{'fr': .45, 'de': .44, 'en': .1}])['language'], None)
        result = module.research_decision([{'fr': .92, 'en': .03}, {'fr': .9, 'en': .04}])
        self.assertEqual(result['language'], 'fr')
        self.assertEqual(result['samples'], 2)
        self.assertGreater(result['confidence'], .9)
        self.assertEqual(module.research_decision([{'es': .99, 'fr': .01}])['language'], None)

    def test_cohort_verifies_content_hash_format_and_actual_duration(self):
        module = self.module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            audio = root / 'public.wav'
            with wave.open(str(audio), 'wb') as output:
                output.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
                output.writeframes(b'\0\0' * 16000)
            entry = {'id': 'public', 'file': 'public.wav', 'sha256': hashlib.sha256(audio.read_bytes()).hexdigest(),
                     'seconds': 1, 'language': 'fr', 'reference': 'Bonjour', 'license': 'CC-BY-4.0'}
            manifest = root / 'manifest.json'
            def save():
                manifest.write_text(json.dumps({'schemaVersion': 1, 'fixtures': [entry]}))
            save()
            self.assertEqual(module.load_cohort(manifest)['fixtures'][0]['seconds'], 1)
            entry['seconds'] = 2
            save()
            with self.assertRaisesRegex(ValueError, 'duration'):
                module.load_cohort(manifest)
            entry['seconds'] = 1
            entry['file'] = '../public.wav'
            save()
            with self.assertRaisesRegex(ValueError, 'directory'):
                module.load_cohort(manifest)

    def test_invalid_detection_scores_fail_instead_of_reporting_confidence(self):
        module = self.module()
        for scores in [[{'fr': float('nan')}], [{'fr': -1}], [{'fr': 2}], ['fr']]:
            with self.assertRaises(ValueError):
                module.research_decision(scores)

    def test_cached_weights_uses_resolved_snapshot_outside_default_cache(self):
        module = self.module()
        with tempfile.TemporaryDirectory() as directory:
            snapshot = Path(directory) / 'custom-hf-home' / 'revision'
            snapshot.mkdir(parents=True)
            (snapshot / 'weights.npz').write_bytes(b'public synthetic weight identity')
            hub = types.SimpleNamespace(snapshot_download=lambda repository, **kwargs: str(snapshot))
            live = types.SimpleNamespace(MLX_REPOS={'tiny': 'test/tiny'})
            with patch.dict(sys.modules, {'huggingface_hub': hub, 'live_language': live}):
                result = module.cached_weights('tiny')
            self.assertEqual(result['snapshotPath'], str(snapshot.resolve()))
            self.assertEqual(result['revision'], 'revision')
            self.assertEqual(result['bytes'], (snapshot / 'weights.npz').stat().st_size)

    def test_failed_worker_still_verifies_owned_process_retirement(self):
        module = self.module()
        self.assertTrue(callable(getattr(module, 'supervise', None)), 'Worker supervision is missing')
        checks = []
        measure = types.SimpleNamespace(process_sample=lambda pid: {'pid': pid})
        replay = types.SimpleNamespace(owned_identities=lambda pid: {pid: {'pid': pid}},
            process_identities=lambda: {}, surviving_owned=lambda owned, present: checks.append(owned) or [])
        child = subprocess.Popen([sys.executable, '-c', 'raise SystemExit(7)'])
        self.addCleanup(lambda: (child.kill() if child.poll() is None else None, child.wait(timeout=5)))
        with self.assertRaisesRegex(RuntimeError, 'failed'):
            module.supervise(child, measure, replay, 5)
        self.assertEqual(child.returncode, 7)
        self.assertEqual(len(checks), 1)
        self.assertIn(child.pid, checks[0])

    def test_timed_out_worker_is_reaped_and_audited(self):
        module = self.module()
        self.assertTrue(callable(getattr(module, 'supervise', None)), 'Worker supervision is missing')
        checks = []
        measure = types.SimpleNamespace(process_sample=lambda pid: {'pid': pid})
        replay = types.SimpleNamespace(owned_identities=lambda pid: {pid: {'pid': pid}},
            process_identities=lambda: {}, surviving_owned=lambda owned, present: checks.append(owned) or [])
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(10)'])
        self.addCleanup(lambda: (child.kill() if child.poll() is None else None, child.wait(timeout=5)))
        with self.assertRaises(TimeoutError):
            module.supervise(child, measure, replay, .1)
        self.assertIsNotNone(child.returncode)
        self.assertEqual(len(checks), 1)


if __name__ == '__main__':
    unittest.main()
