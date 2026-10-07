"""Original authority uses real files with an injected authenticated handle server."""
import io
import json
import os
import importlib.util
import unittest
import test_acceptance as fixture
from test_transport import ENDPOINT, CREDS
from guardian import serve


class AuthorityTests(unittest.TestCase):
    setUp = fixture.BootstrapOwnershipTests.setUp
    tearDown = fixture.BootstrapOwnershipTests.tearDown
    call = fixture.BootstrapOwnershipTests.call
    def startup(self, **updates):
        value = dict(protocol=1, action="qa-open-owned-authority", endpoint=ENDPOINT,
                     credentials=CREDS, binding=self.binding, spec=self.spec,
                     workspace=self.workspace, selectedScope="parent", role="creator")
        value.update(updates)
        return value

    def session(self, controls, **updates):
        data = json.dumps(self.startup(**updates)).encode() + b"\n"
        for sequence, action in enumerate(controls, 1):
            data += json.dumps(dict(sequence=sequence, action=action)).encode() + b"\n"
        output = io.BytesIO()
        serve(io.BytesIO(data), output, backend_factory=lambda: self.server)
        return [json.loads(line) for line in output.getvalue().splitlines()]

    def test_initialized_original_session_checks_and_closes_without_namespace_writes(self):
        self.assertTrue(self.call()["ok"])
        before = (len(self.server.directory_creations), len(self.server.header_creations))
        path = self.workspace["path"] + "/acceptance/receipt"
        with open(path, "rb") as f: receipt = f.read()
        result = self.session(["check", "close"])
        self.assertTrue(result[0]["ok"], result)
        self.assertEqual(result[0]["value"]["role"], "creator")
        self.assertTrue(result[-1]["ok"])
        with open(path, "rb") as f: self.assertEqual(f.read(), receipt)
        self.assertEqual(before, (len(self.server.directory_creations), len(self.server.header_creations)))
        self.assertTrue(all(h.closed for h in self.server.opened))

    def test_missing_receipt_refuses_before_authentication_or_receipt_issue(self):
        calls = []
        self.server.connect = lambda *args: calls.append(True)
        result = self.session(["close"])
        self.assertFalse(result[0]["ok"])
        self.assertEqual(calls, [])
        self.assertFalse(os.path.exists(self.workspace["path"] + "/acceptance/guard"))

    def test_authority_holds_guard_and_receipt_entry_across_actual_substitution(self):
        self.assertTrue(self.call()["ok"])
        self.assertIsNotNone(importlib.util.find_spec("acceptance_authority"))
        from acceptance_authority import Authority
        startup = self.startup()
        with Authority(startup, backend_factory=lambda: self.server) as authority:
            authority.check()
            with self.assertRaises(Exception):
                with Authority(startup, backend_factory=lambda: self.server):
                    self.fail("Concurrent guard must refuse")
            path = self.workspace["path"] + "/acceptance/receipt"
            with open(path, "rb") as f: raw = f.read()
            os.rename(path, path + "-original")
            with open(path, "wb") as f:
                os.chmod(path, 0o600)
                f.write(raw)
            with self.assertRaises(Exception): authority.check()
            with open(path, "rb") as f: self.assertEqual(f.read(), raw)
        self.assertTrue(all(h.closed for h in self.server.opened))

    def test_control_never_dispatches_artifact_or_allocation_operations(self):
        self.assertTrue(self.call()["ok"])
        for action in ("write", "read", "qa-create-child", "initialize"):
            result = self.session([action])
            self.assertFalse(result[-1]["ok"], result)

    def test_changed_physical_origin_and_torn_receipt_refuse_before_authentication(self):
        self.assertTrue(self.call()["ok"])
        calls = []
        original = self.server.connect
        self.server.connect = lambda *args: calls.append(True)
        from unittest.mock import patch
        with patch("acceptance.physical_uuid", return_value="22222222-2222-4222-8222-222222222222"):
            self.assertFalse(self.session(["close"])[0]["ok"])
        self.assertEqual(calls, [])
        self.server.connect = original
        path = self.workspace["path"] + "/acceptance/receipt"
        with open(path, "ab") as f: f.write(b'{"phase":')
        calls = []
        self.server.connect = lambda *args: calls.append(True)
        self.assertFalse(self.session(["close"])[0]["ok"])
        self.assertEqual(calls, [])
        with open(path, "rb") as f: self.assertTrue(f.read().endswith(b'{"phase":'))

    def test_control_sequence_and_oversize_refuse_and_release_original_guard(self):
        self.assertTrue(self.call()["ok"])
        from acceptance_authority import Authority
        for control in (dict(sequence=True, action="check"), dict(sequence=2, action="check"), dict(sequence=1, action="check", private="x" * 4096)):
            source = io.BytesIO(json.dumps(self.startup()).encode() + b"\n" + json.dumps(control).encode() + b"\n")
            output = io.BytesIO()
            serve(source, output, backend_factory=lambda: self.server)
            frames = [json.loads(line) for line in output.getvalue().splitlines()]
            self.assertFalse(frames[-1]["ok"])
            with Authority(self.startup(), backend_factory=lambda: self.server) as authority:
                authority.check()


    def test_retained_creator_and_participant_allow_separate_production_transaction(self):
        from unittest.mock import patch
        from types import SimpleNamespace
        from uuid import uuid4
        from smbprotocol.exceptions import SharingViolation
        from smbprotocol.create_contexts import SMB2CreateQueryMaximalAccessResponse
        from transport import SmbProtocolBackend, DirectTransport
        from transaction import Transaction
        from acceptance_authority import Authority
        from protocol import SmbError

        created = self.call()
        self.assertTrue(created["ok"], created)
        child_binding = dict(created["value"]["binding"], id=str(uuid4()),
                             credentialRef=str(uuid4()), connectionGeneration=str(uuid4()))
        participant = fixture.fixture_workspace(self.base, "b", self.spec["runId"])
        joined = self.call("qa-join-child", binding=child_binding, endpoint=child_binding["endpoint"],
                           workspace=participant, selectedScope="child",
                           evidence=dict(runId=self.spec["runId"], destinationId=self.spec["destinationId"],
                                         provider="smb-direct", destinationVersion=3, child=self.spec["child"], initialized=True))
        self.assertTrue(joined["ok"], joined)
        import hashlib
        import wave
        audio = io.BytesIO()
        with wave.open(audio, "wb") as wav:
            wav.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
            wav.writeframes(b"\x00\x00" * 160)
        audio = audio.getvalue()
        audio_name = hashlib.sha256(audio).hexdigest()
        objects = self.server.root + "/" + child_binding["endpoint"]["folder"] + "/objects"
        os.mkdir(objects, 0o700)
        with open(objects + "/" + audio_name, "wb") as file: file.write(audio)
        server, registry, events = self.server, [], []

        class BoundaryOpen:
            def __init__(self, tree, name):
                self.path = self.file_name = name.replace("\\", "/")
                self.closed = True

            def create(self, impersonation, access, attributes, sharing, disposition, options, create_contexts=None):
                self.access, self.sharing = access, sharing
                self.directory = bool(options & 1)
                effective = 0x10007 if access == 0x02000000 else access
                needs = lambda mask: (1 if mask & 1 else 0) | (2 if mask & 6 else 0) | (4 if mask & 0x10000 else 0)
                for other in registry:
                    if not other.closed and other.path == self.path and (
                        needs(effective) & ~other.sharing or needs(other.access) & ~sharing
                    ):
                        events.append(("sharing-refused", self.path, access, sharing))
                        raise SharingViolation()
                target = server.root + "/" + self.path
                if disposition == 2:
                    if os.path.exists(target): raise SmbError("destination-exists")
                    if self.directory: os.mkdir(target, 0o700)
                    else:
                        with open(target, "xb"): pass
                h = server.open(self.path, directory=self.directory)
                self.fd, self.closed = h.fd, False
                server.opened[-1] = self
                registry.append(self)
                events.append(("open", self.path, access, sharing))
                if create_contexts:
                    value = SMB2CreateQueryMaximalAccessResponse()
                    value["query_status"], value["maximal_access"] = 0, 0x10087
                    return [value]
                return None

            def close(self):
                if not self.closed: os.close(self.fd)
                self.closed = True

            def read(self, offset, size): return os.pread(self.fd, size, offset)

        class BoundaryBackend(SmbProtocolBackend):
            def __init__(self):
                super().__init__()
                self.server_guid = server.server_guid
                self.share_safe = True
                self.tree = SimpleNamespace()

            def connect(self, *_): return server.security
            def metadata(self, handle): return server.metadata(handle)
            def query(self, *_): return dict(access_flags=0x7)
            def list(self, handle, limit): return server.list(handle, limit)
            def rename(self, handle, target):
                if not handle.access & 0x10000: raise AssertionError("Rename requires exact DELETE handle")
                if os.path.exists(server.root + "/" + target): raise SmbError("destination-exists")
                old = handle.path
                os.rename(server.root + "/" + old, server.root + "/" + target)
                for opened in registry:
                    if opened.path == old or opened.path.startswith(old + "/"):
                        opened.path = target + opened.path[len(old):]
                        opened.file_name = opened.path
            def close(self):
                for handle in list(reversed(self.handles)): self.close_handle(handle)

        for role, startup in (
            ("creator", self.startup()),
            ("participant", self.startup(binding=child_binding, endpoint=child_binding["endpoint"],
                                         workspace=participant, role="participant", selectedScope="child")),
        ):
            with self.subTest(role=role), patch("smbprotocol.open.Open", BoundaryOpen), patch(
                "journal.physical_uuid", return_value="11111111-1111-4111-8111-111111111111"
            ):
                receipt_path = startup["workspace"]["path"] + "/acceptance/receipt"
                with open(receipt_path, "rb") as file: original = file.read()
                with Authority(startup, backend_factory=BoundaryBackend) as authority:
                    authority.check()
                    transport = DirectTransport(authority.binding["endpoint"], CREDS, backend=BoundaryBackend())
                    tx = None
                    try:
                        transport.connect()
                        self.assertFalse(transport.backend.read_only)
                        app = self.base + "/production-" + role
                        os.mkdir(app, 0o700)
                        tx = Transaction(transport, authority.binding,
                                         dict(operationId=str(uuid4()), deviceId=str(uuid4()), kind="publish"), app)
                        self.assertEqual(b"".join(transport.stream("objects/" + audio_name, len(audio))), audio)
                        tx.checkpoint()
                        authority.check()
                        for access in ("write", "delete"):
                            with self.assertRaises(SmbError) as caught:
                                transport.backend.open(authority.binding["endpoint"]["folder"], directory=True, access=access)
                            self.assertEqual(caught.exception.code, "destination-busy")
                        with self.assertRaises(BlockingIOError):
                            with Authority(startup, backend_factory=BoundaryBackend): pass
                        tx.close()
                        authority.check()
                    finally:
                        if tx is not None and not tx.closed: tx.abort()
                        transport.close()
                with open(receipt_path, "rb") as file: self.assertEqual(file.read(), original)
                self.assertTrue(all(handle.closed for handle in registry))
        self.assertFalse(any(event[0] == "open" and event[2] == 0x02000000 for event in events))
