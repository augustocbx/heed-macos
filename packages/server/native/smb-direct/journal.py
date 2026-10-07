"""Private original-machine/physical-directory authority for direct SMB effects.

Wire query: {protocol:1,action:'pending',binding:DirectSmbBinding,appDir:string}.
Files: appDir/library/catalog/direct-smb/<binding UUID>/<operation UUID>.{json,guard}.
Version 1 is private state, unrelated to portable payload/coordination versions.
No copied receipt, generation change, elapsed time, or remote bytes grants authority.
"""

import fcntl
import hashlib
import json
import os
import re
import stat
import subprocess
from uuid import uuid4

from protocol import (
    SmbError,
    UUID,
    MAX_ENTRIES,
    duplicate_free,
    exact,
    validate_path,
    validate_endpoint,
)
from identity import validate_metadata, validate_identity

MAX_JOURNAL = 4_000_000
# Matches the provider's per-operation reservation, including retained atomic copies.
MAX_OPERATION_JOURNAL_BYTES = 8_000_000
MAX_PENDING_JOURNAL_BYTES = 16_000_000
MAX_PENDING_RESPONSE_BYTES = 1_900_000
MAX_PENDING_ADMISSIONS = 10_000
PHASES = {"prepared", "claimed", "checkpointed", "releasing", "released"}


def physical_uuid():
    result = subprocess.run(
        ["/usr/sbin/ioreg", "-rd1", "-c", "IOPlatformExpertDevice"],
        capture_output=True,
        timeout=5,
        check=False,
    )
    if result.returncode or len(result.stdout) > 65536:
        raise SmbError("recovery-required")
    match = re.search(rb'"IOPlatformUUID"\s*=\s*"([A-Fa-f0-9-]{36})"', result.stdout)
    if (
        not match
        or not re.fullmatch(rb"[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}", match[1])
        or set(match[1].replace(b"-", b"")) == {48}
    ):
        raise SmbError("recovery-required")
    return match[1].decode().lower()


def local_identity(info):
    birth = getattr(info, "st_birthtime_ns", None)
    if birth is None:
        value = getattr(info, "st_birthtime", None)
        if value is None:
            raise SmbError("unsupported-identity")
        birth = int(value * 1_000_000_000)
    return [str(info.st_dev), str(info.st_ino), str(birth)]


def validate_original_private_root(value):
    identity = exact(value, ("device", "inode", "birthMilliseconds"))
    if any(not isinstance(n, str) or not re.fullmatch(r"[0-9]{1,30}", n)
           for n in identity.values()):
        raise SmbError("invalid-input")
    return identity


def check_original_private_root(fd, expected):
    expected = validate_original_private_root(expected)
    info = os.fstat(fd)
    identity = local_identity(info)
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) != 0o700
            or identity[0] != expected["device"]
            or identity[1] != expected["inode"]
            or str(int(local_identity(info)[2]) // 1_000_000) != expected["birthMilliseconds"]):
        raise SmbError("recovery-required")


def journal_directory(app_fd, binding_id, create=False):
    """Walk the fixed private suffix from the initially checked original app FD."""
    fd = os.dup(app_fd)
    try:
        for name in ("library", "catalog", "direct-smb", binding_id):
            if create:
                try:
                    os.mkdir(name, 0o700, dir_fd=fd)
                    os.fsync(fd)
                except FileExistsError:
                    pass
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def directory(path, create=False):
    if (
        not isinstance(path, str)
        or not path.startswith("/")
        or os.path.realpath(path) != path
        or any(p in (".", "..") for p in path.split("/"))
    ):
        raise SmbError("recovery-required")
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for name in path.split("/")[1:]:
            if not name:
                continue
            if create:
                try:
                    os.mkdir(name, 0o700, dir_fd=fd)
                    os.fsync(fd)
                except FileExistsError:
                    pass
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def regular(fd, maximum=MAX_JOURNAL):
    info = os.fstat(fd)
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_nlink != 1
        or info.st_uid != os.getuid()
        or info.st_mode & 0o077
        or info.st_size > maximum
    ):
        raise SmbError("recovery-required")
    return info


def bounded_names(parent, maximum):
    """Stop at the first excess entry instead of materializing an unbounded list."""
    names = []
    with os.scandir(parent) as entries:
        for entry in entries:
            if len(names) >= maximum:
                raise SmbError("bounds-exceeded")
            names.append(entry.name)
    return names


def charge(budget, amount):
    if amount > budget[0]:
        raise SmbError("bounds-exceeded")
    budget[0] -= amount


def read_json(parent, name, budget=None):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    try:
        info = regular(fd)
        if budget is not None:
            charge(budget, info.st_size)
        data = b""
        while len(data) < info.st_size:
            chunk = os.read(fd, min(131072, info.st_size - len(data)))
            if not chunk:
                raise SmbError("recovery-required")
            data += chunk
        value = json.loads(data, object_pairs_hook=duplicate_free)
        return value
    except (ValueError, UnicodeError, RecursionError):
        raise SmbError("recovery-required") from None
    finally:
        os.close(fd)


def scope_for(binding, context):
    for key in ("id", "destinationId", "connectionGeneration"):
        if not UUID.fullmatch(binding.get(key, "")):
            raise SmbError("invalid-input")
    exact(context, ("operationId", "deviceId", "kind"))
    if any(not UUID.fullmatch(context.get(k, "")) for k in ("operationId", "deviceId")) or context[
        "kind"
    ] not in ("read", "publish", "delete"):
        raise SmbError("invalid-input")
    return dict(
        bindingId=binding["id"],
        endpoint=binding["endpoint"],
        identity=binding["identity"],
        destinationId=binding["destinationId"],
        connectionGeneration=binding["connectionGeneration"],
        **context,
    )


def validate_job(job):
    exact(
        job,
        (
            "version",
            "scope",
            "origin",
            "phase",
            "claim",
            "allocations",
            "admissions",
            "effects",
            "confirmed",
            "removals",
        ),
    )
    if job["version"] != 1 or type(job["version"]) is not int or job["phase"] not in PHASES:
        raise SmbError("recovery-required")
    scope = job["scope"]
    exact(
        scope,
        (
            "bindingId",
            "endpoint",
            "identity",
            "destinationId",
            "connectionGeneration",
            "operationId",
            "deviceId",
            "kind",
        ),
    )
    for key in (
        "bindingId",
        "destinationId",
        "connectionGeneration",
        "operationId",
        "deviceId",
    ):
        if not isinstance(scope[key], str) or not UUID.fullmatch(scope[key]):
            raise SmbError("recovery-required")
    if scope["kind"] not in ("read", "publish", "delete"):
        raise SmbError("recovery-required")
    validate_endpoint(scope["endpoint"])
    validate_identity(scope["identity"])
    origin = exact(job["origin"], ("physical", "appPath", "app", "catalog", "guard"))
    for key in ("physical", "appPath"):
        if not isinstance(origin[key], str) or not re.fullmatch("[a-f0-9]{64}", origin[key]):
            raise SmbError("recovery-required")
    for key in ("app", "catalog", "guard"):
        if (
            not isinstance(origin[key], list)
            or len(origin[key]) != 3
            or any(
                not isinstance(n, str) or not re.fullmatch("[0-9]{1,30}", n) for n in origin[key]
            )
        ):
            raise SmbError("recovery-required")
    claim = job["claim"]
    if claim is not None:
        exact(claim, ("stage", "metadata", "state"))
        if (
            not isinstance(claim["stage"], str)
            or not claim["stage"].startswith(".heed-stage-")
            or not UUID.fullmatch(claim["stage"][12:])
            or claim["state"] not in ("allocating", "renaming", "claimed")
        ):
            raise SmbError("recovery-required")
        if claim["metadata"] is not None:
            validate_metadata(claim["metadata"], True)
    elif job["phase"] != "prepared":
        raise SmbError("recovery-required")

    if type(job["effects"]) is not int or not 0 <= job["effects"] <= 100000:
        raise SmbError("recovery-required")
    for key in ("allocations", "admissions", "confirmed", "removals"):
        if not isinstance(job[key], dict) or len(job[key]) > MAX_ENTRIES:
            raise SmbError("bounds-exceeded")
    for path, item in job["admissions"].items():
        parts = path.split("/")
        if (
            len(parts) != 5
            or parts[0] != "meetings"
            or parts[2] != "revisions"
            or parts[4] != "manifest.json"
            or not UUID.fullmatch(parts[1])
            or not UUID.fullmatch(parts[3])
            or path not in job["allocations"]
            or item != job["allocations"][path]["sha256"]
        ):
            raise SmbError("recovery-required")
    for path, item in job["allocations"].items():
        validate_path(path)
        exact(item, ("stage", "metadata", "bytes", "sha256", "state", "directory"))
        if (
            not isinstance(item["stage"], str)
            or not re.fullmatch(r"\.heed-claim/[a-f0-9-]{36}", item["stage"])
            or not UUID.fullmatch(item["stage"].split("/")[1])
            or item["state"]
            not in (
                "planned",
                "allocating",
                "writing",
                "verified",
                "renaming",
                "published",
            )
            or type(item["directory"]) is not bool
        ):
            raise SmbError("recovery-required")
        if item["metadata"] is not None:
            validate_metadata(item["metadata"], item["directory"])
        if (
            type(item["bytes"]) is not int
            or item["bytes"] < 0
            or not isinstance(item["sha256"], str)
            or not re.fullmatch("[a-f0-9]{64}", item["sha256"])
        ):
            raise SmbError("recovery-required")
    for path, digest in job["confirmed"].items():
        if (
            not re.fullmatch(r"commits/[a-f0-9-]{36}/[a-f0-9-]{36}\.json", path)
            or not isinstance(digest, str)
            or not re.fullmatch("[a-f0-9]{64}", digest)
        ):
            raise SmbError("recovery-required")
    for path, item in job["removals"].items():
        validate_path(path)
        exact(item, ("artifact", "metadata", "parent", "parentMetadata", "parents", "state"))
        exact(item["artifact"], ("path", "bytes", "sha256"))
        a = item["artifact"]
        if (a["path"] != path or type(a["bytes"]) is not int or not 0 < a["bytes"] <= 8000000000000
                or not isinstance(a["sha256"], str) or not re.fullmatch("[a-f0-9]{64}", a["sha256"])
                or item["state"] not in ("selected", "disposing", "removed")
                or item["parent"] != path.rsplit("/", 1)[0]
                or not (re.fullmatch(r"commits/[a-f0-9-]{36}/[a-f0-9-]{36}\.json", path)
                        or re.fullmatch(r"meetings/[a-f0-9-]{36}/revisions/[a-f0-9-]{36}/(?:meeting|manifest)\.json", path))):
            raise SmbError("recovery-required")
        validate_metadata(item["metadata"], False)
        validate_metadata(item["parentMetadata"], True)
        if not isinstance(item["parents"],dict) or not 0 < len(item["parents"]) <= 512:
            raise SmbError("recovery-required")
        for full, metadata in item["parents"].items():
            validate_path(full, True)
            validate_metadata(metadata, True)
        if item["metadata"]["bytes"] != a["bytes"]:
            raise SmbError("recovery-required")
        if scope["kind"] != "delete":
            raise SmbError("recovery-required")
    return job


class Journal:
    def __init__(self, binding, context, app_dir, original_private_root=None):
        self.fd = self.app_fd = self.guard_fd = None
        self.app_dir = app_dir
        self.scope = scope_for(binding, context)
        self.path = app_dir + "/library/catalog/direct-smb/" + binding["id"]
        self.name = context["operationId"] + ".json"
        self.guard_name = context["operationId"] + ".guard"
        self.previous = None
        try:
            self.app_fd = directory(app_dir)
            if original_private_root is not None:
                check_original_private_root(self.app_fd, original_private_root)
                self.fd = journal_directory(self.app_fd, binding["id"], create=True)
            else:
                self.fd = directory(self.path, create=True)
            self.machine = physical_uuid()
            names = bounded_names(self.fd, max(0, MAX_ENTRIES * 2 - 1))
            existing = self.name in names
            flags = (
                os.O_RDWR
                | os.O_NOFOLLOW
                | os.O_NONBLOCK
                | (0 if existing else os.O_CREAT | os.O_EXCL)
            )
            self.guard_fd = os.open(self.guard_name, flags, 0o600, dir_fd=self.fd)
            regular(self.guard_fd, 0)
            try:
                fcntl.flock(self.guard_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise SmbError("destination-busy") from None
            self.origin = self.current_origin()
            if existing:
                self.data = validate_job(read_json(self.fd, self.name))
                if self.data["origin"] != self.origin or self.data["scope"] != self.scope:
                    raise SmbError("recovery-required")
                self.previous = json.loads(json.dumps(self.data))
            else:
                os.fsync(self.guard_fd)
                os.fsync(self.fd)
                self.data = dict(
                    version=1,
                    scope=self.scope,
                    origin=self.origin,
                    phase="prepared",
                    claim=None,
                    allocations={},
                    admissions={},
                    effects=0,
                    confirmed={},
                    removals={},
                )
                self.save()
        except BaseException:
            self.close()
            raise

    def current_origin(self):
        app = directory(self.app_dir)
        catalog = directory(self.path)
        try:
            app_identity = local_identity(os.fstat(app))
            catalog_identity = local_identity(os.fstat(catalog))
            if app_identity != local_identity(
                os.fstat(self.app_fd)
            ) or catalog_identity != local_identity(os.fstat(self.fd)):
                raise SmbError("recovery-required")
            info = regular(self.guard_fd, 0)
            actual = os.stat(self.guard_name, dir_fd=self.fd, follow_symlinks=False)
            if local_identity(info) != local_identity(actual) or not stat.S_ISREG(actual.st_mode):
                raise SmbError("recovery-required")
            return dict(
                physical=hashlib.sha256(
                    ("heed-direct-smb-device-v1:" + self.machine).encode()
                ).hexdigest(),
                appPath=hashlib.sha256(
                    ("heed-direct-smb-app-v1:" + self.app_dir).encode()
                ).hexdigest(),
                app=app_identity,
                catalog=catalog_identity,
                guard=local_identity(info),
            )
        finally:
            os.close(app)
            os.close(catalog)

    def check(self):
        if self.fd is None or self.current_origin() != self.origin:
            raise SmbError("recovery-required")
        if self.previous is not None and read_json(self.fd, self.name) != self.previous:
            raise SmbError("recovery-required")

    def save(self):
        self.check()
        validate_job(self.data)
        content = json.dumps(self.data, separators=(",", ":")).encode()
        if len(content) > MAX_JOURNAL:
            raise SmbError("bounds-exceeded")
        self.admit_copy(len(content))
        name = self.name + "." + str(uuid4()) + ".tmp"
        fd = os.open(
            name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
            dir_fd=self.fd,
        )
        try:
            remaining = memoryview(content)
            while remaining:
                n = os.write(fd, remaining)
                if n <= 0:
                    raise SmbError("recovery-required")
                remaining = remaining[n:]
            os.fsync(fd)
        finally:
            os.close(fd)
        self.check()
        os.replace(name, self.name, src_dir_fd=self.fd, dst_dir_fd=self.fd)
        os.fsync(self.fd)
        self.previous = json.loads(content)

    def admit_copy(self, size):
        """Count all matching evidence without reading or adopting temporary copies."""
        budget = [MAX_OPERATION_JOURNAL_BYTES]
        charge(budget, size)
        count = 0
        with os.scandir(self.fd) as entries:
            for entry in entries:
                count += 1
                if count > MAX_ENTRIES * 2 - 1:
                    raise SmbError("bounds-exceeded")
                name = entry.name
                if name != self.name and not (
                    name.startswith(self.name + ".")
                    and re.fullmatch(r"\.[0-9a-f-]{36}\.tmp", name[len(self.name):])
                ):
                    continue
                try:
                    fd = os.open(
                        name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                        dir_fd=self.fd,
                    )
                    try:
                        charge(budget, regular(fd).st_size)
                    finally:
                        os.close(fd)
                except OSError:
                    raise SmbError("recovery-required") from None

    def begin_effect(self):
        self.check()
        if self.data["phase"] not in ("claimed", "checkpointed"):
            raise SmbError("recovery-required")
        self.data["phase"] = "claimed"
        self.data["effects"] += 1
        self.save()

    def finish(self):
        self.data["phase"] = "released"
        self.save()
        self.check()
        os.unlink(self.name, dir_fd=self.fd)
        os.fsync(self.fd)
        os.unlink(self.guard_name, dir_fd=self.fd)
        os.fsync(self.fd)
        self.close()

    def close(self):
        for name in ("guard_fd", "fd", "app_fd"):
            fd = getattr(self, name, None)
            if fd is not None:
                os.close(fd)
                setattr(self, name, None)


def pending_transactions(binding, app_dir, original_private_root=None):
    """Pure bounded local query; positive recovery hints still require SMB revalidation."""
    scope_for(binding, dict(operationId=binding["id"], deviceId=binding["id"], kind="read"))
    path = app_dir + "/library/catalog/direct-smb/" + binding["id"]
    app = None
    if original_private_root is not None:
        try:
            app = directory(app_dir)
            check_original_private_root(app, original_private_root)
        except BaseException as error:
            if app is not None:
                os.close(app)
            if isinstance(error, FileNotFoundError):
                raise SmbError("recovery-required") from None
            raise
    try:
        if app is not None:
            fd = journal_directory(app, binding["id"])
        else:
            fd = directory(path)
    except FileNotFoundError:
        if app is not None:
            os.close(app)
        return []
    except BaseException:
        if app is not None:
            os.close(app)
        raise
    result = []
    try:
        if app is None:
            app = directory(app_dir)
        names = bounded_names(fd, MAX_ENTRIES * 3)
        input_budget = [MAX_PENDING_JOURNAL_BYTES]
        response_budget = [MAX_PENDING_RESPONSE_BYTES]
        charge(response_budget, 2)  # The enclosing JSON array.
        admission_count = 0
        machine = physical_uuid()
        jobs = [n for n in names if n.endswith(".json") and not n.startswith(".")]
        if len(jobs) > MAX_ENTRIES:
            raise SmbError("bounds-exceeded")
        for name in sorted(jobs):
            if not UUID.fullmatch(name[:-5]):
                raise SmbError("recovery-required")
            job = validate_job(read_json(fd, name, budget=input_budget))
            scope = job["scope"]
            if name != scope["operationId"] + ".json":
                raise SmbError("recovery-required")
            authority = False
            try:
                guard = os.open(
                    name[:-5] + ".guard", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd
                )
                try:
                    regular(guard, 0)
                    origin = dict(
                        physical=hashlib.sha256(
                            ("heed-direct-smb-device-v1:" + machine).encode()
                        ).hexdigest(),
                        appPath=hashlib.sha256(
                            ("heed-direct-smb-app-v1:" + app_dir).encode()
                        ).hexdigest(),
                        app=local_identity(os.fstat(app)),
                        catalog=local_identity(os.fstat(fd)),
                        guard=local_identity(os.fstat(guard)),
                    )
                    authority = job["origin"] == origin
                finally:
                    os.close(guard)
            except (FileNotFoundError, SmbError):
                pass
            binding_matches = scope == scope_for(
                binding, {k: scope[k] for k in ("operationId", "deviceId", "kind")}
            )
            pinned = bool(job["claim"] and job["claim"].get("metadata")) and all(
                a["metadata"] or a["state"] == "planned" for a in job["allocations"].values()
            )
            prepared_zero_effect = (
                job["phase"] == "prepared"
                and job["claim"] is None
                and job["effects"] == 0
                and all(not job[key] for key in (
                    "allocations", "admissions", "removals", "confirmed"
                ))
            )
            recoverable = bool(
                authority and binding_matches and (pinned or prepared_zero_effect)
            )
            release_only = (
                job["phase"] in ("checkpointed", "releasing", "released")
                or not job["admissions"]
                and not job["effects"]
            )
            item = dict(
                operationId=scope["operationId"],
                deviceId=scope["deviceId"],
                kind=scope["kind"],
                recoverable=recoverable,
                admissions=[],
            )
            if release_only:
                item["releaseOnly"] = True
            if not recoverable:
                item["blockedReason"] = (
                    "Original physical owner, exact binding, and durable object receipts are required."
                )
            charge(
                response_budget,
                len(json.dumps(item, separators=(",", ":")).encode()) + bool(result),
            )
            for path, digest in job["admissions"].items():
                if admission_count >= MAX_PENDING_ADMISSIONS:
                    raise SmbError("bounds-exceeded")
                admission = dict(
                    meetingId=path.split("/")[1], revisionId=path.split("/")[3], manifestHash=digest
                )
                charge(
                    response_budget,
                    len(json.dumps(admission, separators=(",", ":")).encode())
                    + bool(item["admissions"]),
                )
                admission_count += 1
                item["admissions"].append(admission)
            result.append(item)
        return result
    finally:
        os.close(fd)
        if app is not None:
            os.close(app)
