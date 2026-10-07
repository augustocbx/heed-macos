"""Opt-in acceptance boundaries. All endpoints use injected handle servers."""

import io
import json
import unittest

from guardian import serve
from test_transport import HandleServer, ENDPOINT, CREDS, IDENTITY


class ObservationServer(HandleServer):
    def __init__(self):
        super().__init__()
        self.effects = []

    def list(self, *args):
        self.effects.append("list")
        raise AssertionError("Parent observation must not enumerate")

    def read(self, *args):
        self.effects.append("read")
        raise AssertionError("Parent observation must not read headers")

    def exclusive_create(self, *args):
        self.effects.append("create")
        raise AssertionError("Parent observation must not write")


def request(server, **overrides):
    startup = dict(
        protocol=1,
        action="qa-observe-parent",
        endpoint=ENDPOINT,
        credentials=CREDS,
        identity=IDENTITY,
    )
    startup.update(overrides)
    sink = io.BytesIO()
    serve(
        io.BytesIO(json.dumps(startup).encode() + b"\n"),
        sink,
        backend_factory=lambda: server,
    )
    return json.loads(sink.getvalue())


class AcceptanceObserverTests(unittest.TestCase):
    def test_guardian_observes_authenticated_parent_without_listing_or_header(self):
        server = ObservationServer()
        result = request(server)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["value"]["identity"], IDENTITY)
        self.assertEqual(result["value"]["security"], "signed")
        self.assertEqual(len(result["value"]["ancestors"]), 3)
        self.assertEqual(server.effects, [])
        self.assertTrue(server.opened)
        self.assertTrue(all(handle.closed for handle in server.opened))

    def test_changed_identity_and_unsigned_session_refuse_without_namespace_effect(
        self,
    ):
        for changed in (True, False):
            server = ObservationServer()
            if changed:
                server.changed = dict(objectId="00000000000000ff")
            else:
                server.security.update(signed=False, encrypted=False)
            result = request(server)
            self.assertFalse(result["ok"])
            self.assertEqual(
                result["error"],
                "identity-changed" if changed else "unsupported-security",
            )
            self.assertEqual(server.effects, [])
            self.assertTrue(all(handle.closed for handle in server.opened))

    def test_parent_component_bound_refuses_before_authenticated_connection(self):
        server = ObservationServer()
        calls = []
        server.connect = lambda *args: calls.append("connect")
        result = request(server, endpoint=dict(ENDPOINT, folder="/".join(["a"] * 64)))
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "bounds-exceeded")
        self.assertEqual(calls, [])
        self.assertEqual(server.opened, [])


class BootstrapDispatchTests(unittest.TestCase):
    def test_participant_cannot_request_creator_operation_before_connect(self):
        server = ObservationServer()
        calls = []
        server.connect = lambda *args: calls.append("connect")
        result = request(server, action="qa-create-child", role="participant")
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "invalid-input")
        self.assertEqual(calls, [])


import os
import stat
import tempfile
import shutil
from unittest.mock import patch
from uuid import uuid4
from types import SimpleNamespace
from protocol import SmbError
from transport import DirectTransport


class PhysicalFixtureServer(HandleServer):
    def __init__(self, root):
        super().__init__()
        self.root = root
        os.makedirs(root + "/Heed/library", mode=0o700, exist_ok=True)
        self.directory_creations = []
        self.header_creations = []

    def open(self, path, directory=False, access="read", exclusive=False):
        target = self.root + "/" + path
        if directory and exclusive:
            try:
                os.mkdir(target, 0o700)
            except FileExistsError:
                raise SmbError("destination-exists") from None
            self.directory_creations.append(path)
        fd = os.open(
            target, os.O_RDONLY | os.O_NOFOLLOW | (os.O_DIRECTORY if directory else 0)
        )
        h = SimpleNamespace(path=path, directory=directory, fd=fd, closed=False)
        self.opened.append(h)
        return h

    def metadata(self, h):
        s = os.fstat(h.fd) if hasattr(h, "fd") else os.stat(self.root + "/" + h.path)
        return dict(
            objectId=format(s.st_ino, "016x"),
            created=format(int(s.st_birthtime * 10_000_000), "016x"),
            volumeSerial=IDENTITY["volumeSerial"],
            volumeCreated=IDENTITY["volumeCreated"],
            directory=stat.S_ISDIR(s.st_mode),
            reparse=False,
            deletePending=False,
            links=1,
            bytes=s.st_size if stat.S_ISREG(s.st_mode) else 0,
        )

    def list(self, h, limit):
        return iter(os.listdir(h.fd))

    def read(self, h, offset, size):
        return os.pread(h.fd, size, offset)

    def exclusive_create(self, path, data):
        fd = os.open(
            self.root + "/" + path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600
        )
        try:
            os.write(fd, data)
            os.fsync(fd)
        finally:
            os.close(fd)
        self.header_creations.append(path)
        return self.open(path)

    def flush(self, h):
        os.fsync(h.fd)

    def close_handle(self, h):
        if not h.closed:
            os.close(h.fd)
        super().close_handle(h)


def fixture_workspace(base, name, run):
    p = base + "/" + name
    os.mkdir(p, 0o700)
    os.mkdir(p + "/acceptance", 0o700)
    os.mkdir(p + "/quota", 0o700)

    def identity(path):
        s = os.stat(path)
        return dict(
            device=str(s.st_dev),
            inode=str(s.st_ino),
            birth=str(int(s.st_birthtime * 1000)),
        )

    value = dict(
        path=p,
        identity=identity(p),
        receipts=identity(p + "/acceptance"),
        quota=identity(p + "/quota"),
    )
    paths = sorted(
        p + "/acceptance/" + n
        for n in ["guard", "receipt", "checkpoint", "parent-binding", "child-binding"]
    )
    ledger = dict(
        version=1,
        reservations={
            "qa-ledger-" + run: dict(bytes=8192, paths=[]),
            "qa-bootstrap-" + run: dict(bytes=332768, paths=paths),
        },
        atomicWrites={},
    )
    with open(p + "/quota/ledger", "w") as f:
        os.chmod(f.name, 0o600)
        header = dict(format="heed-qa-ledger", version=2, identity=identity(f.name))
        first = dict(
            version=1,
            reservations={"qa-ledger-" + run: dict(bytes=8192, paths=[])},
            atomicWrites={},
        )
        for record in (header, first, ledger):
            f.write(
                json.dumps(
                    record, sort_keys=True, separators=(",", ":"), ensure_ascii=False
                )
                + "\n"
            )
    return value


def receipt_state(path):
    with open(path) as file:
        records = [json.loads(line) for line in file]
    return dict(records[0]["scope"], **records[-1])


class BootstrapOwnershipTests(unittest.TestCase):
    def setUp(self):
        self.base = os.path.realpath(tempfile.mkdtemp(prefix="heed-qa-owned-"))
        os.mkdir(self.base + "/remote", 0o700)
        self.server = PhysicalFixtureServer(self.base + "/remote")
        t = DirectTransport(ENDPOINT, CREDS, backend=self.server)
        t.connect()
        identity = t.identity
        t.close()
        self.spec = dict(
            version=1,
            runId=str(uuid4()),
            destinationId=str(uuid4()),
            provider="smb-direct",
            destinationVersion=3,
            aliases=["a", "b"],
            locales=["en", "pt"],
            fixtureSchema=1,
            fixtureHash="a" * 64,
        )
        self.spec["child"] = "heed-qa-" + self.spec["runId"]
        self.binding = dict(
            id=str(uuid4()),
            name="Synthetic parent",
            endpoint=ENDPOINT,
            identity=identity,
            destinationId=str(uuid4()),
            destinationVersion=3,
            connectionGeneration=str(uuid4()),
            credentialRef=str(uuid4()),
            readOnly=False,
            security="signed",
        )
        self.workspace = fixture_workspace(self.base, "a", self.spec["runId"])
        self.machine = patch(
            "acceptance.physical_uuid",
            return_value="11111111-1111-4111-8111-111111111111",
        )
        self.machine.start()

    def tearDown(self):
        self.server.close()
        self.machine.stop()
        shutil.rmtree(self.base)

    def call(self, action="qa-create-child", **extra):
        startup = dict(
            protocol=1,
            action=action,
            endpoint=ENDPOINT,
            credentials=CREDS,
            binding=self.binding,
            spec=self.spec,
            workspace=self.workspace,
            selectedScope="parent",
        )
        startup.update(extra)
        sink = io.BytesIO()
        serve(
            io.BytesIO(json.dumps(startup).encode() + b"\n"),
            sink,
            backend_factory=lambda: self.server,
        )
        return json.loads(sink.getvalue())

    def test_creator_records_identity_before_header_and_retries_same_child(self):
        original = self.server.exclusive_create

        def header(path, data):
            r = receipt_state(self.workspace["path"] + "/acceptance/receipt")
            self.assertEqual(r["phase"], "allocated")
            self.assertIsNotNone(r["child"])
            return original(path, data)

        self.server.exclusive_create = header
        first = self.call()
        self.assertTrue(first["ok"], first)
        second = self.call()
        self.assertTrue(second["ok"], second)
        self.assertEqual(first["value"]["binding"], second["value"]["binding"])
        self.assertEqual(len(self.server.directory_creations), 1)
        self.assertEqual(len(self.server.header_creations), 1)
        with open(
            self.base
            + "/remote/Heed/library/"
            + self.spec["child"]
            + "/heed-library.json"
        ) as f:
            self.assertEqual(
                json.load(f),
                dict(
                    format="heed-portable-library",
                    schemaVersion=3,
                    destinationId=self.spec["destinationId"],
                ),
            )

    def test_unknown_allocation_retains_child_and_refuses_adoption(self):
        from acceptance import Ownership

        original = Ownership.save

        def save(owner):
            if owner.data["phase"] == "allocated":
                raise RuntimeError("Synthetic lost checkpoint")
            return original(owner)

        with patch.object(Ownership, "save", save):
            self.assertFalse(self.call()["ok"])
        self.assertEqual(
            receipt_state(self.workspace["path"] + "/acceptance/receipt")["phase"],
            "allocating",
        )
        self.assertFalse(self.call()["ok"])
        self.assertEqual(len(self.server.directory_creations), 1)
        self.assertEqual(self.server.header_creations, [])

    def test_allocated_original_resumes_but_copied_receipt_cannot(self):
        original = self.server.exclusive_create
        self.server.exclusive_create = lambda *args: (_ for _ in ()).throw(
            RuntimeError("Synthetic header interruption")
        )
        self.assertFalse(self.call()["ok"])
        self.server.exclusive_create = original
        self.assertTrue(self.call()["ok"])
        other = fixture_workspace(self.base, "copied", self.spec["runId"])
        for n in ["guard", "receipt"]:
            shutil.copyfile(
                self.workspace["path"] + "/acceptance/" + n,
                other["path"] + "/acceptance/" + n,
            )
            os.chmod(other["path"] + "/acceptance/" + n, 0o600)
        self.assertFalse(self.call(workspace=other)["ok"])
        self.assertEqual(len(self.server.directory_creations), 1)

    def test_participant_joins_independent_exact_child_never_initializes_or_promotes(
        self,
    ):
        first = self.call()
        self.assertTrue(first["ok"], first)
        participant = fixture_workspace(self.base, "b", self.spec["runId"])
        binding = dict(
            first["value"]["binding"],
            id=str(uuid4()),
            connectionGeneration=str(uuid4()),
            credentialRef=str(uuid4()),
        )
        evidence = {
            **{
                k: self.spec[k]
                for k in [
                    "runId",
                    "destinationId",
                    "provider",
                    "destinationVersion",
                    "child",
                ]
            },
            "initialized": True,
        }
        result = self.call(
            "qa-join-child",
            workspace=participant,
            evidence=evidence,
            selectedScope="child",
            endpoint=binding["endpoint"],
            binding=binding,
        )
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["value"]["role"], "participant")
        self.assertFalse(self.call(workspace=participant)["ok"])
        self.assertEqual(len(self.server.directory_creations), 1)
        self.assertEqual(len(self.server.header_creations), 1)

    def test_private_bindings_are_durable_and_immutable_original_receipt_files(self):
        result = self.call()
        self.assertTrue(result["ok"], result)
        with open(self.workspace["path"] + "/acceptance/parent-binding") as f:
            self.assertEqual(json.load(f), self.binding)
        with open(self.workspace["path"] + "/acceptance/child-binding") as f:
            self.assertEqual(json.load(f), result["value"]["binding"])
        before = os.stat(self.workspace["path"] + "/acceptance/child-binding").st_ino
        self.assertTrue(self.call()["ok"])
        self.assertEqual(
            os.stat(self.workspace["path"] + "/acceptance/child-binding").st_ino, before
        )
        os.unlink(self.workspace["path"] + "/acceptance/child-binding")
        self.assertFalse(self.call()["ok"])
        self.assertEqual(len(self.server.directory_creations), 1)

    def test_copied_original_receipt_refuses_before_connect(self):
        self.assertTrue(self.call()["ok"])
        other = fixture_workspace(self.base, "copied-preflight", self.spec["runId"])
        for n in ["guard", "receipt", "parent-binding", "child-binding"]:
            shutil.copyfile(
                self.workspace["path"] + "/acceptance/" + n,
                other["path"] + "/acceptance/" + n,
            )
            os.chmod(other["path"] + "/acceptance/" + n, 0o600)
        calls = []
        original = self.server.connect
        self.server.connect = lambda *args: (calls.append("connect"), original(*args))[
            1
        ]
        self.assertFalse(self.call(workspace=other)["ok"])
        self.assertEqual(calls, [])

    def test_boolean_schema_refuses_before_connect(self):
        calls = []
        self.server.connect = lambda *args: calls.append("connect")
        self.assertFalse(self.call(spec=dict(self.spec, fixtureSchema=True))["ok"])
        self.assertEqual(calls, [])

    def test_unknown_quota_checkpoint_refuses_before_connect_and_retains_bytes(self):
        path = self.workspace["path"] + "/quota/checkpoint"
        with open(path, "w") as f:
            os.chmod(path, 0o600)
            f.write("retained")
        calls = []
        self.server.connect = lambda *args: calls.append("connect")
        self.assertFalse(self.call()["ok"])
        self.assertEqual(calls, [])
        with open(path) as f:
            self.assertEqual(f.read(), "retained")

    def test_existing_child_collision_is_retained_without_header_or_adoption(self):
        path = self.base + "/remote/Heed/library/" + self.spec["child"]
        os.mkdir(path, 0o700)
        with open(path + "/sentinel", "w") as f:
            f.write("foreign fixture")
        self.assertFalse(self.call()["ok"])
        self.assertFalse(self.call()["ok"])
        self.assertEqual(self.server.header_creations, [])
        with open(path + "/sentinel") as f:
            self.assertEqual(f.read(), "foreign fixture")

    def test_participant_missing_header_does_not_initialize(self):
        first = self.call()
        self.assertTrue(first["ok"])
        binding = first["value"]["binding"]
        os.unlink(
            self.base
            + "/remote/Heed/library/"
            + self.spec["child"]
            + "/heed-library.json"
        )
        participant = fixture_workspace(self.base, "missing-header", self.spec["runId"])
        evidence = {
            **{
                k: self.spec[k]
                for k in [
                    "runId",
                    "destinationId",
                    "provider",
                    "destinationVersion",
                    "child",
                ]
            },
            "initialized": True,
        }
        result = self.call(
            "qa-join-child",
            workspace=participant,
            evidence=evidence,
            selectedScope="child",
            endpoint=binding["endpoint"],
            binding=binding,
        )
        self.assertFalse(result["ok"])
        self.assertEqual(len(self.server.header_creations), 1)

    def test_creator_receipt_cannot_resume_participant_phase(self):
        self.assertTrue(self.call()["ok"])
        path = self.workspace["path"] + "/acceptance/receipt"
        with open(path) as f:
            records = [json.loads(line) for line in f]
        records[-1]["phase"] = "joined"
        with open(path, "w") as f:
            for record in records:
                f.write(
                    json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n"
                )
        calls = []
        self.server.connect = lambda *args: calls.append("connect")
        self.assertFalse(self.call()["ok"])
        self.assertEqual(calls, [])

    def test_allocated_child_replacement_never_recreates_or_initializes(self):
        original = self.server.exclusive_create
        self.server.exclusive_create = lambda *args: (_ for _ in ()).throw(
            RuntimeError("Synthetic header interruption")
        )
        self.assertFalse(self.call()["ok"])
        self.server.exclusive_create = original
        path = self.base + "/remote/Heed/library/" + self.spec["child"]
        os.rename(path, path + "-original")
        os.mkdir(path, 0o700)
        self.assertFalse(self.call()["ok"])
        self.assertEqual(len(self.server.directory_creations), 1)
        self.assertEqual(self.server.header_creations, [])
        self.assertTrue(os.path.isdir(path + "-original"))

    def test_original_receipt_source_substitution_never_allocates_or_changes_foreign_entry(
        self,
    ):
        original = os.write
        path = self.workspace["path"] + "/acceptance/receipt"
        injected = []

        def write(fd, data):
            if b'"phase":"allocating"' in bytes(data) and not injected:
                injected.append(True)
                os.rename(path, path + "-original")
                with open(path, "wb") as file:
                    os.chmod(path, 0o600)
                    file.write(b"foreign source sentinel")
            return original(fd, data)

        with patch("acceptance.os.write", write):
            self.assertFalse(self.call()["ok"])
        self.assertTrue(injected)
        self.assertEqual(self.server.directory_creations, [])
        with open(path, "rb") as file:
            self.assertEqual(file.read(), b"foreign source sentinel")

    def test_receipt_destination_substitution_after_fsync_never_allocates(self):
        original = os.fsync
        path = self.workspace["path"] + "/acceptance/receipt"
        injected = []

        def sync(fd):
            original(fd)
            if os.path.exists(path) and os.fstat(fd).st_ino == os.stat(path).st_ino:
                data = os.pread(fd, 16385, 0)
                if data.endswith(b'"phase":"allocating"}\n') and not injected:
                    injected.append(data)
                    os.rename(path, path + "-original")
                    with open(path, "wb") as file:
                        os.chmod(path, 0o600)
                        file.write(data)

        with patch("acceptance.os.fsync", sync):
            self.assertFalse(self.call()["ok"])
        self.assertTrue(injected)
        self.assertEqual(self.server.directory_creations, [])
        with open(path, "rb") as file:
            self.assertEqual(file.read(), injected[0])

    def test_byte_identical_receipt_new_inode_refuses_before_authentication(self):
        self.assertTrue(self.call()["ok"])
        path = self.workspace["path"] + "/acceptance/receipt"
        with open(path, "rb") as file:
            data = file.read()
        os.rename(path, path + "-original")
        with open(path, "wb") as file:
            os.chmod(path, 0o600)
            file.write(data)
        calls = []
        self.server.connect = lambda *args: calls.append("connect")
        self.assertFalse(self.call()["ok"])
        self.assertEqual(calls, [])

    def test_torn_original_receipt_append_refuses_before_authentication(self):
        self.assertTrue(self.call()["ok"])
        path = self.workspace["path"] + "/acceptance/receipt"
        with open(path, "ab") as file:
            file.write(b'{"partial":')
        calls = []
        self.server.connect = lambda *args: calls.append("connect")
        self.assertFalse(self.call()["ok"])
        self.assertEqual(calls, [])
        with open(path, "rb") as file:
            self.assertTrue(file.read().endswith(b'{"partial":'))


if __name__ == "__main__":
    unittest.main()
