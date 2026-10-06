#!/usr/bin/python3
"""Helpers shared by the release installer and uninstaller.

Runs with the macOS system Python (3.9), so it uses only the standard library.
"""
import argparse
import json
import os
import pathlib
import signal
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request

NATIVE_HOST_DIRS = [
    "Library/Application Support/Google/Chrome/NativeMessagingHosts",
    "Library/Application Support/Microsoft Edge/NativeMessagingHosts",
]
NATIVE_HOST_NAME = "local.heed.meet.json"


def service_configuration():
    # Standalone uninstall helpers are copied out before deleting the runtime.
    # Their configuration still comes from the intact installed payload.
    root = pathlib.Path(os.environ.get("HEED_SERVICE_CONFIG_ROOT", str(pathlib.Path(__file__).resolve().parents[2]))).resolve()
    sys.path.insert(0, str(root / "scripts"))
    from service_config import service_config, service_port
    return service_config(), service_port


def service_identity(base, service, root=None):
    service_configuration()
    from service_runtime import read_identity
    return read_identity(base, service, root)


def command_ports(args):
    ports = args.service_ports
    if args.owned_release:
        from service_config import transcription_url
        from service_runtime import separately_managed_transcription
        if separately_managed_transcription(transcription_url(), ports['transcription']):
            raise ValueError('The packaged installer requires its own versioned transcription service. Use the checkout with the override, or remove HEED_TRANSCRIPTION_URL before installing this release. Existing services and data were preserved.')
    if args.saved:
        from service_config import saved_service_ports
        ports = saved_service_ports()
    elif args.defaults:
        from service_config import DEFAULTS, service_port
        ports = {key: service_port(DEFAULTS[key], key + " port") for key in ['api', 'ui', 'transcription']}
    if ports is not None:
        print("%d %d %d" % tuple(ports[key] for key in ["api", "ui", "transcription"]))
    return 0


def command_restore_port_absence(args):
    """Undo only this install's newly created device configuration; preserve unknown edits."""
    path = pathlib.Path(os.environ.get('HEED_APP_DIR', str(pathlib.Path.home() / '.heed-app'))) / 'service-ports.json'
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return 0
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_size > 4096:
            raise ValueError('The device port configuration changed; it was preserved.')
        raw = os.read(descriptor, 4097)
        expected = {'version': 1, **args.service_ports}
        value = json.loads(raw)
        if len(raw) > 4096 or not isinstance(value, dict) or value != expected or any(type(value[key]) is not int for key in expected):
            raise ValueError('The device port configuration changed; it was preserved.')
        current = os.lstat(path)
        if (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino):
            raise ValueError('The device port configuration changed; it was preserved.')
        os.unlink(path)
        parent = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
    finally:
        os.close(descriptor)
    return 0


def configuration_root(candidates):
    """Recognize intact payloads/checkouts before importing their runtime helpers."""
    for candidate in candidates:
        if not candidate:
            continue
        root = pathlib.Path(candidate).resolve()
        script = root / 'scripts/service_config.py'
        if not script.is_file() or script.is_symlink():
            continue
        for name, field in [('release.json', 'app'), ('package.json', 'name')]:
            descriptor = None
            try:
                descriptor = os.open(root / name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                info = os.fstat(descriptor)
                if not stat.S_ISREG(info.st_mode) or info.st_size > 16384:
                    continue
                raw = os.read(descriptor, 16385)
                if len(raw) <= 16384 and json.loads(raw).get(field) == 'heed':
                    return str(root)
            except (OSError, ValueError, AttributeError):
                continue
            finally:
                if descriptor is not None:
                    os.close(descriptor)
    raise ValueError('The installed safe service configuration was not found. Migrate the checkout with the latest install-macos.sh first. Nothing was removed.')


def command_configuration_root(args):
    print(configuration_root(args.candidate))
    return 0


def fetch_json(url, timeout=3.0, method="GET", body=None, max_bytes=65536):
    """Return (status, parsed JSON or None, raw text). Connection errors return status None."""
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        # Local ownership checks and permission mutations must not follow redirects.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args):
                return None
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        with opener.open(request, timeout=timeout) as response:
            payload = response.read(max_bytes + 1)
            status = response.status
            if len(payload) > max_bytes:
                return status, None, ""
            raw = payload.decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        raw = error.read(65536).decode("utf-8", "replace")
        status = error.code
    except (urllib.error.URLError, OSError, ValueError):
        return None, None, ""
    try:
        return status, json.loads(raw), raw
    except ValueError:
        return status, None, raw


def identity_problem(kind, status, data, version, commit=None):
    """Describe why a response is not the expected Heed service, or None when it is."""
    if status is None:
        return "not responding"
    if not isinstance(data, dict):
        return "answers HTTP %s without Heed identity (another application may own this port)" % status
    if kind == "transcription":
        if data.get("service") != "heed-transcription":
            return "answers JSON that is not the Heed transcription service (another application may own this port)"
    elif data.get("app") != "heed" or data.get("component") != "api":
        return "answers JSON that is not the Heed API (another application may own this port)"
    if data.get("version") != version:
        return "is Heed %s, expected %s" % (data.get("version"), version)
    # Another Heed checkout of the same version must not be mistaken for this installation.
    if commit and data.get("commit") != commit:
        return "is a different Heed build (commit %s, expected %s)" % (data.get("commit"), commit)
    return None


def check_services(version, api_port, ui_port, transcription_port, commit=None, root=None):
    checks = {
        "API": ("api", "http://127.0.0.1:%d/api/version" % api_port),
        # The interface proxies /api to the API, so this proves the interface port is Heed's.
        "Interface": ("api", "http://localhost:%d/api/version" % ui_port),
        "Transcription": ("transcription", "http://127.0.0.1:%d/health" % transcription_port),
    }
    result = {}
    for name, (kind, url) in checks.items():
        service = {"API": "heed-api", "Interface": "heed-ui", "Transcription": "heed-transcription"}[name]
        base = url.rsplit('/health' if kind == 'transcription' else '/api/version', 1)[0]
        probe = base + ('/health' if kind == 'transcription' else '/.well-known/heed-service')
        if fetch_json(probe)[0] is None:
            result[name] = "not responding"
            continue
        identity = service_identity(base, service, root)
        if identity is None:
            result[name] = "has no matching Heed service/root identity (another application may own this port)"
            continue
        if kind == "transcription" and identity.get("ready") is not True:
            result[name] = "is still loading the transcription engines"
            continue
        status, data, _ = fetch_json(url)
        result[name] = identity_problem(kind, status, data, version, commit)
    return result


def command_wait_ready(args):
    deadline = time.monotonic() + args.timeout
    foreign_since = {}
    last = {}
    while True:
        last = check_services(args.version, args.api_port, args.ui_port, args.transcription_port, args.commit, args.root)
        if all(problem is None for problem in last.values()):
            print("Heed %s services are ready (API %d, interface %d, transcription %d)."
                  % (args.version, args.api_port, args.ui_port, args.transcription_port))
            return 0
        now = time.monotonic()
        for name, problem in last.items():
            # A port that keeps answering as something else will never become Heed: fail early.
            if problem and ("another application" in problem or "different Heed build" in problem):
                foreign_since.setdefault(name, now)
                if now - foreign_since[name] >= args.foreign_grace:
                    print("%s port %s." % (name, problem), file=sys.stderr)
                    return 2
            else:
                foreign_since.pop(name, None)
        if now >= deadline:
            for name, problem in last.items():
                if problem:
                    print("%s %s." % (name, problem), file=sys.stderr)
            return 1
        time.sleep(args.interval)


def command_wait_api(args):
    """Wait only for an owned API; model loading is irrelevant to guard release."""
    deadline = time.monotonic() + args.timeout
    while True:
        if service_identity("http://127.0.0.1:%d" % args.api_port, "heed-api", args.root) is not None:
            return 0
        if time.monotonic() >= deadline:
            print("The previous Heed API did not return its expected identity. Its maintenance guard was not released.", file=sys.stderr)
            return 1
        time.sleep(min(args.interval, max(0, deadline - time.monotonic())))


# audioWork covers manual transcription and every other job that holds audio.
BUSY_KEYS = ["recording", "processing", "pending", "starting", "audioWork"]
# The desktop status includes the last saved session and its transcript snapshot.
# Keep reads bounded while allowing normal meeting history during an upgrade.
STATUS_RESPONSE_LIMIT = 16 * 1024 * 1024


def command_busy(args):
    """Exit 0 when Heed is idle or not running, 1 when audio work is active, 2 when the state is unknown."""
    status, data, _ = fetch_json("http://127.0.0.1:%d/api/desktop/control/status" % args.api_port,
                               max_bytes=STATUS_RESPONSE_LIMIT)
    if status is None:
        if listener_pids(args.api_port):
            print("The configured API listener did not return recording status. Nothing was stopped.", file=sys.stderr)
            return 2
        return 0
    if service_identity("http://127.0.0.1:%d" % args.api_port, "heed-api", args.root) is None:
        print("Port %d is used by another application or an unsupported service. It was not stopped; verify the configured port before retrying."
              % args.api_port, file=sys.stderr)
        return 2
    if status != 200 or not isinstance(data, dict) or not all(type(data.get(key)) is bool for key in BUSY_KEYS):
        print("Heed returned incomplete or unsupported recording status. Migrate its checkout with the latest install-macos.sh first. Its services and data were not changed.", file=sys.stderr)
        return 2
    active = [key for key in BUSY_KEYS if data.get(key)]
    if active:
        print("Heed is busy (%s)." % ", ".join(active), file=sys.stderr)
        return 1
    return 0


def describe_microphone(value):
    return {
        "authorized": "allowed",
        "denied": "denied - enable Heed in System Settings > Privacy & Security > Microphone",
        "restricted": "restricted by a device policy",
        "notDetermined": "not requested yet",
    }.get(value, "unknown")


def permission_lines(permissions):
    screen = permissions.get("screenCapture")
    slack = permissions.get("slackLogs")
    # (name, granted, detail, required)
    return [
        ("Microphone", permissions.get("microphone") == "authorized", describe_microphone(permissions.get("microphone")), True),
        ("Screen & System Audio Recording", screen is True,
         "allowed" if screen is True else "not allowed - enable Heed in System Settings > Privacy & Security > Screen & System Audio Recording", True),
        ("Slack meeting logs (optional)", slack is True,
         "allowed" if slack is True else "automatic Slack recording is off" if slack is None
         else "not authorized - use Allow Slack log access in the Heed menu", False),
    ]


def read_permissions(base, timeout):
    deadline = time.monotonic() + timeout
    while True:
        status, data, _ = fetch_json(base + "/api/desktop/permissions")
        if status == 200 and isinstance(data, dict) and data.get("controllerConnected") and isinstance(data.get("permissions"), dict):
            return data["permissions"]
        if time.monotonic() >= deadline:
            return None
        time.sleep(1)


def request_permission(base, action, timeout):
    status, data, _ = fetch_json(base + "/api/desktop/permissions", method="POST", body={"action": action})
    if status != 200:
        return
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        _, state, _ = fetch_json(base + "/api/desktop/permissions")
        if isinstance(state, dict) and not state.get("pending"):
            return
        time.sleep(1)


def command_permissions(args):
    base = "http://127.0.0.1:%d" % args.api_port
    if service_identity(base, "heed-api", args.root) is None:
        print("The configured API has no matching Heed identity. No permission request was sent.", file=sys.stderr)
        return 4
    permissions = read_permissions(base, args.timeout)
    if permissions is None:
        print("The Heed menu app did not report permissions. Open Heed from ~/Applications and check Settings and permissions.", file=sys.stderr)
        return 4
    if args.request:
        if permissions.get("microphone") == "notDetermined":
            print("Requesting microphone access. Answer the macOS prompt.")
            request_permission(base, "microphone", args.prompt_timeout)
        if permissions.get("screenCapture") is not True:
            print("Requesting Screen & System Audio Recording. macOS may open System Settings.")
            request_permission(base, "screenCapture", args.prompt_timeout)
        # Reports arrive every few seconds; wait for one taken after the requests.
        time.sleep(3)
        permissions = read_permissions(base, args.timeout) or permissions
    missing = False
    print("Permission check:")
    for name, granted, detail, required in permission_lines(permissions):
        print("  [%s] %s: %s" % ("OK" if granted else "!!" if required else "--", name, detail))
        missing = missing or (required and not granted)
    return 3 if missing else 0


def under(path, roots):
    real = os.path.realpath(path)
    for root in roots:
        root = os.path.realpath(root)
        if real == root or real.startswith(root.rstrip("/") + "/"):
            return True
    return False


def listener_pids(port):
    result = subprocess.run(["/usr/sbin/lsof", "-t", "-nP", "-iTCP:%d" % port, "-sTCP:LISTEN"],
                            capture_output=True, text=True)
    if result.returncode not in (0, 1):
        raise RuntimeError('Could not inspect the configured listener. No services were changed.')
    return sorted({int(pid) for pid in result.stdout.split()})


def process_cwd(pid):
    output = subprocess.run(["/usr/sbin/lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"],
                            capture_output=True, text=True).stdout
    paths = [line[1:] for line in output.splitlines() if line.startswith("n")]
    return paths[0] if paths else None


def owned_listener(pid, roots):
    cwd = process_cwd(pid)
    if not cwd or not under(cwd, roots):
        return False
    command = subprocess.run(['ps', '-ww', '-p', str(pid), '-o', 'command='],
                             capture_output=True, text=True).stdout.strip()
    service_configuration()
    from service_runtime import owned_process
    # The approved runtime root may contain multiple immutable version folders.
    # Match the actual checkout and exact service entrypoint, not merely its cwd.
    directory = pathlib.Path(os.path.realpath(cwd))
    for candidate in [directory, directory.parent, directory.parent.parent]:
        if under(str(candidate), roots) and any(owned_process(str(candidate), service, cwd, command)
                                               for service in ['api', 'ui', 'transcription']):
            return True
    return False


def command_stop_services(args):
    roots = [root for root in args.root if root]
    owned = []
    for port in args.ports:
        for pid in listener_pids(port):
            if not owned_listener(pid, roots):
                print("Port %d belongs to another application (PID %d). It was not stopped; free the port and run the installer again."
                      % (port, pid), file=sys.stderr)
                return 2
            owned.append(pid)
    for pid in set(owned):
        if not owned_listener(pid, roots):
            print("The listener's ownership changed. No signal was sent to PID %d." % pid, file=sys.stderr)
            return 2
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + args.timeout
    while time.monotonic() < deadline:
        if not any(listener_pids(port) for port in args.ports):
            return 0
        time.sleep(0.5)
    print("Heed services did not stop within %d seconds." % args.timeout, file=sys.stderr)
    return 1


def native_host_paths(home):
    return [pathlib.Path(home) / folder / NATIVE_HOST_NAME for folder in NATIVE_HOST_DIRS]


def command_migrate_native_hosts(args):
    target = str(pathlib.Path(args.new_root) / "packages/desktop/browser-meet/native-host.py")
    for path in native_host_paths(args.home):
        if not path.is_file():
            continue
        manifest = json.loads(path.read_text())
        if manifest.get("name") != "local.heed.meet" or not under(manifest.get("path", "/nonexistent"), args.old_root):
            continue
        manifest["path"] = target
        temporary = path.with_suffix(".json.new")
        temporary.write_text(json.dumps(manifest, indent=2) + "\n")
        temporary.chmod(0o600)
        os.replace(str(temporary), str(path))
        print("Updated the Meet browser bridge: %s" % path)
    return 0


def command_native_hosts(args):
    for path in native_host_paths(args.home):
        try:
            if json.loads(path.read_text()).get("name") == "local.heed.meet":
                print(path)
        except (OSError, ValueError):
            continue
    return 0


def command_state(args):
    path = pathlib.Path(args.file)
    state = {}
    if path.is_file():
        state = json.loads(path.read_text())
    if args.get:
        value = state.get(args.get)
        if isinstance(value, list):
            print("\n".join(value))
        elif value is not None:
            print(value)
        return 0
    for item in args.set or []:
        key, _, value = item.partition("=")
        state[key] = value if value else None
    for item in args.add or []:
        key, _, value = item.partition("=")
        values = state.get(key) or []
        if value and value not in values:
            values.append(value)
        state[key] = values
    temporary = path.with_suffix(".json.new")
    temporary.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n")
    os.replace(str(temporary), str(path))
    return 0


def command_release_field(args):
    data = json.loads(pathlib.Path(args.file).read_text())
    print(data[args.field])
    return 0


def owned_recordings(path, home=None):
    """True only for a real recordings folder inside a Heed checkout; never for home, root or symlinks."""
    home = os.path.realpath(home or str(pathlib.Path.home()))
    if not os.path.isabs(path) or os.path.islink(path) or not os.path.isdir(path):
        return False
    real = os.path.realpath(path)
    if real in ("/", home) or os.path.basename(real) != "recordings":
        return False
    package = os.path.join(os.path.dirname(real), "package.json")
    try:
        with open(package) as f:
            return json.load(f).get("name") == "heed"
    except (OSError, ValueError, AttributeError):
        return False


def command_owned_recordings(args):
    return 0 if owned_recordings(args.path) else 1


def command_remaining(args):
    remaining = [path for path in args.path if os.path.lexists(path)]
    for path in remaining:
        print(path)
    return 1 if remaining else 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    def ports(command):
        command.add_argument("--api-port", type=int)
        command.add_argument("--ui-port", type=int)
        command.add_argument("--transcription-port", type=int)
        command.add_argument("--root", help="Expected canonical checkout root of the running services")

    configuration = commands.add_parser("ports")
    configuration.add_argument("--saved", action="store_true", help="Return only the previous device-local ports, without environment overrides")
    configuration.add_argument("--defaults", action="store_true", help="Return validated checkout defaults, without environment overrides")
    configuration.add_argument("--owned-release", action="store_true", help="Require the packaged install's own versioned transcription endpoint")
    configuration.set_defaults(handler=command_ports)

    restore_absence = commands.add_parser('restore-port-absence')
    ports(restore_absence)
    restore_absence.set_defaults(handler=command_restore_port_absence)

    config_root = commands.add_parser('config-root')
    config_root.add_argument('--candidate', action='append', required=True)
    config_root.set_defaults(handler=command_configuration_root)

    ready = commands.add_parser("wait-ready")
    ready.add_argument("--version", required=True)
    ready.add_argument("--commit")
    ready.add_argument("--timeout", type=float, default=900)
    ready.add_argument("--interval", type=float, default=2)
    ready.add_argument("--foreign-grace", type=float, default=20)
    ports(ready)
    ready.set_defaults(handler=command_wait_ready)

    api_ready = commands.add_parser("wait-api")
    api_ready.add_argument("--timeout", type=float, default=20)
    api_ready.add_argument("--interval", type=float, default=0.5)
    ports(api_ready)
    api_ready.set_defaults(handler=command_wait_api)

    permissions = commands.add_parser("permissions")
    permissions.add_argument("--request", action="store_true")
    permissions.add_argument("--timeout", type=float, default=60)
    permissions.add_argument("--prompt-timeout", type=float, default=120)
    ports(permissions)
    permissions.set_defaults(handler=command_permissions)

    busy = commands.add_parser("busy")
    ports(busy)
    busy.set_defaults(handler=command_busy)

    stop = commands.add_parser("stop-services")
    stop.add_argument("--root", action="append", default=[])
    stop.add_argument("--ports", type=int, nargs="+", required=True)
    stop.add_argument("--timeout", type=int, default=20)
    stop.set_defaults(handler=command_stop_services)

    migrate = commands.add_parser("migrate-native-hosts")
    migrate.add_argument("--home", default=str(pathlib.Path.home()))
    migrate.add_argument("--new-root", required=True)
    migrate.add_argument("--old-root", action="append", default=[])
    migrate.set_defaults(handler=command_migrate_native_hosts)

    hosts = commands.add_parser("native-hosts")
    hosts.add_argument("--home", default=str(pathlib.Path.home()))
    hosts.set_defaults(handler=command_native_hosts)

    state = commands.add_parser("state")
    state.add_argument("file")
    state.add_argument("--get")
    state.add_argument("--set", action="append")
    state.add_argument("--add", action="append")
    state.set_defaults(handler=command_state)

    field = commands.add_parser("release-field")
    field.add_argument("file")
    field.add_argument("field")
    field.set_defaults(handler=command_release_field)

    recordings = commands.add_parser("owned-recordings")
    recordings.add_argument("path")
    recordings.set_defaults(handler=command_owned_recordings)

    remaining = commands.add_parser("remaining")
    remaining.add_argument("path", nargs="*")
    remaining.set_defaults(handler=command_remaining)

    args = parser.parse_args(argv)
    if args.command in ["ports", "restore-port-absence", "wait-ready", "wait-api", "permissions", "busy", "stop-services"]:
        defaults, validate = service_configuration()
        args.service_ports = {key: validate(defaults[key] if getattr(args, key + "_port", None) is None else getattr(args, key + "_port"), key + " port")
                              for key in ["api", "ui", "transcription"]}
        if args.command != "ports":
            for key, value in args.service_ports.items():
                setattr(args, key + "_port", value)
            if hasattr(args, "root") and args.command != "stop-services" and args.root is None:
                from service_config import ROOT
                args.root = str(ROOT)
        if args.command == "stop-services":
            args.ports = [validate(port, "Stop service port") for port in args.ports]
    return args.handler(args)


if __name__ == "__main__":
    sys.exit(main())
