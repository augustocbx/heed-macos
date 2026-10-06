import json
import os
import pathlib
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
import importlib
import time
from unittest.mock import patch
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = pathlib.Path(__file__).resolve().parent.parent

class ForeignHandler(BaseHTTPRequestHandler):
    payload = b'<html>unrelated application</html>'
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(self.payload)
    def log_message(self, *args):
        pass

class DiagnosticsTests(unittest.TestCase):
    def test_proxy_override_keeps_startup_state_for_other_matching_service_ports(self):
        sys.path.insert(0,str(ROOT/'scripts'));diagnostics=importlib.import_module('service_diagnostics')
        with tempfile.TemporaryDirectory(prefix='heed-startup-proxy-') as app,patch.dict(os.environ,{'HEED_APP_DIR':app}),patch.object(diagnostics,'bootstrap_owned',return_value=True):
            ports={'api':48100,'ui':48101,'transcription':48102}
            diagnostics.record_startup(str(ROOT),ports,'starting')
            self.assertEqual(diagnostics.startup_states(str(ROOT),{**ports,'api':48103}),{'ui':'starting','transcription':'starting'})
    def test_actual_framework_python_bootstrap_is_recognized_with_its_exact_root(self):
        sys.path.insert(0,str(ROOT/'scripts'));diagnostics=importlib.import_module('service_diagnostics')
        with tempfile.TemporaryDirectory(prefix='heed-framework-bootstrap-') as directory:
            root=pathlib.Path(directory);(root/'scripts').mkdir()
            entry=root/'scripts/service_runtime.py';entry.write_text('import time;time.sleep(60)\n')
            child=subprocess.Popen([sys.executable,str(entry),'start','--root',str(root),'--log-dir',str(root/'logs')],cwd=root,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            try:
                time.sleep(.1)
                self.assertTrue(diagnostics.bootstrap_owned(child.pid,os.path.realpath(root)))
                self.assertFalse(diagnostics.bootstrap_owned(child.pid,'/another-root'))
            finally:child.terminate();child.wait(timeout=3)
    def test_same_port_localhost_requires_owned_checkout_and_ipv6_does_not_probe_ipv4(self):
        sys.path.insert(0,str(ROOT/'scripts'))
        diagnostics=importlib.import_module('service_diagnostics')
        server=ThreadingHTTPServer(('127.0.0.1',0),ForeignHandler)
        worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
        ForeignHandler.payload=json.dumps({'service':'heed-transcription','protocolVersion':1,'checkoutRoot':'/other-checkout','pid':os.getpid(),'ready':True,'whisper':True,'pyannote':False}).encode()
        with tempfile.TemporaryDirectory(prefix='heed-loopback-diagnostics-') as app,patch.dict(os.environ,{'HEED_APP_DIR':app}):
            try:
                port=server.server_port
                notice=diagnostics.inspect_services(str(ROOT),{'transcription':port},f'http://localhost:{port}')[0]
                with self.subTest(origin='localhost'):
                    self.assertEqual(notice['state'],'conflict','localhost at the configured port is managed locally and must match this checkout')
                with self.assertRaises(OSError):socket.create_connection(('::1',port),timeout=.2)
                notice=diagnostics.inspect_services(str(ROOT),{'transcription':port},f'http://[::1]:{port}')[0]
                self.assertEqual(notice['state'],'stopped','An IPv4-only unrelated listener is not an IPv6 conflict')
                self.assertNotIn('application',notice)
                self.assertTrue(server.socket.fileno()>=0)
            finally:server.shutdown();server.server_close();worker.join()
    def test_foreign_html_json_and_unresponsive_listeners_are_preserved_then_recover(self):
        http = ThreadingHTTPServer(('127.0.0.1', 0), ForeignHandler)
        worker = threading.Thread(target=http.serve_forever, daemon=True)
        worker.start()
        unidentified = socket.socket()
        unidentified.bind(('127.0.0.1', 0))
        unidentified.listen()
        empty = socket.socket()
        empty.bind(('127.0.0.1', 0))
        free_port = empty.getsockname()[1]
        empty.close()
        with tempfile.TemporaryDirectory(prefix='heed-diagnostics-') as directory:
            env = {**os.environ, 'HEED_APP_DIR': directory, 'HEED_API_PORT': str(http.server_port),
                   'PORT': str(http.server_port), 'HEED_UI_PORT': str(free_port),
                   'HEED_TRANSCRIPTION_PORT': str(unidentified.getsockname()[1])}
            env.pop('HEED_TRANSCRIPTION_URL', None)
            def inspect():
                result = subprocess.run([sys.executable, str(ROOT / 'scripts/service_diagnostics.py'), '--root', str(ROOT), '--refresh'],
                                        env=env, capture_output=True, text=True, timeout=12)
                self.assertEqual(result.returncode, 0, result.stderr)
                notices = json.loads(result.stdout)
                self.assertEqual(len(notices), 3)
                for item in notices:
                    self.assertLessEqual(set(item), {'service', 'port', 'state', 'application'})
                self.assertNotIn(directory, result.stdout)
                self.assertNotIn(str(ROOT), result.stdout)
                return {item['service']: item for item in notices}
            try:
                for payload in [b'<html>unrelated application</html>', b'{"ready":true,"whisper":true}']:
                    ForeignHandler.payload = payload
                    states = inspect()
                    self.assertEqual(states['api']['state'], 'conflict')
                    self.assertEqual(states['transcription']['state'], 'conflict')
                    self.assertEqual(states['ui']['state'], 'stopped')
                    self.assertEqual(http.socket.fileno() >= 0, True, 'Never close another listener')
                    self.assertEqual(unidentified.fileno() >= 0, True)
                http.shutdown(); http.server_close(); worker.join()
                unidentified.close()
                states = inspect()
                self.assertTrue(all(item['state'] == 'stopped' for item in states.values()))
            finally:
                http.shutdown(); http.server_close(); worker.join()
                unidentified.close()

    def test_owned_starting_is_bounded_and_readiness_requires_correct_listener_ownership(self):
        diagnostics = importlib.import_module('service_diagnostics')
        records = [{'pid': 42, 'cwd': '/synthetic', 'command': 'bun run packages/server/server.ts'}]
        identity = {'service': 'heed-api', 'pid': 42}
        self.assertEqual(diagnostics.classify('api', 48100, '/synthetic', identity, records, True)['state'], 'ready')
        self.assertEqual(diagnostics.classify('api', 48100, '/synthetic', None, records, True, starting=True)['state'], 'starting')
        self.assertEqual(diagnostics.classify('api', 48100, '/synthetic', None, records, True)['state'], 'unhealthy')
        self.assertEqual(diagnostics.classify('api', 48100, '/synthetic', {'pid': 99}, records, True)['state'], 'unhealthy')
        self.assertEqual(diagnostics.classify('api', 48100, '/synthetic', identity, [], True)['state'], 'conflict')
        self.assertEqual(diagnostics.classify('api', 48100, '/synthetic', None, [], True)['state'], 'conflict')
        self.assertEqual(diagnostics.classify('api', 48100, '/synthetic', None, [], False)['state'], 'stopped')
        tx = [{'pid': 44, 'cwd': '/synthetic', 'command': 'python3 -u packages/transcription/transcription_server.py'}]
        self.assertEqual(diagnostics.classify('transcription', 48102, '/synthetic', {'pid': 44, 'ready': False}, tx, True)['state'], 'unhealthy')
        self.assertEqual(diagnostics.classify('transcription', 48102, '/synthetic', {'pid': 44, 'ready': False}, tx, True, starting=True)['state'], 'starting')

    def test_only_safe_executable_basename_can_be_published(self):
        diagnostics = importlib.import_module('service_diagnostics')
        self.assertEqual(diagnostics.safe_application_name('/private/personal/app/Ruby'), 'Ruby')
        self.assertEqual(diagnostics.safe_application_name('/private/personal/Python'), 'Python')
        for name in ['password=secret', 'ruby --token=secret', 'evil\nname', 'a' * 65, '', '.credentials']:
            self.assertIsNone(diagnostics.safe_application_name(name))

    def test_starting_expires_and_requires_a_live_checkout_owned_bootstrap(self):
        diagnostics = importlib.import_module('service_diagnostics')
        ports = {'api': 48100, 'ui': 48101, 'transcription': 48102}
        with tempfile.TemporaryDirectory(prefix='heed-startup-status-') as directory, patch.dict(os.environ, {'HEED_APP_DIR': directory}):
            diagnostics.record_startup('/synthetic', ports, 'starting')
            with patch.object(diagnostics, 'bootstrap_owned', return_value=True):
                self.assertEqual(diagnostics.startup_states('/synthetic', ports), {key: 'starting' for key in ports})
                path = pathlib.Path(directory) / 'service-startup.json'
                data = json.loads(path.read_text()); data['startedAt'] = time.time() - 36; path.write_text(json.dumps(data))
                self.assertEqual(diagnostics.startup_states('/synthetic', ports), {})
            diagnostics.record_startup('/synthetic', ports, 'starting')
            with patch.object(diagnostics, 'bootstrap_owned', return_value=False):
                self.assertEqual(diagnostics.startup_states('/synthetic', ports), {})
            diagnostics.record_startup('/synthetic', ports, 'failed')
            self.assertEqual(diagnostics.startup_states('/synthetic', ports), {key: 'failed' for key in ports})
            self.assertEqual(diagnostics.startup_states('/different', ports), {})
            diagnostics.record_startup('/synthetic', ports, 'ready')
            self.assertEqual(diagnostics.startup_states('/synthetic', ports), {})

    def test_cache_is_private_bounded_context_bound_and_explicit_recheck_recovers(self):
        diagnostics = importlib.import_module('service_diagnostics')
        ports = {'api': 48100, 'ui': 48101, 'transcription': 48102}
        statuses = [{'service': key, 'port': port, 'state': 'conflict'} for key, port in ports.items()]
        with tempfile.TemporaryDirectory(prefix='heed-notice-cache-') as directory, patch.dict(os.environ, {'HEED_APP_DIR': directory}):
            with patch.object(diagnostics, 'inspect_services', return_value=statuses) as observe:
                self.assertEqual(diagnostics.cached_inspection('/synthetic', ports), statuses)
                self.assertEqual(diagnostics.cached_inspection('/synthetic', ports), statuses)
                self.assertEqual(observe.call_count, 1)
                stopped = [{**item, 'state': 'stopped'} for item in statuses]
                observe.return_value = stopped
                self.assertEqual(diagnostics.cached_inspection('/synthetic', ports, refresh=True), stopped)
                self.assertEqual(observe.call_count, 2)
                diagnostics.cached_inspection('/other-checkout', ports)
                self.assertEqual(observe.call_count, 3)
            path = pathlib.Path(directory) / 'service-diagnostics.json'
            self.assertLess(path.stat().st_size, 4096)
            self.assertNotIn('/synthetic', path.read_text())
            path.write_text('x' * 4097)
            with patch.object(diagnostics, 'inspect_services', return_value=statuses) as observe:
                self.assertEqual(diagnostics.cached_inspection('/synthetic', ports), statuses)
                self.assertEqual(observe.call_count, 1)

if __name__ == '__main__':
    unittest.main()
