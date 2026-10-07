#!/usr/bin/env python3
"""Recover only Heed's screen capture permission after native user confirmation."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import plistlib
import stat
import subprocess
import sys
import time
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(ROOT / 'scripts/release'))
from installation_lock import InstallationLock
from service_config import service_config

BUNDLE_ID = 'local.heed.menubar'
ERROR = 'System audio permission recovery could not finish. Reopen Heed and try again after active work or updates finish.'


class RecoveryError(ValueError):
    pass


class Context:
    def __init__(self, root, app, pid, command):
        self.root = Path(root); self.app = Path(app); self.pid = pid; self.command = command

    def validate(self):
        if (not self.root.is_absolute() or self.root.resolve() != ROOT.resolve()
                or not self.app.is_absolute() or self.app.is_symlink() or self.app.suffix != '.app'
                or type(self.pid) is not int or self.pid <= 1 or self.pid == os.getpid()
                or str(uuid.UUID(self.command)) != self.command):
            raise RecoveryError(ERROR)
        contents = self.app / 'Contents'
        if contents.is_symlink(): raise RecoveryError(ERROR)
        data = read_file(contents / 'Info.plist')
        info = plistlib.loads(data)
        executable = info.get('CFBundleExecutable')
        if (info.get('CFBundleIdentifier') != BUNDLE_ID or not isinstance(executable, str)
                or not executable or Path(executable).name != executable or executable in ['.', '..']):
            raise RecoveryError(ERROR)
        self.executable = contents / 'MacOS' / executable
        if not self.executable.is_file() or self.executable.is_symlink(): raise RecoveryError(ERROR)
        resources = contents / 'Resources'
        if resources.is_symlink(): raise RecoveryError(ERROR)
        installed_root = Path(read_file(resources / 'heed-root.txt').decode().strip())
        if not installed_root.is_absolute() or installed_root.resolve() != self.root.resolve():
            raise RecoveryError(ERROR)
        home_resource = resources / 'heed-home.txt'
        home = os.environ.get('HEED_HOME') or (read_file(home_resource).decode().strip() if home_resource.exists() else str(Path.home() / '.heed'))
        self.home = Path(home)
        if not self.home.is_absolute() or self.home.is_symlink(): raise RecoveryError(ERROR)
        self.owner = 'permission-recovery-' + self.command


def read_file(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_size > 65536: raise RecoveryError(ERROR)
        return os.read(descriptor, 65537)
    finally: os.close(descriptor)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args): return None


class Runtime:
    def __init__(self, context=None):
        environment = dict(os.environ)
        if context is not None and 'HEED_APP_DIR' not in environment:
            resource = context.app / 'Contents/Resources/heed-app-dir.txt'
            if resource.exists():
                directory = Path(read_file(resource).decode().strip())
                if not directory.is_absolute(): raise RecoveryError(ERROR)
                environment['HEED_APP_DIR'] = str(directory)
        self.base = 'http://127.0.0.1:%d' % service_config(environment)['api']
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def request(self, path, body=None):
        request = urllib.request.Request(self.base + path,
            data=None if body is None else json.dumps(body).encode(),
            headers={'Content-Type': 'application/json'}, method='GET' if body is None else 'POST')
        # Lifecycle calls request lean summaries, excluding personal transcripts.
        limit = 65536
        with self.opener.open(request, timeout=3) as response:
            if response.status != 200: raise RecoveryError(ERROR)
            data = response.read(limit + 1)
        if len(data) > limit: raise RecoveryError(ERROR)
        value = json.loads(data)
        if not isinstance(value, dict): raise RecoveryError(ERROR)
        return value

    def run(self, command, timeout):
        subprocess.run(command, check=True, timeout=timeout, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def process_state(self, pid, executable):
        result = subprocess.run(['/bin/ps', '-ww', '-p', str(pid), '-o', 'comm='],
            capture_output=True, text=True, timeout=3)
        if result.returncode == 1 and not result.stdout.strip(): return 'absent'
        if result.returncode != 0: raise RecoveryError(ERROR)
        return 'expected' if result.stdout.strip() == str(executable) else 'foreign'

    def menu_available(self):
        path = Path.home() / 'Library/Application Support/Heed/menubar.lock'
        try: descriptor = os.open(path, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK)
        except FileNotFoundError: return True
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise RecoveryError(ERROR)
            try: fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError: return False
            fcntl.flock(descriptor, fcntl.LOCK_UN)
            return True
        finally: os.close(descriptor)

    def installation_lock(self, home): return InstallationLock(home)
    def monotonic(self): return time.monotonic()
    def now(self): return time.time()
    def sleep(self, seconds): time.sleep(seconds)
    def emit(self, value): print(json.dumps(value), flush=True)


def identity(context, runtime):
    data = runtime.request('/.well-known/heed-service')
    if (data.get('service') != 'heed-api' or type(data.get('protocolVersion')) is not int
            or data['protocolVersion'] != 1 or type(data.get('pid')) is not int or data['pid'] <= 0
            or not isinstance(data.get('checkoutRoot'), str) or not Path(data['checkoutRoot']).is_absolute()
            or Path(data['checkoutRoot']).resolve() != context.root.resolve()):
        raise RecoveryError(ERROR)


def idle(context, runtime):
    identity(context, runtime)
    data = runtime.request('/api/desktop/control/status?summary=1')
    request = data.get('permissionRequest')
    if (not isinstance(request, dict) or request.get('id') != context.command
            or request.get('action') != 'recoverScreenCapture'
            or any(type(data.get(key)) is not bool or data[key] for key in
                   ['recording', 'processing', 'starting', 'pending', 'audioWork', 'maintenance'])
            or data.get('processingKinds') != [] or data.get('maintenanceProtocol') != 2
            or data.get('updateTransactionId') is not None):
        raise RecoveryError(ERROR)


def maintenance(context, runtime, acquire):
    identity(context, runtime)
    if not acquire:
        state = runtime.request('/api/desktop/control/status?summary=1')
        if state.get('maintenanceProtocol') != 2 or state.get('updateTransactionId') is not None:
            raise RecoveryError(ERROR)
    # No transaction ID: this short guard must never create or release an update lease.
    data = runtime.request('/api/recording/maintenance?summary=1', {'acquire': acquire, 'owner': context.owner})
    if (data.get('maintenance') is not acquire or data.get('maintenanceProtocol') != 2
            or data.get('updateTransactionId') is not None): raise RecoveryError(ERROR)


def wait_for_exit(context, runtime):
    deadline = runtime.monotonic() + 15
    while runtime.monotonic() < deadline:
        state = runtime.process_state(context.pid, context.executable)
        if state == 'foreign': raise RecoveryError(ERROR)
        if state == 'absent' and runtime.menu_available(): return
        runtime.sleep(0.2)
    raise RecoveryError(ERROR)


def wait_for_report(runtime, instance, since):
    deadline = runtime.monotonic() + 30
    while runtime.monotonic() < deadline:
        report = runtime.request('/api/desktop/permissions')
        build = report.get('build'); timestamp = report.get('updatedAt'); permissions = report.get('permissions')
        if (report.get('controllerConnected') is True and report.get('pending') is False
                and isinstance(build, dict) and isinstance(build.get('instanceId'), str)
                and build['instanceId'] and build['instanceId'] != instance
                and type(timestamp) in [float, int] and timestamp >= since * 1000
                and 0 <= runtime.now() * 1000 - timestamp < 12000
                and isinstance(permissions, dict) and type(permissions.get('screenCapture')) is bool):
            return permissions['screenCapture']
        runtime.sleep(0.2)
    raise RecoveryError(ERROR)


def recover(context, runtime):
    attempted = False
    try:
        context.validate()
        if runtime.process_state(context.pid, context.executable) != 'expected': raise RecoveryError(ERROR)
        idle(context, runtime)
        original = runtime.request('/api/desktop/permissions')
        build = original.get('build')
        if (original.get('controllerConnected') is not True or not isinstance(build, dict)
                or not isinstance(build.get('instanceId'), str) or not build['instanceId']):
            raise RecoveryError(ERROR)
        with runtime.installation_lock(context.home):
            try:
                # Revalidate after locking so a just-started meeting or update wins admission.
                idle(context, runtime)
                attempted = True
                maintenance(context, runtime, True)
                if runtime.process_state(context.pid, context.executable) != 'expected': raise RecoveryError(ERROR)
                runtime.run(['/usr/bin/tccutil', 'reset', 'ScreenCapture', BUNDLE_ID], timeout=10)
                runtime.emit({'readyToRestart': True})
                wait_for_exit(context, runtime)
                since = runtime.now()
                runtime.run(['/usr/bin/open', '-n', str(context.app), '--args',
                             '--resume-screen-capture-recovery', context.command], timeout=10)
                granted = wait_for_report(runtime, build['instanceId'], since)
                return {'restarted': True, 'authorized': granted}
            finally:
                if attempted: maintenance(context, runtime, False)
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        # Do not expose paths, API responses, private worker output or command stderr.
        raise RecoveryError(ERROR) from None


def output(value):
    try: print(json.dumps(value), flush=True)
    except BrokenPipeError:
        # The native parent normally closes its pipe when it exits. Guards have
        # already been released before final output, which is diagnostic only.
        sys.stdout = open(os.devnull, 'w')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True); parser.add_argument('--app', required=True)
    parser.add_argument('--pid', required=True, type=int); parser.add_argument('--command', required=True)
    args = parser.parse_args(argv)
    try:
        context = Context(args.root, args.app, args.pid, args.command)
        context.validate()
        result = recover(context, Runtime(context))
        output(result)
        return 0
    except (OSError, ValueError, subprocess.SubprocessError):
        output({'error': ERROR})
        return 1


if __name__ == '__main__': sys.exit(main())
