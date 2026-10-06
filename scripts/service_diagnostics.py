"""Read-only local service diagnosis. Public output never contains process arguments or paths."""
import argparse
import json
import os
import pathlib
import re
import subprocess
import sys
import urllib.parse
import hashlib
import math
import stat
import socket
import tempfile
import time
from service_config import ROOT, service_config, transcription_url, local_service_url
from service_runtime import NAMES, read_identity, occupied, process_records, owned_process, python_arguments, separately_managed_transcription

def safe_application_name(value):
    if not isinstance(value, str) or any(character in value for character in '\r\n\t'):
        return None
    name = pathlib.PurePath(value.strip()).name
    if not re.fullmatch(r'[A-Za-z][A-Za-z0-9._-]{0,63}', name):
        return None
    return name

def classify(service, port, root, identity, records, listening, starting=False, external=False, failed=False):
    owned = [record for record in records if owned_process(root, service, record['cwd'], record['command'])]
    verified = identity is not None and (external or any(record['pid'] == identity['pid'] for record in owned))
    if verified:
        state = 'ready' if service != 'transcription' or identity.get('ready') is True else 'starting' if starting else 'unhealthy'
    elif owned:
        state = 'starting' if starting else 'unhealthy'
    elif listening:
        state = 'conflict'
    else:
        state = 'starting' if starting else 'unhealthy' if failed else 'stopped'
    return {'service': service, 'port': port, 'state': state}

def private_directory():
    return pathlib.Path(os.environ.get('HEED_APP_DIR', str(pathlib.Path.home() / '.heed-app')))

def read_document(filename):
    try:
        descriptor = os.open(private_directory() / filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_size > 4096:
                return None
            raw = os.read(descriptor, 4097)
            return json.loads(raw) if len(raw) <= 4096 else None
        finally:
            os.close(descriptor)
    except (OSError, ValueError, UnicodeError):
        return None

def write_document(filename, value):
    directory = private_directory()
    temporary = None
    try:
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        descriptor, temporary = tempfile.mkstemp(prefix='service-status.', dir=directory)
        with os.fdopen(descriptor, 'w') as output:
            json.dump(value, output); output.flush(); os.fsync(output.fileno())
        os.replace(temporary, directory / filename)
        parent = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
        return True
    except OSError:
        return False
    finally:
        if temporary:
            try:
                os.unlink(temporary)
            except OSError:
                pass

def record_startup(root, ports, phase):
    if phase not in ('starting', 'ready', 'failed'):
        raise ValueError('Invalid startup phase')
    value = {'version': 1, 'pid': os.getpid(), 'root': os.path.realpath(root),
             'ports': ports, 'phase': phase, 'startedAt': time.time()}
    try:
        (private_directory() / 'service-diagnostics.json').unlink()
    except OSError:
        pass
    return write_document('service-startup.json', value)

def bootstrap_owned(pid, root):
    try:
        command = subprocess.run(['ps', '-ww', '-p', str(pid), '-o', 'command='], capture_output=True, text=True, timeout=.4).stdout.strip()
        cwd = subprocess.run(['/usr/sbin/lsof', '-a', '-p', str(pid), '-d', 'cwd', '-Fn'], capture_output=True, text=True, timeout=.4).stdout
        arguments=python_arguments(root,root,command,'scripts/service_runtime.py')
        if not arguments or arguments[0]!='start':return False
        options=arguments[1:]
        if len(options)%2 or any(options[index] not in ('--root','--log-dir') for index in range(0,len(options),2)) or len(set(options[::2]))!=len(options[::2]):return False
        if '--root' in options and os.path.realpath(options[options.index('--root')+1])!=root:return False
        return any(os.path.realpath(line[1:]) == root for line in cwd.splitlines() if line.startswith('n'))
    except (OSError, subprocess.TimeoutExpired):
        return False

def startup_states(root, ports):
    data = read_document('service-startup.json')
    if not isinstance(data, dict) or type(data.get('version')) is not int or data.get('version') != 1 or data.get('root') != os.path.realpath(root):
        return {}
    saved = data.get('ports')
    if not isinstance(saved, dict) or not saved or any(key not in ports or type(value) is not int for key, value in saved.items()):
        return {}
    matching = {key: value for key, value in saved.items() if value == ports[key]}
    if not matching:
        return {}
    started = data.get('startedAt')
    if type(started) not in (float, int) or not math.isfinite(started) or time.time() < started:
        return {}
    if data.get('phase') == 'failed':
        return {key: 'failed' for key in matching}
    pid = data.get('pid')
    if data.get('phase') == 'starting' and type(pid) is int and pid > 0 and time.time() - started <= 35 and bootstrap_owned(pid, os.path.realpath(root)):
        return {key: 'starting' for key in matching}
    return {}

def application_name(records):
    for record in records:
        try:
            value = subprocess.run(['ps', '-p', str(record['pid']), '-o', 'comm='], capture_output=True,
                                   text=True, timeout=.4).stdout.strip()
            name = safe_application_name(value)
            if name:
                return name
        except (OSError, subprocess.TimeoutExpired):
            pass
    return None

def inspect_services(root, ports, external_url=None, api_url=None):
    notices = []
    startup = startup_states(root, ports)
    for service, configured_port in ports.items():
        base = external_url if service == 'transcription' and external_url else api_url if service == 'api' and api_url else f'http://127.0.0.1:{configured_port}'
        parsed = urllib.parse.urlsplit(base)
        port = parsed.port or (443 if parsed.scheme == 'https' else 80)
        external = service == 'transcription' and external_url is not None and separately_managed_transcription(external_url,configured_port)
        identity = read_identity(base, NAMES[service], None if external else root, timeout=.35)
        # A separately managed IPv6/TLS origin cannot borrow an IPv4 process
        # name merely because that unrelated listener uses the same port.
        records = [] if external or parsed.hostname not in ('127.0.0.1','localhost') else process_records(port,timeout=.4)
        try:
            with socket.create_connection((parsed.hostname,port),timeout=.2):listening=True
        except OSError:
            listening=False
        notice = classify(service, port, root, identity, records, listening, starting=startup.get(service) == 'starting',
                          failed=startup.get(service) == 'failed', external=external)
        if notice['state'] == 'conflict' and not external:
            name = application_name(records)
            if name:
                notice['application'] = name
        notices.append(notice)
    return notices

def valid_notices(value, ports, external_url):
    if not isinstance(value, list) or len(value) != 3:
        return False
    expected = dict(ports)
    if external_url:
        parsed = urllib.parse.urlsplit(external_url)
        expected['transcription'] = parsed.port or (443 if parsed.scheme == 'https' else 80)
    found = set()
    for item in value:
        if not isinstance(item, dict) or not set(item).issubset({'service', 'port', 'state', 'application'}):
            return False
        service = item.get('service')
        if service not in expected or service in found or type(item.get('port')) is not int or item['port'] != expected[service] or item.get('state') not in ('ready', 'stopped', 'starting', 'unhealthy', 'conflict'):
            return False
        if 'application' in item and (item['state'] != 'conflict' or safe_application_name(item['application']) != item['application']):
            return False
        found.add(service)
    return found == set(expected)

def cached_inspection(root, ports, external_url=None, refresh=False, api_url=None):
    context = hashlib.sha256(json.dumps([os.path.realpath(root), ports, external_url,api_url], sort_keys=True).encode()).hexdigest()
    cached = read_document('service-diagnostics.json')
    if not refresh and isinstance(cached, dict) and cached.get('version') == 1 and cached.get('context') == context:
        updated = cached.get('updatedAt')
        if type(updated) in (float, int) and math.isfinite(updated) and 0 <= time.time() - updated <= 5 and valid_notices(cached.get('notices'), ports, external_url):
            return cached['notices']
    notices = inspect_services(root, ports, external_url,api_url)
    write_document('service-diagnostics.json', {'version': 1, 'context': context, 'updatedAt': time.time(), 'notices': notices})
    return notices

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', default=str(ROOT))
    parser.add_argument('--refresh', action='store_true')
    parser.add_argument('--api-origin')
    arguments = parser.parse_args()
    try:
        # Establish a private group before any inspector subprocesses. Native
        # Process and detached Node children may have already created it.
        if os.getpgrp() != os.getpid():
            os.setsid()
        root = os.path.realpath(arguments.root)
        if root != str(ROOT):
            raise ValueError()
        ports = service_config()
        api_url=local_service_url(arguments.api_origin,'API proxy') if arguments.api_origin else None
        if api_url:
            parsed=urllib.parse.urlsplit(api_url);ports['api']=parsed.port or (443 if parsed.scheme=='https' else 80)
        print(json.dumps(cached_inspection(root, ports, transcription_url() if 'HEED_TRANSCRIPTION_URL' in os.environ else None, arguments.refresh,api_url)))
    except (ValueError, OSError, RuntimeError, subprocess.TimeoutExpired):
        sys.exit('Service diagnostics unavailable. Check the configured ports and try again.')
