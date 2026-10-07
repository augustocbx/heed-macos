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
