"""Deadline-bounded stdio transport for an exclusively owned native process group.

No stderr reader threads: native diagnostics are discarded rather than permitting a
joined pipe-drainer to strand shutdown. HTTP client cancellation does not own this worker.
"""
import json
import math
import os
import selectors
import signal
import subprocess
import threading
import time
from process_ownership import child_exited_without_reaping
from worker_lifecycle import registry, defer_termination

NATIVE_STARTUP_TIMEOUT_SECONDS = 300
NATIVE_LIVE_TIMEOUT_SECONDS = 120
NATIVE_OFFLINE_MIN_TIMEOUT_SECONDS = 300
NATIVE_OFFLINE_MAX_TIMEOUT_SECONDS = 3600
NATIVE_SHUTDOWN_TIMEOUT_SECONDS = 1
MAX_RESPONSE_LINE_BYTES = 32 * 1024 * 1024


def offline_timeout(duration):
    """Allow 2x real-time plus model overhead, capped at one hour."""
    return min(NATIVE_OFFLINE_MAX_TIMEOUT_SECONDS,
               max(NATIVE_OFFLINE_MIN_TIMEOUT_SECONDS, 120 + max(0, duration) * 2))


def _budget(value):
    if not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise ValueError('Native deadline must be a finite positive number')
    return value


class NativeWorker:
    def __init__(self, command, env=None, startup_timeout=NATIVE_STARTUP_TIMEOUT_SECONDS,
                 shutdown_timeout=NATIVE_SHUTDOWN_TIMEOUT_SECONDS):
        self._shutdown_timeout = _budget(shutdown_timeout)
        startup_timeout = _budget(startup_timeout)
        self.lock = threading.Lock()
        self._close_lock = threading.Lock()
        self._closed = threading.Event()
        self._reaped = False
        self._buffer = bytearray()
        self.proc = None
        try:
            registry.provision(self, lambda: subprocess.Popen(
                command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL, bufsize=0, env=env,
                start_new_session=True), timeout=startup_timeout)
            for pipe in (self.proc.stdin, self.proc.stdout):
                os.set_blocking(pipe.fileno(), False)
            deadline = time.monotonic() + startup_timeout
            self.ready_info = self._response(deadline)
            while self.ready_info.get('ready') is not True:
                # Model initialization can emit noise or unrelated JSON telemetry.
                # Only explicit protocol readiness admits requests; no line resets time.
                self.ready_info = self._response(deadline)
        except BaseException:
            if self.proc is not None:
                self.close()
            raise

    @property
    def alive(self):
        if self._closed.is_set():
            return False
        try:
            return not self._owned_exited()
        except RuntimeError:
            return False

    def _check(self, deadline):
        if self._closed.is_set() or registry.stopping:
            raise RuntimeError('Native worker closed or entrypoint stopping')
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('Native worker deadline exceeded')
        return remaining

    def _wait(self, pipe, event, deadline):
        with selectors.DefaultSelector() as selector:
            selector.register(pipe, event)
            while True:
                remaining = self._check(deadline)
                if selector.select(min(remaining, .05)):
                    self._check(deadline)
                    return

    def _response(self, deadline):
        while True:
            self._check(deadline)
            newline = self._buffer.find(b'\n')
            if newline >= 0:
                if newline > MAX_RESPONSE_LINE_BYTES:
                    raise RuntimeError('Native worker response exceeds protocol limit')
                line = bytes(self._buffer[:newline])
                del self._buffer[:newline + 1]
                brace = line.find(b'{')
                if brace >= 0:
                    try:
                        value = json.loads(line[brace:])
                        if isinstance(value, dict):
                            return value
                    except (ValueError, UnicodeDecodeError):
                        pass
                continue
            if len(self._buffer) > MAX_RESPONSE_LINE_BYTES:
                raise RuntimeError('Native worker response exceeds protocol limit')
            self._wait(self.proc.stdout, selectors.EVENT_READ, deadline)
            try:
                chunk = os.read(self.proc.stdout.fileno(), 65536)
            except BlockingIOError:
                continue
            if not chunk:
                raise RuntimeError('Native worker closed without a response')
            self._buffer.extend(chunk)

    def request(self, obj, timeout=NATIVE_LIVE_TIMEOUT_SECONDS):
        deadline = time.monotonic() + _budget(timeout)
        acquired = False
        io_started = False
        bytes_written = 0
        try:
            while not acquired:
                remaining = self._check(deadline)
                acquired = self.lock.acquire(timeout=min(remaining, .05))
            data = memoryview((json.dumps(obj) + '\n').encode('utf-8'))
            while data:
                io_started = True
                self._wait(self.proc.stdin, selectors.EVENT_WRITE, deadline)
                try:
                    written = os.write(self.proc.stdin.fileno(), data)
                except BlockingIOError:
                    continue
                bytes_written += written
                data = data[written:]
            return self._response(deadline)
        except Exception as error:
            # Lock admission alone owns no native state. Only protocol bytes or a
            # real transport failure invalidate the worker; zero-byte deadlines
            # and serialization errors belong solely to their caller.
            if bytes_written or (io_started and not isinstance(error, TimeoutError)):
                self.close()
            raise
        finally:
            if acquired:
                self.lock.release()

    def _owned_exited(self):
        # Retain the direct child (even as a zombie) until every group signal is
        # complete. poll()/wait() would release its PID for unrelated reuse.
        try:
            return child_exited_without_reaping(self.proc.pid)
        except ChildProcessError as error:
            raise RuntimeError('Native worker process ownership was lost') from error

    def _signal_group(self, sig):
        exited = self._owned_exited()
        try:
            os.killpg(self.proc.pid, sig)
        except ProcessLookupError:
            pass
        except PermissionError:
            # macOS can report EPERM for an unreaped zombie-only group. The own
            # child still pins its PID; never suppress refusal for a live worker.
            if not exited:
                raise

    def close(self):
        with defer_termination():
            # Never take the request lock: a request may be blocked on this process's pipes.
            self._closed.set()
            with self._close_lock:
                if self._reaped:
                    registry.forget(self)
                    return
                try:
                    self._signal_group(signal.SIGTERM)
                    # Give descendants grace even if the leader exits first. Do not reap it.
                    until = time.monotonic() + self._shutdown_timeout
                    while time.monotonic() < until:
                        time.sleep(min(.02, max(0, until - time.monotonic())))
                    self._signal_group(signal.SIGKILL)
                    self.proc.wait(timeout=self._shutdown_timeout)
                    self._reaped = True
                finally:
                    for pipe in (self.proc.stdin, self.proc.stdout):
                        pipe.close()
                # Failed waits remain registered. Closing protocol pipes is not
                # proof of process retirement; a retry must retain ownership and
                # verify reap before it can remove the cleanup obligation.
                registry.forget(self)
