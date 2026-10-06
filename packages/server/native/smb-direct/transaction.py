"""Whole-operation claims, immutable publication and exact original-owner recovery.

Completed claim archives intentionally remain on the share. At 10,000 root
entries new work refuses; archive reclamation needs a separately reviewed exact
owner operation. No TTL, path-unlink, copied-receipt, or overwrite fallback exists.
Task 3 adds exact confirmed deletion using the journal/handle authority below.
"""

import hashlib
import io
import json
import re
from uuid import uuid4

from identity import same_object, validate_metadata
from journal import Journal
from protocol import (
    SmbError,
    UUID,
    CHUNK,
    MAX_ENTRIES,
    count,
    duplicate_free,
    exact,
    validate_path,
)
from transport import HEADER, MAX_HANDLES

HASH = re.compile(r"^[a-f0-9]{64}$")
MANIFEST = re.compile(r"^meetings/([a-f0-9-]{36})/revisions/([a-f0-9-]{36})/manifest.json$")
PAYLOAD = re.compile(r"^meetings/([a-f0-9-]{36})/revisions/([a-f0-9-]{36})/meeting.json$")
COMMIT = re.compile(r"^commits/([a-f0-9-]{36})/([a-f0-9-]{36})\.json$")
CLAIM = ".heed-claim"


def encode(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()


def parse(data):
    try:
        return json.loads(
            data,
            object_pairs_hook=duplicate_free,
            parse_constant=lambda _: (_ for _ in ()).throw(SmbError("invalid-input")),
        )
    except (ValueError, UnicodeError, RecursionError):
        raise SmbError("invalid-input") from None


def uuid(value):
    if not isinstance(value, str) or not UUID.fullmatch(value):
        raise SmbError("invalid-input")
    return value


def sha(value):
    if not isinstance(value, str) or not HASH.fullmatch(value):
        raise SmbError("invalid-input")
    return value


def artifact(value):
    exact(value, ("path", "bytes", "sha256"))
    validate_path(value["path"])
    count(value["bytes"])
    sha(value["sha256"])
    return value


def revision(value, descriptor=False):
    exact(
        value,
        (
            "libraryId",
            "meetingId",
            "revisionId",
            *(("manifestHash", "parents") if descriptor else ()),
        ),
    )
    for k in ("libraryId", "meetingId", "revisionId"):
        uuid(value[k])
    if descriptor:
        sha(value["manifestHash"])
        parents(value["parents"])
    return value


def parents(value):
    if not isinstance(value, list) or len(value) > MAX_ENTRIES or len(set(value)) != len(value):
        raise SmbError("invalid-input")
    for item in value:
        uuid(item)


def manifest(value):
    exact(
        value,
        (
            "schemaVersion",
            "libraryId",
            "meetingId",
            "revisionId",
            "parents",
            "artifacts",
        ),
    )
    if type(value["schemaVersion"]) is not int or value["schemaVersion"] != 1:
        raise SmbError("invalid-input")
    revision({k: value[k] for k in ("libraryId", "meetingId", "revisionId")})
    parents(value["parents"])
    if not isinstance(value["artifacts"], list) or len(value["artifacts"]) != 1:
        raise SmbError("invalid-input")
    a = artifact(value["artifacts"][0])
    if a["path"] != "meeting.json" or not 0 < a["bytes"] <= 16 * 1024 * 1024:
        raise SmbError("bounds-exceeded")
    return value


def marker(value):
    exact(
        value,
        (
            "schemaVersion",
            "libraryId",
            "meetingId",
            "revisionId",
            "deviceId",
            "manifestPath",
            "manifestHash",
        ),
    )
    if type(value["schemaVersion"]) is not int or value["schemaVersion"] != 1:
        raise SmbError("invalid-input")
    revision({k: value[k] for k in ("libraryId", "meetingId", "revisionId")})
    uuid(value["deviceId"])
    sha(value["manifestHash"])
    if (
        value["manifestPath"]
        != f"meetings/{value['meetingId']}/revisions/{value['revisionId']}/manifest.json"
    ):
        raise SmbError("invalid-input")
    return value


def intent(value):
    exact(
        value,
        (
            "version",
            "id",
            "deviceId",
            "revision",
            *(("audio",) if "audio" in value else ()),
        ),
    )
    if type(value["version"]) is not int or value["version"] != 1:
        raise SmbError("invalid-input")
    uuid(value["id"])
    uuid(value["deviceId"])
    revision(value["revision"])
    if value["id"] != value["revision"]["revisionId"]:
        raise SmbError("invalid-input")
    if "audio" in value:
        a = artifact(value["audio"])
        if a["path"] != "objects/" + a["sha256"]:
            raise SmbError("invalid-input")
    return value


def audio_artifact(payload):
    if "audio" not in payload:
        return None
    audio = exact(payload["audio"], ("sha256", "bytes", "format", "mode", "objectPath"))
    sha(audio["sha256"])
    count(audio["bytes"])
    if (
        audio["objectPath"] != "objects/" + audio["sha256"]
        or audio["format"] != "wav"
        or audio["mode"] != "archived"
    ):
        raise SmbError("invalid-input")
    return dict(path=audio["objectPath"], bytes=audio["bytes"], sha256=audio["sha256"])


def deletion(value):
    exact(value, ("version", "jobId", "destinationId", "revisions", "artifacts"))
    if type(value["version"]) is not int or value["version"] != 1:
        raise SmbError("invalid-input")
    uuid(value["jobId"])
    uuid(value["destinationId"])
    for key in ("revisions", "artifacts"):
        if not isinstance(value[key], list) or not 0 < len(value[key]) <= MAX_ENTRIES:
            raise SmbError("bounds-exceeded")
    for r in value["revisions"]:
        revision(r, True)
    for a in value["artifacts"]:
        artifact(a)
        if not (
            MANIFEST.fullmatch(a["path"])
            or PAYLOAD.fullmatch(a["path"])
            or COMMIT.fullmatch(a["path"])
        ):
            raise SmbError("invalid-input")
    return value


def fence(value):
    exact(value, ("kind", "version", "jobId", "destinationId", "revision", "artifact"))
    if (
        value["kind"] != "heed-deleted-revision"
        or type(value["version"]) is not int
        or value["version"] != 1
    ):
        raise SmbError("invalid-input")
    uuid(value["jobId"])
    uuid(value["destinationId"])
    revision(value["revision"], True)
    artifact(value["artifact"])
    r = value["revision"]
    if (
        value["artifact"]["path"]
        != f"meetings/{r['meetingId']}/revisions/{r['revisionId']}/manifest.json"
        or value["artifact"]["sha256"] != r["manifestHash"]
    ):
        raise SmbError("invalid-input")
    return value


class Transaction:
    def __init__(self, transport, binding, context, app_dir):
        self.transport = transport
        self.backend = transport.backend
        self.binding, self.context = binding, context
        self.journal = None
        self.claim = None
        self.closed = False
        self.handles = []
        self.released = False
        try:
            if binding["destinationVersion"] != 3:
                raise SmbError("unsupported-destination")
            if binding["readOnly"]:
                raise SmbError("read-only")
            self.journal = Journal(binding, context, app_dir)
            probe = transport.probe(binding["identity"])
            if probe["readOnly"]:
                raise SmbError("read-only")
            if (
                probe["destinationId"] != binding["destinationId"]
                or binding["security"] == "encrypted"
                and not probe["encrypted"]
            ):
                raise SmbError("identity-changed")
            self.root_pins = [entry for entry in transport.pins if entry[2]["directory"]]
            self.acquire()
        except BaseException:
            self.abort()
            raise

    def full(self, path):
        validate_path(path)
        return "/".join(p for p in (self.transport.endpoint["folder"], path) if p)

    def open_handle(
        self, path, directory=False, access="read", exclusive=False, verification=False
    ):
        if len(self.handles) + len(self.transport.pins) >= MAX_HANDLES:
            raise SmbError("bounds-exceeded")
        h = self.backend.open(
            self.full(path),
            directory=directory,
            access=access,
            exclusive=exclusive,
            verification=verification,
        )
        self.handles.append(h)
        metadata = validate_metadata(self.backend.metadata(h), directory)
        identity = self.binding["identity"]
        if (
            metadata["volumeSerial"] != identity["volumeSerial"]
            or metadata["volumeCreated"] != identity["volumeCreated"]
        ):
            raise SmbError("identity-changed")
        if not verification and self.backend.enforce_sharing(h) is not True:
            raise SmbError("unsupported-namespace")
        return h, metadata

    def open_owned_effect(self, path, expected, directory=False, access="delete"):
        """The retained effect handle, not an earlier observation, proves ownership."""
        handle, actual = self.open_handle(path, directory, access)
        if not same_object(expected, actual):
            self.close_handle(handle)
            raise SmbError("recovery-required")
        return handle

    def close_handle(self, h):
        self.backend.close_handle(h)
        self.handles.remove(h)

    def observe(self, path, directory=False):
        try:
            h, metadata = self.open_handle(path, directory=directory, verification=True)
        except FileNotFoundError:
            return None
        self.close_handle(h)
        return metadata

    def acquire(self):
        job = self.journal.data
        if len(self.transport.listing(self.transport.root)) >= MAX_ENTRIES:
            raise SmbError("bounds-exceeded")
        prior = job["claim"]
        released_path = ".heed-released-" + self.context["operationId"]
        if job["phase"] in ("releasing", "released"):
            if not prior or not prior["metadata"]:
                raise SmbError("recovery-required")
            archived = self.observe(released_path, True)
            if archived is not None:
                if not same_object(prior["metadata"], archived):
                    raise SmbError("recovery-required")
                # A later canonical claim belongs to someone else: never open it.
                self.released = True
                return
            if job["phase"] == "released":
                raise SmbError("recovery-required")
        if prior is None:
            if self.observe(CLAIM, True) is not None:
                raise SmbError("destination-busy")
            prior = dict(stage=".heed-stage-" + str(uuid4()), metadata=None, state="allocating")
            job["claim"] = prior
            self.journal.save()
            self.claim, prior["metadata"] = self.open_handle(prior["stage"], True, "delete", True)
            prior["state"] = "renaming"
            self.journal.save()
            self.transport.revalidate()
            self.journal.check()
            self.backend.rename(self.claim, self.full(CLAIM))
            if not same_object(prior["metadata"], self.observe(CLAIM, True) or {}):
                raise SmbError("recovery-required")
            prior["state"] = "claimed"
            job["phase"] = "claimed"
            self.journal.save()
            return
        if not prior["metadata"]:
            raise SmbError("recovery-required")
        canonical = self.observe(CLAIM, True)
        if canonical is None:
            stage = self.observe(prior["stage"], True)
            if job["phase"] != "prepared" or not same_object(prior["metadata"], stage or {}):
                raise SmbError("recovery-required")
            self.claim = self.open_owned_effect(prior["stage"], prior["metadata"], True)
            self.backend.rename(self.claim, self.full(CLAIM))
        elif not same_object(prior["metadata"], canonical):
            raise SmbError("destination-busy")
        else:
            self.claim = self.open_owned_effect(CLAIM, prior["metadata"], True)
        if job["phase"] == "prepared":
            job["phase"] = "claimed"
        prior["state"] = "claimed"
        self.journal.save()
        self.check()

    def check(self, header=True):
        if self.closed or self.released:
            raise SmbError("transaction-unavailable")
        self.journal.check()
        self.transport.revalidate()
        receipt = self.journal.data["claim"]["metadata"]
        if not same_object(
            receipt, validate_metadata(self.backend.metadata(self.claim), True)
        ) or not same_object(receipt, self.observe(CLAIM, True) or {}):
            raise SmbError("identity-changed")
        # Probe pinned the exact immutable header and ancestors before claiming.
        if header:
            value = parse(b"".join(self.transport.stream(HEADER, 4096)))
            if value != dict(
                format="heed-portable-library",
                schemaVersion=3,
                destinationId=self.binding["destinationId"],
            ):
                raise SmbError("identity-changed")

    def begin_effect(self, kind=None):
        self.check()
        if kind is not None and self.context["kind"] != kind:
            raise SmbError("unsupported-coordination")
        self.journal.begin_effect()

    def ensure_parent(self, path):
        parts = path.split("/")[:-1]
        for n in range(1, len(parts) + 1):
            prefix = "/".join(parts[:n])
            if prefix in self.journal.data["allocations"]:
                self.publish_allocation(
                    prefix,
                    io.BytesIO(b""),
                    0,
                    hashlib.sha256(b"").hexdigest(),
                    directory=True,
                )
            try:
                self.transport.pin(prefix, True)
            except FileNotFoundError:
                self.publish_allocation(
                    prefix,
                    io.BytesIO(b""),
                    0,
                    hashlib.sha256(b"").hexdigest(),
                    directory=True,
                )
                self.transport.pin(prefix, True)

    def read(self, path, maximum):
        return b"".join(self.stream(path, maximum))

    def stream(self, path, maximum):
        self.check()
        count(maximum)
        parent = path.rsplit("/", 1)[0] if "/" in path else ""
        if parent:
            self.transport.pin(parent, True)
        h = self.transport.pin(path)
        initial = validate_metadata(self.backend.metadata(h), False)
        # Retained read pins deny mutation for the complete operation.
        if initial["bytes"] > maximum:
            raise SmbError("bounds-exceeded")
        offset = 0
        while offset < initial["bytes"]:
            self.check()
            data = self.backend.read(h, offset, min(CHUNK, initial["bytes"] - offset))
            if (
                not isinstance(data, bytes)
                or not data
                or len(data) > min(CHUNK, initial["bytes"] - offset)
            ):
                raise SmbError("invalid-protocol")
            offset += len(data)
            yield data
        now = validate_metadata(self.backend.metadata(h), False)
        if not same_object(now, initial) or now["bytes"] != initial["bytes"]:
            raise SmbError("identity-changed")
        self.check()

    def read_json(self, path, maximum=65536):
        return parse(self.read(path, maximum))

    def verify(self, path, size, digest):
        hasher = hashlib.sha256()
        actual = 0
        try:
            for data in self.stream(path, size):
                actual += len(data)
                hasher.update(data)
        except FileNotFoundError:
            raise SmbError("identity-changed") from None
        if actual != size or hasher.hexdigest() != digest:
            raise SmbError("identity-changed")
        allocated = self.journal.data["allocations"].get(path)
        if allocated and not same_object(allocated["metadata"] or {}, self.observe(path) or {}):
            raise SmbError("identity-changed")

    def plan_allocation(self, path, size, digest, directory=False):
        allocations = self.journal.data["allocations"]
        if path not in allocations:
            if len(allocations) >= MAX_ENTRIES:
                raise SmbError("bounds-exceeded")
            allocations[path] = dict(
                stage=CLAIM + "/" + str(uuid4()),
                metadata=None,
                bytes=size,
                sha256=digest,
                state="planned",
                directory=directory,
            )
            self.journal.save()
        return allocations[path]

    def publish_allocation(self, path, source, size, digest, directory=False):
        """Stable receipt precedes rename; only exact original allocations resume."""
        self.check()
        allocations = self.journal.data["allocations"]
        item = allocations.get(path)
        current = self.observe(path, directory)
        if item is not None:
            if (
                item["bytes"] != size
                or item["sha256"] != digest
                or item["directory"] != directory
                or item["metadata"] is None
                and item["state"] != "planned"
            ):
                raise SmbError("recovery-required")
            if current is not None:
                if not same_object(item["metadata"] or {}, current):
                    raise SmbError("canonical-admission-collision")
                if not directory:
                    self.verify(path, size, digest)
                item["state"] = "published"
                self.journal.save()
                return
            if item["state"] == "published":
                raise SmbError("recovery-required")
        elif current is not None:
            raise SmbError("canonical-admission-collision")
        if item is None:
            item = self.plan_allocation(path, size, digest, directory)
        if item["state"] == "planned":
            item["state"] = "allocating"
            self.journal.save()
            h, item["metadata"] = self.open_handle(
                item["stage"],
                directory,
                "delete" if directory else "write-delete",
                True,
            )
            item["state"] = "writing"
            self.journal.save()
        else:
            stage = self.observe(item["stage"], directory)
            if not same_object(item["metadata"], stage or {}):
                raise SmbError("recovery-required")
            h = self.open_owned_effect(
                item["stage"],
                item["metadata"],
                directory,
                "delete" if directory else "write-delete",
            )
        try:
            if not directory:
                if self.backend.metadata(h)["bytes"] > size:
                    raise SmbError("recovery-required")
                hasher = hashlib.sha256()
                offset = 0
                while offset < size:
                    self.check()
                    data = source.read(min(CHUNK, size - offset))
                    if (
                        not isinstance(data, bytes)
                        or not data
                        or len(data) > min(CHUNK, size - offset)
                    ):
                        raise SmbError("invalid-input")
                    # Original partial allocations may resume only matching bytes.
                    prior_bytes = min(len(data), max(0, self.backend.metadata(h)["bytes"] - offset))
                    old = self.backend.read(h, offset, prior_bytes) if prior_bytes else b""
                    if old != data[: len(old)]:
                        raise SmbError("recovery-required")
                    if self.backend.write(h, data, offset) != len(data):
                        raise SmbError("transport-unavailable")
                    offset += len(data)
                    hasher.update(data)
                if hasher.hexdigest() != digest:
                    raise SmbError("invalid-input")
                self.backend.flush(h)
                if self.backend.metadata(h)["bytes"] != size:
                    raise SmbError("identity-changed")
            item["state"] = "verified"
            self.journal.save()
            self.check()
            item["state"] = "renaming"
            self.journal.save()
            self.backend.rename(h, self.full(path))
            if not same_object(item["metadata"], self.observe(path, directory) or {}):
                raise SmbError("identity-changed")
        finally:
            self.close_handle(h)
        if not directory:
            self.verify(path, size, digest)
        item["state"] = "published"
        self.journal.save()

    def admission(self, path):
        if path not in self.journal.data["admissions"]:
            raise SmbError("unsupported-coordination")
        a = self.journal.data["allocations"][path]
        if a["state"] != "published" or not same_object(a["metadata"], self.observe(path) or {}):
            raise SmbError("recovery-required")
        self.verify(path, a["bytes"], a["sha256"])
        return manifest(self.read_json(path))

    def admitted_pending(self, value):
        path = f"control/pending/{self.context['deviceId']}/{value['revisionId']}.json"
        allocation = self.journal.data["allocations"].get(path)
        if not allocation or allocation["state"] != "published":
            raise SmbError("unsupported-coordination")
        self.verify(path, allocation["bytes"], allocation["sha256"])
        pending = intent(self.read_json(path))
        if pending["deviceId"] != self.context["deviceId"] or any(
            pending["revision"][k] != value[k] for k in ("libraryId", "meetingId", "revisionId")
        ):
            raise SmbError("identity-changed")
        return pending

    def barriers(self, value):
        for record in self.control_files("control/deletions", False):
            record = deletion(record)
            if record["destinationId"] != self.binding["destinationId"]:
                raise SmbError("identity-changed")
            if any(
                all(r[k] == value[k] for k in ("libraryId", "meetingId", "revisionId"))
                for r in record["revisions"]
            ):
                raise SmbError("canonical-admission-collision")
        # Canonical permanent fences are also collisions, regardless of record age.
        path = f"meetings/{value['meetingId']}/revisions/{value['revisionId']}/manifest.json"
        if self.observe(path) is not None and path not in self.journal.data["admissions"]:
            raise SmbError("canonical-admission-collision")

    def write(self, path, source, size, digest):
        validate_path(path)
        count(size)
        sha(digest)
        self.check()
        m, p, c = (
            MANIFEST.fullmatch(path),
            PAYLOAD.fullmatch(path),
            COMMIT.fullmatch(path),
        )
        small = m or p or c
        if small:
            for part in small.groups():
                uuid(part)
            maximum = 65536 if m else 16 * 1024 * 1024 if p else 16384
            if size > maximum:
                raise SmbError("bounds-exceeded")
            data = source.read(size)
            if (
                not isinstance(data, bytes)
                or len(data) != size
                or hashlib.sha256(data).hexdigest() != digest
            ):
                raise SmbError("invalid-input")
            value = parse(data)
            source = io.BytesIO(data)
        if m:
            manifest(value)
            if (value["meetingId"], value["revisionId"]) != m.groups():
                raise SmbError("invalid-input")
            # An original interrupted rename already has durable allocation authority.
            if path not in self.journal.data["allocations"]:
                self.barriers(value)
            else:
                for r in self.control_files("control/deletions", False):
                    deletion(r)
                    if any(
                        all(x[k] == value[k] for k in ("libraryId", "meetingId", "revisionId"))
                        for x in r["revisions"]
                    ):
                        raise SmbError("canonical-admission-collision")
        elif p:
            admitted = self.admission(path[: -len("meeting.json")] + "manifest.json")
            pending = self.admitted_pending(admitted)
            if audio_artifact(value) != pending.get("audio"):
                raise SmbError("invalid-input")
            expected = admitted["artifacts"][0]
            if (
                expected["bytes"] != size
                or expected["sha256"] != digest
                or value.get("schemaVersion") != 1
                or value.get("meetingId") != p[1]
            ):
                raise SmbError("invalid-input")
        elif c:
            marker(value)
            if (value["deviceId"], value["revisionId"]) != c.groups() or value[
                "deviceId"
            ] != self.context["deviceId"]:
                raise SmbError("invalid-input")
            self.admitted_pending(self.admission(value["manifestPath"]))
            self.verify_commit(value, require_marker=False)
        elif path.startswith("objects/") and HASH.fullmatch(path[8:]) and path[8:] == digest:
            required = dict(path=path, bytes=size, sha256=digest)
            allowed = False
            for pending in self.control_files("control/pending", True):
                intent(pending)
                admitted_path = f"meetings/{pending['revision']['meetingId']}/revisions/{pending['revision']['revisionId']}/manifest.json"
                if (
                    pending["deviceId"] == self.context["deviceId"]
                    and pending.get("audio") == required
                    and admitted_path in self.journal.data["admissions"]
                ):
                    self.admission(admitted_path)
                    allowed = True
            if not allowed:
                raise SmbError("unsupported-coordination")
            if self.observe(path) is not None and path not in self.journal.data["allocations"]:
                # Content addressing permits a verified read-only reference, never ownership.
                self.verify(path, size, digest)
                received = 0
                h = hashlib.sha256()
                while received < size:
                    data = source.read(min(CHUNK, size - received))
                    if not isinstance(data, bytes) or not data:
                        raise SmbError("invalid-input")
                    received += len(data)
                    h.update(data)
                if received != size or h.hexdigest() != digest:
                    raise SmbError("invalid-input")
                return
        else:
            raise SmbError("invalid-input")
        self.begin_effect("publish")
        if m:
            self.plan_allocation(path, size, digest)
            self.journal.data["admissions"][path] = digest
            self.journal.save()
        self.ensure_parent(path)
        self.publish_allocation(path, source, size, digest)
        if m:
            self.journal.data["admissions"][path] = digest
            self.journal.save()

    def write_control(self, path, value, kind):
        data = encode(value)
        if len(data) > 2_000_000:
            raise SmbError("bounds-exceeded")
        self.begin_effect(kind)
        self.ensure_parent(path)
        self.publish_allocation(path, io.BytesIO(data), len(data), hashlib.sha256(data).hexdigest())
        if self.read_json(path, 2_000_000) != value:
            raise SmbError("identity-changed")

    def write_pending(self, value):
        intent(value)
        if value["deviceId"] != self.context["deviceId"]:
            raise SmbError("invalid-input")
        r = value["revision"]
        path = f"meetings/{r['meetingId']}/revisions/{r['revisionId']}/manifest.json"
        m = self.admission(path)
        if any(m[k] != r[k] for k in ("libraryId", "meetingId", "revisionId")):
            raise SmbError("invalid-input")
        self.write_control(
            f"control/pending/{value['deviceId']}/{value['id']}.json", value, "publish"
        )

    def retire_pending(self, value):
        intent(value)
        if value["deviceId"] != self.context["deviceId"]:
            raise SmbError("invalid-input")
        path = f"control/pending/{value['deviceId']}/{value['id']}.json"
        if path not in self.journal.data["allocations"] or self.read_json(path) != value:
            raise SmbError("recovery-required")
        key = f"commits/{value['deviceId']}/{value['revision']['revisionId']}.json"
        if key not in self.journal.data["confirmed"]:
            raise SmbError("unsupported-coordination")
        self.confirm(self.read_json(key, 16384))
        # Immutable retirement proof suppresses the original intent. No unlink.
        self.write_control(
            f"control/retired/{value['deviceId']}/{value['id']}.json", value, "publish"
        )

    def write_deletion(self, value):
        deletion(value)
        if (
            value["jobId"] != self.context["operationId"]
            or value["destinationId"] != self.binding["destinationId"]
        ):
            raise SmbError("invalid-input")
        self.write_control(f"control/deletions/{value['jobId']}.json", value, "delete")

    def own_deletion(self, job_id):
        if self.context["kind"] != "delete" or job_id != self.context["operationId"]:
            raise SmbError("unsupported-coordination")
        value = deletion(self.read_json(f"control/deletions/{uuid(job_id)}.json", 2_000_000))
        if value["jobId"] != job_id or value["destinationId"] != self.binding["destinationId"]:
            raise SmbError("identity-changed")
        return value

    def write_fence(self, value):
        fence(value)
        record = self.own_deletion(value["jobId"])
        if (
            value["destinationId"] != record["destinationId"]
            or value["revision"] not in record["revisions"]
            or value["artifact"] not in record["artifacts"]
        ):
            raise SmbError("invalid-input")
        self.write_control(value["artifact"]["path"], value, "delete")

    def control_files(self, path, nested, budget=None):
        budget = budget if budget is not None else [0, 0]
        self.check()
        try:
            handle = self.transport.pin(path, True)
        except FileNotFoundError:
            return
        for name in self.transport.listing(handle):
            if nested:
                uuid(name)
                yield from self.control_files(path + "/" + name, False, budget)
            else:
                if not name.endswith(".json"):
                    raise SmbError("recovery-required")
                uuid(name[:-5])
                budget[0] += 1
                if budget[0] > MAX_ENTRIES:
                    raise SmbError("bounds-exceeded")
                data = self.read(path + "/" + name, 2_000_000)
                budget[1] += len(data)
                if budget[1] > 64_000_000:
                    raise SmbError("bounds-exceeded")
                value = parse(data)
                # Bind content identity to canonical filename at this boundary.
                if path.startswith("commits/"):
                    marker(value)
                    if (
                        name != value["revisionId"] + ".json"
                        or path != "commits/" + value["deviceId"]
                    ):
                        raise SmbError("identity-changed")
                elif path == "control/deletions":
                    deletion(value)
                    if (
                        name != value["jobId"] + ".json"
                        or value["destinationId"] != self.binding["destinationId"]
                    ):
                        raise SmbError("identity-changed")
                else:
                    intent(value)
                    if (
                        name != value["id"] + ".json"
                        or path.rsplit("/", 1)[-1] != value["deviceId"]
                    ):
                        raise SmbError("identity-changed")
                yield value

    def reopen_read(self, path):
        """Acquire the new read pin before closing the old pin: no sharing gap."""
        self.check()
        try:
            old = self.transport.pin(path)
        except FileNotFoundError:
            raise SmbError("identity-changed") from None
        prior = validate_metadata(self.backend.metadata(old), False)
        new, current = self.open_handle(path)
        if not same_object(prior, current) or prior["bytes"] != current["bytes"]:
            raise SmbError("identity-changed")
        self.transport.unpin(old)
        self.handles.remove(new)
        self.transport.pins.append((self.full(path), new, current))

    def verify_commit(self, value, require_marker=True):
        marker(value)
        self.reopen_read(value["manifestPath"])
        raw = self.read(value["manifestPath"], 65536)
        if hashlib.sha256(raw).hexdigest() != value["manifestHash"]:
            raise SmbError("identity-changed")
        m = manifest(parse(raw))
        if any(m[k] != value[k] for k in ("libraryId", "meetingId", "revisionId")):
            raise SmbError("identity-changed")
        a = m["artifacts"][0]
        path = value["manifestPath"][: -len("manifest.json")] + "meeting.json"
        self.reopen_read(path)
        self.verify(path, a["bytes"], a["sha256"])
        payload = self.read_json(path, a["bytes"])
        if (
            not isinstance(payload, dict)
            or payload.get("schemaVersion") != 1
            or payload.get("meetingId") != value["meetingId"]
        ):
            raise SmbError("invalid-input")
        if "audio" in payload:
            audio = payload["audio"]
            exact(audio, ("sha256", "bytes", "format", "mode", "objectPath"))
            sha(audio["sha256"])
            count(audio["bytes"])
            if (
                audio["objectPath"] != "objects/" + audio["sha256"]
                or audio["format"] != "wav"
                or audio["mode"] != "archived"
            ):
                raise SmbError("invalid-input")
            self.reopen_read(audio["objectPath"])
            self.verify(audio["objectPath"], audio["bytes"], audio["sha256"])
        if require_marker:
            commit_path = f"commits/{value['deviceId']}/{value['revisionId']}.json"
            self.reopen_read(commit_path)
            stored = self.read(commit_path, 16384)
            if stored != encode(value):
                raise SmbError("identity-changed")
        self.check()

    def confirm(self, value):
        self.verify_commit(value)
        key = f"commits/{value['deviceId']}/{value['revisionId']}.json"
        self.journal.data["confirmed"][key] = value["manifestHash"]
        self.journal.save()
        return "remote-confirmed"

    def inventory(self):
        self.check()
        budget = [0, 0]
        deletions = list(self.control_files("control/deletions", False, budget))
        retired = list(self.control_files("control/retired", True, budget))
        pending = []
        for value in self.control_files("control/pending", True, budget):
            matches = [
                r for r in retired if r["deviceId"] == value["deviceId"] and r["id"] == value["id"]
            ]
            if matches and matches != [value]:
                raise SmbError("identity-changed")
            if not matches:
                pending.append(value)
        commits = []
        for value in self.control_files("commits", True, budget):
            if any(
                any(
                    all(r[k] == value[k] for k in ("libraryId", "meetingId", "revisionId"))
                    for r in record["revisions"]
                )
                for record in deletions
            ):
                continue
            self.verify_commit(value)
            commits.append(value)
        result = dict(commits=commits, deletions=deletions, pending=pending, complete=True)
        if len(encode(result)) > 1_900_000:
            raise SmbError("bounds-exceeded")
        return result

    def listing(self, path):
        self.check()
        if path == "commits":
            # Discovery sees complete marker-last commits only.
            return [
                f"commits/{m['deviceId']}/{m['revisionId']}.json"
                for m in self.inventory()["commits"]
            ]
        return self.transport.listing(
            self.transport.root if not path else self.transport.pin(path, True)
        )

    def checkpoint(self):
        if self.released:
            self.journal.check()
            return
        self.check()
        if self.journal.data["phase"] == "releasing":
            return
        # Uncertain canonical effects must be reconciled by their original command.
        if any(a["state"] != "published" for a in self.journal.data["allocations"].values()):
            raise SmbError("recovery-required")
        self.journal.data["phase"] = "checkpointed"
        self.journal.save()

    def close(self):
        if self.closed:
            return
        if self.released:
            self.transport.close()
            self.journal.finish()
            self.closed = True
            return
        if self.journal.data["phase"] not in ("checkpointed", "releasing"):
            raise SmbError("recovery-required")
        self.check()
        # Completed descendants are closed before release, preserving claim + root
        # authority until the exact non-replacing move and outcome verification.
        for h in list(reversed(self.handles)):
            if h is not self.claim:
                self.close_handle(h)
        for entry in list(reversed(self.transport.pins)):
            if entry not in self.root_pins:
                self.transport.unpin(entry[1])
        self.check(header=False)
        self.journal.data["phase"] = "releasing"
        self.journal.save()
        released = ".heed-released-" + self.context["operationId"]
        self.backend.rename(self.claim, self.full(released))
        if not same_object(
            self.journal.data["claim"]["metadata"], self.observe(released, True) or {}
        ):
            raise SmbError("recovery-required")
        self.close_handle(self.claim)
        self.claim = None
        self.transport.close()
        self.journal.finish()
        self.closed = True

    def abort(self):
        if self.closed:
            return
        self.closed = True
        try:
            self.transport.close()
        except Exception:
            pass
        finally:
            if self.journal:
                self.journal.close()
