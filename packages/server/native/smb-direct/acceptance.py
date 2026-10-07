"""Opt-in synthetic child preparation; ordinary transport actions do not enter here."""

from identity import validate_identity
from protocol import SmbError

MAX_ANCESTORS = 64


def validate_parent_bounds(endpoint):
    # Check before connecting: connect pins the share and every selected ancestor.
    if (
        1 + (len(endpoint["folder"].split("/")) if endpoint["folder"] else 0)
        > MAX_ANCESTORS
    ):
        raise SmbError("bounds-exceeded")


def observe_parent(transport, expected):
    validate_parent_bounds(transport.endpoint)
    validate_identity(expected)
    transport.revalidate()
    if transport.identity != expected:
        raise SmbError("identity-changed")
    ancestors = [
        dict(
            objectId=meta["objectId"],
            created=meta["created"],
            volumeSerial=meta["volumeSerial"],
            volumeCreated=meta["volumeCreated"],
        )
        for _, _, meta in transport.pins
    ]
    transport.revalidate()
    return dict(
        identity=transport.identity,
        ancestors=ancestors,
        security="encrypted" if transport.security["encrypted"] else "signed",
        readOnly=transport.backend.read_only,
        namespaceSafe=True,
    )


# Private files have a fixed set. Ambiguous checkpoints are never enumerated away.
import fcntl
import hashlib
import json
import os
import stat
from uuid import uuid4
from journal import physical_uuid, local_identity, regular
from protocol import UUID, exact, duplicate_free
from identity import validate_metadata, same_object, receipt

RECEIPT_BYTES = 16384
BOOTSTRAP_BYTES = 332768
LEDGER_BYTES = 8192
FILES = ("guard", "receipt", "checkpoint", "parent-binding", "child-binding")


def public_spec(value):
    v = exact(
        value,
        (
            "version",
            "runId",
            "destinationId",
            "provider",
            "destinationVersion",
            "child",
            "aliases",
            "locales",
            "fixtureSchema",
            "fixtureHash",
        ),
    )
    if (
        type(v["version"]) is not int
        or v["version"] != 1
        or v["provider"] != "smb-direct"
        or type(v["destinationVersion"]) is not int
        or v["destinationVersion"] != 3
        or type(v["fixtureSchema"]) is not int
        or v["fixtureSchema"] != 1
        or not all(
            isinstance(v[k], str) and UUID.fullmatch(v[k])
            for k in ("runId", "destinationId")
        )
        or v["child"] != "heed-qa-" + v["runId"]
        or v["aliases"] != ["a", "b"]
        or v["locales"] != ["en", "pt"]
        or not isinstance(v["fixtureHash"], str)
        or len(v["fixtureHash"]) != 64
        or any(c not in "0123456789abcdef" for c in v["fixtureHash"])
    ):
        raise SmbError("invalid-input")
    return v


class LocalChain:
    def __init__(self, path):
        self.fds = []
        self.path = path
        if (
            not isinstance(path, str)
            or not path.startswith("/")
            or len(path) > 4096
            or "\0" in path
            or any(p in ("", ".", "..") for p in path.split("/")[1:])
            or len(path.split("/")) > 64
        ):
            raise SmbError("recovery-required")
        self.parts = path.split("/")[1:]
        try:
            self.fds.append(os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW))
            for part in self.parts:
                self.fds.append(
                    os.open(
                        part,
                        os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                        dir_fd=self.fds[-1],
                    )
                )
            self.identities = [local_identity(os.fstat(fd)) for fd in self.fds]
            self.check()
        except BaseException:
            self.close()
            raise

    @property
    def fd(self):
        return self.fds[-1]

    def check(self):
        for index, fd in enumerate(self.fds):
            if local_identity(os.fstat(fd)) != self.identities[index]:
                raise SmbError("identity-changed")
            if index:
                other = os.open(
                    self.parts[index - 1],
                    os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                    dir_fd=self.fds[index - 1],
                )
                try:
                    if local_identity(os.fstat(other)) != self.identities[index]:
                        raise SmbError("identity-changed")
                finally:
                    os.close(other)

    def private(self):
        info = os.fstat(self.fd)
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise SmbError("recovery-required")

    def close(self):
        for fd in reversed(self.fds):
            os.close(fd)
        self.fds = []


def private_json(fd, name, maximum):
    file = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    try:
        info = regular(file, maximum)
        if stat.S_IMODE(info.st_mode) != 0o600 or info.st_size < 1:
            raise SmbError("recovery-required")
        data = os.read(file, maximum + 1)
        if len(data) != info.st_size:
            raise SmbError("recovery-required")
        return json.loads(data, object_pairs_hook=duplicate_free)
    finally:
        os.close(file)


def absent(fd, name):
    try:
        os.stat(name, dir_fd=fd, follow_symlinks=False)
    except FileNotFoundError:
        return
    raise SmbError("recovery-required")


def digest(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def exclusive_binding(directory, name, value):
    data = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    if len(data) > 150000:
        raise SmbError("bounds-exceeded")
    fd = os.open(
        name,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        0o600,
        dir_fd=directory,
    )
    try:
        remaining = memoryview(data)
        while remaining:
            count = os.write(fd, remaining)
            if count <= 0:
                raise SmbError("recovery-required")
            remaining = remaining[count:]
        os.fsync(fd)
        result = dict(identity=local_identity(os.fstat(fd)), digest=digest(value))
        os.fsync(directory)
        return result
    finally:
        os.close(fd)


def verified_binding(directory, name, expected):
    exact(expected, ("identity", "digest"))
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    try:
        if local_identity(regular(fd, 150000)) != expected["identity"]:
            raise SmbError("recovery-required")
        data = os.read(fd, 150001)
        value = json.loads(data, object_pairs_hook=duplicate_free)
        if len(data) > 150000 or digest(value) != expected["digest"]:
            raise SmbError("recovery-required")
        return value
    finally:
        os.close(fd)


def verify_budget(files, quota, workspace, run_id):
    quota.check()
    inventory = os.open(
        ".", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=quota.fd
    )
    try:
        with os.scandir(inventory) as entries:
            for index, entry in enumerate(entries):
                if index >= 3 or entry.name != "ledger":
                    raise SmbError("recovery-required")
    finally:
        os.close(inventory)
    ledger = exact(
        private_json(quota.fd, "ledger", 4096),
        ("version", "reservations", "atomicWrites"),
    )
    expected = {
        "qa-ledger-" + run_id: dict(bytes=LEDGER_BYTES, paths=[]),
        "qa-bootstrap-"
        + run_id: dict(
            bytes=BOOTSTRAP_BYTES,
            paths=sorted(workspace["path"] + "/acceptance/" + name for name in FILES),
        ),
    }
    if digest(ledger) != digest(
        dict(version=1, reservations=expected, atomicWrites={})
    ):
        raise SmbError("recovery-required")
    total = 0
    for name in FILES:
        try:
            fd = os.open(
                name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=files.fd
            )
        except FileNotFoundError:
            continue
        try:
            maximum = (
                0
                if name == "guard"
                else RECEIPT_BYTES if name in ("receipt", "checkpoint") else 150000
            )
            info = regular(fd, maximum)
            if stat.S_IMODE(info.st_mode) != 0o600:
                raise SmbError("recovery-required")
            total += info.st_size
        finally:
            os.close(fd)
    if total > BOOTSTRAP_BYTES:
        raise SmbError("bounds-exceeded")


class Ownership:
    def __init__(self, workspace, spec, binding, parent, role):
        self.chains = []
        self.guard = None
        self.previous = None
        try:
            self.workspace = workspace
            for suffix in ("", "/acceptance", "/quota"):
                chain = LocalChain(workspace["path"] + suffix)
                self.chains.append(chain)
                chain.private()
            self.root, self.files, self.quota = self.chains
            # Descriptor identities originate locally; physical receipts below are never transferable.
            for chain, key in zip(self.chains, ("identity", "receipts", "quota")):
                actual = os.fstat(chain.fd)
                expected = exact(workspace[key], ("device", "inode", "birth"))
                if (
                    str(actual.st_dev) != expected["device"]
                    or str(actual.st_ino) != expected["inode"]
                    or str(int(actual.st_birthtime * 1000)) != expected["birth"]
                ):
                    raise SmbError("identity-changed")
            self.verify_budget(spec["runId"])
            absent(self.files.fd, "checkpoint")
            try:
                existing = private_json(self.files.fd, "receipt", RECEIPT_BYTES)
            except FileNotFoundError:
                existing = None
            flags = os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK
            if existing is None:
                flags |= os.O_CREAT | os.O_EXCL
            self.guard = os.open("guard", flags, 0o600, dir_fd=self.files.fd)
            regular(self.guard, 0)
            fcntl.flock(self.guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.machine = physical_uuid()
            self.origin = self.current_origin()
            if existing is None:
                parent_file = exclusive_binding(
                    self.files.fd, "parent-binding", binding
                )
            else:
                parent_file = existing.get("parentFile")
                if (
                    verified_binding(self.files.fd, "parent-binding", parent_file)
                    != binding
                ):
                    raise SmbError("recovery-required")
            self.scope = dict(
                version=1,
                role=role,
                spec=spec,
                bindingHash=digest(binding),
                parent=parent,
                origin=self.origin,
                parentFile=parent_file,
            )
            if existing is not None:
                exact(
                    existing,
                    (
                        *self.scope.keys(),
                        "phase",
                        "child",
                        "childId",
                        "childGeneration",
                        "childFile",
                    ),
                )
                if any(existing[k] != v for k, v in self.scope.items()):
                    raise SmbError("recovery-required")
                if existing["phase"] not in (
                    ("prepared", "allocating", "allocated", "initialized")
                    if role == "creator"
                    else ("prepared", "joined")
                ):
                    raise SmbError("recovery-required")
                if not all(
                    isinstance(existing[k], str) and UUID.fullmatch(existing[k])
                    for k in ("childId", "childGeneration")
                ):
                    raise SmbError("recovery-required")
                self.data = existing
                self.previous = json.loads(json.dumps(existing))
            else:
                os.fsync(self.guard)
                os.fsync(self.files.fd)
                self.data = dict(
                    self.scope,
                    phase="prepared",
                    child=None,
                    childId=str(uuid4()),
                    childGeneration=str(uuid4()),
                    childFile=None,
                )
                self.save()
        except BaseException:
            self.close()
            raise

    def verify_budget(self, run_id):
        verify_budget(self.files, self.quota, self.workspace, run_id)

    def current_origin(self):
        for chain in self.chains:
            chain.check()
            chain.private()
        info = regular(self.guard, 0)
        if local_identity(info) != local_identity(
            os.stat("guard", dir_fd=self.files.fd, follow_symlinks=False)
        ):
            raise SmbError("recovery-required")
        return dict(
            physical=digest(["heed-qa-origin-v1", self.machine]),
            workspace=local_identity(os.fstat(self.root.fd)),
            receipts=local_identity(os.fstat(self.files.fd)),
            guard=local_identity(info),
        )

    def check(self):
        if self.current_origin() != self.origin:
            raise SmbError("recovery-required")
        self.verify_budget(self.data["spec"]["runId"])
        verified_binding(self.files.fd, "parent-binding", self.data["parentFile"])
        if self.data["childFile"] is not None:
            verified_binding(self.files.fd, "child-binding", self.data["childFile"])
        else:
            absent(self.files.fd, "child-binding")
        if (
            self.previous is not None
            and private_json(self.files.fd, "receipt", RECEIPT_BYTES) != self.previous
        ):
            raise SmbError("recovery-required")

    def save(self):
        self.check()
        absent(self.files.fd, "checkpoint")
        content = json.dumps(self.data, sort_keys=True, separators=(",", ":")).encode()
        if len(content) > RECEIPT_BYTES:
            raise SmbError("bounds-exceeded")
        fd = os.open(
            "checkpoint",
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
            dir_fd=self.files.fd,
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
        os.replace(
            "checkpoint", "receipt", src_dir_fd=self.files.fd, dst_dir_fd=self.files.fd
        )
        os.fsync(self.files.fd)
        self.previous = json.loads(content)

    def close(self):
        if self.guard is not None:
            os.close(self.guard)
            self.guard = None
        for chain in reversed(self.chains):
            chain.close()
        self.chains = []


def child_transport(parent, component, allocate):
    """Borrow authenticated backend and all parent pins; never connect or close a second transport."""
    from transport import DirectTransport

    full = "/".join(p for p in (parent.endpoint["folder"], component) if p)
    parent.revalidate()
    handle = parent.backend.open(full, directory=True, exclusive=allocate)
    try:
        metadata = validate_metadata(parent.backend.metadata(handle), True)
        if (
            metadata["volumeSerial"] != parent.identity["volumeSerial"]
            or metadata["volumeCreated"] != parent.identity["volumeCreated"]
            or any(same_object(meta, metadata) for _, _, meta in parent.pins)
            or parent.backend.enforce_sharing(handle) is not True
        ):
            raise SmbError("identity-changed")
        child = DirectTransport(
            dict(parent.endpoint, folder=full),
            dict(username="unused", password="unused", domain=""),
            backend=parent.backend,
        )
        child.connected = True
        child.credentials = None
        child.security = parent.security
        child.pins = [*parent.pins, (full, handle, metadata)]
        child.root = handle
        child.identity = receipt(parent.backend.server_guid, metadata)
        child.revalidate()
        return child
    except BaseException:
        parent.backend.close_handle(handle)
        raise


def preflight_workspace(startup):
    """Copied, malformed or interrupted private authority refuses before SMB authentication."""
    workspace, spec = startup["workspace"], startup["spec"]
    chains = []
    try:
        for suffix, key in (
            ("", "identity"),
            ("/acceptance", "receipts"),
            ("/quota", "quota"),
        ):
            chain = LocalChain(workspace["path"] + suffix)
            chains.append(chain)
            chain.private()
            actual, expected = os.fstat(chain.fd), exact(
                workspace[key], ("device", "inode", "birth")
            )
            if expected != dict(
                device=str(actual.st_dev),
                inode=str(actual.st_ino),
                birth=str(int(actual.st_birthtime * 1000)),
            ):
                raise SmbError("identity-changed")
        verify_budget(chains[1], chains[2], workspace, spec["runId"])
        absent(chains[1].fd, "checkpoint")
        try:
            prior = private_json(chains[1].fd, "receipt", RECEIPT_BYTES)
        except FileNotFoundError:
            for name in ("guard", "parent-binding", "child-binding"):
                absent(chains[1].fd, name)
            return
        role = "creator" if startup["action"] == "qa-create-child" else "participant"
        # The existing receipt is independently checked against physical origin, binding,
        # fixed workspace and immutable private files before its parent snapshot is reused.
        owner = Ownership(
            workspace, spec, startup["binding"], prior.get("parent"), role
        )
        try:
            owner.check()
            if owner.data["phase"] == "allocating":
                raise SmbError("recovery-required")
        finally:
            owner.close()
    finally:
        for chain in reversed(chains):
            chain.close()


def validate_evidence(value, spec):
    evidence = exact(
        value,
        (
            "runId",
            "destinationId",
            "provider",
            "destinationVersion",
            "child",
            "initialized",
        ),
    )
    expected = {
        **{
            k: spec[k]
            for k in (
                "runId",
                "destinationId",
                "provider",
                "destinationVersion",
                "child",
            )
        },
        "initialized": True,
    }
    if digest(evidence) != digest(expected):
        raise SmbError("invalid-input")


def bootstrap(parent, startup):
    spec = public_spec(startup["spec"])
    role = "creator" if startup["action"] == "qa-create-child" else "participant"
    observed = observe_parent(parent, startup["binding"]["identity"])
    if observed["security"] != startup["binding"]["security"]:
        raise SmbError("unsupported-security")
    if role == "creator" and len(parent.pins) >= MAX_ANCESTORS:
        raise SmbError("bounds-exceeded")
    if role == "participant":
        validate_evidence(startup["evidence"], spec)
    owner = Ownership(startup["workspace"], spec, startup["binding"], observed, role)
    try:
        phase = owner.data["phase"]
        if phase == "allocating":
            raise SmbError("recovery-required")
        owner.check()
        parent.revalidate()
        allocating = role == "creator" and phase == "prepared"
        if allocating:
            owner.data["phase"] = "allocating"
            owner.save()
        child = (
            child_transport(parent, spec["child"], allocating)
            if role == "creator"
            else parent
        )
        owner.check()
        if allocating:
            owner.data.update(phase="allocated", child=child.identity)
            owner.save()
        elif role == "creator" and owner.data["child"] != child.identity:
            raise SmbError("identity-changed")
        elif (
            role == "participant"
            and phase == "joined"
            and owner.data["child"] != child.identity
        ):
            raise SmbError("identity-changed")
        owner.check()
        child.revalidate()
        probe = child.probe(child.identity)
        if (
            role == "creator"
            and owner.data["phase"] == "allocated"
            and probe["destinationId"] is None
        ):
            owner.check()
            child.initialize(child.identity, spec["destinationId"])
            probe = child.probe(child.identity)
        if (
            probe["destinationId"] != spec["destinationId"]
            or probe["destinationVersion"] != 3
        ):
            raise SmbError("unsupported-destination")
        owner.check()
        child.revalidate()
        binding = dict(
            startup["binding"],
            id=owner.data["childId"],
            name="Synthetic acceptance library",
            endpoint=child.endpoint,
            identity=child.identity,
            destinationId=spec["destinationId"],
            connectionGeneration=owner.data["childGeneration"],
            readOnly=probe["readOnly"],
            security=probe["security"],
        )
        if owner.data["childFile"] is None:
            owner.data["childFile"] = exclusive_binding(
                owner.files.fd, "child-binding", binding
            )
        elif (
            verified_binding(owner.files.fd, "child-binding", owner.data["childFile"])
            != binding
        ):
            raise SmbError("recovery-required")
        owner.data.update(
            phase="initialized" if role == "creator" else "joined", child=child.identity
        )
        owner.save()
        return dict(
            role=role,
            binding=binding,
            phase=owner.data["phase"],
            cleanup="retained-owned-child-and-immutable-audio",
        )
    finally:
        owner.close()
