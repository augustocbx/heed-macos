"""Explicit transcription entrypoint ownership; library imports install no handlers."""
import atexit
from contextlib import contextmanager
import signal
import threading
import time

NATIVE_ENTRYPOINT_SHUTDOWN_SECONDS = 3
_main_critical_depth = 0
_pending_signal = None


@contextmanager
def defer_termination():
    """Defer Python shutdown exceptions, never inherit a blocked child signal mask."""
    global _main_critical_depth, _pending_signal
    main = threading.current_thread() is threading.main_thread()
    if main:
        _main_critical_depth += 1
    try:
        yield
    finally:
        if main:
            _main_critical_depth -= 1
            if _main_critical_depth == 0 and _pending_signal is not None:
                number = _pending_signal
                _pending_signal = None
                raise SystemExit(128 + number)


class WorkerRegistry:
    def __init__(self):
        self.stopping = False
        self._lock = threading.Lock()
        self._workers = set()

    def provision(self, worker, spawn, timeout):
        # This gate covers process provisioning only, never model readiness or I/O.
        # Deferring main-thread signals keeps a returned detached child registered
        # before SystemExit can unwind. Background provisioning settles under the gate.
        with defer_termination():
            deadline = time.monotonic() + timeout
            while True:
                if self.stopping:
                    raise RuntimeError('Transcription entrypoint is stopping')
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError('Native provisioning lock deadline exceeded')
                if self._lock.acquire(timeout=min(.05, remaining)):
                    break
            try:
                if self.stopping:
                    raise RuntimeError('Transcription entrypoint is stopping')
                worker.proc = spawn()
                self._workers.add(worker)
            finally:
                self._lock.release()

    def forget(self, worker):
        if not self._lock.acquire(timeout=NATIVE_ENTRYPOINT_SHUTDOWN_SECONDS):
            raise RuntimeError('Native retirement registration deadline exceeded')
        try:
            self._workers.discard(worker)
        finally:
            self._lock.release()

    def shutdown(self, timeout=NATIVE_ENTRYPOINT_SHUTDOWN_SECONDS):
        self.stopping = True
        deadline = time.monotonic() + timeout
        with defer_termination():
            if not self._lock.acquire(timeout=timeout):
                raise RuntimeError('Native process provisioning did not settle before shutdown deadline')
            try:
                workers = list(self._workers)
            finally:
                self._lock.release()
            errors = []
            def close(worker):
                try:
                    worker.close()
                except Exception as error:
                    errors.append(error)
            threads = [threading.Thread(target=close, args=(worker,), daemon=True,
                                        name='heed-native-shutdown') for worker in workers]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(max(0, deadline - time.monotonic()))
            if errors or any(thread.is_alive() for thread in threads):
                raise RuntimeError('Owned native process cleanup did not complete before shutdown deadline')


registry = WorkerRegistry()


def _shutdown_signal(number, _frame):
    global _pending_signal
    # No locks, joins, native signals, or process creation inside the Python handler.
    registry.stopping = True
    if _main_critical_depth:
        _pending_signal = number
    else:
        raise SystemExit(128 + number)


@contextmanager
def worker_entrypoint():
    if threading.current_thread() is not threading.main_thread():
        raise RuntimeError('Native shutdown handlers require the entrypoint main thread')
    previous = {number: signal.getsignal(number) for number in (signal.SIGTERM, signal.SIGINT)}
    for number in previous:
        signal.signal(number, _shutdown_signal)
    atexit.register(registry.shutdown)
    try:
        yield
    finally:
        try:
            registry.shutdown()
        finally:
            for number, handler in previous.items():
                signal.signal(number, handler)
