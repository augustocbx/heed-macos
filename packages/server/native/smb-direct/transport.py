"""Explicit authenticated SMB handles and stable, pinned namespace receipts."""

import json
import logging
import struct
from importlib.metadata import version
from uuid import uuid4
from protocol import (
    SmbError,
    CHUNK,
    MAX_ENTRIES,
    UUID,
    count,
    validate_endpoint,
    validate_credentials,
    validate_path,
    duplicate_free,
)
from identity import (
    validate_identity,
    stable_hex,
    receipt,
    validate_metadata,
    same_object,
)

HEADER = "heed-library.json"
MAX_HANDLES = 512


def protected_connection_type():
    """Use public SDK hooks to reject unsigned plaintext and implicit redirects."""
    from smbprotocol.connection import Connection
    from smbprotocol.exceptions import SMBResponseException
    from smbprotocol.header import Commands, Smb2Flags
    from smbprotocol.tree import SMB2TreeConnectResponse

    class ProtectedConnection(Connection):
        tree_flags = 0
        tree_access = 0

        def _bind_response(self, header, request, authenticated_setup=False):
            # Expected metadata comes from our request, never an incoming command.
            expected = request.message
            command = expected["command"].get_value()
            sid = request.session_id or 0
            tid = expected["tree_id"].get_value()
            if (
                header["message_id"].get_value() != expected["message_id"].get_value()
                or header["command"].get_value() != command
                or not header["flags"].has_flag(Smb2Flags.SMB2_FLAGS_SERVER_TO_REDIR)
            ):
                raise SmbError("unsupported-security")
            session = self.session_table.get(sid)
            authenticated = session is not None and bool(session.session_key)
            if command in (Commands.SMB2_NEGOTIATE, Commands.SMB2_SESSION_SETUP):
                if authenticated and not authenticated_setup:
                    raise SmbError("unsupported-security")
                if (
                    any(s.session_key for s in self.session_table.values())
                    and not authenticated_setup
                ):
                    raise SmbError("unsupported-security")
                if (
                    tid
                    or header["tree_id"].get_value()
                    or header["flags"].has_flag(Smb2Flags.SMB2_FLAGS_ASYNC_COMMAND)
                ):
                    raise SmbError("unsupported-security")
                if command == Commands.SMB2_NEGOTIATE:
                    if sid or header["session_id"].get_value():
                        raise SmbError("unsupported-security")
                elif sid and header["session_id"].get_value() != sid:
                    raise SmbError("unsupported-security")
            elif not authenticated or header["session_id"].get_value() != sid:
                raise SmbError("unsupported-security")
            elif header["flags"].has_flag(Smb2Flags.SMB2_FLAGS_ASYNC_COMMAND):
                # The SDK mutates Request.async_id before receive, and encrypted
                # packets bypass verify_signature. Public hooks cannot establish
                # the prior AsyncId association, so refuse this unsupported case.
                raise SmbError("unsupported-security")
            elif command != Commands.SMB2_TREE_CONNECT and header["tree_id"].get_value() != tid:
                raise SmbError("unsupported-security")
            elif command == Commands.SMB2_TREE_CONNECT and tid:
                raise SmbError("unsupported-security")
            return session, tid

        def verify_signature(self, header, session_id, force=False):
            request = self.outstanding_requests.get(header["message_id"].get_value())
            final_setup = getattr(self, "_final_setup", None)
            cached_setup = bool(force and final_setup and final_setup[0] is header)
            if request is None and cached_setup:
                request = final_setup[1]
            if request is None:
                raise SmbError("unsupported-security")
            session, tid = self._bind_response(header, request, cached_setup)
            expected_sid = request.session_id or 0
            if request.message["command"].get_value() == Commands.SMB2_SESSION_SETUP:
                expected_sid = header["session_id"].get_value()
            if cached_setup:
                expected_sid = header["session_id"].get_value()
                session = self.session_table.get(expected_sid)
                self._final_setup = None
            if (session_id or 0) != expected_sid:
                raise SmbError("unsupported-security")
            if session and session.session_key:
                tree = getattr(session, "tree_connect_table", {}).get(tid)
                if not cached_setup and (
                    session.encrypt_data is True or tree and tree.encrypt_data is True
                ):
                    raise SmbError("unsupported-security")
                if (
                    not header["flags"].has_flag(Smb2Flags.SMB2_FLAGS_SIGNED)
                    or not session.signing_key
                ):
                    raise SmbError("unsupported-security")
                force = True
            return super().verify_signature(header, expected_sid, force=force)

        def receive(self, request, wait=True, timeout=None, resolve_symlinks=False):
            try:
                response = super().receive(
                    request,
                    wait=wait,
                    timeout=30 if timeout is None else min(timeout, 30),
                    resolve_symlinks=False,
                )
            except SMBResponseException as error:
                # Encrypted errors skip the signature hook and are raised before
                # receive returns. They need the same request proof as success.
                self._bind_response(error.header, request)
                raise
            # The upstream worker skips its signature hook after authenticated
            # decryption, so validate the decrypted association before any parser.
            self._bind_response(response, request)
            if request.message["command"].get_value() == Commands.SMB2_SESSION_SETUP:
                # Session.connect verifies its final setup after receive removes
                # the request and installs keys. Only this exact receipt may do so.
                self._final_setup = (response, request)
            if response["command"].get_value() == Commands.SMB2_TREE_CONNECT:
                tree = SMB2TreeConnectResponse()
                tree.unpack(response["data"].get_value())
                self.tree_flags = tree["share_flags"].get_value()
                self.tree_access = tree["maximal_access"].get_value()
            return response

    return ProtectedConnection


class SmbProtocolBackend:
    """Low-level 1.17.0 API only; no smbclient caching, DFS or path operations."""

    def __init__(self):
        self.connection = None
        self.session = None
        self.tree = None
        self.handles = []

    def connect(self, endpoint, credentials):
        from smbprotocol.session import Session
        from smbprotocol.tree import TreeConnect

        if version("smbprotocol") != "1.17.0":
            raise SmbError("runtime-unavailable")
        logging.disable(logging.CRITICAL)
        self.connection = protected_connection_type()(
            uuid4(), endpoint["server"], port=endpoint["port"], require_signing=True
        )
        self.connection.connect(timeout=30)
        if self.connection.dialect not in (0x300, 0x302, 0x311):
            raise SmbError("unsupported-security")
        username = (credentials["domain"] + "\\" if credentials["domain"] else "") + credentials[
            "username"
        ]
        self.session = Session(
            self.connection,
            username=username,
            password=credentials["password"],
            require_encryption=endpoint["requireEncryption"],
        )
        self.session.connect()
        if not self.session.session_key or not self.session.signing_key:
            raise SmbError("unsupported-security")
        self.tree = TreeConnect(
            self.session, "\\\\" + endpoint["server"] + "\\" + endpoint["share"]
        )
        self.tree.connect(require_secure_negotiate=True)
        flags = self.connection.tree_flags
        self.share_safe = not self.tree.is_dfs_share and not flags & (1 | 2 | 0x100 | 0x200)
        encrypted = self.session.encrypt_data is True or self.tree.encrypt_data is True
        if encrypted and (not self.session.encryption_key or not self.session.decryption_key):
            raise SmbError("unsupported-security")
        self.server_guid = stable_hex(self.connection.server_guid.hex, 32)
        self.read_only = True
        return dict(
            dialect={0x300: "3.0", 0x302: "3.0.2", 0x311: "3.1.1"}[self.connection.dialect],
            authenticated=True,
            signed=self.session.signing_required is True and bool(self.session.signing_key),
            encrypted=encrypted,
        )

    def open(self, path, directory=False, access="read", exclusive=False, verification=False):
        from smbprotocol.open import (
            Open,
            ImpersonationLevel,
            CreateDisposition,
            CreateOptions,
            ShareAccess,
        )
        from smbprotocol.file_info import FileAttributes
        from smbprotocol.exceptions import (
            AccessDenied,
            ObjectNameCollision,
            ObjectNameNotFound,
            ObjectPathNotFound,
            SharingViolation,
        )

        validate_path(path, directory)
        if len(self.handles) >= MAX_HANDLES:
            raise SmbError("bounds-exceeded")
        if access not in ("read", "write", "delete", "write-delete", "maximum"):
            raise SmbError("invalid-input")
        mask = 0x80 | (0x1 if access == "read" else 0)
        if access in ("delete", "write-delete"):
            mask |= 0x10001
        if access in ("write", "write-delete"):
            mask |= 0x3
        if access == "maximum":
            mask = 0x02000000
        h = Open(self.tree, path.replace("/", "\\"))
        options = CreateOptions.FILE_OPEN_REPARSE_POINT | (
            CreateOptions.FILE_DIRECTORY_FILE
            if directory
            else CreateOptions.FILE_NON_DIRECTORY_FILE
        )
        try:
            h.create(
                ImpersonationLevel.Impersonation,
                mask,
                FileAttributes.FILE_ATTRIBUTE_NORMAL,
                (
                    7
                    if verification and access == "read" and not exclusive
                    else ShareAccess.FILE_SHARE_READ
                ),
                (CreateDisposition.FILE_CREATE if exclusive else CreateDisposition.FILE_OPEN),
                options,
            )
        except AccessDenied:
            raise SmbError("access-denied") from None
        except ObjectNameCollision:
            raise SmbError("destination-exists") from None
        except (ObjectNameNotFound, ObjectPathNotFound):
            raise FileNotFoundError() from None
        except SharingViolation:
            raise SmbError("destination-busy") from None
        self.handles.append(h)
        return h

    def root_access(self, path):
        from smbprotocol.file_info import FileAccessInformation

        # This short-lived capability handle is closed before the sole retained
        # root pin, avoiding contradictory sharing against our own WRITE access.
        h = self.open(path, directory=True, access="maximum")
        try:
            metadata = validate_metadata(self.metadata(h), True)
            access = self.query(h, FileAccessInformation)["access_flags"]
            if type(access) is not int:
                raise SmbError("unsupported-namespace")
            return dict(readOnly=(access & 0x7) != 0x7, metadata=metadata)
        finally:
            self.close_handle(h)

    def query(self, handle, kind):
        from smbprotocol.open import SMB2QueryInfoRequest, SMB2QueryInfoResponse
        from smbprotocol.file_info import FileFsVolumeInformation
        from smbprotocol.exceptions import SMBResponseException, AccessDenied

        q = SMB2QueryInfoRequest()
        q["info_type"] = kind.INFO_TYPE
        q["file_info_class"] = kind.INFO_CLASS
        q["output_buffer_length"] = 1024
        q["file_id"] = handle.file_id
        try:
            response = self.connection.receive(
                self.connection.send(q, sid=self.session.session_id, tid=self.tree.tree_connect_id),
                resolve_symlinks=False,
            )
        except AccessDenied:
            raise SmbError("access-denied") from None
        except SMBResponseException:
            raise SmbError("unsupported-identity") from None
        frame = SMB2QueryInfoResponse()
        frame.unpack(response["data"].get_value())
        data = frame["buffer"].get_value()
        parsed = kind()
        rest = parsed.unpack(data)
        if rest:
            raise SmbError("unsupported-identity")
        result = {name: parsed[name].get_value() for name in parsed.fields}
        if kind is FileFsVolumeInformation:
            result["volume_creation_time"] = struct.unpack("<Q", data[:8])[0]
        return result

    def metadata(self, handle):
        from smbprotocol.file_info import (
            FileInternalInformation,
            FileBasicInformation,
            FileStandardInformation,
            FileFsVolumeInformation,
        )

        internal = self.query(handle, FileInternalInformation)
        basic = self.query(handle, FileBasicInformation)
        standard = self.query(handle, FileStandardInformation)
        volume = self.query(handle, FileFsVolumeInformation)
        return dict(
            objectId=stable_hex(internal["index_number"], 16),
            created=stable_hex(basic["creation_time"], 16),
            volumeSerial=stable_hex(volume["volume_serial_number"], 8),
            volumeCreated=stable_hex(volume["volume_creation_time"], 16),
            directory=standard["directory"],
            reparse=bool(basic["file_attributes"] & 0x400),
            deletePending=standard["delete_pending"],
            links=standard["number_of_links"],
            bytes=standard["end_of_file"],
        )

    def enforce_sharing(self, handle):
        from smbprotocol.open import Open, ImpersonationLevel, CreateDisposition, CreateOptions
        from smbprotocol.file_info import FileAttributes
        from smbprotocol.exceptions import SharingViolation

        metadata = self.metadata(handle)
        # Require sharing violations for both conflicting access requests. An
        # access-denied result cannot prove namespace sharing enforcement.
        for mask in (0x2, 0x10000):
            competitor = Open(self.tree, handle.file_name)
            try:
                competitor.create(
                    ImpersonationLevel.Impersonation,
                    mask | 0x80,
                    FileAttributes.FILE_ATTRIBUTE_NORMAL,
                    7,
                    CreateDisposition.FILE_OPEN,
                    CreateOptions.FILE_OPEN_REPARSE_POINT | (1 if metadata["directory"] else 0x40),
                )
            except SharingViolation:
                continue
            except Exception:
                raise SmbError("unsupported-namespace") from None
            else:
                competitor.close()
                return False
        return True

    def list(self, handle, limit):
        from smbprotocol.file_info import FileInformationClass
        from smbprotocol.open import QueryDirectoryFlags
        from smbprotocol.exceptions import NoMoreFiles

        first = True
        seen = 0
        while True:
            try:
                entries = handle.query_directory(
                    "*",
                    FileInformationClass.FILE_NAMES_INFORMATION,
                    flags=QueryDirectoryFlags.SMB2_RESTART_SCANS if first else 0,
                    max_output=65536,
                )
            except NoMoreFiles:
                return
            first = False
            if not entries:
                raise SmbError("invalid-protocol")
            for entry in entries:
                name = entry["file_name"].get_value().decode("utf-16-le")
                if name in (".", ".."):
                    continue
                validate_path(name)
                seen += 1
                if seen > limit:
                    raise SmbError("bounds-exceeded")
                yield name

    def read(self, handle, offset, size):
        return handle.read(offset, size)

    def exclusive_create(self, path, data):
        h = self.open(path, access="write", exclusive=True)
        written = h.write(data, offset=0, write_through=True)
        if written != len(data):
            raise SmbError("transport-unavailable")
        return h

    def write(self, handle, data, offset):
        return handle.write(data, offset=offset, write_through=True)

    def rename(self, handle, target):
        """Network destinations are share-relative; never descriptor-relative."""
        from smbprotocol.file_info import FileRenameInformation
        from smbprotocol.open import SMB2SetInfoRequest
        from smbprotocol.exceptions import ObjectNameCollision

        validate_path(target)
        info = FileRenameInformation()
        info["replace_if_exists"] = False
        info["root_directory"] = 0
        info["file_name"] = target.replace("/", "\\").encode("utf-16-le")
        request = SMB2SetInfoRequest()
        request["info_type"] = info.INFO_TYPE
        request["file_info_class"] = info.INFO_CLASS
        request["file_id"] = handle.file_id
        request["buffer"] = info.pack()
        try:
            self.connection.receive(
                self.connection.send(
                    request, sid=self.session.session_id, tid=self.tree.tree_connect_id
                ),
                resolve_symlinks=False,
            )
        except ObjectNameCollision:
            raise SmbError("destination-exists") from None

    def disposition(self, handle):
        """Only the validated exact handle receives disposition; no path unlink fallback."""
        from smbprotocol.file_info import FileDispositionInformation
        from smbprotocol.open import SMB2SetInfoRequest
        info = FileDispositionInformation()
        info["delete_pending"] = True
        request = SMB2SetInfoRequest()
        request["info_type"] = info.INFO_TYPE
        request["file_info_class"] = info.INFO_CLASS
        request["file_id"] = handle.file_id
        request["buffer"] = info.pack()
        self.connection.receive(self.connection.send(request,sid=self.session.session_id,tid=self.tree.tree_connect_id),resolve_symlinks=False)

    def flush(self, handle):
        handle.flush()

    def close_handle(self, handle):
        handle.close()
        if handle in self.handles:
            self.handles.remove(handle)

    def close(self):
        failed = False
        for h in list(reversed(self.handles)):
            try:
                self.close_handle(h)
            except Exception:
                failed = True
        try:
            if self.session:
                self.session.disconnect(timeout=5)
        finally:
            if self.connection:
                self.connection.disconnect(close=False)
        if failed:
            raise SmbError("transport-unavailable")


class DirectTransport:
    def __init__(self, endpoint, credentials, backend=None):
        self.endpoint = validate_endpoint(endpoint)
        self.credentials = validate_credentials(credentials)
        self.backend = backend or SmbProtocolBackend()
        self.pins = []
        self.connected = False
        self.security = None
        self.identity = None

    def connect(self):
        if self.connected:
            return
        security = self.backend.connect(self.endpoint, self.credentials)
        if (
            security.get("authenticated") is not True
            or security.get("dialect") not in ("3.0", "3.0.2", "3.1.1")
            or not (security.get("signed") is True or security.get("encrypted") is True)
            or self.endpoint["requireEncryption"]
            and security.get("encrypted") is not True
        ):
            raise SmbError("unsupported-security")
        if getattr(self.backend, "share_safe", False) is not True:
            raise SmbError("unsupported-namespace")
        self.security = security
        self.connected = True
        folder = self.endpoint["folder"]
        paths = (
            [""] + ["/".join(folder.split("/")[:n]) for n in range(1, len(folder.split("/")) + 1)]
            if folder
            else [""]
        )
        observed = None
        for path in paths:
            if path == paths[-1]:
                observed = self.backend.root_access(path)
            self.pin(path, True, share_relative=True)
        if (
            not isinstance(observed, dict)
            or type(observed.get("readOnly")) is not bool
            or not same_object(validate_metadata(observed["metadata"], True), self.pins[-1][2])
        ):
            raise SmbError("identity-changed")
        self.backend.read_only = observed["readOnly"]
        self.root = self.pins[-1][1]
        self.identity = receipt(self.backend.server_guid, self.pins[-1][2])
        self.credentials = None

    def revalidate(self):
        self.connect()
        for path, h, prior in self.pins:
            now = validate_metadata(self.backend.metadata(h), prior["directory"])
            if not same_object(prior, now):
                raise SmbError("identity-changed")
        if receipt(self.backend.server_guid, self.backend.metadata(self.root)) != self.identity:
            raise SmbError("identity-changed")

    def pin(self, path, directory=False, share_relative=False):
        validate_path(path, True)
        full = path if share_relative else "/".join(p for p in (self.endpoint["folder"], path) if p)
        for prior, h, meta in self.pins:
            if prior == full:
                now = validate_metadata(self.backend.metadata(h), directory)
                if not same_object(meta, now):
                    raise SmbError("identity-changed")
                return h
        if not share_relative:
            components = path.split("/")
            for n in range(1, len(components)):
                self.pin("/".join(components[:n]), True)
        if len(self.pins) >= MAX_HANDLES:
            raise SmbError("bounds-exceeded")
        h = self.backend.open(full, directory=directory)
        try:
            metadata = validate_metadata(self.backend.metadata(h), directory)
            if self.identity and (
                metadata["volumeSerial"] != self.identity["volumeSerial"]
                or metadata["volumeCreated"] != self.identity["volumeCreated"]
            ):
                raise SmbError("identity-changed")
            if any(same_object(prior, metadata) for _, _, prior in self.pins):
                raise SmbError("unsupported-identity")
            if self.backend.enforce_sharing(h) is not True:
                raise SmbError("unsupported-namespace")
        except Exception:
            self.backend.close_handle(h)
            raise
        self.pins.append((full, h, metadata))
        return h

    def unpin(self, handle):
        # Remove only after CLOSE is acknowledged. An ambiguous close stops the
        # operation and retains private recovery authority.
        self.backend.close_handle(handle)
        self.pins = [pin for pin in self.pins if pin[1] is not handle]

    def listing(self, handle):
        result = []
        for name in self.backend.list(handle, MAX_ENTRIES):
            validate_path(name)
            if "/" in name or name in result:
                raise SmbError("unsupported-namespace")
            result.append(name)
            if len(result) > MAX_ENTRIES:
                raise SmbError("bounds-exceeded")
        return result

    def probe(self, expected=None):
        self.revalidate()
        if expected is not None and validate_identity(expected) != self.identity:
            raise SmbError("identity-changed")
        entries = self.listing(self.root)
        destination = None
        if HEADER in entries:
            data = b"".join(self.stream(HEADER, 4096))
            try:
                header = json.loads(data, object_pairs_hook=duplicate_free)
            except (ValueError, UnicodeError):
                raise SmbError("unsupported-destination") from None
            if (
                not isinstance(header, dict)
                or set(header) != set(("format", "schemaVersion", "destinationId"))
                or header["format"] != "heed-portable-library"
                or type(header["schemaVersion"]) is not int
                or header["schemaVersion"] != 3
                or not isinstance(header["destinationId"], str)
                or not UUID.fullmatch(header["destinationId"])
            ):
                raise SmbError("unsupported-destination")
            destination = header["destinationId"]
        return dict(
            identity=self.identity,
            dialect=self.security["dialect"],
            authentication="authenticated",
            security="encrypted" if self.security["encrypted"] else "signed",
            encrypted=self.security["encrypted"],
            readOnly=self.backend.read_only,
            namespaceSafe=True,
            destinationId=destination,
            destinationVersion=3 if destination else None,
            empty=not entries,
        )

    def initialize(self, expected, destination):
        validate_identity(expected)
        if not isinstance(destination, str) or not UUID.fullmatch(destination):
            raise SmbError("invalid-input")
        probe = self.probe(expected)
        if not probe["empty"]:
            raise SmbError("destination-exists")
        if probe["readOnly"]:
            raise SmbError("read-only")
        self.revalidate()
        if self.listing(self.root):
            raise SmbError("destination-exists")
        self.revalidate()
        data = json.dumps(
            dict(format="heed-portable-library", schemaVersion=3, destinationId=destination),
            separators=(",", ":"),
        ).encode()
        full = "/".join(p for p in (self.endpoint["folder"], HEADER) if p)
        handle = self.backend.exclusive_create(full, data)
        self.backend.flush(handle)
        # Release only the owned new header handle; leave any ambiguous or
        # partial allocation intact. Never remove a header on an error.
        self.backend.close_handle(handle)
        self.revalidate()
        if self.listing(self.root) != [HEADER]:
            raise SmbError("destination-exists")
        result = self.probe(expected)
        if result["destinationId"] != destination:
            raise SmbError("identity-changed")
        return result

    def stream(self, path, maximum):
        validate_path(path)
        count(maximum)
        self.revalidate()
        h = self.pin(path)
        initial = validate_metadata(self.backend.metadata(h), False)
        if initial["bytes"] > maximum:
            raise SmbError("bounds-exceeded")
        offset = 0
        while offset < initial["bytes"]:
            data = self.backend.read(h, offset, min(CHUNK, initial["bytes"] - offset))
            if (
                not isinstance(data, bytes)
                or not data
                or len(data) > min(CHUNK, initial["bytes"] - offset)
            ):
                raise SmbError("invalid-protocol")
            offset += len(data)
            yield data
        self.revalidate()
        final = self.backend.metadata(h)
        if not same_object(initial, final) or final["bytes"] != initial["bytes"]:
            raise SmbError("identity-changed")

    def close(self):
        self.backend.close()
