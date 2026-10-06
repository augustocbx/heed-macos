"""Release payload/runtime compatibility, without installing or starting Heed."""
import json
import contextlib
import io
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from unittest.mock import patch

import heed_release

ROOT = pathlib.Path(__file__).resolve().parents[2]


class ServiceIntegrationTest(unittest.TestCase):
    @contextlib.contextmanager
    def status_server(self, state):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                data = ({'service': 'heed-api', 'protocolVersion': 1,
                         'checkoutRoot': str(ROOT.resolve()), 'pid': os.getpid()}
                        if self.path == '/.well-known/heed-service' else state)
                body = json.dumps(data).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                try:
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def log_message(self, *args):
                pass

        for port in range(49010, 49110):
            try:
                server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
                break
            except OSError:
                continue
        else:
            self.fail('No isolated test port is available')
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield SimpleNamespace(api_port=port, root=str(ROOT))
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = pathlib.Path(self.temp.name)
        self.env = {key: value for key, value in os.environ.items()
                    if key not in ('PORT', 'HEED_API_PORT', 'HEED_UI_PORT', 'HEED_TRANSCRIPTION_PORT',
                                   'HEED_SERVICE_CONFIG_ROOT')}
        self.env.update(HOME=str(self.directory), HEED_APP_DIR=str(self.directory / 'app'))
        self.environment = patch.dict(os.environ, self.env, clear=True)
        self.environment.start()

    def tearDown(self):
        self.environment.stop()
        self.temp.cleanup()

    def ports(self, **environment):
        return subprocess.run([sys.executable, str(ROOT / 'scripts/release/heed_release.py'), 'ports'],
                              env={**self.env, **environment}, capture_output=True, text=True)

    def test_release_resolves_saved_ports_and_explicit_overrides(self):
        self.assertEqual(self.ports().stdout.strip(), '48100 48101 48102')
        app = pathlib.Path(self.env['HEED_APP_DIR'])
        app.mkdir()
        (app / 'service-ports.json').write_text(json.dumps({'version': 1, 'api': 48210, 'ui': 48211, 'transcription': 48212}))
        self.assertEqual(self.ports().stdout.strip(), '48210 48211 48212')
        self.assertEqual(self.ports(HEED_API_PORT='48310', PORT='48310').stdout.strip(), '48310 48211 48212')
        result = subprocess.run([sys.executable, str(ROOT / 'scripts/release/heed_release.py'), 'ports', '--saved'],
                                env={**self.env, 'HEED_API_PORT': '48310'}, capture_output=True, text=True)
        self.assertEqual(result.stdout.strip(), '48210 48211 48212')
        for environment in [{'HEED_API_PORT': '5001'}, {'HEED_API_PORT': '48310', 'PORT': '48311'},
                            {'HEED_UI_PORT': '48210'}]:
            self.assertNotEqual(self.ports(**environment).returncode, 0)
        (app / 'service-ports.json').write_text('corrupt')
        self.assertNotEqual(self.ports().returncode, 0)

    def test_packaged_cleanup_preserves_native_runtime_dependencies(self):
        payload = self.directory / 'payload'
        (payload / 'scripts/release').mkdir(parents=True)
        (payload / 'config').mkdir()
        for name in ['service_config.py', 'service_runtime.py', 'service_diagnostics.py', 'postmortem.py']:
            shutil.copyfile(ROOT / 'scripts' / name, payload / 'scripts' / name)
        shutil.copyfile(ROOT / 'config/service-ports.json', payload / 'config/service-ports.json')
        shutil.copyfile(ROOT / 'scripts/release/heed_release.py', payload / 'scripts/release/heed_release.py')
        script = (ROOT / 'scripts/release/build-release.sh').read_text()
        cleanup = script.split('# Development material that the installed app never reads.\n', 1)[1].split("printf '> Installing build dependencies", 1)[0]
        result = subprocess.run(['bash', '-e', '-c', cleanup], cwd=payload, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        for name in ['service_config.py', 'service_runtime.py', 'service_diagnostics.py']:
            self.assertTrue((payload / 'scripts' / name).is_file(), name)
        self.assertFalse((payload / 'scripts/postmortem.py').exists())
        result = subprocess.run([sys.executable, '-c', 'import service_config,service_runtime,service_diagnostics;print(service_config.service_config())'],
                                cwd=payload / 'scripts', env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        # A copied uninstall helper must still resolve the installed payload's configuration.
        shutil.copyfile(payload / 'scripts/release/heed_release.py', self.directory / 'heed_release.py')
        result = subprocess.run([sys.executable, str(self.directory / 'heed_release.py'), 'ports'],
                                env={**self.env, 'HEED_SERVICE_CONFIG_ROOT': str(payload)}, capture_output=True, text=True)
        self.assertEqual(result.stdout.strip(), '48100 48101 48102', result.stderr)

    def test_release_readiness_rejects_a_proxy_with_only_matching_version(self):
        version = {'app': 'heed', 'component': 'api', 'version': '1.2.0', 'commit': 'abc'}
        with patch.object(heed_release, 'fetch_json', return_value=(200, version, '')), \
             patch.object(heed_release, 'service_identity', return_value=None, create=True):
            result = heed_release.check_services('1.2.0', 48110, 48111, 48112, 'abc')
        self.assertIsNotNone(result['Interface'])

    def test_invalid_port_zero_cannot_fall_back_to_default(self):
        result = subprocess.run([sys.executable, str(ROOT / 'scripts/release/heed_release.py'),
                                 'busy', '--api-port', '0'], env=self.env, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)

    def test_upgrade_guard_keeps_its_checkout_and_rollback_owner(self):
        script = (ROOT / 'scripts/release/install.sh').read_text()
        stage = self.directory / 'stage'
        previous = self.directory / 'previous'
        guard = stage / 'packages/desktop/guard-lifecycle.py'
        guard.parent.mkdir(parents=True)
        token = self.directory / 'token'
        guard.write_text('import os,pathlib,sys\npathlib.Path(os.environ["TOKEN_FILE"]).write_text(os.environ.get("HEED_LIFECYCLE_GUARD_TOKEN", ""))\nsys.exit(1)\n')
        helper = self.directory / 'helper.py'
        helper.write_text('pass\n')
        fragment = script[script.index('# The guard imports'):script.index('export HEED_LIFECYCLE_GUARD_TOKEN=')]
        environment = {**self.env, 'HEED_STAGE': str(stage), 'HEED_PREVIOUS_DIR': str(previous),
                       'HEED_LEGACY_ROOT': '', 'HEED_HELPER': str(helper), 'HEED_LIFECYCLE_GUARD_TOKEN': 'original-owner',
                       'TOKEN_FILE': str(token), 'HEED_VERSION': '1.2.0'}
        result = subprocess.run(['bash', '-eu', '-c', fragment + '\nprintf "%s" "$HEED_GUARD_SCRIPT"'],
                                env=environment, capture_output=True, text=True)
        self.assertEqual(result.stdout, str(previous / 'packages/desktop/guard-lifecycle.py'))
        rollback = script.split('rollback() {', 1)[1].split("\nstep 'Stopping the running Heed services'", 1)[0]
        result = subprocess.run(['bash', '-eu', '-c', 'rollback() {' + rollback + '\nrollback'],
                                env=environment, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(token.read_text(), 'original-owner')

    def test_stop_refuses_an_unrelated_listener_inside_the_checkout(self):
        from types import SimpleNamespace
        arguments = SimpleNamespace(root=[str(ROOT)], ports=[48110], timeout=0)
        with patch.object(heed_release, 'listener_pids', return_value=[123456]), \
             patch.object(heed_release, 'process_cwd', return_value=str(ROOT)), \
             patch.object(heed_release.subprocess, 'run', return_value=SimpleNamespace(stdout='ruby unrelated.rb')), \
             patch.object(heed_release.os, 'kill') as kill:
            self.assertEqual(heed_release.command_stop_services(arguments), 2)
            kill.assert_not_called()

    def test_committed_permission_failure_releases_installers_guard(self):
        script = (ROOT / 'scripts/release/install.sh').read_text()
        current = self.directory / 'current'
        guard = current / 'packages/desktop/guard-lifecycle.py'
        guard.parent.mkdir(parents=True)
        result_file = self.directory / 'released'
        guard.write_text('import os,pathlib,sys\npathlib.Path(os.environ["RESULT_FILE"]).write_text(sys.argv[1])\n')
        temporary = self.directory / 'download'
        temporary.mkdir()
        cleanup = script.split('cleanup() {', 1)[1].split('\ntrap cleanup EXIT', 1)[0]
        result = subprocess.run(['bash', '-u', '-c', 'cleanup() {' + cleanup + '\n(exit 3)\ncleanup'],
                                env={**self.env, 'HEED_CURRENT': str(current), 'HEED_TEMP': str(temporary),
                                     'HEED_GUARD_HELD': '1', 'HEED_COMMITTED': '1', 'RESULT_FILE': str(result_file)},
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(result_file.exists(), 'Permission failure must not strand the install-owned maintenance guard')
        self.assertEqual(result_file.read_text(), 'release')

    def test_rollback_restores_saved_ports_before_restarting_previous_version(self):
        script = (ROOT / 'scripts/release/install.sh').read_text()
        stage = self.directory / 'stage'
        (stage / 'scripts').mkdir(parents=True)
        (stage / 'config').mkdir()
        shutil.copyfile(ROOT / 'scripts/service_config.py', stage / 'scripts/service_config.py')
        shutil.copyfile(ROOT / 'config/service-ports.json', stage / 'config/service-ports.json')
        guard = stage / 'packages/desktop/guard-lifecycle.py'
        guard.parent.mkdir(parents=True)
        guard.write_text('pass\n')
        helper = self.directory / 'helper.py'
        helper.write_text('import os,sys,json,pathlib\n'
                          'if sys.argv[1] == "wait-api":\n'
                          ' pathlib.Path(os.environ["WAIT_PORTS"]).write_text(json.dumps({key:os.environ[key] for key in ["HEED_API_PORT","PORT"]}))\n'
                          'if sys.argv[1] in ["busy","wait-api"]:sys.exit(0)\n'
                          f'sys.path.insert(0,{str(ROOT / "scripts/release")!r})\n'
                          'import heed_release\nraise SystemExit(heed_release.main())\n')
        app = pathlib.Path(self.env['HEED_APP_DIR'])
        app.mkdir()
        preferences = app / 'service-ports.json'
        preferences.write_text(json.dumps({'version': 1, 'api': 48310, 'ui': 48311, 'transcription': 48312}))
        backup = self.directory / 'backup'
        backup.mkdir()
        rollback = script.split('rollback() {', 1)[1].split("\nstep 'Stopping the running Heed services'", 1)[0]
        environment = {**self.env, 'HEED_STAGE': str(stage), 'HEED_HELPER': str(helper),
                       'HEED_PREVIOUS_PORTS': '48210 48211 48212', 'HEED_PREVIOUS_DIR': str(self.directory / 'old'),
                       'HEED_BACKUP': str(backup), 'HEED_APP': str(self.directory / 'app-bundle'),
                       'HEED_AGENT': str(self.directory / 'agent'), 'HEED_HOME': str(self.directory),
                       'HEED_GUARD_HELD': '1', 'HEED_GUARD_SCRIPT': str(guard), 'HEED_LEGACY_ROOT': '',
                       'WAIT_PORTS': str(self.directory / 'wait-ports'),
                       'HEED_VERSION': '1.2.0', 'HEED_API_PORT': '48310', 'PORT': '48310',
                       'HEED_UI_PORT': '48311', 'HEED_TRANSCRIPTION_PORT': '48312'}
        result = subprocess.run(['bash', '-eu', '-c', 'stop_heed() { return 0; }\nswitch_current() { return 0; }\nrollback() {' + rollback + '\nrollback'],
                                env=environment, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(preferences.read_text()), {'version': 1, 'api': 48210, 'ui': 48211, 'transcription': 48212})
        # No original file: undo only the installer's exact file and use the original defaults.
        preferences.write_text(json.dumps({'version': 1, 'api': 48310, 'ui': 48311, 'transcription': 48312}))
        environment.update(HEED_PRIOR_PORTS_EXISTED='0', HEED_PREVIOUS_PORTS='48100 48101 48102')
        result = subprocess.run(['bash', '-eu', '-c', 'stop_heed() { return 0; }\nswitch_current() { return 0; }\nrollback() {' + rollback + '\nrollback'],
                                env=environment, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(preferences.exists())
        self.assertEqual(json.loads((self.directory / 'wait-ports').read_text()), {'HEED_API_PORT': '48100', 'PORT': '48100'})

    def test_rollback_api_wait_requires_identity_before_guard_release(self):
        from types import SimpleNamespace
        arguments = SimpleNamespace(api_port=48110, root=str(ROOT), timeout=0, interval=0.1)
        with patch.object(heed_release, 'service_identity', return_value=None):
            self.assertEqual(heed_release.command_wait_api(arguments), 1)
        with patch.object(heed_release, 'service_identity', return_value={'service': 'heed-api'}):
            self.assertEqual(heed_release.command_wait_api(arguments), 0)

    def test_unbound_services_keep_the_full_startup_budget(self):
        with patch.object(heed_release, 'fetch_json', return_value=(None, None, '')), \
             patch.object(heed_release, 'service_identity', return_value=None):
            problems = heed_release.check_services('1.2.0', 48110, 48111, 48112, 'abc')
        self.assertEqual(set(problems.values()), {'not responding'})

    def test_busy_refuses_partial_state_and_an_unresponsive_listener(self):
        from types import SimpleNamespace
        arguments = SimpleNamespace(api_port=48110, root=str(ROOT))
        with patch.object(heed_release, 'fetch_json', return_value=(200, {'recording': False}, '')), \
             patch.object(heed_release, 'service_identity', return_value={'service': 'heed-api'}):
            self.assertEqual(heed_release.command_busy(arguments), 2)
        with patch.object(heed_release, 'fetch_json', return_value=(None, None, '')), \
             patch.object(heed_release, 'listener_pids', return_value=[123456]):
            self.assertEqual(heed_release.command_busy(arguments), 2)
        diagnostics = io.StringIO()
        old_owned = {key: False for key in heed_release.BUSY_KEYS if key != 'audioWork'}
        with patch.object(heed_release, 'fetch_json', return_value=(200, old_owned, '')), \
             patch.object(heed_release, 'service_identity', return_value={'service': 'heed-api'}), \
             contextlib.redirect_stderr(diagnostics):
            self.assertEqual(heed_release.command_busy(arguments), 2)
        self.assertIn('incomplete or unsupported recording status', diagnostics.getvalue())
        self.assertNotIn('another application', diagnostics.getvalue())

    def test_idle_upgrade_accepts_a_status_with_a_long_saved_transcript(self):
        state = {'recording': False, 'processing': False, 'pending': False,
                 'starting': False, 'audioWork': False,
                 'session': {'transcript': 'Synthetic meeting transcript. ' * 6000}}
        with self.status_server(state) as arguments:
            self.assertEqual(heed_release.command_busy(arguments), 0)

    def test_long_status_still_refuses_active_audio_work(self):
        state = {'recording': False, 'processing': False, 'pending': False,
                 'starting': False, 'audioWork': True,
                 'session': {'transcript': 'Synthetic meeting transcript. ' * 6000}}
        with self.status_server(state) as arguments:
            self.assertEqual(heed_release.command_busy(arguments), 1)

    def test_oversized_status_remains_unknown(self):
        state = {'recording': False, 'processing': False, 'pending': False,
                 'starting': False, 'audioWork': False,
                 'session': {'transcript': 'x' * (20 * 1024 * 1024)}}
        with self.status_server(state) as arguments:
            self.assertEqual(heed_release.command_busy(arguments), 2)

    def test_restore_previous_absence_removes_only_the_installers_exact_ports(self):
        app = pathlib.Path(self.env['HEED_APP_DIR'])
        app.mkdir()
        path = app / 'service-ports.json'
        path.write_text(json.dumps({'version': 1, 'api': 48310, 'ui': 48311, 'transcription': 48312}))
        command = [sys.executable, str(ROOT / 'scripts/release/heed_release.py'), 'restore-port-absence']
        environment = {**self.env, 'HEED_API_PORT': '48310', 'HEED_UI_PORT': '48311', 'HEED_TRANSCRIPTION_PORT': '48312'}
        result = subprocess.run(command, env=environment, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(path.exists())
        path.write_text(json.dumps({'version': 1, 'api': 48410, 'ui': 48411, 'transcription': 48412}))
        before = path.read_bytes()
        result = subprocess.run(command, env=environment, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(path.read_bytes(), before)

    def test_pre_configuration_checkout_is_rejected_before_runtime_dependencies(self):
        script = (ROOT / 'scripts/release/install.sh').read_text()
        fragment = script.split('HEED_PREVIOUS_ROOT=', 1)[1].split('if [ -n "$HEED_PREVIOUS_DIR" ]; then\n    printf', 1)[0]
        previous = self.directory / 'previous'
        previous.mkdir()
        command = 'fail() { printf "%s" "$1" >&2; exit 1; }\nHEED_PREVIOUS_ROOT=' + fragment
        result = subprocess.run(['bash', '-eu', '-c', command],
                                env={**self.env, 'HEED_PREVIOUS_DIR': str(previous), 'HEED_LEGACY_ROOT': '',
                                     'HEED_PRIOR_PORTS_EXISTED': '0'}, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('latest install-macos.sh first', result.stderr)
        self.assertFalse(pathlib.Path(self.env['HEED_APP_DIR']).exists())

    def test_uninstall_config_root_requires_an_intact_recognized_payload(self):
        unknown = self.directory / 'unrelated'
        (unknown / 'scripts').mkdir(parents=True)
        (unknown / 'scripts/service_config.py').write_text('raise RuntimeError("must never be imported")\n')
        (unknown / 'package.json').write_text('{"name":"unrelated"}')
        with self.assertRaises(ValueError):
            heed_release.configuration_root([str(unknown)])
        payload = self.directory / 'payload'
        (payload / 'scripts').mkdir(parents=True)
        (payload / 'scripts/service_config.py').write_text('# Known payload fixture\n')
        (payload / 'release.json').write_text('{"app":"heed"}')
        self.assertEqual(heed_release.configuration_root([str(unknown), str(payload)]), str(payload.resolve()))
        (payload / 'release.json').unlink()
        (payload / 'package.json').write_text('{"name":"heed"}')
        self.assertEqual(heed_release.configuration_root([str(payload)]), str(payload.resolve()))

    def test_owned_release_requires_its_own_transcription_endpoint(self):
        command = [sys.executable, str(ROOT / 'scripts/release/heed_release.py'), 'ports', '--owned-release']
        for url in ['http://localhost:48102', 'http://127.0.0.1:48102']:
            result = subprocess.run(command, env={**self.env, 'HEED_TRANSCRIPTION_URL': url}, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
        for url in ['http://127.0.0.1:48202', 'https://localhost:48102', 'http://[::1]:48102']:
            result = subprocess.run(command, env={**self.env, 'HEED_TRANSCRIPTION_URL': url}, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('own versioned transcription service', result.stderr)
            self.assertNotIn(url, result.stderr)

    def test_external_transcription_rejection_precedes_dependency_effects(self):
        script = (ROOT / 'scripts/release/install.sh').read_text()
        fragment = 'HEED_VALIDATED_PORTS=' + script.split('HEED_VALIDATED_PORTS=', 1)[1].split('\nHEED_VERSION=', 1)[0]
        sentinel = self.directory / 'dependency-effects'
        sentinel.write_text('unchanged')
        result = subprocess.run(['bash', '-eu', '-c', 'fail() { printf "%s" "$1" >&2; exit 1; }\n' + fragment + '\nprintf changed > "$SENTINEL"'],
                                env={**self.env, 'HEED_HELPER': str(ROOT / 'scripts/release/heed_release.py'),
                                     'HEED_TRANSCRIPTION_URL': 'http://127.0.0.1:48202', 'SENTINEL': str(sentinel)},
                                capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(sentinel.read_text(), 'unchanged')


if __name__ == '__main__':
    unittest.main()
