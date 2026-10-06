#!/usr/bin/env python3
"""Mounted-SMB adapter. Descriptor-relative I/O never recreates a missing mount.

The CLI accepts one bounded JSON request followed by optional streamed bytes.
Raw mount sources, smbutil output, exceptions and credentials never leave this process.
"""
import ctypes
import errno
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import uuid
import signal
import fcntl
import threading
from contextlib import contextmanager

MAX_BYTES = 8_000_000_000_000
CHUNK = 131072


class ShareError(Exception):
    pass


@contextmanager
def receipt_critical_section():
    # Defer app SIGTERM only across CREATE-to-private-inode checkpoint. Forced
    # SIGKILL remains bounded and an unknown outcome is never adopted.
    previous=signal.pthread_sigmask(signal.SIG_BLOCK,{signal.SIGTERM})
    try:yield
    finally:signal.pthread_sigmask(signal.SIG_SETMASK,previous)


class DarwinStatFS(ctypes.Structure):
    _fields_ = [("bsize", ctypes.c_uint32), ("iosize", ctypes.c_int32),
                *[(name, ctypes.c_uint64) for name in ("blocks", "bfree", "bavail", "files", "ffree")],
                ("fsid", ctypes.c_int32 * 2), ("owner", ctypes.c_uint32), ("type", ctypes.c_uint32),
                ("flags", ctypes.c_uint32), ("subtype", ctypes.c_uint32), ("fstypename", ctypes.c_char * 16),
                ("mntonname", ctypes.c_char * 1024), ("mntfromname", ctypes.c_char * 1024),
                ("flags_ext", ctypes.c_uint32), ("reserved", ctypes.c_uint32 * 7)]


def mounted_share(fd):
    if sys.platform != "darwin":
        raise ShareError("unsupported-platform")
    buf = DarwinStatFS()
    libc = ctypes.CDLL(None, use_errno=True)
    call = getattr(libc, "fstatfs$INODE64", None) or libc.fstatfs
    if call(fd, ctypes.byref(buf)) != 0:
        raise ShareError("mount-unavailable")
    source = bytes(buf.mntfromname).decode("utf-8", "strict")
    # The SMB mount source may contain credentials. Retain only a one-way
    # server/share identity, stripping all user information before hashing.
    source = source.rsplit("@", 1)[-1].lstrip("/")
    return {"type": bytes(buf.fstypename).decode("ascii"), "fsid": f"{buf.fsid[0]}:{buf.fsid[1]}",
            "sourceHash": hashlib.sha256(source.encode()).hexdigest(),
            "mountPath": bytes(buf.mntonname).decode("utf-8", "strict"), "readOnly": bool(buf.flags & 1)}


def security_capabilities(raw):
    if not isinstance(raw, list) or len(raw) != 1 or not isinstance(raw[0], dict):
        return {"security": "unknown", "dialect": "unknown", "authentication": "macOS-session"}
    value = raw[0]
    dialect = value.get("SMB_VERSION")
    if dialect not in ("SMB_2.002", "SMB_2.1", "SMB_3.0", "SMB_3.0.2", "SMB_3.1.1"):
        dialect = "unknown"
    security = "unknown"
    if dialect != "unknown":
        if value.get("ENCRYPTION_REQUIRED") is True and dialect.startswith("SMB_3"):
            security = "encrypted"
        elif value.get("SIGNING_ON") is True:
            security = "signed"
    return {"security": security, "dialect": dialect, "authentication": "macOS-session"}


def probe_security(mount_path):
    # Scope the public diagnostic command to this selected mount. Never expose
    # stdout/stderr or use its support flags as evidence of active protection.
    try:
        result = subprocess.run(["/usr/bin/smbutil", "statshares", "-m", mount_path, "-f", "json"],
                                capture_output=True, timeout=8, check=False)
        if result.returncode != 0 or len(result.stdout) > 65536:
            raise ValueError()
        return security_capabilities(json.loads(result.stdout))
    except (OSError, ValueError, subprocess.SubprocessError):
        return security_capabilities(None)


def volume_atomic_operations(fd):
    """Read the public volume interface flags; never infer NAS capability."""
    if sys.platform != 'darwin':
        # Explicit non-production local fixtures use Linux renameat2.
        return hasattr(ctypes.CDLL(None), 'renameat2')
    class Attributes(ctypes.Structure):
        _fields_ = [('count',ctypes.c_uint16),('reserved',ctypes.c_uint16),
                    *[(name,ctypes.c_uint32) for name in ('common','volume','directory','file','fork')]]
    class Capabilities(ctypes.Structure):
        _fields_ = [('length',ctypes.c_uint32),('capabilities',ctypes.c_uint32*4),('valid',ctypes.c_uint32*4)]
    attributes=Attributes(5,0,0,0x80020000,0,0,0);result=Capabilities()
    libc=ctypes.CDLL(None,use_errno=True)
    return libc.fgetattrlist(fd,ctypes.byref(attributes),ctypes.byref(result),ctypes.sizeof(result),0)==0 and result.length==ctypes.sizeof(result) and bool(result.capabilities[1]&result.valid[1]&0x00080000)


def logical_path(path):
    if not isinstance(path, str) or len(path) > 512 or not re.fullmatch(r"[A-Za-z0-9_./-]+", path):
        raise ShareError("invalid-path")
    parts = path.split("/")
    if parts[0] not in ("meetings", "commits", "objects") or any(p in ("", ".", "..") for p in parts):
        raise ShareError("invalid-path")
    return parts


def publish_exclusive(parent_fd, temporary, name):
    if sys.platform == "darwin":
        libc = ctypes.CDLL(None, use_errno=True)
        # Public Darwin renameatx_np(RENAME_EXCL) is atomic and refuses an
        # existing immutable target. Never use ordinary overwriting rename.
        if libc.renameatx_np(parent_fd, temporary.encode(), parent_fd, name.encode(), 4) != 0:
            code = ctypes.get_errno()
            if code == 17:
                raise FileExistsError()
            raise ShareError("atomic-publication-unavailable")
    else:
        # Unit fixtures use descriptor-relative hard links. Production rejects
        # non-Darwin mounts before reaching this path.
        os.link(temporary, name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd, follow_symlinks=False)
        os.unlink(temporary, dir_fd=parent_fd)


class SafeShare:
    def __init__(self, path, expected=None, probe=mounted_share):
        if not isinstance(path, str) or not os.path.isabs(path) or "\x00" in path or len(path) > 4096:
            raise ShareError("invalid-folder")
        self.probe = probe
        self.authority = None
        self.fd = -1
        fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
        try:
            for component in path.split("/"):
                if not component:
                    continue
                if component in (".", ".."):
                    raise ShareError("invalid-folder")
                child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = child
            self.identity = probe(fd)
            if self.identity["type"] != "smbfs":
                raise ShareError("not-smb-mount")
            self.expected = dict(expected or self.identity)
            self.fd = fd
            fd = -1
            self.check()
        finally:
            if fd != -1:
                os.close(fd)

    def close(self):
        if self.fd != -1:
            os.close(self.fd)
            self.fd = -1

    def check(self, fd=None, write=False):
        info = self.probe(self.fd if fd is None else fd)
        if info["type"] != "smbfs" or any(info[key] != self.expected[key] for key in ("fsid", "sourceHash", "mountPath")):
            raise ShareError("mount-changed")
        if write and info["readOnly"]:
            raise ShareError("read-only")
        if self.authority is not None: self.authority()

    def directory(self, parts, create=False):
        self.check(write=create)
        fd = os.dup(self.fd)
        try:
            for part in parts:
                self.check(fd, write=create)
                try:
                    child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                except FileNotFoundError:
                    if not create:
                        raise
                    # The open parent is still on the exact bound mount. A
                    # replaced path cannot redirect this mkdir into local storage.
                    try:
                        os.mkdir(part, mode=0o700, dir_fd=fd)
                    except FileExistsError:
                        pass
                    child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                self.check(child, write=create)
                os.close(fd)
                fd = child
            return fd
        except BaseException:
            os.close(fd)
            raise

    def open_file(self, parts):
        parent = self.directory(parts[:-1])
        try:
            fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
            if not stat.S_ISREG(os.fstat(fd).st_mode) or self.authority is not None and os.fstat(fd).st_nlink != 1:
                os.close(fd)
                raise ShareError("invalid-file")
            self.check(fd)
            return fd
        finally:
            os.close(parent)

    def stream(self, path, limit, output):
        if not isinstance(limit, int) or isinstance(limit, bool) or not 0 <= limit <= MAX_BYTES:
            raise ShareError("invalid-size")
        fd = self.open_file(logical_path(path))
        try:
            if os.fstat(fd).st_size > limit:
                raise ShareError("size-exceeded")
            received = 0
            while True:
                self.check(fd)
                chunk = os.read(fd, CHUNK)
                if not chunk:
                    break
                received += len(chunk)
                if received > limit:
                    raise ShareError("size-exceeded")
                output.write(chunk)
            self.check(fd)
        finally:
            os.close(fd)

    def read(self, path, limit):
        import io
        output = io.BytesIO()
        self.stream(path, limit, output)
        return output.getvalue()

    def matches(self, parent, name, count, digest):
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
        try:
            self.check(fd)
            if not stat.S_ISREG(os.fstat(fd).st_mode) or self.authority is not None and os.fstat(fd).st_nlink != 1 or os.fstat(fd).st_size != count:
                return False
            value = hashlib.sha256()
            while True:
                self.check(fd)
                chunk = os.read(fd, CHUNK)
                if not chunk:
                    break
                value.update(chunk)
            self.check(fd)
            return value.hexdigest() == digest
        finally:
            os.close(fd)

    def write_parts(self, parts, source, count, digest, staging_id=None):
        if not isinstance(count, int) or isinstance(count, bool) or not 0 <= count <= MAX_BYTES or not re.fullmatch(r"[a-f0-9]{64}", digest):
            raise ShareError("invalid-size")
        parent = self.directory(parts[:-1], create=True)
        if staging_id is not None:
            uuid.UUID(staging_id)
        temporary = ".heed-" + (staging_id or str(uuid.uuid4())) + "-" + digest[:16]
        fd, lock_fd, locked = -1, -1, False
        try:
            self.check(parent, write=True)
            if staging_id:
                # A stable separate lock survives publication renames. Hold it
                # through stage cleanup so another retry cannot lose its inode.
                lock_fd = os.open(".heed-" + staging_id + ".lock", os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=parent)
                lock_info = os.fstat(lock_fd)
                if not stat.S_ISREG(lock_info.st_mode) or lock_info.st_nlink != 1:
                    raise ShareError("invalid-lock")
                self.check(lock_fd, write=True)
                try:
                    fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except OSError:
                    raise ShareError("staging-busy")
                locked = True
            if staging_id:
                # Reclaim only this connection's exact interrupted temporary
                # object. Stable names bound retry debris without deleting any
                # committed object or another connection's staging file.
                try:
                    previous = os.stat(temporary, dir_fd=parent, follow_symlinks=False)
                    if not stat.S_ISREG(previous.st_mode):
                        raise ShareError("invalid-file")
                    os.unlink(temporary, dir_fd=parent)
                except FileNotFoundError:
                    pass
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
            self.check(fd, write=True)
            received, value = 0, hashlib.sha256()
            while True:
                chunk = source.read(CHUNK)
                if not chunk:
                    break
                received += len(chunk)
                if received > count:
                    raise ShareError("size-exceeded")
                value.update(chunk)
                self.check(fd, write=True)
                remaining = memoryview(chunk)
                while remaining:
                    written = os.write(fd, remaining)
                    if written <= 0:
                        raise ShareError("write-unavailable")
                    remaining = remaining[written:]
            if received != count or value.hexdigest() != digest:
                raise ShareError("integrity-failed")
            os.fsync(fd)
            os.close(fd)
            fd = -1
            self.check(parent, write=True)
            try:
                publish_exclusive(parent, temporary, parts[-1])
            except FileExistsError:
                if not self.matches(parent, parts[-1], count, digest):
                    raise ShareError("immutable-conflict")
            os.fsync(parent)
            if not self.matches(parent, parts[-1], count, digest):
                raise ShareError("integrity-failed")
            self.check(parent, write=True)
        finally:
            if fd != -1:
                os.close(fd)
            try:
                if not staging_id or locked:
                    try:
                        os.unlink(temporary, dir_fd=parent)
                    except FileNotFoundError:
                        pass
            finally:
                if lock_fd != -1:
                    os.close(lock_fd)
                os.close(parent)

    def write(self, path, source, count, digest, staging_id=None):
        self.check(write=True)
        self.write_parts(logical_path(path), source, count, digest, staging_id)

    def list_commits(self, limit):
        self.check()
        try:
            root = self.directory(["commits"])
        except FileNotFoundError:
            return []
        paths = []
        try:
            devices = os.listdir(root)
            if len(devices) > limit:
                raise ShareError("discovery-limit")
            for device in sorted(devices):
                if device.startswith("."):
                    continue
                logical_path("commits/" + device)
                child = os.open(device, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
                try:
                    self.check(child)
                    names = os.listdir(child)
                    if len(names) + len(paths) > limit:
                        raise ShareError("discovery-limit")
                    for name in sorted(names):
                        if name.startswith(".") or not name.endswith(".json"):
                            continue
                        info = os.stat(name, dir_fd=child, follow_symlinks=False)
                        if not stat.S_ISREG(info.st_mode):
                            raise ShareError("invalid-file")
                        paths.append("commits/" + device + "/" + name)
                finally:
                    os.close(child)
            self.check()
            return paths
        finally:
            os.close(root)

    def header(self, versions=(1,)):
        try:
            fd = self.open_file(["heed-library.json"])
        except FileNotFoundError:
            return None
        try:
            if os.fstat(fd).st_size > 4096:
                raise ShareError("invalid-library")
            content = os.read(fd, 4097)
            self.check(fd)
            value = json.loads(content)
            if not isinstance(value, dict) or set(value) != {"format", "schemaVersion", "destinationId"} or value["format"] != "heed-portable-library" or value["schemaVersion"] not in versions or not re.fullmatch(r"[a-f0-9-]{36}", value["destinationId"]):
                raise ShareError("invalid-library")
            uuid.UUID(value["destinationId"])
            return value
        finally:
            os.close(fd)


LEASE_NAME = ".heed-v2-lease"
MAX_PRIVATE = 65536


def physical_uuid():
    if sys.platform != "darwin":
        raise ShareError("physical-origin-unavailable")
    result = subprocess.run(["/usr/sbin/ioreg", "-rd1", "-c", "IOPlatformExpertDevice"], capture_output=True, timeout=5, check=False)
    if result.returncode != 0 or len(result.stdout) > 65536:
        raise ShareError("physical-origin-unavailable")
    match = re.search(rb'"IOPlatformUUID"\s*=\s*"([A-Fa-f0-9-]{36})"', result.stdout)
    if not match:
        raise ShareError("physical-origin-unavailable")
    return str(uuid.UUID(match.group(1).decode()))


def file_identity(fd):
    info = os.fstat(fd)
    return [str(info.st_dev), str(info.st_ino)]


def bounded_json(parent, name, maximum=MAX_PRIVATE):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > maximum:
            raise ShareError("invalid-record")
        if [str(info.st_dev), str(info.st_ino)] != file_identity_at(parent, name):
            raise ShareError("record-changed")
        data = bytearray()
        while len(data) <= maximum:
            chunk = os.read(fd, min(CHUNK, maximum + 1 - len(data)))
            if not chunk: break
            data.extend(chunk)
        if len(data) > maximum:
            raise ShareError("record-limit")
        return json.loads(data)
    finally:
        os.close(fd)


def file_identity_at(parent, name):
    info = os.stat(name, dir_fd=parent, follow_symlinks=False)
    return [str(info.st_dev), str(info.st_ino)]


def checked_directory(path):
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for component in path.split('/'):
            if not component: continue
            if component in ('.', '..'): raise ShareError('invalid-folder')
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd); fd = child
        return fd
    except BaseException:
        os.close(fd); raise


def exclusive_rename(parent, name, target_parent, target):
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "darwin":
        result = libc.renameatx_np(parent, name.encode(), target_parent, target.encode(), 4)
    elif hasattr(libc, "renameat2"):
        # Direct synthetic Linux fixtures only; production mounts remain Darwin.
        result = libc.renameat2(parent, name.encode(), target_parent, target.encode(), 1)
    else:
        raise ShareError("exclusive-rename-unavailable")
    if result != 0:
        if ctypes.get_errno() == errno.EEXIST: raise FileExistsError(errno.EEXIST, 'exclusive destination exists')
        raise ShareError("exclusive-rename-unavailable")


def valid_uuid(value):
    if not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}', value, re.I):
        raise ShareError('invalid-identifier')
    return value


def exact_keys(value, keys, optional=()):
    if not isinstance(value, dict) or not set(keys).issubset(value) or set(value) - set(keys) - set(optional):
        raise ShareError('invalid-control')
    return value


def revision(value, descriptor=False):
    exact_keys(value, ('libraryId', 'meetingId', 'revisionId') + (('manifestHash', 'parents') if descriptor else ()))
    for key in ('libraryId', 'meetingId', 'revisionId'): valid_uuid(value[key])
    if descriptor:
        if not isinstance(value['manifestHash'], str) or not re.fullmatch(r'[a-f0-9]{64}', value['manifestHash']) or not isinstance(value['parents'], list) or len(value['parents']) > 32 or len(set(value['parents'])) != len(value['parents']): raise ShareError('invalid-control')
        for parent in value['parents']:
            valid_uuid(parent)
            if parent == value['revisionId']: raise ShareError('invalid-control')
    return value


def artifact(value):
    exact_keys(value, ('path', 'bytes', 'sha256'))
    if not isinstance(value['bytes'], int) or isinstance(value['bytes'], bool) or not 0 < value['bytes'] <= MAX_BYTES or not isinstance(value['sha256'], str) or not re.fullmatch(r'[a-f0-9]{64}', value['sha256']): raise ShareError('invalid-artifact')
    parts = logical_path(value['path'])
    if parts[0] == 'objects':
        if len(parts) != 2 or parts[1] != value['sha256']: raise ShareError('invalid-artifact')
    elif parts[0] == 'commits':
        if len(parts) != 3 or not parts[2].endswith('.json'): raise ShareError('invalid-artifact')
        valid_uuid(parts[1]); valid_uuid(parts[2][:-5])
        if value['bytes'] > 16384: raise ShareError('metadata-limit')
    else:
        if len(parts) != 5 or parts[2] != 'revisions' or parts[4] not in ('meeting.json', 'manifest.json'): raise ShareError('invalid-artifact')
        valid_uuid(parts[1]); valid_uuid(parts[3])
        if value['bytes'] > (65536 if parts[4] == 'manifest.json' else 16_000_000): raise ShareError('metadata-limit')
    return value


def deletion_record(value):
    exact_keys(value, ('version', 'jobId', 'destinationId', 'revisions', 'artifacts'))
    if value['version'] != 1: raise ShareError('invalid-control')
    valid_uuid(value['jobId']); valid_uuid(value['destinationId'])
    if not isinstance(value['revisions'], list) or not 1 <= len(value['revisions']) <= 1000 or not isinstance(value['artifacts'], list) or not 1 <= len(value['artifacts']) <= 10000: raise ShareError('control-limit')
    for item in value['revisions']: revision(item, True)
    for item in value['artifacts']: artifact(item)
    if len({(r['libraryId'], r['meetingId'], r['revisionId']) for r in value['revisions']}) != len(value['revisions']) or len({a['path'] for a in value['artifacts']}) != len(value['artifacts']) or len(json_bytes(value)) > 2_000_000: raise ShareError('invalid-control')
    # Metadata targets must belong to a selected revision; audio removal stays disabled.
    for a in value['artifacts']:
        parts = logical_path(a['path'])
        if parts[0] == 'meetings' and not any(r['meetingId'] == parts[1] and r['revisionId'] == parts[3] and (parts[4] != 'manifest.json' or r['manifestHash'] == a['sha256']) for r in value['revisions']): raise ShareError('invalid-control-scope')
        if parts[0] == 'commits' and not any(r['revisionId'] == parts[2][:-5] for r in value['revisions']): raise ShareError('invalid-control-scope')
    return value


def publication_intent(value):
    exact_keys(value, ('version', 'id', 'deviceId', 'revision'), ('audio',))
    if value['version'] != 1: raise ShareError('invalid-control')
    valid_uuid(value['id']); valid_uuid(value['deviceId']); revision(value['revision'])
    if 'audio' in value:
        artifact(value['audio'])
        if not value['audio']['path'].startswith('objects/'): raise ShareError('invalid-control')
    return value


def deletion_fence(value):
    exact_keys(value, ('kind', 'version', 'jobId', 'destinationId', 'revision', 'artifact'))
    if value['kind'] != 'heed-deleted-revision' or value['version'] != 1: raise ShareError('invalid-fence')
    valid_uuid(value['jobId']); valid_uuid(value['destinationId']); revision(value['revision'], True); artifact(value['artifact'])
    r = value['revision']
    if value['artifact']['path'] != 'meetings/' + r['meetingId'] + '/revisions/' + r['revisionId'] + '/manifest.json' or value['artifact']['sha256'] != r['manifestHash']: raise ShareError('invalid-fence')
    return value


def json_bytes(value):
    return json.dumps(value, separators=(',', ':'), ensure_ascii=False).encode()


def validate_marker(value):
    exact_keys(value, ('schemaVersion', 'libraryId', 'meetingId', 'revisionId', 'deviceId', 'manifestPath', 'manifestHash'))
    revision({key: value[key] for key in ('libraryId', 'meetingId', 'revisionId')}); valid_uuid(value['deviceId'])
    if value['schemaVersion'] != 1 or not isinstance(value['manifestHash'], str) or not re.fullmatch(r'[a-f0-9]{64}', value['manifestHash']) or value['manifestPath'] != 'meetings/' + value['meetingId'] + '/revisions/' + value['revisionId'] + '/manifest.json': raise ShareError('invalid-commit')
    return value


class Transaction:
    """One guardian owns native I/O, its local guard and persistent remote claim."""
    def __init__(self, app_dir, request, probe=mounted_share, physical=physical_uuid, security=probe_security):
        self.app_fd = self.catalog_fd = self.guard_fd = self.lease_fd = -1
        self.fs = None; self.closed = False; self.released = False
        self.physical = physical; self.request = request
        self.checkpointed = False; self.created_claim = False; self.fresh_journal = False
        try:
            self.physical_value = physical()
            if request.get("kind") not in ("read", "publish", "delete"):
                raise ShareError("invalid-operation")
            for key in ("destinationId", "operationId", "deviceId"):
                uuid.UUID(request[key])
            if not isinstance(app_dir, str) or not os.path.isabs(app_dir):
                raise ShareError("invalid-private-root")
            self.app_path = os.path.realpath(app_dir)
            os.makedirs(self.app_path, mode=0o700, exist_ok=True)
            self.app_fd = os.open(self.app_path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            self.app_identity = file_identity(self.app_fd)
            fd = os.dup(self.app_fd)
            try:
                for component in ("library", "catalog", "transactions"):
                    try:
                        os.mkdir(component, mode=0o700, dir_fd=fd); os.fsync(fd)
                    except FileExistsError: pass
                    child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                    os.close(fd); fd = child
                self.catalog_fd = fd; fd = -1
            finally:
                if fd >= 0: os.close(fd)
            if len(os.listdir(self.catalog_fd)) > 256: raise ShareError("private-journal-limit")
            self.journal_name = request["operationId"] + ".json"
            self.guard_name = request["destinationId"] + ".guard"
            try: previous = bounded_json(self.catalog_fd, self.journal_name, 4_000_000)
            except FileNotFoundError: previous = None
            flags = os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK
            if previous is None: flags |= os.O_CREAT
            self.guard_fd = os.open(self.guard_name, flags, 0o600, dir_fd=self.catalog_fd)
            info = os.fstat(self.guard_fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise ShareError("invalid-local-guard")
            fcntl.flock(self.guard_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            os.fsync(self.guard_fd); os.fsync(self.catalog_fd)
            self.origin = self.current_origin()
            scope = {key: request[key] for key in ("root", "identity", "destinationId", "operationId", "deviceId", "kind")}
            scope.update(connectionGeneration=request.get("connectionGeneration"), security=request.get("security"), readOnly=bool(request.get("readOnly")))
            if previous is not None:
                if not isinstance(previous, dict) or set(previous) != {"version", "origin", "scope", "nonce", "phase", "receipt", "admissions", "fences", "effects"} or previous["version"] != 1 or previous["origin"] != self.origin or previous["scope"] != scope or previous["phase"] not in ("prepared", "claimed", "checkpointed", "releasing"):
                    raise ShareError("recovery-required")
                uuid.UUID(previous["nonce"])
                self.journal = previous
                if any(not isinstance(previous[key], dict) or len(previous[key]) > 10000 for key in ('admissions','fences')) or not isinstance(previous["effects"], int) or isinstance(previous["effects"], bool) or not 0 <= previous["effects"] <= 100000: raise ShareError("invalid-admissions")
            else:
                self.journal = {"version": 1, "origin": self.origin, "scope": scope, "nonce": str(uuid.uuid4()), "phase": "prepared", "receipt": None, "admissions": {}, "fences": {}, "effects": 0}
                self.save_journal(); self.fresh_journal = True
            # Origin and local exclusion are established before any remote call.
            self.fs = SafeShare(request["root"], request["identity"], probe=probe)
            if request.get('readOnly') or self.fs.identity['readOnly']:
                raise ShareError('v2-coordination-permission-required')
            protection = security(self.fs.identity['mountPath'])
            if protection['security'] not in ('signed', 'encrypted') or request.get('security') == 'encrypted' and protection['security'] != 'encrypted': raise ShareError('protected-session-required')
            self.fs.check(write=True)
            if not volume_atomic_operations(self.fs.fd): raise ShareError('unsupported-filesystem')
            if self.fs.header((2,)) != {"format": "heed-portable-library", "schemaVersion": 2, "destinationId": request["destinationId"]}:
                raise ShareError("destination-changed")
            self.root_identity = file_identity(self.fs.fd)
            self.owner = {"version": 1, "destinationId": request["destinationId"], "deviceId": request["deviceId"], "operationId": request["operationId"], "nonce": self.journal["nonce"]}
            if self.journal["phase"] == "releasing":
                self.finish_release()
                raise ShareError("released-operation")
            if self.journal["phase"] == "prepared":
                with receipt_critical_section():
                    receipt=self.journal['receipt']
                    if receipt is None:
                        self.created_claim = True  # Unknown mkdir outcome is never guessed.
                        try: os.mkdir(LEASE_NAME, mode=0o700, dir_fd=self.fs.fd)
                        except FileExistsError:
                            self.created_claim = False
                            raise ShareError("destination-busy")
                        self.lease_fd=os.open(LEASE_NAME,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=self.fs.fd)
                        receipt={'root':self.root_identity,'lease':file_identity(self.lease_fd),'owner':None}
                        self.journal['receipt']=receipt;self.save_journal()
                    else:
                        self.lease_fd=os.open(LEASE_NAME,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=self.fs.fd)
                        if receipt.get('root')!=self.root_identity or receipt.get('lease')!=file_identity(self.lease_fd):raise ShareError('prepared-claim-changed')
                    owner=json_bytes(self.owner)
                    if set(os.listdir(self.lease_fd))-{'owner.json'}:raise ShareError('prepared-claim-changed')
                    if receipt.get('owner') is None:
                        try:fd=os.open('owner.json',os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=self.lease_fd)
                        except FileExistsError:raise ShareError('unknown-owner-allocation')
                        try:receipt['owner']=file_identity(fd);self.save_journal()
                        except BaseException:os.close(fd);raise
                    else:fd=os.open('owner.json',os.O_RDWR|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=self.lease_fd)
                    try:
                        info=os.fstat(fd)
                        if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or file_identity(fd)!=receipt['owner'] or file_identity_at(self.lease_fd,'owner.json')!=receipt['owner'] or info.st_size>len(owner):raise ShareError('prepared-owner-changed')
                        prefix=os.read(fd,len(owner)+1)
                        if prefix!=owner[:len(prefix)]:raise ShareError('prepared-owner-changed')
                        self.check_origin();self.fs.check(write=True);os.lseek(fd,0,os.SEEK_SET)
                        self.write_all(fd,owner);os.fsync(fd)
                    finally:os.close(fd)
                os.fsync(self.lease_fd); os.fsync(self.fs.fd)
                self.journal["phase"] = "claimed"; self.save_journal()
            else:
                self.lease_fd = os.open(LEASE_NAME, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=self.fs.fd)
            self.fresh = previous is None
            self.check()
            self.fs.authority = self.check_scope
        except BaseException as error:
            if self.fresh_journal and not self.created_claim:
                try:
                    self.check_origin()
                    if bounded_json(self.catalog_fd, self.journal_name, 4_000_000) != self.journal: raise ShareError('private-journal-changed')
                    os.unlink(self.journal_name, dir_fd=self.catalog_fd); os.fsync(self.catalog_fd)
                except (OSError, ShareError, ValueError): pass
            self.close()
            if isinstance(error, ShareError): raise
            raise ShareError("transaction-unavailable") from None

    @staticmethod
    def write_all(fd, data):
        remaining = memoryview(data)
        while remaining:
            count = os.write(fd, remaining)
            if count <= 0: raise ShareError("write-unavailable")
            remaining = remaining[count:]

    def current_origin(self):
        value = self.physical_value
        try: value = str(uuid.UUID(value))
        except (ValueError, AttributeError, TypeError): raise ShareError("physical-origin-unavailable")
        if os.path.realpath(self.app_path) != self.app_path or file_identity_at(self.app_fd, ".") != self.app_identity:
            raise ShareError("private-origin-changed")
        path_fd = os.open(self.app_path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            if file_identity(path_fd) != self.app_identity: raise ShareError("private-origin-changed")
        finally: os.close(path_fd)
        directory = os.dup(self.app_fd)
        try:
            for component in ('library', 'catalog', 'transactions'):
                child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                os.close(directory); directory = child
            if file_identity(directory) != file_identity(self.catalog_fd): raise ShareError('private-directory-changed')
        finally: os.close(directory)
        guard = os.fstat(self.guard_fd)
        if not stat.S_ISREG(guard.st_mode) or guard.st_nlink != 1 or file_identity_at(self.catalog_fd, self.guard_name) != file_identity(self.guard_fd):
            raise ShareError("private-guard-changed")
        return {"physical": hashlib.sha256(("heed-smb-device-v1:" + value).encode()).hexdigest(), "appPath": hashlib.sha256(("heed-smb-app-v1:" + self.app_path).encode()).hexdigest(), "app": self.app_identity, "guard": file_identity(self.guard_fd)}

    def check_origin(self):
        if self.current_origin() != self.origin: raise ShareError("recovery-required")

    def save_journal(self):
        self.check_origin()
        content = json.dumps(self.journal, separators=(",", ":")).encode()
        if len(content) > 4_000_000: raise ShareError("private-record-limit")
        temporary = "." + self.journal_name + "." + self.journal["nonce"]
        try:
            old = bounded_json(self.catalog_fd, temporary, 4_000_000)
        except FileNotFoundError:
            old = None
        if old is not None:
            if not isinstance(old, dict) or any(old.get(key) != self.journal[key] for key in ("version", "origin", "scope", "nonce")):
                raise ShareError("unknown-private-staging")
            self.check_origin(); os.unlink(temporary, dir_fd=self.catalog_fd); os.fsync(self.catalog_fd)
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self.catalog_fd)
        try:
            self.write_all(fd, content); os.fsync(fd)
        finally: os.close(fd)
        try:
            self.check_origin()
            os.replace(temporary, self.journal_name, src_dir_fd=self.catalog_fd, dst_dir_fd=self.catalog_fd)
            os.fsync(self.catalog_fd)
        finally:
            try: os.unlink(temporary, dir_fd=self.catalog_fd)
            except FileNotFoundError: pass

    def check(self):
        if self.closed or self.released: raise ShareError("transaction-closed")
        self.check_origin(); self.fs.check()
        receipt = self.journal["receipt"]
        if not isinstance(receipt, dict) or set(receipt) != {"root", "lease", "owner"} or receipt["root"] != file_identity(self.fs.fd) or receipt["lease"] != file_identity(self.lease_fd) or file_identity_at(self.fs.fd, LEASE_NAME) != receipt["lease"] or file_identity_at(self.lease_fd,'owner.json')!=receipt['owner']:
            raise ShareError("claim-changed")
        current = checked_directory(self.request["root"])
        try:
            if file_identity(current) != receipt["root"]: raise ShareError("selected-root-changed")
        finally: os.close(current)
        if bounded_json(self.lease_fd, "owner.json") != self.owner or self.fs.header((2,))["destinationId"] != self.request["destinationId"]:
            raise ShareError("claim-changed")

    def check_scope(self):
        if self.closed or self.released: raise ShareError('transaction-closed')
        self.check_origin()
        receipt = self.journal['receipt']
        if receipt['root'] != file_identity(self.fs.fd) or receipt['lease'] != file_identity(self.lease_fd) or file_identity_at(self.fs.fd, LEASE_NAME) != receipt['lease'] or file_identity_at(self.lease_fd,'owner.json')!=receipt['owner']:
            raise ShareError('claim-changed')
        current = checked_directory(self.request['root'])
        try:
            if file_identity(current) != receipt['root']: raise ShareError('selected-root-changed')
        finally: os.close(current)
        if bounded_json(self.lease_fd, 'owner.json') != self.owner: raise ShareError('claim-changed')
        if bounded_json(self.fs.fd, 'heed-library.json', 4096) != {'format':'heed-portable-library','schemaVersion':2,'destinationId':self.request['destinationId']}: raise ShareError('destination-changed')

    def begin_effect(self, kind=None):
        self.check()
        if kind is not None and self.request['kind'] != kind: raise ShareError('invalid-operation-kind')
        # Authorization from an earlier inner operation never covers a later
        # mutation. Persist this revocation before the remote syscall.
        self.checkpointed = False
        if self.journal['effects'] >= 100000: raise ShareError('effect-limit')
        self.journal['effects'] += 1
        self.journal['phase'] = 'claimed'; self.save_journal()

    def control(self, parts, value):
        data = json_bytes(value)
        if len(data) > 2_000_000: raise ShareError('control-limit')
        import io
        self.fs.write_parts(parts, io.BytesIO(data), len(data), hashlib.sha256(data).hexdigest(), self.request['operationId'])
        parent = self.fs.directory(parts[:-1])
        try:
            if bounded_json(parent, parts[-1], 2_000_000) != value: raise ShareError('control-changed')
        finally: os.close(parent)

    def control_read(self, parts):
        parent = self.fs.directory(parts[:-1])
        try: return bounded_json(parent, parts[-1], 2_000_000)
        finally: os.close(parent)

    def write_pending(self, value):
        publication_intent(value)
        if value['deviceId'] != self.request['deviceId']: raise ShareError('pending-owner-changed')
        prefix = 'meetings/' + value['revision']['meetingId'] + '/revisions/' + value['revision']['revisionId']
        if prefix + '/manifest.json' not in self.journal['admissions']: raise ShareError('admission-required')
        self.begin_effect('publish')
        self.control(['control', 'pending', value['deviceId'], value['id'] + '.json'], value)

    def retire_pending(self, value):
        publication_intent(value)
        if value['deviceId'] != self.request['deviceId']: raise ShareError('pending-owner-changed')
        self.begin_effect('publish')
        parts = ['control', 'pending', value['deviceId'], value['id'] + '.json']
        try:
            current = self.control_read(parts)
            if current != value: raise ShareError('pending-changed')
        except FileNotFoundError:
            if self.control_read(['control', 'retired', value['deviceId'], value['id'] + '.json']) != value: raise ShareError('pending-changed')
            return
        # Keep a typed immutable retirement proof before unlinking exact intent.
        self.control(['control', 'retired', value['deviceId'], value['id'] + '.json'], value)
        parent = self.fs.directory(parts[:-1])
        try:
            if bounded_json(parent, parts[-1], 2_000_000) != value: raise ShareError('pending-changed')
            self.check(); os.unlink(parts[-1], dir_fd=parent); os.fsync(parent)
        finally: os.close(parent)

    def write_deletion(self, value):
        deletion_record(value)
        if value['destinationId'] != self.request['destinationId'] or value['jobId'] != self.request['operationId']: raise ShareError('deletion-owner-changed')
        self.begin_effect('delete')
        self.control(['control', 'deletions', value['jobId'] + '.json'], value)

    def own_deletion(self, job_id):
        valid_uuid(job_id)
        if job_id != self.request['operationId'] or self.request['kind'] != 'delete': raise ShareError('deletion-owner-changed')
        record = deletion_record(self.control_read(['control', 'deletions', job_id + '.json']))
        if record['destinationId'] != self.request['destinationId'] or record['jobId'] != job_id: raise ShareError('deletion-owner-changed')
        return record

    def write_fence(self, value):
        deletion_fence(value)
        record = self.own_deletion(value['jobId'])
        if value['revision'] not in record['revisions'] or value['artifact'] not in record['artifacts'] or value['destinationId'] != record['destinationId']: raise ShareError('fence-scope-changed')
        self.begin_effect('delete')
        parts = logical_path(value['artifact']['path']); parent = self.fs.directory(parts[:-1])
        try:
            data = json_bytes(value)
            self.canonical_stage(parent, parts[-1], value['artifact']['path'], data, self.journal['fences'], 'fence-collision')
            if bounded_json(parent, parts[-1]) != value: raise ShareError('fence-changed')
        finally: os.close(parent)

    def canonical_stage(self, parent, name, path, data, receipts, collision):
        """Publish only a complete, journal-pinned inode by exclusive rename.

        A planned name alone never authorizes adopting or unlinking an unknown
        inode left in the CREATE-to-receipt crash window.
        """
        expected = {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
        receipt = receipts.get(path); created = receipt is None
        if receipt is None:
            receipt = {**expected, 'inode': None, 'stage': '.heed-' + str(uuid.uuid4()) + '.stage'}
            receipts[path] = receipt; self.save_journal()
            with receipt_critical_section():
                try: fd = os.open(receipt['stage'], os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
                except FileExistsError: raise ShareError('unknown-canonical-stage')
                try:
                    receipt['inode'] = file_identity(fd); self.save_journal(); os.fsync(parent)
                finally: os.close(fd)
        if receipt.get('bytes') != expected['bytes'] or receipt.get('sha256') != expected['sha256'] or not receipt.get('inode'): raise ShareError('canonical-stage-recovery-required')
        try: canonical = file_identity_at(parent, name)
        except FileNotFoundError: canonical = None
        if canonical is not None and not created:
            if canonical != receipt['inode'] or not self.fs.matches(parent, name, len(data), expected['sha256']): raise ShareError(collision)
            try: os.stat(receipt.get('stage', ''), dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError: pass
            else: raise ShareError('canonical-stage-changed')
            return
        stage = receipt.get('stage')
        if not isinstance(stage, str) or not re.fullmatch(r'\.heed-[a-f0-9-]{36}\.stage', stage): raise ShareError('invalid-canonical-stage')
        fd = os.open(stage, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or file_identity(fd) != receipt['inode'] or file_identity_at(parent, stage) != receipt['inode'] or info.st_size > len(data): raise ShareError('canonical-stage-changed')
            prefix = os.read(fd, len(data) + 1)
            if prefix != data[:len(prefix)]: raise ShareError('canonical-stage-changed')
            os.lseek(fd, 0, os.SEEK_SET); self.check(); self.write_all(fd, data); os.fsync(fd)
            if file_identity_at(parent, stage) != receipt['inode'] or not self.fs.matches(parent, stage, len(data), expected['sha256']): raise ShareError('canonical-stage-changed')
            self.check()
            try: exclusive_rename(parent, stage, parent, name)
            except FileExistsError:
                # Only our exact pinned staging inode may be retired. The
                # canonical collision is never read/adopted or overwritten.
                if created and file_identity_at(parent, stage) == receipt['inode'] and self.fs.matches(parent, stage, len(data), expected['sha256']):
                    os.unlink(stage, dir_fd=parent); os.fsync(parent)
                    del receipts[path]; self.save_journal()
                    if self.fresh and self.journal['effects'] == 1 and not self.journal['admissions'] and not self.journal['fences']:
                        raise ShareError('canonical-collision-noeffect')
                raise ShareError(collision)
            os.fsync(parent)
            if file_identity_at(parent, name) != receipt['inode'] or not self.fs.matches(parent, name, len(data), expected['sha256']): raise ShareError('canonical-stage-changed')
        finally: os.close(fd)

    def read(self, path, maximum):
        self.check(); return self.fs.read(path, maximum)

    def stream(self, path, maximum, output):
        self.check(); self.fs.stream(path, maximum, output); self.check()

    def write(self, path, source, count, digest):
        parts = logical_path(path)
        artifact({'path': path, 'bytes': count, 'sha256': digest})
        admissions = self.journal['admissions']
        if not isinstance(admissions, dict) or len(admissions) > 10000: raise ShareError('admission-limit')
        if parts[0] == 'meetings' and parts[-1] == 'manifest.json':
            if count > 65536: raise ShareError('metadata-limit')
            # A blocked or invalid caller frame has no canonical allocation.
            # Keep the initial checkpoint valid until the complete bytes pass.
            data = source.read(count + 1); self.check()
            if len(data) != count or hashlib.sha256(data).hexdigest() != digest: raise ShareError('integrity-failed')
            value = json.loads(data); exact_keys(value, ('schemaVersion', 'libraryId', 'meetingId', 'revisionId', 'parents', 'artifacts'))
            revision({key: value[key] for key in ('libraryId', 'meetingId', 'revisionId')})
            if value['schemaVersion'] != 1 or value['meetingId'] != parts[1] or value['revisionId'] != parts[3] or not isinstance(value['parents'], list) or len(value['parents']) > 32 or not isinstance(value['artifacts'], list) or len(value['artifacts']) != 1: raise ShareError('invalid-manifest')
            for item in value['parents']: valid_uuid(item)
            a = value['artifacts'][0]; exact_keys(a, ('path', 'bytes', 'sha256'))
            if a['path'] != 'meeting.json': raise ShareError('invalid-manifest')
            artifact({'path': '/'.join(parts[:-1]) + '/meeting.json', 'bytes': a['bytes'], 'sha256': a['sha256']})
            self.begin_effect('publish')
            parent = self.fs.directory(parts[:-1], create=True)
            try:
                if len(admissions) >= 10000: raise ShareError('admission-limit')
                self.canonical_stage(parent, parts[-1], path, data, admissions, 'canonical-admission-collision')
            finally: os.close(parent)
            return
        self.begin_effect('publish')
        if parts[0] == 'meetings':
            if '/'.join(parts[:-1]) + '/manifest.json' not in admissions: raise ShareError('admission-required')
            manifest = json.loads(self.read('/'.join(parts[:-1]) + '/manifest.json', 65536))
            expected = manifest['artifacts'][0]
            if count != expected['bytes'] or digest != expected['sha256']: raise ShareError('manifest-payload-changed')
        elif parts[0] == 'commits':
            if count > 16384: raise ShareError('metadata-limit')
            import io
            data = source.read(count + 1)
            if len(data) != count or hashlib.sha256(data).hexdigest() != digest: raise ShareError('integrity-failed')
            marker = validate_marker(json.loads(data))
            admitted = admissions.get(marker['manifestPath'])
            if not admitted or admitted['sha256'] != marker['manifestHash'] or marker['deviceId'] != parts[1] or marker['revisionId'] + '.json' != parts[2]: raise ShareError('admission-required')
            manifest = json.loads(self.read(marker['manifestPath'], 65536)); expected = manifest['artifacts'][0]
            payload_path = '/'.join(logical_path(marker['manifestPath'])[:-1]) + '/meeting.json'
            payload = self.read(payload_path, expected['bytes'])
            if len(payload) != expected['bytes'] or hashlib.sha256(payload).hexdigest() != expected['sha256']: raise ShareError('unverified-payload')
            source = io.BytesIO(data)
        elif parts[0] == 'objects':
            pending = self.inventory()['pending']
            if not any(intent.get('audio') == {'path': path, 'bytes': count, 'sha256': digest} and 'meetings/' + intent['revision']['meetingId'] + '/revisions/' + intent['revision']['revisionId'] + '/manifest.json' in admissions for intent in pending): raise ShareError('pending-audio-required')
        self.fs.write(path, source, count, digest, self.request['operationId']); self.check()

    def hash_file(self, parent, name, expected):
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size != expected['bytes']: raise ShareError('artifact-changed')
            digest = hashlib.sha256(); size = 0
            while True:
                self.check_scope(); self.fs.check(fd)
                chunk = os.read(fd, CHUNK)
                if not chunk: break
                size += len(chunk)
                if size > expected['bytes']: raise ShareError('artifact-changed')
                digest.update(chunk)
            if size != expected['bytes'] or digest.hexdigest() != expected['sha256'] or file_identity_at(parent, name) != file_identity(fd): raise ShareError('artifact-changed')
            return file_identity(fd)
        finally: os.close(fd)

    def remove_exact(self, job_id, value):
        artifact(value)
        if value['path'].startswith('objects/'): raise ShareError('shared-audio-gc-pending-acceptance')
        record = self.own_deletion(job_id)
        if value not in record['artifacts']: raise ShareError('deletion-scope-changed')
        self.begin_effect('delete')
        parts = logical_path(value['path']); parent = self.fs.directory(parts[:-1])
        quarantine = None
        slot = self.quarantine_slot(value)
        try:
            quarantine = self.fs.directory(['control', 'quarantine', job_id], create=True)
            try: source = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError: source = None
            try: staged = os.stat(slot, dir_fd=quarantine, follow_symlinks=False)
            except FileNotFoundError: staged = None
            if source is not None and parts[-1] == 'manifest.json':
                try: fence = deletion_fence(bounded_json(parent, parts[-1]))
                except (ShareError, ValueError): fence = None
                if fence is not None:
                    if fence['jobId'] == job_id and fence['artifact'] == value and fence['revision'] in record['revisions'] and fence['destinationId'] == record['destinationId'] and staged is None: return 'already-removed'
                    raise ShareError('fence-scope-changed')
            if source is not None and staged is not None: raise ShareError('quarantine-conflict')
            if source is None and staged is None: return 'already-removed'  # Exact durable remote plan is authority.
            if source is not None:
                inode = self.hash_file(parent, parts[-1], value)
                self.check(); self.fs.check(parent, write=True); self.fs.check(quarantine, write=True)
                exclusive_rename(parent, parts[-1], quarantine, slot)
                os.fsync(parent); os.fsync(quarantine)
                if self.hash_file(quarantine, slot, value) != inode: raise ShareError('quarantine-changed')
            else: self.hash_file(quarantine, slot, value)
            self.check(); self.fs.check(quarantine, write=True)
            os.unlink(slot, dir_fd=quarantine); os.fsync(quarantine); self.check()
            return 'removed'
        finally:
            os.close(parent)
            if quarantine is not None: os.close(quarantine)

    def control_files(self, parts, nested=False, budget=None):
        budget = budget if budget is not None else {'count': 0, 'bytes': 0}
        try: parent = self.fs.directory(parts)
        except FileNotFoundError: return
        try:
            names = os.listdir(parent)
            if len(names) > 10000: raise ShareError('inventory-limit')
            for name in sorted(names):
                if name.startswith('.heed-'):
                    if not re.fullmatch(r'\.heed-[a-f0-9-]{36}\.lock', name): raise ShareError('unresolved-control-staging')
                    valid_uuid(name[6:-5])
                    info = os.stat(name, dir_fd=parent, follow_symlinks=False)
                    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1: raise ShareError('invalid-control-lock')
                    continue
                if nested:
                    valid_uuid(name)
                    yield from self.control_files(parts + [name], budget=budget)
                else:
                    if not name.endswith('.json'): raise ShareError('invalid-control-name')
                    valid_uuid(name[:-5]); budget['count'] += 1
                    if budget['count'] > 10000: raise ShareError('inventory-limit')
                    value = bounded_json(parent, name, 2_000_000); budget['bytes'] += len(json_bytes(value))
                    if budget['bytes'] > 64_000_000: raise ShareError('inventory-byte-limit')
                    yield (parts + [name], value)
        finally: os.close(parent)

    def verify_quarantines(self):
        try: root = self.fs.directory(['control', 'quarantine'])
        except FileNotFoundError: return
        try:
            jobs = os.listdir(root)
            if len(jobs) > 10000: raise ShareError('inventory-limit')
            count = 0
            for job_id in jobs:
                valid_uuid(job_id)
                record = deletion_record(self.control_read(['control', 'deletions', job_id + '.json']))
                if record['jobId'] != job_id or record['destinationId'] != self.request['destinationId']: raise ShareError('quarantine-scope-changed')
                allowed = {self.quarantine_slot(a): a for a in record['artifacts']}
                directory = self.fs.directory(['control', 'quarantine', job_id])
                try:
                    names = os.listdir(directory); count += len(names)
                    if count > 10000: raise ShareError('inventory-limit')
                    for name in names:
                        if name not in allowed: raise ShareError('unknown-quarantine-content')
                        # Every retained slot still contains the exact planned
                        # bytes; an unexpected replacement blocks later plans.
                        if allowed[name]['path'].startswith('objects/'): raise ShareError('shared-audio-gc-pending-acceptance')
                        self.hash_file(directory, name, allowed[name])
                finally: os.close(directory)
        finally: os.close(root)

    @staticmethod
    def quarantine_slot(value):
        return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()

    def inventory(self):
        self.check()
        try:
            control = self.fs.directory(['control'])
        except FileNotFoundError: control = -1
        if control >= 0:
            try:
                if set(os.listdir(control)) - {'deletions', 'pending', 'retired', 'quarantine'}: raise ShareError('unknown-control')
            finally: os.close(control)
        self.verify_quarantines()
        deletions = []; pending = []; total = 0
        for parts, raw in self.control_files(['control', 'deletions']):
            record = deletion_record(raw)
            if record['jobId'] + '.json' != parts[-1] or record['destinationId'] != self.request['destinationId']: raise ShareError('control-scope-changed')
            deletions.append(record); total += len(json_bytes(raw))
            if total > 64_000_000: raise ShareError('inventory-byte-limit')
        retired = {}
        for parts, raw in self.control_files(['control', 'retired'], True):
            value = publication_intent(raw)
            if value['deviceId'] != parts[-2] or value['id'] + '.json' != parts[-1]: raise ShareError('control-scope-changed')
            retired[(value['deviceId'], value['id'])] = value; total += len(json_bytes(raw))
            if total > 64_000_000: raise ShareError('inventory-byte-limit')
        for parts, raw in self.control_files(['control', 'pending'], True):
            value = publication_intent(raw)
            if value['deviceId'] != parts[-2] or value['id'] + '.json' != parts[-1]: raise ShareError('control-scope-changed')
            done = retired.get((value['deviceId'], value['id']))
            if done is not None and done != value: raise ShareError('pending-retirement-changed')
            if done is None: pending.append(value)
            total += len(json_bytes(raw))
            if total > 64_000_000: raise ShareError('inventory-byte-limit')
        commits = []
        for path in self.fs.list_commits(10000):
            raw = self.read(path, 16384); total += len(raw)
            if total > 64_000_000: raise ShareError('inventory-byte-limit')
            marker = validate_marker(json.loads(raw))
            if path != 'commits/' + marker['deviceId'] + '/' + marker['revisionId'] + '.json': raise ShareError('commit-scope-changed')
            commits.append(marker)
        # Canonical fences survive a stale deletion-directory listing and an
        # unseen-device commit marker. They contain no meeting text/audio.
        try: meetings = self.fs.directory(['meetings'])
        except FileNotFoundError: meetings = -1
        if meetings >= 0:
            try:
                names = os.listdir(meetings)
                if len(names) > 10000: raise ShareError('inventory-limit')
                revisions_seen = 0
                for meeting in sorted(names):
                    if meeting.startswith('.'): continue
                    valid_uuid(meeting)
                    try: revisions_fd = self.fs.directory(['meetings', meeting, 'revisions'])
                    except FileNotFoundError: continue
                    try:
                        names = os.listdir(revisions_fd); revisions_seen += len(names)
                        if revisions_seen > 10000: raise ShareError('inventory-limit')
                        for revision_id in sorted(names):
                            if revision_id.startswith('.'): continue
                            valid_uuid(revision_id)
                            canonical = 'meetings/' + meeting + '/revisions/' + revision_id + '/manifest.json'
                            try: raw = self.read(canonical, 65536)
                            except FileNotFoundError: continue
                            total += len(raw); value = json.loads(raw)
                            if value.get('kind') == 'heed-deleted-revision':
                                fence = deletion_fence(value)
                                if fence['destinationId'] != self.request['destinationId'] or fence['artifact']['path'] != canonical: raise ShareError('fence-scope-changed')
                                try: record = deletion_record(self.control_read(['control', 'deletions', fence['jobId'] + '.json']))
                                except FileNotFoundError: raise ShareError('fence-intent-missing')
                                if fence['revision'] not in record['revisions'] or fence['artifact'] not in record['artifacts']: raise ShareError('fence-intent-changed')
                                if record not in deletions: deletions.append(record)
                            if total > 64_000_000: raise ShareError('inventory-byte-limit')
                    finally: os.close(revisions_fd)
            finally: os.close(meetings)
        if total > 64_000_000 or len(deletions) > 10000: raise ShareError('inventory-byte-limit')
        self.check(); return {'commits': commits, 'deletions': deletions, 'pending': pending, 'complete': True}

    def checkpoint(self):
        self.check()
        for path, receipt in self.journal['admissions'].items():
            parts = logical_path(path)
            if len(parts) != 5 or parts[-1] != 'manifest.json': raise ShareError('invalid-admission')
            parent = self.fs.directory(parts[:-1])
            try:
                try:
                    if file_identity_at(parent, parts[-1]) != receipt['inode'] or not self.fs.matches(parent, parts[-1], receipt['bytes'], receipt['sha256']): raise ShareError('incomplete-admission')
                except FileNotFoundError: raise ShareError('incomplete-admission')
            finally: os.close(parent)
        if self.request['kind'] == 'delete':
            try: record = self.own_deletion(self.request['operationId'])
            except FileNotFoundError: record = None
            if record is not None:
                for r in record['revisions']:
                    path = 'meetings/' + r['meetingId'] + '/revisions/' + r['revisionId'] + '/manifest.json'
                    a = next((a for a in record['artifacts'] if a['path'] == path), None)
                    if a is None: raise ShareError('incomplete-deletion-fence')
                    fence = deletion_fence(json.loads(self.read(path, 65536)))
                    if fence['jobId'] != record['jobId'] or fence['destinationId'] != record['destinationId'] or fence['revision'] != r or fence['artifact'] != a: raise ShareError('incomplete-deletion-fence')
        self.journal['phase'] = 'checkpointed'; self.save_journal(); self.checkpointed = True

    def release(self):
        self.check()
        if not self.checkpointed: raise ShareError("durable-checkpoint-required")
        if sorted(os.listdir(self.lease_fd)) != ["owner.json"]: raise ShareError("unknown-claim-content")
        self.journal["phase"] = "releasing"; self.save_journal()
        released = ".heed-v2-released-" + self.journal["nonce"]
        exclusive_rename(self.fs.fd, LEASE_NAME, self.fs.fd, released)
        os.fsync(self.fs.fd); self.fs.authority = None; self.released = True
        self.finish_release()

    def finish_release(self):
        self.check_origin(); self.fs.check(write=True)
        receipt = self.journal["receipt"]
        if not isinstance(receipt, dict) or receipt.get("root") != file_identity(self.fs.fd):
            raise ShareError("released-root-changed")
        released = ".heed-v2-released-" + self.journal["nonce"]
        try:
            fd = os.open(released, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=self.fs.fd)
        except FileNotFoundError:
            # The durable releasing phase precedes rename. Resume that exact
            # directory only; a later owner's fixed claim is never touched.
            try:
                fixed = os.open(LEASE_NAME, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=self.fs.fd)
            except FileNotFoundError:
                fixed = -1
            if fixed >= 0:
                try:
                    if file_identity(fixed) == receipt["lease"]:
                        if sorted(os.listdir(fixed)) != ["owner.json"] or bounded_json(fixed, "owner.json") != self.owner:
                            raise ShareError("released-claim-changed")
                        exclusive_rename(self.fs.fd, LEASE_NAME, self.fs.fd, released); os.fsync(self.fs.fd)
                finally: os.close(fixed)
            try: fd = os.open(released, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=self.fs.fd)
            except FileNotFoundError: fd = -1
        if fd >= 0:
            try:
                names = sorted(os.listdir(fd))
                if file_identity(fd) != receipt["lease"] or names not in ([], ["owner.json"]):
                    raise ShareError("released-claim-changed")
                if names:
                    if bounded_json(fd, "owner.json") != self.owner: raise ShareError("released-claim-changed")
                    os.unlink("owner.json", dir_fd=fd); os.fsync(fd)
            finally: os.close(fd)
            os.rmdir(released, dir_fd=self.fs.fd); os.fsync(self.fs.fd)
        os.unlink(self.journal_name, dir_fd=self.catalog_fd); os.fsync(self.catalog_fd)

    def close(self):
        if self.closed: return
        self.closed = True
        if self.fs is not None: self.fs.close()
        for name in ("lease_fd", "guard_fd", "catalog_fd", "app_fd"):
            fd = getattr(self, name, -1)
            if fd >= 0: os.close(fd); setattr(self, name, -1)


class LimitedInput:
    def __init__(self, source, count):
        if not isinstance(count, int) or isinstance(count, bool) or not 0 <= count <= MAX_BYTES: raise ShareError('invalid-size')
        self.source = source; self.remaining = count

    def read(self, count=-1):
        size = self.remaining if count < 0 else min(self.remaining, count)
        if size == 0: return b''
        result = self.source.read(size)
        if not result: raise ShareError('request-eof')
        self.remaining -= len(result)
        return result


def rpc_response(output, value):
    data = json_bytes(value)
    if len(data) > 64_000_000: raise ShareError('response-limit')
    output.write(data + b'\n'); output.flush()


def serve_transaction(request, source, output, factory=Transaction, heartbeat_interval=5):
    try: tx = factory(request['appDir'], request)
    except (ShareError, OSError, ValueError, KeyError, TypeError) as error:
        code = str(error) if isinstance(error, ShareError) else 'transaction-unavailable'
        if code == 'released-operation':
            rpc_response(output, {'ok': True, 'ready': True, 'checkpointed': True, 'completed': True}); return
        if not re.fullmatch('[a-z-]{1,80}', code): code = 'transaction-unavailable'
        rpc_response(output, {'ok': False, 'error': code}); return
    try:
        frame_lock=threading.Lock()
        def respond(value):
            if not value.get('progress'):heartbeat_stop.set()
            with frame_lock:
                if value.get('progress') and heartbeat_stop.is_set():return
                rpc_response(output,value)
        # Only a genuinely fresh empty acquire is authorized initially. A
        # recovered operation must reconcile and checkpoint its dirty progress.
        if tx.fresh: tx.checkpoint()
        rpc_response(output, {'ok': True, 'ready': True, 'checkpointed': tx.checkpointed})
        while True:
            raw = source.readline(2_000_001)
            if not raw: return
            if len(raw) > 2_000_000 or not raw.endswith(b'\n'): raise ShareError('request-limit')
            command = json.loads(raw)
            if not isinstance(command, dict) or not isinstance(command.get('id'), int) or isinstance(command['id'], bool): raise ShareError('invalid-request')
            stream = None
            heartbeat_stop=threading.Event()
            def heartbeat():
                while not heartbeat_stop.wait(heartbeat_interval):
                    try:respond({'id':command['id'],'progress':True})
                    except (OSError,ValueError):return
            worker=threading.Thread(target=heartbeat,daemon=True)
            # The worker inherits SIGTERM blocked. Otherwise the OS can
            # deliver to it and Python raises the main-thread handler inside
            # a CREATE-to-receipt section despite the main thread's mask.
            with receipt_critical_section():worker.start()
            try:
                tx.check(); action = command.get('action'); result = None
                if action == 'inventory': result = tx.inventory()
                elif action == 'list': result = tx.fs.list_commits(10000)
                elif action == 'read':
                    ident = command['id']
                    class Output:
                        def write(self, data):
                            # Header+binary payload cannot interleave with a
                            # heartbeat; every frame is one pipe transaction.
                            with frame_lock:
                                rpc_response(output, {'id': ident, 'bytes': len(data)})
                                output.write(data); output.flush()
                    tx.stream(command['path'], command['maxBytes'], Output())
                elif action == 'write':
                    stream = LimitedInput(source, command['bytes'])
                    tx.write(command['path'], stream, command['bytes'], command['sha256'])
                    if stream.remaining: raise ShareError('request-incomplete')
                elif action == 'write-deletion': tx.write_deletion(command['value'])
                elif action == 'write-fence': tx.write_fence(command['value'])
                elif action == 'write-pending': tx.write_pending(command['value'])
                elif action == 'retire-pending': tx.retire_pending(command['value'])
                elif action == 'remove-exact': result = tx.remove_exact(command['jobId'], command['artifact'])
                elif action == 'checkpoint': tx.checkpoint()
                elif action == 'release':
                    tx.release(); respond({'id': command['id'], 'ok': True}); return
                else: raise ShareError('invalid-action')
                respond({'id': command['id'], 'ok': True, 'value': result})
            except (ShareError, OSError, ValueError, KeyError, TypeError) as error:
                # Preserve framing on a fully supplied rejected upload. Broken
                # pipes/EOF cannot checkpoint or release the persistent claim.
                if stream is not None:
                    while stream.remaining: stream.read(CHUNK)
                tx.check()
                code = str(error) if isinstance(error, ShareError) else 'transaction-unavailable'
                if not re.fullmatch('[a-z-]{1,80}', code): code = 'transaction-unavailable'
                respond({'id': command['id'], 'ok': False, 'error': code})
            finally:heartbeat_stop.set();worker.join(timeout=0.1)
    finally: tx.close()


def main():
    fs = None
    try:
        raw = sys.stdin.buffer.readline(16385)
        if len(raw) > 16384:
            raise ShareError("invalid-request")
        request = json.loads(raw)
        action = request["action"]
        if action == "transaction":
            serve_transaction(request, sys.stdin.buffer, sys.stdout.buffer)
            return 0
        fs = SafeShare(request["root"], request.get("identity"))
        if action not in ("probe", "library", "header", "create", "prepare", "test-write"):
            header = fs.header()
            if not header or header["destinationId"] != request.get("destinationId"):
                raise ShareError("destination-changed")
        if action == "probe":
            value = {"identity": fs.identity, **probe_security(fs.identity["mountPath"]), 'atomicOperations':volume_atomic_operations(fs.fd)}
            print(json.dumps(value))
        elif action == "library":
            try:
                child = fs.directory(["Heed Library"])
            except FileNotFoundError:
                print("null")
            else:
                original = fs.fd
                fs.fd = child
                try:
                    print(json.dumps(fs.header((1, 2))))
                finally:
                    fs.fd = original
                    os.close(child)
        elif action == "list":
            print(json.dumps(fs.list_commits(10000)))
        elif action == "read":
            fs.stream(request["path"], request["maxBytes"], sys.stdout.buffer)
        elif action == "write":
            fs.write(request["path"], sys.stdin.buffer, request["bytes"], request["sha256"], request["stagingId"])
            print("{}")
        elif action == "header":
            print(json.dumps(fs.header((1, 2))))
        elif action == "prepare":
            if not volume_atomic_operations(fs.fd): raise ShareError('unsupported-filesystem')
            # Creation is called only after explicit confirmation in Settings.
            fd = fs.directory(["Heed Library"], create=True)
            os.close(fd)
            print("{}")
        elif action == "create":
            if not volume_atomic_operations(fs.fd): raise ShareError('unsupported-filesystem')
            header = request["header"]
            if not isinstance(header, dict) or set(header) != {"format", "schemaVersion", "destinationId"} or header["format"] != "heed-portable-library" or header["schemaVersion"] not in (1, 2):
                raise ShareError("invalid-library")
            uuid.UUID(header["destinationId"])
            # Do not adopt arbitrary existing content as a new shared library.
            if any(name != ".DS_Store" for name in os.listdir(fs.fd)):
                raise ShareError("nonempty-library")
            content = json.dumps(header, separators=(",", ":")).encode()
            import io
            fs.write_parts(["heed-library.json"], io.BytesIO(content), len(content), hashlib.sha256(content).hexdigest())
            print("{}")
        elif action == "test-write":
            if not volume_atomic_operations(fs.fd): raise ShareError('unsupported-filesystem')
            # Probe only our own unique temporary entry, never user files.
            fs.check(write=True)
            name = ".heed-probe-" + str(uuid.uuid4())
            published = name + "-committed"
            fd = -1
            try:
                fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fs.fd)
                fs.check(fd, write=True)
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                os.write(fd, b"Heed access probe")
                os.fsync(fd)
                os.close(fd)
                fd = -1
                fs.check(write=True)
                publish_exclusive(fs.fd, name, published)
                os.fsync(fs.fd)
                if not fs.matches(fs.fd, published, 17, hashlib.sha256(b"Heed access probe").hexdigest()):
                    raise ShareError("integrity-failed")
                print("{}")
            finally:
                if fd != -1:
                    os.close(fd)
                for temporary in (name, published):
                    try:
                        os.unlink(temporary, dir_fd=fs.fd)
                    except FileNotFoundError:
                        pass
        else:
            raise ShareError("invalid-action")
    except (ShareError, OSError, ValueError, KeyError, TypeError, InterruptedError) as error:
        if isinstance(error,ShareError) and str(error)=='unsupported-filesystem' and request.get('action') in ('test-write','create','prepare'):
            print(json.dumps({'error':'unsupported-filesystem'}));return 0
        # Deliberately generic: OS exception strings include mount paths and
        # smbutil can print credential-bearing mount sources.
        sys.stderr.write("SMB operation unavailable; verify the selected mount, access and library integrity.\n")
        return 1
    finally:
        if fs is not None:
            fs.close()
    return 0


if __name__ == "__main__":
    def interrupt(signum, frame):
        raise InterruptedError()
    signal.signal(signal.SIGTERM, interrupt)
    sys.exit(main())
