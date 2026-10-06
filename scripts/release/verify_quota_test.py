"""Focused quota verification with isolated files and loopback HTTP responders."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


ROOT = Path(__file__).resolve().parents[2]
VERIFIER = Path(__file__).with_name('verify_quota.py')


class QuotaVerificationTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)
        self.config = self.directory / 'config.json'
        self.expected = 3_000_000_000
        self.config.write_text(json.dumps({'storage_limit_bytes': self.expected, 'ui_locale': 'pt-BR'}))
        self.responses = {
            '/api/storage': {'limitBytes': self.expected},
            '/api/desktop/control/status': {'storage': {'limitBytes': self.expected}},
        }
        self.requests = []
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                owner.requests.append((self.command, self.path))
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps(owner.responses[self.path]).encode())

            def log_message(self, *_args):
                pass

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f'http://127.0.0.1:{self.server.server_port}'

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temporary.cleanup()

    def verify(self, api=True):
        arguments = [sys.executable, str(VERIFIER), '--config', str(self.config),
                     '--expected-bytes', str(self.expected)]
        if api:
            arguments += ['--api-base', self.base]
        return subprocess.run(arguments, capture_output=True, text=True, timeout=10)

    def test_matching_custom_quota_checks_both_consumers_without_changing_files(self):
        before = {path.name: path.read_bytes() for path in self.directory.iterdir()}
        result = self.verify()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.requests, [('GET', '/api/storage'), ('GET', '/api/desktop/control/status')])
        self.assertEqual({path.name: path.read_bytes() for path in self.directory.iterdir()}, before)

    def test_default_reset_at_any_boundary_is_rejected(self):
        for boundary in ['config', 'storage', 'desktop']:
            with self.subTest(boundary=boundary):
                self.config.write_text(json.dumps({'storage_limit_bytes': self.expected}))
                self.responses['/api/storage']['limitBytes'] = self.expected
                self.responses['/api/desktop/control/status']['storage']['limitBytes'] = self.expected
                if boundary == 'config':
                    self.config.write_text(json.dumps({'storage_limit_bytes': 2_000_000_000}))
                elif boundary == 'storage':
                    self.responses['/api/storage']['limitBytes'] = 2_000_000_000
                else:
                    self.responses['/api/desktop/control/status']['storage']['limitBytes'] = 2_000_000_000
                result = self.verify()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('does not match', result.stderr)

    def test_missing_or_noninteger_persisted_value_cannot_pass(self):
        for value in [None, str(self.expected), float(self.expected), True]:
            with self.subTest(value=value):
                self.config.write_text(json.dumps({'storage_limit_bytes': value}))
                self.assertNotEqual(self.verify(api=False).returncode, 0)

    def test_actual_initializer_defaults_missing_field_and_preserves_custom_choice(self):
        environment = {**os.environ, 'HEED_APP_DIR': str(self.directory)}
        bun = environment.get('HEED_TEST_BUN') or shutil.which('bun') or str(Path.home() / '.bun/bin/bun')
        initializer = ROOT / 'scripts/init-managed-quota.ts'
        for configured, expected in [(None, 2_000_000_000), (3_000_000_000, 3_000_000_000)]:
            with self.subTest(configured=configured):
                original = {'ui_locale': 'pt-BR', 'ollama_model': 'synthetic-local'}
                if configured is not None:
                    original['storage_limit_bytes'] = configured
                self.config.write_text(json.dumps(original))
                for _attempt in range(2):
                    result = subprocess.run([bun, str(initializer)], env=environment,
                                            capture_output=True, text=True, timeout=10)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.expected = expected
                    self.assertEqual(self.verify(api=False).returncode, 0)
                    self.assertEqual(json.loads(self.config.read_text()),
                                     {**original, 'storage_limit_bytes': expected})
        self.assertEqual(self.requests, [])


if __name__ == '__main__':
    unittest.main()
