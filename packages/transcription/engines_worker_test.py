import subprocess
import sys
import threading
import time
import unittest
from unittest.mock import patch
import engines


class ParakeetDeadlineTests(unittest.TestCase):
    def test_unresponsive_finish_returns_failure_and_can_recreate_singleton(self):
        real_popen = subprocess.Popen
        script = 'import sys,time;print("{\\\"ready\\\":true}",flush=True);sys.stdin.readline();time.sleep(30)'
        def spawn(_command, **kwargs):
            return real_popen([sys.executable, '-u', '-c', script], **kwargs)
        with patch('native_worker.subprocess.Popen', side_effect=spawn), patch('engines.NATIVE_LIVE_TIMEOUT_SECONDS', .1, create=True):
            engine = engines.ParakeetEngine()
            failures = []
            def finish():
                try:
                    engine.stream_finish()
                except Exception as error:
                    failures.append(error)
            thread = threading.Thread(target=finish)
            thread.start()
            thread.join(2)
            finished = not thread.is_alive()
            try:
                self.assertTrue(finished, 'stream-finish has no elapsed-time deadline')
                self.assertTrue(failures, 'worker failure must not become an empty successful transcript')
                self.assertIsNotNone(engine.proc.poll())
                with patch.object(engines, '_parakeet_singleton', engine):
                    replacement = engines.get_parakeet()
                    self.addCleanup(replacement.close)
                    self.assertIsNot(replacement, engine)
            finally:
                if engine.proc.poll() is None:
                    engine.proc.kill()
                engine.proc.wait(timeout=1)
                thread.join(1)
                engine.close()

    def test_waiting_for_singleton_initialization_is_bounded_without_canceling_owner(self):
        for factory in (engines.get_parakeet, engines.get_parakeet_diar):
            with self.subTest(factory=factory.__name__):
                failures = []
                def waiting():
                    try:
                        factory()
                    except Exception as error:
                        failures.append(error)
                engines._parakeet_lock.acquire()
                thread = threading.Thread(target=waiting)
                with patch('engines.NATIVE_STARTUP_TIMEOUT_SECONDS', .05, create=True), patch('engines.ParakeetEngine', side_effect=RuntimeError('Must not start while initialization is owned')):
                    try:
                        thread.start()
                        thread.join(.3)
                        finished = not thread.is_alive()
                        self.assertTrue(engines._parakeet_lock.locked())
                    finally:
                        engines._parakeet_lock.release()
                        thread.join(.5)
                self.assertTrue(finished, 'singleton factory lock has no elapsed-time deadline')
                self.assertIsInstance(failures[0], TimeoutError)



if __name__ == '__main__':
    unittest.main()
