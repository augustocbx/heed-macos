import os
import signal
import sys
import tempfile
from pathlib import Path
import threading
import time
import unittest
from native_worker import NativeWorker, offline_timeout
from process_ownership import child_exited_without_reaping
import subprocess
from unittest.mock import patch


# Allow interpreter scheduling for successful fixtures; timeout tests override this.
WORKER_FIXTURE_STARTUP_SECONDS = 5


class NativeWorkerTests(unittest.TestCase):
    def worker(self, code, startup=WORKER_FIXTURE_STARTUP_SECONDS):
        worker = NativeWorker([sys.executable, '-u', '-c', code], startup_timeout=startup,
                              shutdown_timeout=0.1)
        self.addCleanup(worker.close)
        return worker

    def test_partial_startup_line_times_out_and_reaps_owned_process(self):
        real_spawn = subprocess.Popen
        owned = []
        def spawn(command, **kwargs):
            proc = real_spawn(command, **kwargs)
            owned.append(proc)
            return proc
        with patch('native_worker.subprocess.Popen', side_effect=spawn):
            with self.assertRaisesRegex(TimeoutError, 'deadline'):
                self.worker('import sys,time;sys.stdout.write("{\\\"ready\\\":");sys.stdout.flush();time.sleep(30)', 0.1)
        self.assertEqual(len(owned), 1)
        self.assertIsNotNone(owned[0].poll())

    def test_partial_response_cannot_escape_deadline_and_worker_is_invalidated(self):
        worker = self.worker('import sys,time;print("{\\\"ready\\\":true}");sys.stdin.readline();sys.stdout.write("{");sys.stdout.flush();time.sleep(30)')
        started = time.monotonic()
        with self.assertRaisesRegex(TimeoutError, 'deadline'):
            worker.request({'cmd': 'finish'}, timeout=0.1)
        self.assertLess(time.monotonic() - started, 1)
        self.assertFalse(worker.alive)
        self.assertIsNotNone(worker.proc.poll())

    def test_blocked_stdin_write_obeys_same_deadline(self):
        worker = self.worker('import time;print("{\\\"ready\\\":true}");time.sleep(30)')
        with self.assertRaises(TimeoutError):
            worker.request({'text': 'x' * 2_000_000}, timeout=0.1)
        self.assertFalse(worker.alive)

    def test_waiting_for_another_request_has_a_deadline(self):
        worker = self.worker('import sys,time;print("{\\\"ready\\\":true}");sys.stdin.readline();time.sleep(30)')
        failures = []
        def request():
            try:
                worker.request({'cmd': 'one'}, timeout=2)
            except Exception as error:
                failures.append(error)
        thread = threading.Thread(target=request)
        thread.start()
        time.sleep(0.05)
        try:
            with self.assertRaises(TimeoutError):
                worker.request({'cmd': 'two'}, timeout=0.1)
        finally:
            worker.close()
            thread.join(1)
        self.assertFalse(thread.is_alive())
        self.assertTrue(failures)

    def test_close_cancels_read_without_waiting_for_request_lock(self):
        worker = self.worker('import sys,time;print("{\\\"ready\\\":true}");sys.stdin.readline();time.sleep(30)')
        failures = []
        def request():
            try:
                worker.request({'cmd': 'one'}, timeout=30)
            except Exception as error:
                failures.append(error)
        thread = threading.Thread(target=request)
        thread.start()
        time.sleep(0.05)
        started = time.monotonic()
        worker.close()
        thread.join(1)
        self.assertLess(time.monotonic() - started, 1)
        self.assertFalse(thread.is_alive())
        self.assertTrue(failures)

    def test_timeout_kills_owned_descendant_even_when_parent_exits_on_term(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = os.path.join(directory, 'alive')
            child = 'import signal,time,pathlib;signal.signal(signal.SIGTERM,signal.SIG_IGN);p=pathlib.Path(' + repr(marker) + ');\nwhile True:p.write_text(str(time.monotonic()));time.sleep(.01)'
            code = 'import subprocess,sys,time;subprocess.Popen([sys.executable,"-u","-c",' + repr(child) + ']);print("{\\\"ready\\\":true}");sys.stdin.readline();time.sleep(30)'
            worker = self.worker(code)
            with self.assertRaises(TimeoutError):
                worker.request({'cmd': 'one'}, timeout=0.15)
            before = Path(marker).read_text()
            time.sleep(0.1)
            self.assertEqual(Path(marker).read_text(), before)
            self.assertIsNotNone(worker.proc.poll())

    def test_noise_does_not_reset_total_deadline(self):
        worker = self.worker('import sys,time;print("{\\\"ready\\\":true}");sys.stdin.readline();\nwhile True:print("noise");time.sleep(.01)')
        with self.assertRaises(TimeoutError):
            worker.request({'cmd': 'one'}, timeout=0.1)

    def test_valid_delayed_response_and_prefixed_json_are_preserved(self):
        worker = self.worker('import sys,time;print("{\\\"ready\\\":true}");\nfor line in sys.stdin:time.sleep(.1);print("E5RT noise {\\\"ok\\\":true,\\\"text\\\":\\\"synthetic\\\"}")')
        self.assertEqual(worker.request({'cmd': 'one'}, timeout=0.5), {'ok': True, 'text': 'synthetic'})
        self.assertEqual(worker.request({'cmd': 'two'}, timeout=0.5)['text'], 'synthetic')

    def test_timeout_does_not_signal_an_unrelated_worker(self):
        foreign = subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(30)'], start_new_session=True)
        try:
            worker = self.worker('import sys,time;print("{\\\"ready\\\":true}");sys.stdin.readline();time.sleep(30)')
            with self.assertRaises(TimeoutError):
                worker.request({'cmd': 'one'}, timeout=0.1)
            self.assertIsNone(foreign.poll())
        finally:
            foreign.kill()
            foreign.wait(timeout=1)

    def test_eof_invalidates_worker_instead_of_returning_an_empty_success(self):
        worker = self.worker('import sys;print("{\\\"ready\\\":true}");sys.stdin.readline()')
        with self.assertRaisesRegex(RuntimeError, 'without a response'):
            worker.request({'cmd': 'one'}, timeout=0.2)
        self.assertFalse(worker.alive)
        self.assertIsNotNone(worker.proc.poll())

    def test_long_recording_has_duration_headroom_but_finite_ceiling(self):
        self.assertGreaterEqual(offline_timeout(1800), 1800)
        self.assertLessEqual(offline_timeout(24 * 3600), 3600)


    def test_startup_ignores_noise_and_nonready_json_until_explicit_ready_true(self):
        worker = self.worker('import time;print("E5RT telemetry {\\\"status\\\":\\\"loading\\\"}");print("{\\\"ready\\\":1}");time.sleep(.03);print("{\\\"ready\\\":true}");time.sleep(30)')
        self.assertTrue(worker.alive)

    def test_delayed_valid_startup_still_allows_a_bounded_request(self):
        # Positive protocol checks must tolerate interpreter scheduling before readiness.
        worker = self.worker('import sys,time;time.sleep(.4);print(\'{"ready":true}\');sys.stdin.readline();print(\'{"ok":true}\');time.sleep(30)')
        self.assertEqual(worker.request({'cmd': 'one'}, timeout=.5), {'ok': True})
        self.assertTrue(worker.alive)


    def test_truthy_nonboolean_ready_cannot_admit_requests(self):
        with self.assertRaises(TimeoutError):
            self.worker('import time;print("{\\\"ready\\\":1}");time.sleep(30)', startup=.1)


    def test_complete_oversized_line_is_rejected_as_well_as_partial_lines(self):
        worker = self.worker('import sys;print("{\\\"ready\\\":true}");sys.stdin.readline();print("{\\\"ok\\\":true,\\\"text\\\":\\\""+"x"*100+"\\\"}")')
        with patch('native_worker.MAX_RESPONSE_LINE_BYTES', 32):
            with self.assertRaisesRegex(RuntimeError, 'protocol limit'):
                worker.request({'cmd': 'one'}, timeout=.3)
        self.assertFalse(worker.alive)


    def test_expired_lock_waiter_does_not_cancel_admitted_request(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = os.path.join(directory, 'admitted')
            code = 'import sys,time,pathlib;print("{\\\"ready\\\":true}");\nfor line in sys.stdin:pathlib.Path(' + repr(marker) + ').write_text("admitted");time.sleep(.25);print("{\\\"ok\\\":true}")'
            worker = self.worker(code)
            results = []
            def first():
                try:
                    results.append(worker.request({'cmd': 'first'}, timeout=1))
                except Exception as error:
                    results.append(error)
            thread = threading.Thread(target=first)
            thread.start()
            until = time.monotonic() + .5
            while not os.path.exists(marker) and time.monotonic() < until:
                time.sleep(.01)
            try:
                self.assertTrue(os.path.exists(marker))
                with self.assertRaises(TimeoutError):
                    worker.request({'cmd': 'waiter'}, timeout=.05)
                thread.join(1)
                self.assertEqual(results, [{'ok': True}])
                self.assertTrue(worker.alive)
                self.assertEqual(worker.request({'cmd': 'third'}, timeout=1), {'ok': True})
            finally:
                worker.close()
                thread.join(1)

    def test_group_signals_keep_owned_child_unreaped_until_cleanup_finishes(self):
        worker = self.worker('import time;print("{\\\"ready\\\":true}");time.sleep(30)')
        real_signal = os.killpg
        def signal_owned(pgid, sig):
            self.assertEqual(pgid, worker.proc.pid)
            # WNOWAIT proves child identity still exists without relinquishing its PID.
            child_exited_without_reaping(pgid)
            return real_signal(pgid, sig)
        with patch('native_worker.os.killpg', side_effect=signal_owned):
            worker.close()
        self.assertIsNotNone(worker.proc.returncode)

    def test_externally_reaped_leader_refuses_stale_group_signals(self):
        from worker_lifecycle import WorkerRegistry
        owned = WorkerRegistry()
        with patch('native_worker.registry', owned):
            worker = NativeWorker([sys.executable, '-u', '-c',
                                   'import time;print("{\\\"ready\\\":true}");time.sleep(30)'],
                                  startup_timeout=WORKER_FIXTURE_STARTUP_SECONDS, shutdown_timeout=.1)
            worker.proc.kill()
            worker.proc.wait(timeout=1)
            with patch('native_worker.os.killpg') as send:
                for _ in range(2):
                    with self.assertRaisesRegex(RuntimeError, 'ownership'):
                        worker.close()
                with self.assertRaises(RuntimeError):
                    owned.shutdown(timeout=.5)
                send.assert_not_called()


    @unittest.skipUnless(sys.platform == 'darwin', 'Darwin ABI fallback')
    def test_missing_python_waitid_uses_darwin_api_without_reaping(self):
        proc = subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(.05)'], start_new_session=True)
        try:
            with patch('process_ownership.os.waitid', None, create=True):
                self.assertFalse(child_exited_without_reaping(proc.pid))
                until = time.monotonic() + 1
                while not child_exited_without_reaping(proc.pid) and time.monotonic() < until:
                    time.sleep(.01)
                self.assertTrue(child_exited_without_reaping(proc.pid))
                self.assertTrue(child_exited_without_reaping(proc.pid))
                proc.wait(timeout=1)
                with self.assertRaises(ChildProcessError):
                    child_exited_without_reaping(proc.pid)
        finally:
            if proc.poll() is None:
                proc.kill()
            proc.wait(timeout=1)


    def test_deadline_after_lock_admission_before_first_byte_preserves_worker(self):
        worker = self.worker('import sys;print("{\\\"ready\\\":true}");\nfor line in sys.stdin:print("{\\\"ok\\\":true}")')
        original = worker.lock
        class DelayedAdmission:
            delayed = False
            def acquire(self, timeout):
                acquired = original.acquire(timeout=timeout)
                if acquired and not self.delayed:
                    self.delayed = True
                    time.sleep(.08)  # Scheduler stalls after acquiring, before caller resumes.
                return acquired
            def release(self):
                original.release()
        worker.lock = DelayedAdmission()
        with self.assertRaises(TimeoutError):
            worker.request({'cmd': 'expired'}, timeout=.05)
        self.assertTrue(worker.alive)
        self.assertEqual(worker.request({'cmd': 'next'}, timeout=.3), {'ok': True})

    def test_serialization_failure_before_io_preserves_worker(self):
        worker = self.worker('import sys;print("{\\\"ready\\\":true}");\nfor line in sys.stdin:print("{\\\"ok\\\":true}")')
        with self.assertRaises(TypeError):
            worker.request({'invalid': object()}, timeout=.3)
        self.assertTrue(worker.alive)
        self.assertEqual(worker.request({'cmd': 'next'}, timeout=.3), {'ok': True})


    def test_default_sigterm_child_exits_gracefully_without_inherited_blocked_mask(self):
        worker = self.worker('import time;print("{\\\"ready\\\":true}");time.sleep(30)')
        worker.close()
        self.assertEqual(worker.proc.returncode, -signal.SIGTERM)



if __name__ == '__main__':
    unittest.main()
