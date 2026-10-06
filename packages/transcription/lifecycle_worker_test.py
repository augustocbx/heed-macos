import json
import os
import selectors
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from pathlib import Path


class WorkerEntrypointTests(unittest.TestCase):
    def test_failed_reap_remains_registered_and_reports_until_verified_retry(self):
        from native_worker import NativeWorker
        from worker_lifecycle import WorkerRegistry
        owned = WorkerRegistry()
        child = 'import time;print(\'{"ready":true}\',flush=True);time.sleep(30)'
        with patch('native_worker.registry', owned):
            worker = NativeWorker([sys.executable, '-u', '-c', child],
                                  startup_timeout=1, shutdown_timeout=.03)
            try:
                with patch.object(worker.proc, 'wait', side_effect=subprocess.TimeoutExpired('synthetic', .03)):
                    with self.assertRaises(subprocess.TimeoutExpired):
                        worker.close()
                    # A failed reap must remain a reported cleanup obligation,
                    # even after its protocol pipes have already been closed.
                    with self.assertRaises(RuntimeError):
                        owned.shutdown(timeout=.5)
                owned.shutdown(timeout=.5)
                with self.assertRaises(ProcessLookupError):
                    os.kill(worker.proc.pid, 0)
            finally:
                worker.close()
                worker.proc.wait(timeout=1)

    def fixture(self, phase, signal_number=signal.SIGTERM):
        with tempfile.TemporaryDirectory(prefix='heed-worker-owner-') as directory:
            root = Path(directory)
            pid_path = root / 'pid'
            heartbeat = root / 'heartbeat'
            child = ('import os,pathlib,signal,time;'
                     'pathlib.Path(' + repr(str(pid_path)) + ').write_text(str(os.getpid()));'
                     'p=pathlib.Path(' + repr(str(heartbeat)) + ');')
            if phase != 'startup':
                child += 'print(' + repr('{"ready":true}') + ',flush=True);'
            child += '\nwhile True:p.write_text(str(time.monotonic()));time.sleep(.01)'
            command = '[sys.executable,"-u","-c",' + repr(child) + ']'
            code = ('import os,signal,subprocess,sys,threading,time;'
                    'from native_worker import NativeWorker;'
                    'from worker_lifecycle import worker_entrypoint;\n')
            if phase in ('main-spawn', 'background-spawn'):
                code += ('real_spawn=subprocess.Popen\n'
                         'def raced_spawn(*args,**kwargs):\n'
                         ' proc=real_spawn(*args,**kwargs)\n'
                         ' os.kill(os.getpid(),signal.SIGTERM)\n'
                         ' time.sleep(.1)\n'
                         ' return proc\n'
                         'subprocess.Popen=raced_spawn\n')
            code += ('owner=worker_entrypoint();owner.__enter__()\nif True:\n' if phase=='atexit' else 'with worker_entrypoint():\n')
            if phase == 'background-spawn':
                code += (' def construct():\n'
                         '  try:NativeWorker(' + command + ',startup_timeout=10,shutdown_timeout=.1)\n'
                         '  except RuntimeError:pass\n'
                         ' threading.Thread(target=construct,daemon=True).start()\n'
                         ' signal.pause()\n')
            else:
                code += ' worker=NativeWorker(' + command + ',startup_timeout=10,shutdown_timeout=.2)\n'
                if phase in ('normal','atexit'):
                    code += ' print("normal",flush=True)\n'
                elif phase == 'close':
                    code += ' print("closing",flush=True)\n worker.close()\n'
                elif phase == 'response':
                    code += ' print("request",flush=True)\n worker.request({"cmd":"blocked"},timeout=10)\n'
                elif phase == 'main-spawn':
                    code += ' raise RuntimeError("Signal must stop provisioning")\n'
            parent = subprocess.Popen([sys.executable, '-u', '-c', code],
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                      env=dict(os.environ, PYTHONPATH=str(Path(__file__).parent)),
                                      start_new_session=True)
            child_pid = None
            try:
                until = time.monotonic() + 2
                while not pid_path.exists() and parent.poll() is None and time.monotonic() < until:
                    time.sleep(.01)
                self.assertTrue(pid_path.exists(), parent.stderr.read() if parent.poll() is not None else 'No owned worker provisioned')
                child_pid = int(pid_path.read_text())
                if phase in ('startup', 'response', 'close'):
                    if phase != 'startup':
                        with selectors.DefaultSelector() as selector:
                            selector.register(parent.stdout, selectors.EVENT_READ)
                            self.assertTrue(selector.select(1))
                        parent.stdout.readline()
                    os.killpg(parent.pid, signal_number)
                parent.wait(timeout=3)
                self.assertEqual(parent.returncode, 0 if phase in ('normal','atexit') else 128 + signal_number)
                before = heartbeat.read_text() if heartbeat.exists() else None
                time.sleep(.08)
                self.assertEqual(heartbeat.read_text() if heartbeat.exists() else None, before)
                # The parent must reap its owned direct child, not only stop its output.
                with self.assertRaises(ProcessLookupError):
                    os.kill(child_pid, 0)
            finally:
                if parent.poll() is None:
                    os.killpg(parent.pid, signal.SIGKILL)
                parent.wait(timeout=1)
                if child_pid is not None:
                    try:os.killpg(child_pid, signal.SIGKILL)
                    except ProcessLookupError:pass
                parent.stdout.close()
                parent.stderr.close()

    def test_sigterm_during_startup_reaps_owned_worker(self):
        self.fixture('startup')

    def test_sigterm_during_response_reaps_owned_worker(self):
        self.fixture('response')

    def test_sigint_during_response_reaps_owned_worker(self):
        self.fixture('response', signal.SIGINT)

    def test_normal_entrypoint_exit_reaps_owned_worker(self):
        self.fixture('normal')

    def test_sigterm_between_main_spawn_return_and_registration_cannot_orphan(self):
        self.fixture('main-spawn')

    def test_sigterm_during_background_spawn_registration_cannot_orphan(self):
        self.fixture('background-spawn')

    def test_sigterm_during_main_thread_close_defers_until_reap(self):
        self.fixture('close')

    def test_registered_atexit_cleanup_reaps_owned_worker(self):
        self.fixture('atexit')

    def test_parallel_shutdown_reaps_all_owned_workers_with_one_shared_budget(self):
        code = ('import signal,sys;from native_worker import NativeWorker;'
                'from worker_lifecycle import worker_entrypoint;\n'
                'with worker_entrypoint():\n'
                ' workers=[NativeWorker([sys.executable,"-u","-c",'+repr('import time;print('+repr('{"ready":true}')+',flush=True);time.sleep(30)')+'],startup_timeout=.5) for _ in range(4)]\n'
                ' print(",".join(str(w.proc.pid) for w in workers),flush=True)\n'
                ' signal.pause()\n')
        parent = subprocess.Popen([sys.executable,'-u','-c',code],stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                                  env=dict(os.environ,PYTHONPATH=str(Path(__file__).parent)),start_new_session=True)
        children=[]
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(parent.stdout, selectors.EVENT_READ)
                self.assertTrue(selector.select(2))
            children=[int(value) for value in parent.stdout.readline().decode().strip().split(',')]
            os.killpg(parent.pid,signal.SIGTERM)
            parent.wait(timeout=3.5)
            self.assertEqual(parent.returncode,143,parent.stderr.read().decode())
            for pid in children:
                with self.assertRaises(ProcessLookupError):os.kill(pid,0)
        finally:
            if parent.poll() is None:os.killpg(parent.pid,signal.SIGKILL)
            parent.wait(timeout=1)
            for pid in children:
                try:os.killpg(pid,signal.SIGKILL)
                except ProcessLookupError:pass
            parent.stdout.close();parent.stderr.close()

    def test_stopping_entrypoint_rejects_new_spawns_without_effects(self):
        with tempfile.TemporaryDirectory() as directory:
            marker=Path(directory)/'spawned'
            child='import pathlib;pathlib.Path('+repr(str(marker))+').write_text("unexpected")'
            code=('import sys;from native_worker import NativeWorker;from worker_lifecycle import worker_entrypoint;\n'
                  'with worker_entrypoint():pass\n'
                  'try:NativeWorker([sys.executable,"-c",'+repr(child)+'],startup_timeout=.2)\n'
                  'except RuntimeError:print("rejected",flush=True)\n')
            result=subprocess.run([sys.executable,'-c',code],env=dict(os.environ,PYTHONPATH=str(Path(__file__).parent)),
                                  capture_output=True,timeout=2,check=True)
            self.assertEqual(result.stdout.strip(),b'rejected')
            self.assertFalse(marker.exists())


    def test_signal_cancels_provisioning_lock_wait_before_its_long_startup_budget(self):
        code=('import os,signal,sys,threading,time;from native_worker import NativeWorker;'
              'from worker_lifecycle import worker_entrypoint,registry;\n'
              'with worker_entrypoint():\n'
              ' registry._lock.acquire()\n'
              ' def terminate():time.sleep(.05);os.kill(os.getpid(),signal.SIGTERM)\n'
              ' threading.Thread(target=terminate,daemon=True).start()\n'
              ' try:NativeWorker([sys.executable,"-c","raise RuntimeError(\\\"must not spawn\\\")"],startup_timeout=10)\n'
              ' finally:registry._lock.release()\n')
        result=subprocess.run([sys.executable,'-u','-c',code],env=dict(os.environ,PYTHONPATH=str(Path(__file__).parent)),
                              capture_output=True,timeout=2)
        self.assertEqual(result.returncode,143,result.stderr.decode())



if __name__ == '__main__':
    unittest.main()
