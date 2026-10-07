"""Permission recovery tests never change real permissions or restart an installed app."""
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / 'packages/desktop/permission-recovery.py'


class RecoveryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location('permission_recovery', HELPER)
        cls.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.module)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.app = Path(self.temporary.name) / 'Heed.app'
        resources = self.app / 'Contents/Resources'
        resources.mkdir(parents=True)
        (resources / 'heed-home.txt').write_text(str(Path(self.temporary.name) / 'installation'))
        (resources / 'heed-root.txt').write_text(str(ROOT))
        executable = self.app / 'Contents/MacOS/Heed'
        executable.parent.mkdir(); executable.touch()
        with (self.app / 'Contents/Info.plist').open('wb') as file:
            plistlib.dump({'CFBundleIdentifier': 'local.heed.menubar', 'CFBundleExecutable': 'Heed'}, file)
        self.command = '12345678-1234-1234-1234-123456789abc'
        self.context = self.module.Context(ROOT, self.app, 123, self.command)
        self.runtime = FakeRuntime(self.context)

    def recover(self):
        return self.module.recover(self.context, self.runtime)

    def test_lifecycle_requests_use_lean_summaries_without_transcript_reads(self):
        self.recover()
        status = [path for path in self.runtime.paths if path.startswith('/api/desktop/control/status')]
        maintenance = [path for path in self.runtime.paths if path.startswith('/api/recording/maintenance')]
        self.assertGreaterEqual(len(status), 3)
        self.assertEqual(set(status), {'/api/desktop/control/status?summary=1'})
        self.assertEqual(set(maintenance), {'/api/recording/maintenance?summary=1'})

    def test_all_http_responses_are_bounded_even_for_lifecycle_summaries(self):
        body = json.dumps({'unexpected': 'synthetic '*9000}).encode()
        runtime = self.module.Runtime()
        class Response:
            status = 200
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, limit): return body[:limit]
        class Opener:
            def open(self, request, timeout): return Response()
        runtime.opener = Opener()
        for path in ['/api/desktop/control/status?summary=1', '/api/recording/maintenance?summary=1', '/api/desktop/permissions']:
            with self.subTest(path=path):
                with self.assertRaises(self.module.RecoveryError): runtime.request(path)

    def test_nondefault_installed_data_directory_selects_the_saved_api_port(self):
        data = Path(self.temporary.name) / 'data'; data.mkdir()
        (data / 'service-ports.json').write_text(json.dumps({'version':1, 'api':48113, 'ui':48114, 'transcription':48115}))
        (self.app / 'Contents/Resources/heed-app-dir.txt').write_text(str(data))
        with patch.dict(os.environ, {}, clear=True):
            runtime = self.module.Runtime(self.context)
        self.assertEqual(runtime.base, 'http://127.0.0.1:48113')

    def test_invalid_command_or_bundle_root_never_resets(self):
        self.context.command = 'not-a-uuid'
        with self.assertRaises(self.module.RecoveryError): self.recover()
        self.assertEqual(self.runtime.events, [])
        self.context.command = self.command
        (self.app / 'Contents/Resources/heed-root.txt').write_text('/other-checkout')
        with self.assertRaises(self.module.RecoveryError): self.recover()
        self.assertEqual(self.runtime.events, [])

    def test_generic_errors_do_not_expose_worker_details(self):
        self.runtime.fail = 'reset'
        with self.assertRaises(self.module.RecoveryError) as raised: self.recover()
        self.assertEqual(str(raised.exception), self.module.ERROR)
        self.assertNotIn('private injected', str(raised.exception))

    def test_reset_is_scoped_and_only_after_both_guards(self):
        result = self.recover()
        self.assertEqual(result, {'restarted': True, 'authorized': False})
        self.assertEqual(self.runtime.events, ['lock', 'acquire', 'reset', 'ready', 'old-exit', 'open', 'fresh', 'release', 'unlock'])
        self.assertEqual(self.runtime.commands[0], ['/usr/bin/tccutil', 'reset', 'ScreenCapture', 'local.heed.menubar'])
        self.assertEqual(self.runtime.commands[1], ['/usr/bin/open', '-n', str(self.app), '--args', '--resume-screen-capture-recovery', self.command])
        self.assertNotIn('transactionId', self.runtime.bodies[0])

    def test_fresh_authorization_is_the_only_granted_result(self):
        self.runtime.granted = True
        self.assertTrue(self.recover()['authorized'])

    def test_reset_failure_releases_guards_without_restarting(self):
        self.runtime.fail = 'reset'
        with self.assertRaises(self.module.RecoveryError): self.recover()
        self.assertEqual(self.runtime.events[-2:], ['release', 'unlock'])
        self.assertNotIn('ready', self.runtime.events)
        self.assertNotIn('open', self.runtime.events)

    def test_open_failure_releases_guards(self):
        self.runtime.fail = 'open'
        with self.assertRaises(self.module.RecoveryError): self.recover()
        self.assertEqual(self.runtime.events[-2:], ['release', 'unlock'])

    def test_old_process_timeout_never_launches_another_instance(self):
        self.runtime.fail = 'old-exit'
        with self.assertRaises(self.module.RecoveryError): self.recover()
        self.assertNotIn('open', self.runtime.events)
        self.assertEqual(self.runtime.events[-2:], ['release', 'unlock'])

    def test_stale_or_missing_new_report_times_out_and_releases(self):
        for failure in ['stale-report', 'same-instance', 'pending-report']:
            with self.subTest(failure=failure):
                self.runtime = FakeRuntime(self.context); self.runtime.fail = failure
                with self.assertRaises(self.module.RecoveryError): self.recover()
                self.assertEqual(self.runtime.events[-2:], ['release', 'unlock'])

    def test_foreign_pid_bundle_or_api_is_rejected_before_any_control(self):
        for failure in ['foreign-pid', 'foreign-api']:
            with self.subTest(failure=failure):
                self.runtime = FakeRuntime(self.context); self.runtime.fail = failure
                with self.assertRaises(self.module.RecoveryError): self.recover()
                self.assertEqual(self.runtime.events, [])
        with (self.app / 'Contents/Info.plist').open('wb') as file:
            plistlib.dump({'CFBundleIdentifier': 'other.app', 'CFBundleExecutable': 'Heed'}, file)
        with self.assertRaises(self.module.RecoveryError): self.recover()
        self.assertEqual(self.runtime.events, [])

    def test_changed_command_or_busy_work_is_rejected_without_reset(self):
        for failure in ['wrong-command', 'recording', 'processing', 'starting', 'pending', 'audioWork', 'maintenance', 'processingKinds', 'updateTransactionId']:
            with self.subTest(failure=failure):
                self.runtime = FakeRuntime(self.context); self.runtime.fail = failure
                with self.assertRaises(self.module.RecoveryError): self.recover()
                self.assertNotIn('reset', self.runtime.events)

    def test_duplicate_or_updater_lock_contention_does_not_release_foreign_guard(self):
        self.runtime.fail = 'lock'
        with self.assertRaises(self.module.RecoveryError): self.recover()
        self.assertNotIn('acquire', self.runtime.events)
        self.assertNotIn('release', self.runtime.events)

    def test_failed_admission_releases_only_attempted_owner_and_never_resets(self):
        self.runtime.fail = 'acquire'
        with self.assertRaises(self.module.RecoveryError): self.recover()
        self.assertNotIn('reset', self.runtime.events)
        self.assertEqual(self.runtime.bodies[-1], {'acquire': False, 'owner': 'permission-recovery-' + self.command})

    def test_new_foreign_update_lease_is_never_released(self):
        self.runtime.fail = 'foreign-lease'
        with self.assertRaises(self.module.RecoveryError): self.recover()
        self.assertNotIn('release', self.runtime.events)
        self.assertEqual(self.runtime.events[-1], 'unlock')

    def test_parent_must_still_be_running_before_reset(self):
        self.runtime.fail = 'parent-exit'
        with self.assertRaises(self.module.RecoveryError): self.recover()
        self.assertNotIn('reset', self.runtime.events)
        self.assertEqual(self.runtime.events[-2:], ['release', 'unlock'])

    def test_menu_lock_timeout_does_not_launch_a_duplicate(self):
        self.runtime.fail = 'menu-lock'
        with self.assertRaises(self.module.RecoveryError): self.recover()
        self.assertNotIn('open', self.runtime.events)
        self.assertEqual(self.runtime.events[-2:], ['release', 'unlock'])

    def test_second_status_check_closes_the_admission_race(self):
        self.runtime.fail = 'race'
        with self.assertRaises(self.module.RecoveryError): self.recover()
        self.assertNotIn('reset', self.runtime.events)
        self.assertEqual(self.runtime.events[-1], 'unlock')

    def test_subprocess_emits_ready_before_exit_then_completion(self):
        # Run the actual module in a separate interpreter with only platform operations replaced.
        harness = '''import importlib.util, json, sys
sys.path.insert(0, str(__import__('pathlib').Path(sys.argv[1]) / 'scripts'))
from service_permission_recovery_test import FakeRuntime
spec=importlib.util.spec_from_file_location('recovery',sys.argv[1]+'/packages/desktop/permission-recovery.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
c=m.Context(m.Path(sys.argv[1]),m.Path(sys.argv[2]),123,sys.argv[3])
r=FakeRuntime(c)
original_emit=r.emit
def emit(value): original_emit(value);print(json.dumps(value),flush=True)
r.emit=emit
print(json.dumps(m.recover(c,r)),flush=True)
'''
        harness = harness.replace("Path(sys.argv[1]) / 'scripts'", "Path(sys.argv[1]) / 'scripts'")
        result = subprocess.run([sys.executable, '-c', harness, str(ROOT), str(self.app), self.command], capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([json.loads(line) for line in result.stdout.splitlines()], [{'readyToRestart': True}, {'restarted': True, 'authorized': False}])


class FakeRuntime:
    def __init__(self, context):
        self.context = context; self.events = []; self.commands = []; self.bodies = []; self.paths = []
        self.fail = None; self.granted = False; self.elapsed = 0; self.opened = False; self.status_reads = 0
    def now(self): return 1000 + self.elapsed
    def monotonic(self): return self.elapsed
    def sleep(self, seconds): self.elapsed += seconds
    def process_state(self, pid, executable):
        if self.fail == 'foreign-pid': return 'foreign'
        if self.fail == 'parent-exit' and 'acquire' in self.events: return 'absent'
        if 'ready' not in self.events: return 'expected'
        if self.fail == 'old-exit': return 'expected'
        if 'old-exit' not in self.events: self.events.append('old-exit')
        return 'absent'
    def menu_available(self): return self.fail != 'menu-lock'
    @contextlib.contextmanager
    def installation_lock(self, home):
        if self.fail == 'lock': raise ValueError('private injected lock detail')
        self.events.append('lock')
        try: yield
        finally: self.events.append('unlock')
    def emit(self, data): self.events.append('ready')
    def run(self, command, timeout):
        kind = 'reset' if command[0] == '/usr/bin/tccutil' else 'open'
        self.commands.append(command); self.events.append(kind)
        if self.fail == kind: raise OSError('private injected worker detail')
        if kind == 'open': self.opened = True
    def request(self, path, body=None):
        self.paths.append(path)
        path = path.split('?', 1)[0]
        if path == '/.well-known/heed-service':
            return {'service': 'other' if self.fail == 'foreign-api' else 'heed-api', 'protocolVersion': 1, 'checkoutRoot': str(self.context.root), 'pid': 456}
        if path == '/api/desktop/control/status':
            self.status_reads += 1
            data = {key: False for key in ['recording','processing','starting','pending','audioWork','maintenance']}
            data.update(processingKinds=[], updateTransactionId=None, maintenanceProtocol=2,
                        permissionRequest={'id':self.context.command, 'action':'recoverScreenCapture'})
            if self.fail == 'wrong-command': data['permissionRequest']['id'] = 'other'
            if self.fail in data: data[self.fail] = ['active'] if self.fail == 'processingKinds' else 'foreign' if self.fail == 'updateTransactionId' else True
            if self.fail == 'race' and self.status_reads > 1: data['recording'] = True
            if self.fail == 'foreign-lease' and self.opened: data['updateTransactionId'] = 'foreign'
            return data
        if path == '/api/recording/maintenance':
            self.bodies.append(body); self.events.append('acquire' if body['acquire'] else 'release')
            if self.fail == 'acquire' and body['acquire']: raise OSError('foreign owner')
            return {'maintenance':body['acquire'], 'maintenanceProtocol':2, 'updateTransactionId':None}
        if path == '/api/desktop/permissions':
            if self.opened and 'fresh' not in self.events: self.events.append('fresh')
            return {'controllerConnected':True, 'updatedAt':(self.now()-100 if self.fail == 'stale-report' else self.now())*1000,
                    'build':{'instanceId':'old' if not self.opened or self.fail == 'same-instance' else 'new'},
                    'pending':self.fail == 'pending-report', 'permissions':{'screenCapture':self.granted}}
        raise AssertionError(path)


if __name__ == '__main__': unittest.main()
