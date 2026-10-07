"""Read-only original ownership lifetime. Artifact I/O stays in production providers."""
import json
import time
import select
from acceptance import (Ownership, LocalChain, read_receipt, public_spec,
                        observe_parent, child_transport, verified_binding)
from protocol import SmbError, exact, duplicate_free, read_frame, emit
from transport import DirectTransport


def validate_startup(startup):
    spec = public_spec(startup["spec"])
    role = startup["role"]
    if (role not in ("creator", "participant") or
        startup["selectedScope"] != ("parent" if role == "creator" else "child") or
        startup["binding"]["endpoint"] != startup["endpoint"] or
        (role == "participant" and startup["endpoint"]["folder"].split("/")[-1] != spec["child"])):
        raise SmbError("invalid-input")


class Authority:
    def __init__(self, startup, backend_factory=None):
        self.owner = self.parent = self.child = None
        try:
            validate_startup(startup)
            self.startup = startup
            self.spec = public_spec(startup["spec"])
            chain = LocalChain(startup["workspace"]["path"] + "/acceptance")
            try:
                chain.private()
                prior = read_receipt(chain.fd)  # Reviewed original-FD schema-v2 parser.
            finally:
                chain.close()
            self.owner = Ownership(startup["workspace"], self.spec, startup["binding"],
                                   prior.get("parent"), startup["role"], existing_only=True)
            self.owner.check()  # physical origin before authentication
            self.parent = DirectTransport(startup["endpoint"], startup["credentials"],
                                          backend=backend_factory() if backend_factory else None)
            observed = observe_parent(self.parent, startup["binding"]["identity"])
            if observed != self.owner.data["parent"]:
                raise SmbError("identity-changed")
            self.child = (child_transport(self.parent, self.spec["child"], False, self.owner.check)
                          if startup["role"] == "creator" else self.parent)
            self.binding = verified_binding(self.owner.files.fd, "child-binding", self.owner.data["childFile"])
            self.check()
        except BaseException:
            self.close()
            raise

    def check(self):
        if self.owner is None or self.child is None:
            raise SmbError("recovery-required")
        self.owner.check()
        self.parent.revalidate()
        self.child.revalidate()
        if (self.child.identity != self.owner.data["child"] or
            self.binding["identity"] != self.child.identity or
            self.binding["endpoint"] != self.child.endpoint or
            self.binding["connectionGeneration"] != self.owner.data["childGeneration"] or
            self.binding["destinationId"] != self.spec["destinationId"]):
            raise SmbError("identity-changed")
        header = json.loads(b"".join(self.child.stream("heed-library.json", 4096)), object_pairs_hook=duplicate_free)
        if (set(header) != {"format", "schemaVersion", "destinationId"} or
            header["format"] != "heed-portable-library" or type(header["schemaVersion"]) is not int or
            header["schemaVersion"] != 3 or header["destinationId"] != self.spec["destinationId"]):
            raise SmbError("unsupported-destination")
        self.owner.check()

    def close(self):
        try:
            if self.parent is not None:
                self.parent.close()
        finally:
            self.parent = self.child = None
            if self.owner is not None:
                self.owner.close()
                self.owner = None

    def __enter__(self): return self
    def __exit__(self, *_): self.close()


def serve_authority(startup, source, sink, backend_factory=None):
    deadline = time.monotonic() + 120
    with Authority(startup, backend_factory) as authority:
        emit(sink, dict(ok=True, value=dict(role=startup["role"], binding=authority.binding,
                                           generation=authority.binding["connectionGeneration"])))
        for sequence in range(1, 514):
            control_deadline = min(deadline, time.monotonic() + 30)
            remaining = control_deadline - time.monotonic()
            if remaining <= 0: raise SmbError("transport-unavailable")
            # Real pipes read one byte after readiness, avoiding buffered read-ahead blocking.
            try: fd = source.fileno()
            except (AttributeError, OSError): fd = None
            if fd is not None:
                import os
                data = bytearray()
                while len(data) <= 4096:
                    timeout = control_deadline - time.monotonic()
                    if timeout <= 0 or not select.select([fd], [], [], timeout)[0]:
                        raise SmbError("transport-unavailable")
                    byte = os.read(fd, 1)
                    if not byte: return
                    data += byte
                    if byte == b"\n": break
                import io
                request = read_frame(io.BytesIO(data), 4096)
            else:
                if hasattr(source, "peek") and not source.peek(1): return
                request = read_frame(source, 4096)
            exact(request, ("sequence", "action"))
            if type(request["sequence"]) is not int or request["sequence"] != sequence:
                raise SmbError("invalid-protocol")
            if request["action"] == "close":
                emit(sink, dict(sequence=sequence, ok=True))
                return
            if request["action"] != "check" or sequence > 512:
                raise SmbError("invalid-protocol")
            authority.check()
            emit(sink, dict(sequence=sequence, ok=True))
