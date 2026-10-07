"""Safety boundary tests use handle-oriented server doubles; no SMB network effects."""

import copy
import io
import json
import unittest
from types import SimpleNamespace

try:
    from transport import DirectTransport, SmbProtocolBackend, protected_connection_type
    from protocol import (
        SmbError,
        read_frame,
        validate_endpoint,
        validate_credentials,
        validate_rpc,
    )
    from identity import validate_identity
    from guardian import serve
except ModuleNotFoundError:
    DirectTransport = None

ENDPOINT = dict(
    server="nas.local",
    port=445,
    share="meetings",
    folder="Heed/library",
    requireEncryption=False,
)
CREDS = dict(username="reviewer", password="secret-never-log", domain="")
IDENTITY = dict(
    serverGuid="0123456789abcdef0123456789abcdef",
    volumeSerial="00000001",
    volumeCreated="01db000000000001",
    rootId="0000000000000010",
    rootCreated="01db000000000002",
)
DEST = "22222222-2222-4222-8222-222222222222"


class HandleServer:
    def __init__(self):
        self.security = dict(dialect="3.1.1", authenticated=True, signed=True, encrypted=False)
        self.server_guid = IDENTITY["serverGuid"]
        self.share_safe = True
        self.read_only = False
        self.enforces_sharing = True
        self.entries = []
        self.files = {}
        self.opened = []
        self.closed = []
        self.created = []
        self.changed = None
        self.unsafe = None

    def connect(self, endpoint, credentials):
        return self.security

    def root_access(self, path):
        return dict(
            readOnly=self.read_only,
            metadata=self.metadata(SimpleNamespace(path=path, directory=True)),
        )

    def open(self, path, directory=False, access="read", exclusive=False):
        if path == self.unsafe:
            raise SmbError("access-denied")
        h = SimpleNamespace(path=path, directory=directory, access=access, closed=False)
        self.opened.append(h)
        return h

    def metadata(self, handle):
        value = dict(
            objectId={
                "": "0000000000000001",
                "Heed": "0000000000000002",
                "Heed/library": "0000000000000010",
                "Heed/library/objects": "0000000000000003",
                "Heed/library/heed-library.json": "0000000000000020",
                "Heed/library/objects/abc": "0000000000000021",
            }.get(handle.path, "0000000000000030"),
            created=IDENTITY["rootCreated"],
            volumeSerial=IDENTITY["volumeSerial"],
            volumeCreated=IDENTITY["volumeCreated"],
            directory=handle.directory,
            reparse=False,
            deletePending=False,
            links=1,
            bytes=len(self.files.get(handle.path, b"")),
        )
        if self.changed and handle.path == ENDPOINT["folder"]:
            value.update(self.changed)
        return value

    def enforce_sharing(self, handle):
        return self.enforces_sharing

    def list(self, handle, limit):
        return iter(self.entries)

    def read(self, handle, offset, size):
        return self.files[handle.path][offset : offset + size]

    def exclusive_create(self, path, data):
        if path in self.files:
            raise SmbError("destination-exists")
        self.created.append(path)
        self.files[path] = data
        self.entries.append(path.rsplit("/", 1)[-1])
        return self.open(path)

    def flush(self, handle):
        return None

    def close_handle(self, handle):
        handle.closed = True
        self.closed.append(handle.path)

    def close(self):
        for h in self.opened:
            if not h.closed:
                self.close_handle(h)


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(DirectTransport, "direct authenticated transport is not implemented")
        self.server = HandleServer()

    def transport(self):
        return DirectTransport(ENDPOINT, CREDS, backend=self.server)

    def test_endpoint_aliases_are_canonical_and_paths_are_unambiguous(self):
        self.assertEqual(
            validate_endpoint(dict(ENDPOINT, server="NAS.Local."))["server"], "nas.local"
        )
        self.assertEqual(
            validate_endpoint(dict(ENDPOINT, server="bücher.example"))["server"],
            "xn--bcher-kva.example",
        )
        for field, values in [
            (
                "server",
                [
                    "smb://u:p@nas/share",
                    "nas:445",
                    "nas\n.local",
                    "127.00.0.1",
                    "0x7f000001",
                    "127.1",
                    "0177.0.0.1",
                ],
            ),
            ("folder", ["../x", "x/../y", "x//y", "x%2fy", "x\\y", "x.", "CON"]),
        ]:
            for value in values:
                with self.subTest(value=value), self.assertRaises(SmbError):
                    validate_endpoint(dict(ENDPOINT, **{field: value}))
        for port in (139, 5001, 48445):
            with self.assertRaises(SmbError):
                validate_endpoint(dict(ENDPOINT, port=port))
        self.assertEqual(
            validate_endpoint(dict(ENDPOINT, server="localhost", port=48445))["port"], 48445
        )
        with self.assertRaises(SmbError):
            validate_credentials(dict(CREDS, password="secret\0"))
        with self.assertRaises(SmbError):
            validate_credentials(dict(CREDS, password="bad\ud800"))

    def test_authenticated_signed_and_encrypted_sessions_are_accepted(self):
        self.assertEqual(self.transport().probe()["identity"], IDENTITY)
        self.server.security.update(signed=False, encrypted=True)
        self.assertEqual(self.transport().probe()["security"], "encrypted")

    def test_guest_null_smb2_and_unknown_security_are_rejected_before_handles(self):
        for change in [
            dict(authenticated=False),
            dict(dialect="2.1"),
            dict(signed=False, encrypted=False),
        ]:
            self.server = HandleServer()
            self.server.security.update(change)
            with self.subTest(change=change), self.assertRaises(SmbError):
                self.transport().probe()
            self.assertEqual(self.server.opened, [])

    def test_root_access_observation_is_tied_to_pinned_identity(self):
        original = self.server.root_access

        def replaced(path):
            value = original(path)
            self.server.changed = dict(created="01db000000000003")
            return value

        self.server.root_access = replaced
        with self.assertRaises(SmbError):
            self.transport().probe()
        self.assertEqual(self.server.created, [])

    def test_read_only_access_is_reported_and_refuses_initialization(self):
        self.server.read_only = True
        t = self.transport()
        self.assertTrue(t.probe()["readOnly"])
        with self.assertRaises(SmbError):
            t.initialize(IDENTITY, DEST)
        self.assertEqual(self.server.created, [])

    def test_complete_identity_mismatch_preserves_folder(self):
        for field in IDENTITY:
            wrong = dict(IDENTITY)
            wrong[field] = "00000002" if field == "volumeSerial" else ("1" * len(wrong[field]))
            with self.subTest(field=field), self.assertRaises(SmbError):
                self.transport().probe(wrong)
            self.assertEqual(self.server.created, [])

    def test_dfs_reparse_multilink_and_unenforced_namespace_are_rejected(self):
        for change in [
            dict(reparse=True),
            dict(deletePending=True),
            dict(links=2),
            dict(objectId="0000000000000000"),
            dict(created="ffffffffffffffff"),
            dict(created="fffffffffffffffe"),
        ]:
            self.server = HandleServer()
            self.server.changed = change
            with self.subTest(change=change), self.assertRaises(SmbError):
                self.transport().probe()
        for field in ["share_safe", "enforces_sharing"]:
            self.server = HandleServer()
            setattr(self.server, field, False)
            with self.assertRaises(SmbError):
                self.transport().probe()

    def test_repeated_object_identity_for_different_paths_is_refused(self):
        original = self.server.metadata

        def alias(handle):
            value = original(handle)
            if handle.path == "Heed":
                value["objectId"] = "0000000000000010"
            return value

        self.server.metadata = alias
        with self.assertRaises(SmbError) as caught:
            self.transport().probe()
        self.assertEqual(caught.exception.code, "unsupported-identity")
        self.assertEqual(self.server.created, [])

    def test_every_ancestor_is_pinned_and_denied_ancestor_refuses_reads(self):
        t = self.transport()
        t.probe()
        self.assertEqual([h.path for h in self.server.opened], ["", "Heed", "Heed/library"])
        self.server.unsafe = "Heed"
        with self.assertRaises(SmbError):
            self.transport().probe()
        t.close()
        self.assertTrue(all(h.closed for h in self.server.opened))

    def test_bounded_listing_and_denied_reads_refuse_initialization(self):
        self.server.entries = [f"entry{i}" for i in range(10001)]
        with self.assertRaises(SmbError):
            self.transport().probe()
        self.server.entries = ["heed-library.json"]
        self.server.unsafe = "Heed/library/heed-library.json"
        with self.assertRaises(SmbError):
            self.transport().probe()
        self.assertEqual(self.server.created, [])

    def test_initialize_is_exclusive_and_does_not_replace_existing_headers(self):
        t = self.transport()
        p = t.initialize(IDENTITY, DEST)
        self.assertEqual(p["destinationVersion"], 3)
        self.assertEqual(
            json.loads(self.server.files["Heed/library/heed-library.json"]),
            dict(format="heed-portable-library", schemaVersion=3, destinationId=DEST),
        )
        before = copy.deepcopy(self.server.files)
        with self.assertRaises(SmbError):
            t.initialize(IDENTITY, DEST)
        self.assertEqual(self.server.files, before)

    def test_initialize_revalidates_birth_before_exclusive_create(self):
        t = self.transport()
        t.probe()
        self.server.changed = dict(created="01db000000000003")
        with self.assertRaises(SmbError):
            t.initialize(IDENTITY, DEST)
        self.assertEqual(self.server.created, [])

    def test_initialize_revalidates_after_empty_listing_before_create(self):
        server = self.server
        calls = 0

        def listing(handle, limit):
            nonlocal calls
            calls += 1
            if calls == 2:
                server.changed = dict(created="01db000000000003")
            return iter([])

        server.list = listing
        with self.assertRaises(SmbError):
            self.transport().initialize(IDENTITY, DEST)
        self.assertEqual(server.created, [])

    def test_extra_startup_data_has_no_remote_effects(self):
        output = io.BytesIO()
        startup = dict(
            protocol=1,
            action="initialize",
            endpoint=ENDPOINT,
            credentials=CREDS,
            identity=IDENTITY,
            destinationId=DEST,
        )
        serve(
            io.BytesIO((json.dumps(startup) + "\n{}\n").encode()),
            output,
            backend_factory=lambda: self.server,
        )
        self.assertEqual(json.loads(output.getvalue()), dict(ok=False, error="invalid-protocol"))
        self.assertEqual(self.server.created, [])

    def test_unknown_headers_and_legacy_versions_are_preserved(self):
        for version in [1, 2, 4]:
            self.server = HandleServer()
            self.server.entries = ["heed-library.json"]
            self.server.files["Heed/library/heed-library.json"] = json.dumps(
                dict(format="heed-portable-library", schemaVersion=version, destinationId=DEST)
            ).encode()
            with self.assertRaises(SmbError):
                self.transport().probe()
            self.assertEqual(self.server.created, [])

    def test_read_pins_parents_and_bounds_bytes(self):
        t = self.transport()
        t.probe()
        self.server.files["Heed/library/objects/abc"] = b"abc"
        self.assertEqual(b"".join(t.stream("objects/abc", 3)), b"abc")
        with self.assertRaises(SmbError):
            b"".join(t.stream("objects/abc", 2))
        self.assertIn("Heed/library/objects", [h.path for h in self.server.opened])

    def test_malformed_extra_and_oversized_frames_refuse_effects(self):
        for data in [b'{"a":1,"a":2}\n', b"x" * 65537 + b"\n", b"{}", b"{}\r\n"]:
            with self.subTest(data=data[:32]), self.assertRaises(SmbError):
                read_frame(io.BytesIO(data))
        for value in [
            dict(id=1, action="read", path="../x", maxBytes=1),
            dict(
                id=1, action="write", path="objects/a", bytes=3, sha256="0" * 64, credentials=CREDS
            ),
            dict(id=1, action="read", path="objects/a", maxBytes=1, extra=True),
        ]:
            with self.assertRaises(SmbError):
                validate_rpc(value, 1)

    def test_rpc_correlation_is_required_and_exact(self):
        valid = dict(id=1, nonce="a" * 64, action="list", path="")
        self.assertEqual(validate_rpc(valid, 1), valid)
        for change in (
            dict(nonce=None),
            dict(nonce="a" * 63),
            dict(nonce="A" * 64),
            dict(nonce="secret\n"),
            dict(id=2),
            dict(extra=True),
        ):
            with self.subTest(change=change), self.assertRaises(SmbError):
                validate_rpc(dict(valid, **change), 1)
        missing = dict(valid)
        del missing["nonce"]
        with self.assertRaises(SmbError):
            validate_rpc(missing, 1)

    def guardian_read(self, requests):
        # Whole-operation read transactions now need a private physical owner
        # and a namespace-capable server. The protocol assertions stay unchanged.
        import tempfile
        from pathlib import Path
        from unittest.mock import patch
        from test_transaction import MemoryServer, ENDPOINT as endpoint, PHYSICAL

        server = MemoryServer()
        server.add("library/objects", directory=True)
        server.add("library/objects/abc", b"abc")
        identity = dict(
            IDENTITY,
            rootId="0000000000000002",
            rootCreated="01db000000000001",
            volumeCreated="01db000000000002",
        )
        binding = dict(
            endpoint=endpoint,
            identity=identity,
            destinationId=DEST,
            destinationVersion=3,
            readOnly=False,
            security="signed",
            id="11111111-1111-4111-8111-111111111111",
            name="Test",
            connectionGeneration="33333333-3333-4333-8333-333333333333",
            credentialRef="44444444-4444-4444-8444-444444444444",
        )
        with tempfile.TemporaryDirectory() as app, patch(
            "journal.physical_uuid", return_value=PHYSICAL
        ):
            startup = dict(
                protocol=1,
                action="transaction",
                endpoint=endpoint,
                credentials=CREDS,
                binding=binding,
                context=dict(operationId=DEST, deviceId=DEST, kind="read"),
                appDir=str(Path(app).resolve()),
            )
            data = json.dumps(startup).encode() + b"\n"
            for request in requests:
                data += (
                    request if isinstance(request, bytes) else json.dumps(request).encode() + b"\n"
                )
            output = io.BytesIO()
            serve(io.BytesIO(data), output, backend_factory=lambda: server)
        return io.BytesIO(output.getvalue())

    def test_guardian_echoes_only_current_request_nonce_on_all_frames(self):
        source = self.guardian_read(
            [
                dict(id=1, nonce="a" * 64, action="read", path="objects/abc", maxBytes=3),
                dict(id=2, nonce="b" * 64, action="list", path=""),
                dict(id=3, nonce="c" * 64, action="checkpoint"),
                dict(id=4, nonce="d" * 64, action="close"),
            ]
        )
        self.assertTrue(read_frame(source)["ready"])
        self.assertEqual(read_frame(source), dict(id=1, nonce="a" * 64, bytes=3))
        self.assertEqual(source.read(3), b"abc")
        for sequence, nonce in enumerate("abcd", 1):
            response = read_frame(source)
            self.assertEqual((response["id"], response["nonce"]), (sequence, nonce * 64))
            self.assertTrue(response["ok"])
        self.assertEqual(source.read(), b"")
        self.assertEqual(self.server.created, [])
        source = self.guardian_read([dict(id=1, nonce="e" * 64, action="remove-exact")])
        read_frame(source)
        self.assertEqual(
            read_frame(source),
            dict(id=1, nonce="e" * 64, ok=False, error="invalid-input"),
        )

    def test_malformed_later_request_never_reuses_previous_correlation(self):
        source = self.guardian_read([dict(id=1, nonce="a" * 64, action="checkpoint"), b"{\n"])
        read_frame(source)
        self.assertEqual(read_frame(source)["nonce"], "a" * 64)
        self.assertEqual(
            read_frame(source), dict(id=2, nonce=None, ok=False, error="invalid-protocol")
        )
        self.assertEqual(self.server.created, [])

    def test_guardian_sanitizes_sdk_exception_and_requires_original_app_directory(self):
        class Broken(HandleServer):
            def connect(self, *args):
                raise RuntimeError("password secret-never-log server private-path")

        output = io.BytesIO()
        serve(
            io.BytesIO(
                (
                    json.dumps(
                        dict(
                            protocol=1,
                            action="probe",
                            endpoint=ENDPOINT,
                            credentials=CREDS,
                        )
                    )
                    + "\n"
                ).encode()
            ),
            output,
            backend_factory=lambda: Broken(),
        )
        self.assertEqual(
            json.loads(output.getvalue()), dict(ok=False, error="transport-unavailable")
        )
        output = io.BytesIO()
        binding = dict(
            endpoint=ENDPOINT,
            identity=IDENTITY,
            destinationId=DEST,
            destinationVersion=3,
            readOnly=False,
            security="signed",
            id="11111111-1111-4111-8111-111111111111",
            name="Test",
            connectionGeneration="33333333-3333-4333-8333-333333333333",
            credentialRef="44444444-4444-4444-8444-444444444444",
        )
        startup = dict(
            protocol=1,
            action="transaction",
            endpoint=ENDPOINT,
            credentials=CREDS,
            binding=binding,
            context=dict(operationId=DEST, deviceId=DEST, kind="publish"),
            appDir="/private/tmp/task1",
        )
        serve(
            io.BytesIO(
                (
                    json.dumps(startup)
                    + "\n"
                    + json.dumps(
                        dict(
                            id=1,
                            action="write",
                            path="objects/abc",
                            bytes=0,
                            sha256="0" * 64,
                        )
                    )
                    + "\n"
                ).encode()
            ),
            output,
            backend_factory=lambda: self.server,
        )
        self.assertIn(b"transport-unavailable", output.getvalue())
        self.assertEqual(self.server.created, [])


class SdkBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(DirectTransport, "direct transport is not implemented")
        try:
            import smbprotocol
        except ImportError:
            self.skipTest("pinned SDK boundary tests require the private development venv")

    def worker_response(
        self,
        expected,
        actual,
        *,
        authenticated=True,
        signed=False,
        encrypted=False,
        tamper=False,
        sid=None,
        tid=None,
        encrypt_session=None,
        encrypt_tree=None,
        async_response=False,
        status=0,
        payload=None,
    ):
        """Run the real SDK worker on a single in-memory server packet."""
        import logging
        import struct
        from collections import deque
        from smbprotocol.connection import Request, SMB2TransformHeader, SMB2NegotiateResponse
        from smbprotocol.session import SMB2SessionSetupResponse
        from smbprotocol.exceptions import SMB2ErrorResponse
        from smbprotocol.tree import SMB2TreeConnectResponse
        from smbprotocol.open import SMB2QueryInfoRequest, SMB2QueryInfoResponse
        from smbprotocol.header import SMB2HeaderRequest, SMB2HeaderResponse, Commands, Smb2Flags
        from cryptography.hazmat.primitives.cmac import CMAC
        from cryptography.hazmat.primitives.ciphers import algorithms
        from cryptography.hazmat.primitives.ciphers.aead import AESCCM
        from uuid import UUID

        key = b"k" * 16
        c = protected_connection_type()(UUID(int=1), "nas.local", require_signing=True)
        c.dialect = 0x300
        request_header = SMB2HeaderRequest()
        request_header["command"] = expected
        request_header["message_id"] = 7
        request_sid = 1 if authenticated else 0
        request_tid = 2 if authenticated and expected != Commands.SMB2_TREE_CONNECT else 0
        request_header["session_id"] = request_sid
        request_header["tree_id"] = request_tid
        request = Request(
            request_header,
            SMB2QueryInfoRequest,
            c,
            session_id=(
                None if not authenticated and expected == Commands.SMB2_NEGOTIATE else request_sid
            ),
        )
        c.outstanding_requests[7] = request
        c.preauth_integrity_session_hash_value[7] = []
        if authenticated:
            c.session_table[1] = SimpleNamespace(
                session_id=1,
                session_key=key,
                signing_key=key,
                signing_required=not encrypted,
                encrypt_data=encrypted if encrypt_session is None else encrypt_session,
                encryption_key=key,
                decryption_key=key,
                tree_connect_table={
                    2: SimpleNamespace(
                        encrypt_data=encrypted if encrypt_tree is None else encrypt_tree
                    )
                },
            )
        header = SMB2HeaderResponse()
        header["command"] = actual
        header["status"] = status
        header["message_id"] = 7
        header["session_id"] = (
            sid
            if sid is not None
            else (1 if authenticated or expected == Commands.SMB2_SESSION_SETUP else 0)
        )
        header["tree_id"] = tid if tid is not None else request_tid
        header["flags"].set_flag(Smb2Flags.SMB2_FLAGS_SERVER_TO_REDIR)
        if async_response:
            header["flags"].set_flag(Smb2Flags.SMB2_FLAGS_ASYNC_COMMAND)
            header["reserved"] = 7
            header["tree_id"] = 0
        if payload is not None:
            pass
        elif status and status != 0xC0000016:
            payload = SMB2ErrorResponse()
        elif expected == Commands.SMB2_NEGOTIATE:
            payload = SMB2NegotiateResponse()
        elif expected == Commands.SMB2_SESSION_SETUP:
            payload = SMB2SessionSetupResponse()
            if status == 0xC0000016:
                payload["buffer"] = b"challenge"
        elif expected == Commands.SMB2_TREE_CONNECT:
            payload = SMB2TreeConnectResponse()
        else:
            payload = SMB2QueryInfoResponse()
            payload["buffer"] = struct.pack("<Q", 12345)
        header["data"] = payload.pack()
        if signed:
            header["flags"].set_flag(Smb2Flags.SMB2_FLAGS_SIGNED)
            signer = CMAC(algorithms.AES(key))
            signer.update(header.pack())
            header["signature"] = signer.finalize()
        packet = header.pack()
        if encrypted:
            transform = SMB2TransformHeader()
            transform["original_message_size"] = len(packet)
            transform["session_id"] = 1
            nonce = b"n" * 11
            transform["nonce"] = nonce + b"\x00" * 5
            sealed = AESCCM(key).encrypt(nonce, packet, transform.pack()[20:52])
            transform["signature"] = sealed[-16:]
            transform["data"] = sealed[:-16]
            packet = transform.pack()
        if tamper:
            packet = packet[:-1] + bytes([packet[-1] ^ 1])

        class MemoryTransport:
            connected = True

            def __init__(self):
                self.packets = deque([packet, b""])

            def recv(self, timeout):
                return self.packets.popleft()

            def close(self):
                self.connected = False

        c.transport = MemoryTransport()
        prior = logging.root.manager.disable
        logging.disable(logging.CRITICAL)
        try:
            c._process_message_thread()
        finally:
            logging.disable(prior)
        return c, request, c.receive(request)

    def test_async_encrypted_association_without_public_request_proof_is_refused(self):
        from smbprotocol.header import Commands

        with self.assertRaises(SmbError):
            self.worker_response(
                Commands.SMB2_QUERY_INFO,
                Commands.SMB2_QUERY_INFO,
                encrypted=True,
                async_response=True,
            )

    def test_tree_connect_may_assign_a_tree_only_to_its_actual_request(self):
        from smbprotocol.header import Commands

        for protection in (dict(signed=True), dict(encrypted=True)):
            c, request, response = self.worker_response(
                Commands.SMB2_TREE_CONNECT, Commands.SMB2_TREE_CONNECT, tid=2, **protection
            )
            self.assertEqual(response["tree_id"].get_value(), 2)

    def test_worker_rejects_handshake_relabeling_of_authenticated_query(self):
        from smbprotocol.header import Commands

        for command in (Commands.SMB2_SESSION_SETUP, Commands.SMB2_NEGOTIATE):
            with self.subTest(command=command), self.assertRaises(SmbError):
                self.worker_response(Commands.SMB2_QUERY_INFO, command)

    def test_worker_accepts_actual_preauth_handshakes_and_signed_query(self):
        from smbprotocol.header import Commands
        from smbprotocol.open import SMB2QueryInfoResponse
        import struct

        for command in (Commands.SMB2_SESSION_SETUP, Commands.SMB2_NEGOTIATE):
            c, request, response = self.worker_response(command, command, authenticated=False)
            self.assertEqual(response["command"].get_value(), command)
        c, request, response = self.worker_response(
            Commands.SMB2_QUERY_INFO, Commands.SMB2_QUERY_INFO, signed=True
        )
        value = SMB2QueryInfoResponse()
        value.unpack(response["data"].get_value())
        self.assertEqual(struct.unpack("<Q", value["buffer"].get_value())[0], 12345)

    def test_worker_rejects_signed_wrong_command_session_and_tree(self):
        from smbprotocol.header import Commands

        for fields in (
            dict(actual=Commands.SMB2_SESSION_SETUP),
            dict(actual=Commands.SMB2_NEGOTIATE),
            dict(actual=Commands.SMB2_QUERY_INFO, sid=2),
            dict(actual=Commands.SMB2_QUERY_INFO, tid=3),
        ):
            with self.subTest(fields=fields), self.assertRaises(SmbError):
                self.worker_response(Commands.SMB2_QUERY_INFO, signed=True, **fields)

    def test_worker_accepts_authenticated_encryption_and_rejects_tampering(self):
        from smbprotocol.header import Commands
        from smbprotocol.open import SMB2QueryInfoResponse
        from cryptography.exceptions import InvalidTag
        import struct

        c, request, response = self.worker_response(
            Commands.SMB2_QUERY_INFO, Commands.SMB2_QUERY_INFO, encrypted=True
        )
        value = SMB2QueryInfoResponse()
        value.unpack(response["data"].get_value())
        self.assertEqual(struct.unpack("<Q", value["buffer"].get_value())[0], 12345)
        with self.assertRaises(InvalidTag):
            self.worker_response(
                Commands.SMB2_QUERY_INFO, Commands.SMB2_QUERY_INFO, encrypted=True, tamper=True
            )

    def test_worker_rejects_wrong_encrypted_command_session_and_tree(self):
        from smbprotocol.header import Commands

        for fields in (
            dict(actual=Commands.SMB2_SESSION_SETUP),
            dict(actual=Commands.SMB2_NEGOTIATE),
            dict(actual=Commands.SMB2_QUERY_INFO, sid=2),
            dict(actual=Commands.SMB2_QUERY_INFO, tid=3),
        ):
            with self.subTest(fields=fields), self.assertRaises(SmbError):
                self.worker_response(Commands.SMB2_QUERY_INFO, encrypted=True, **fields)

    def test_encrypted_error_wrong_command_session_and_tree_are_security_refusals(self):
        from smbprotocol.header import Commands

        for fields in (
            dict(actual=Commands.SMB2_SESSION_SETUP),
            dict(actual=Commands.SMB2_CREATE, sid=2),
            dict(actual=Commands.SMB2_CREATE, tid=3),
        ):
            with self.subTest(fields=fields):
                with self.assertRaises(SmbError) as caught:
                    self.worker_response(
                        Commands.SMB2_CREATE, encrypted=True, status=0xC0000043, **fields
                    )
                self.assertEqual(caught.exception.code, "unsupported-security")

    def test_associated_encrypted_sharing_violation_remains_a_real_sdk_exception(self):
        from smbprotocol.header import Commands
        from smbprotocol.exceptions import SharingViolation

        with self.assertRaises(SharingViolation) as caught:
            self.worker_response(
                Commands.SMB2_CREATE, Commands.SMB2_CREATE, encrypted=True, status=0xC0000043
            )
        self.assertEqual(caught.exception.header["command"].get_value(), Commands.SMB2_CREATE)
        self.assertEqual(caught.exception.header["session_id"].get_value(), 1)
        self.assertEqual(caught.exception.header["tree_id"].get_value(), 2)
        self.assertEqual(caught.exception.error_details, [])

    def test_namespace_proof_accepts_only_associated_encrypted_sharing_violations(self):
        from unittest.mock import patch
        from smbprotocol.header import Commands
        from smbprotocol.open import Open

        backend = SmbProtocolBackend()
        backend.tree = SimpleNamespace(session=SimpleNamespace(connection=None))
        backend.metadata = lambda handle: dict(directory=True)
        handle = SimpleNamespace(file_name="Heed/library")
        attempts = []

        def denied(competitor, impersonation, access, *args):
            attempts.append(access)
            self.worker_response(
                Commands.SMB2_CREATE, Commands.SMB2_CREATE, encrypted=True, status=0xC0000043
            )

        with patch.object(Open, "create", denied):
            self.assertTrue(backend.enforce_sharing(handle))
        self.assertEqual(attempts, [0x82, 0x10080])

        def wrong(competitor, *args):
            self.worker_response(
                Commands.SMB2_CREATE, Commands.SMB2_CREATE, encrypted=True, status=0xC0000043, tid=3
            )

        with patch.object(Open, "create", wrong), self.assertRaises(SmbError):
            backend.enforce_sharing(handle)

    def test_legitimate_authentication_continuation_keeps_its_sdk_header_and_token(self):
        from smbprotocol.header import Commands
        from smbprotocol.exceptions import MoreProcessingRequired
        from smbprotocol.session import SMB2SessionSetupResponse

        with self.assertRaises(MoreProcessingRequired) as caught:
            self.worker_response(
                Commands.SMB2_SESSION_SETUP,
                Commands.SMB2_SESSION_SETUP,
                authenticated=False,
                status=0xC0000016,
            )
        response = SMB2SessionSetupResponse()
        response.unpack(caught.exception.header["data"].get_value())
        self.assertEqual(caught.exception.header["session_id"].get_value(), 1)
        self.assertEqual(response["buffer"].get_value(), b"challenge")

    def test_unsigned_authenticated_query_is_rejected(self):
        from smbprotocol.header import Commands

        with self.assertRaises(SmbError):
            self.worker_response(Commands.SMB2_QUERY_INFO, Commands.SMB2_QUERY_INFO)
        with self.assertRaises(SmbError):
            self.worker_response(Commands.SMB2_SESSION_SETUP, Commands.SMB2_SESSION_SETUP)

    def test_encrypted_share_rejects_plaintext_even_with_valid_session_signing(self):
        from smbprotocol.header import Commands

        with self.assertRaises(SmbError):
            self.worker_response(
                Commands.SMB2_QUERY_INFO,
                Commands.SMB2_QUERY_INFO,
                signed=True,
                encrypt_session=False,
                encrypt_tree=True,
            )
        self.worker_response(
            Commands.SMB2_QUERY_INFO,
            Commands.SMB2_QUERY_INFO,
            encrypted=True,
            encrypt_session=False,
            encrypt_tree=True,
        )

    def test_signed_plaintext_is_verified_and_tampered_data_is_rejected(self):
        from smbprotocol.header import Commands
        from smbprotocol.exceptions import SMBException

        with self.assertRaises(SMBException):
            self.worker_response(
                Commands.SMB2_QUERY_INFO, Commands.SMB2_QUERY_INFO, signed=True, tamper=True
            )

    def test_final_setup_forced_verification_requires_the_exact_received_handshake(self):
        from smbprotocol.header import Commands

        c, request, response = self.worker_response(
            Commands.SMB2_SESSION_SETUP,
            Commands.SMB2_SESSION_SETUP,
            authenticated=False,
            signed=True,
        )
        c.session_table[1] = SimpleNamespace(
            session_key=b"k" * 16, signing_key=b"k" * 16, encrypt_data=True
        )
        c.verify_signature(response, 1, force=True)
        with self.assertRaises(SmbError):
            c.verify_signature(response, 1, force=True)

    def maximal_access_backend(self, values, *, tamper=False, signed=True, actual=None, sid=None, tid=None):
        from unittest.mock import patch
        from smbprotocol.header import Commands
        from smbprotocol.open import Open, SMB2CreateResponse, SMB2CreateRequest
        from smbprotocol.create_contexts import SMB2CreateContextRequest

        payload = SMB2CreateResponse()
        payload["file_id"] = b"m" * 16
        if values:
            payload["buffer"] = SMB2CreateContextRequest.pack_multiple(values)
        captured, closed = [], []
        connection = SimpleNamespace(dialect=0x300)
        session = SimpleNamespace(connection=connection, username="public fixture", session_id=1, open_table={})
        tree = SimpleNamespace(session=session, share_name="public fixture", tree_connect_id=2)
        backend = SmbProtocolBackend()
        backend.tree = tree
        backend.metadata = lambda h: dict(
            objectId="0000000000000010", created="01db000000000002", volumeSerial="00000001",
            volumeCreated="01db000000000001", directory=True, reparse=False, deletePending=False, links=1, bytes=0,
        )

        def sent(message, *args, **kwargs):
            wire = SMB2CreateRequest()
            wire.unpack(message.pack())
            captured.append(wire)
            _, request, response = self.worker_response(
                Commands.SMB2_CREATE, actual if actual is not None else Commands.SMB2_CREATE,
                payload=payload, signed=signed, tamper=tamper, sid=sid, tid=tid,
            )
            connection.response = response
            return request

        connection.send = sent
        connection.receive = lambda *_: connection.response
        def close(handle):
            closed.append(handle.file_id)
            session.open_table.pop(handle.file_id, None)
            handle._connected = False
        return backend, captured, closed, patch.object(Open, "close", close)

    def maximal_context(self, rights=0x7, status=0, name=b"MxAc"):
        from smbprotocol.create_contexts import SMB2CreateContextRequest, SMB2CreateQueryMaximalAccessResponse
        value = SMB2CreateQueryMaximalAccessResponse()
        value["query_status"], value["maximal_access"] = status, rights
        context = SMB2CreateContextRequest()
        context["buffer_name"], context["buffer_data"] = name, value.pack()
        return context

    def test_root_write_access_comes_from_current_read_only_mxac_create(self):
        for rights, read_only in ((0x1, True), (0x7, False)):
            with self.subTest(rights=rights):
                backend, captured, closed, closing = self.maximal_access_backend([self.maximal_context(rights)])
                with closing:
                    self.assertEqual(backend.root_access("Heed/library")["readOnly"], read_only)
                wire = captured[0]
                self.assertEqual(wire["desired_access"].get_value(), 0x81)
                self.assertEqual(wire["share_access"].get_value(), 0x1)
                self.assertEqual(wire["create_disposition"].get_value(), 1)
                self.assertEqual(wire["create_options"].get_value(), 0x00200001)
                self.assertEqual(wire["requested_oplock_level"].get_value(), 0)
                contexts = wire["buffer_contexts"].get_value()
                self.assertEqual(len(contexts), 1)
                self.assertEqual(contexts[0]["buffer_name"].get_value(), b"MxAc")
                self.assertEqual(contexts[0]["data_length"].get_value(), 0)
                self.assertEqual(contexts[0]["buffer_data"].get_value(), b"")
                self.assertEqual(closed, [b"m" * 16])
                self.assertEqual(backend.handles, [])

    def test_invalid_maximal_response_refuses_and_closes_its_opened_handle(self):
        malformed = self.maximal_context()
        malformed["buffer_data"] = b"bad"
        cases = ([], [malformed], [self.maximal_context(name=b"bad!")],
                 [self.maximal_context(), self.maximal_context()],
                 [self.maximal_context(status=0xC0000073)])
        for values in cases:
            with self.subTest(contexts=len(values)):
                backend, _, closed, closing = self.maximal_access_backend(values)
                with closing, self.assertRaises(SmbError) as caught:
                    backend.root_access("Heed/library")
                self.assertEqual(caught.exception.code, "unsupported-namespace")
                self.assertEqual(closed, [b"m" * 16])
                self.assertEqual(backend.handles, [])

    def test_maximal_response_requires_actual_signed_associated_untampered_create(self):
        from smbprotocol.header import Commands
        from smbprotocol.exceptions import SMBException
        for fields in (dict(tamper=True), dict(signed=False), dict(actual=Commands.SMB2_QUERY_INFO), dict(sid=2), dict(tid=3)):
            with self.subTest(fields=fields):
                backend, _, closed, closing = self.maximal_access_backend([self.maximal_context()], **fields)
                with closing, self.assertRaises((SmbError, SMBException)) as caught:
                    backend.root_access("Heed/library")
                if isinstance(caught.exception, SmbError):
                    self.assertEqual(caught.exception.code, "unsupported-security")
                else:
                    self.assertTrue(fields.get("tamper"))
                self.assertEqual(closed, [])
                self.assertEqual(backend.handles, [])

    def test_unsupported_identity_query_is_a_typed_refusal(self):
        from smbprotocol.open import SMB2QueryInfoResponse
        from smbprotocol.exceptions import InvalidInfoClass
        from smbprotocol.header import SMB2HeaderResponse
        from smbprotocol.file_info import FileInternalInformation

        backend = SmbProtocolBackend()
        h = SMB2HeaderResponse()
        h["status"] = 0xC0000003
        backend.connection = SimpleNamespace(
            send=lambda *a, **k: None,
            receive=lambda *a, **k: (_ for _ in ()).throw(InvalidInfoClass(h)),
        )
        backend.session = SimpleNamespace(session_id=1)
        backend.tree = SimpleNamespace(tree_connect_id=2)
        with self.assertRaises(SmbError) as caught:
            backend.query(SimpleNamespace(file_id=b"x" * 16), FileInternalInformation)
        self.assertEqual(caught.exception.code, "unsupported-identity")

    def test_public_receive_disables_symlink_resolution(self):
        from unittest.mock import patch
        from smbprotocol.connection import Connection
        from smbprotocol.header import SMB2HeaderRequest, SMB2HeaderResponse, Commands, Smb2Flags
        from smbprotocol.connection import Request
        from smbprotocol.open import SMB2QueryInfoRequest
        from uuid import UUID

        h = SMB2HeaderResponse()
        h["command"] = Commands.SMB2_NEGOTIATE
        h["flags"].set_flag(Smb2Flags.SMB2_FLAGS_SERVER_TO_REDIR)
        expected = SMB2HeaderRequest()
        expected["command"] = Commands.SMB2_NEGOTIATE
        request = Request(expected, SMB2QueryInfoRequest, None, session_id=0)
        observed = []

        def received(connection, request, **kwargs):
            observed.append(kwargs)
            return h

        with patch.object(Connection, "receive", received):
            protected_connection_type()(UUID(int=1), "nas.local").receive(
                request, resolve_symlinks=True
            )
        self.assertFalse(observed[0]["resolve_symlinks"])
        self.assertEqual(observed[0]["timeout"], 30)

    def test_identity_queries_use_real_sdk_wire_structures_and_exact_filetime(self):
        import struct
        from smbprotocol.open import SMB2QueryInfoResponse
        from smbprotocol.header import SMB2HeaderResponse, Commands

        backend = SmbProtocolBackend()
        sent = []
        payloads = {
            (1, 6): struct.pack("<Q", 16),
            (1, 4): struct.pack("<QQQQII", 0x01DB000000000002, 0, 0, 0, 16, 0),
            (1, 5): struct.pack("<qqI??H", 0, 0, 1, False, True, 0),
            (2, 1): struct.pack("<QIIBB", 0x01DB000000000001, 1, 0, 0, 0),
        }

        def send(message, **kwargs):
            sent.append((message, kwargs))
            return message

        def receive(message, **kwargs):
            result = SMB2QueryInfoResponse()
            result["buffer"] = payloads[
                (message["info_type"].get_value(), message["file_info_class"].get_value())
            ]
            header = SMB2HeaderResponse()
            header["command"] = Commands.SMB2_QUERY_INFO
            header["data"] = result.pack()
            return header

        backend.connection = SimpleNamespace(send=send, receive=receive)
        backend.session = SimpleNamespace(session_id=1)
        backend.tree = SimpleNamespace(tree_connect_id=2)
        value = backend.metadata(SimpleNamespace(file_id=b"x" * 16))
        self.assertEqual(value["objectId"], "0000000000000010")
        self.assertEqual(value["created"], "01db000000000002")
        self.assertEqual(value["volumeCreated"], "01db000000000001")
        self.assertFalse(value["deletePending"])
        self.assertTrue(
            all(message["file_id"].get_value() == b"x" * 16 for message, kwargs in sent)
        )
        self.assertEqual([kwargs for message, kwargs in sent], [dict(sid=1, tid=2)] * 4)

    def test_query_identity_uses_supported_file_and_volume_info_not_open_id(self):
        from smbprotocol.file_info import (
            FileBasicInformation,
            FileInternalInformation,
            FileStandardInformation,
            FileFsVolumeInformation,
        )

        backend = SmbProtocolBackend()
        queries = []

        def query(handle, kind):
            queries.append(kind)
            if kind is FileInternalInformation:
                return {"index_number": 16}
            if kind is FileBasicInformation:
                return {"creation_time": 0x01DB000000000002, "file_attributes": 16}
            if kind is FileStandardInformation:
                return {
                    "number_of_links": 1,
                    "directory": True,
                    "end_of_file": 0,
                    "delete_pending": False,
                }
            if kind is FileFsVolumeInformation:
                return {"volume_creation_time": 0x01DB000000000001, "volume_serial_number": 1}
            raise AssertionError("unexpected identity query")

        backend.query = query
        receipt = backend.metadata(SimpleNamespace(file_id=b"\xff" * 16))
        self.assertEqual(receipt["objectId"], "0000000000000010")
        self.assertEqual(receipt["volumeCreated"], "01db000000000001")
        self.assertEqual(len(queries), 4)


if __name__ == "__main__":
    unittest.main()
