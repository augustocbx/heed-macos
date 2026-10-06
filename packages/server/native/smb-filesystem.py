#!/usr/bin/env python3
"""Mounted-SMB adapter. Descriptor-relative I/O never recreates a missing mount.

The CLI accepts one bounded JSON request followed by optional streamed bytes.
Raw mount sources, smbutil output, exceptions and credentials never leave this process.
"""
import ctypes
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import uuid
import signal

MAX_BYTES = 8_000_000_000_000
CHUNK = 131072


class ShareError(Exception):
    pass


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
            if not stat.S_ISREG(os.fstat(fd).st_mode):
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
            if not stat.S_ISREG(os.fstat(fd).st_mode) or os.fstat(fd).st_size != count:
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
        fd = -1
        try:
            self.check(parent, write=True)
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
                os.unlink(temporary, dir_fd=parent)
            except FileNotFoundError:
                pass
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

    def header(self):
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
            if not isinstance(value, dict) or set(value) != {"format", "schemaVersion", "destinationId"} or value["format"] != "heed-portable-library" or value["schemaVersion"] != 1 or not re.fullmatch(r"[a-f0-9-]{36}", value["destinationId"]):
                raise ShareError("invalid-library")
            uuid.UUID(value["destinationId"])
            return value
        finally:
            os.close(fd)


def main():
    fs = None
    try:
        raw = sys.stdin.buffer.readline(16385)
        if len(raw) > 16384:
            raise ShareError("invalid-request")
        request = json.loads(raw)
        fs = SafeShare(request["root"], request.get("identity"))
        action = request["action"]
        if action not in ("probe", "library", "header", "create", "prepare", "test-write"):
            header = fs.header()
            if not header or header["destinationId"] != request.get("destinationId"):
                raise ShareError("destination-changed")
        if action == "probe":
            value = {"identity": fs.identity, **probe_security(fs.identity["mountPath"])}
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
                    print(json.dumps(fs.header()))
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
            print(json.dumps(fs.header()))
        elif action == "prepare":
            # Creation is called only after explicit confirmation in Settings.
            fd = fs.directory(["Heed Library"], create=True)
            os.close(fd)
            print("{}")
        elif action == "create":
            header = request["header"]
            if not isinstance(header, dict) or set(header) != {"format", "schemaVersion", "destinationId"} or header["format"] != "heed-portable-library" or header["schemaVersion"] != 1:
                raise ShareError("invalid-library")
            uuid.UUID(header["destinationId"])
            # Do not adopt arbitrary existing content as a new shared library.
            if os.listdir(fs.fd):
                raise ShareError("nonempty-library")
            content = json.dumps(header, separators=(",", ":")).encode()
            import io
            fs.write_parts(["heed-library.json"], io.BytesIO(content), len(content), hashlib.sha256(content).hexdigest())
            print("{}")
        elif action == "test-write":
            # Probe only our own unique temporary entry, never user files.
            fs.check(write=True)
            name = ".heed-probe-" + str(uuid.uuid4())
            published = name + "-committed"
            fd = -1
            try:
                fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fs.fd)
                fs.check(fd, write=True)
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
    except (ShareError, OSError, ValueError, KeyError, TypeError, InterruptedError):
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
