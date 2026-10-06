#!/usr/bin/env python3
"""Credential-on-stdin guardian. No transaction effects before coordination exists."""

import logging
import sys
from identity import validate_identity
from protocol import (
    SmbError,
    UUID,
    CHUNK,
    NONCE,
    exact,
    text,
    validate_endpoint,
    validate_credentials,
    read_frame,
    emit,
    validate_rpc,
)
from transport import DirectTransport


def validate_startup(value):
    action = value.get("action")
    fields = {
        "probe": (),
        "initialize": ("identity", "destinationId"),
        "transaction": ("binding", "context", "appDir"),
    }
    if action not in fields or type(value.get("protocol")) is not int or value["protocol"] != 1:
        raise SmbError("invalid-protocol")
    exact(value, ("protocol", "action", "endpoint", "credentials", *fields[action]))
    endpoint = validate_endpoint(value["endpoint"])
    credentials = validate_credentials(value["credentials"])
    if action == "initialize":
        validate_identity(value["identity"])
        if not isinstance(value["destinationId"], str) or not UUID.fullmatch(
            value["destinationId"]
        ):
            raise SmbError("invalid-input")
    if action == "transaction":
        b = exact(
            value["binding"],
            (
                "id",
                "name",
                "endpoint",
                "identity",
                "destinationId",
                "destinationVersion",
                "connectionGeneration",
                "credentialRef",
                "readOnly",
                "security",
            ),
        )
        for k in ("id", "destinationId", "connectionGeneration", "credentialRef"):
            if not isinstance(b[k], str) or not UUID.fullmatch(b[k]):
                raise SmbError("invalid-input")
        text(b["name"], 120)
        validate_identity(b["identity"])
        if (
            validate_endpoint(b["endpoint"]) != endpoint
            or b["destinationVersion"] != 3
            or type(b["readOnly"]) is not bool
            or b["security"] not in ("signed", "encrypted")
        ):
            raise SmbError("invalid-input")
        c = exact(value["context"], ("operationId", "deviceId", "kind"))
        if any(
            not isinstance(c[k], str) or not UUID.fullmatch(c[k])
            for k in ("operationId", "deviceId")
        ) or c["kind"] not in ("read", "publish", "delete"):
            raise SmbError("invalid-input")
        app_dir = text(value["appDir"], 4096)
        if not app_dir.startswith("/") or any(p in (".", "..") for p in app_dir.split("/")):
            raise SmbError("invalid-input")
    return endpoint, credentials


def serve(source, sink, backend_factory=None):
    transport = None
    sequence = None
    nonce = None
    try:
        startup = read_frame(source)
        endpoint, credentials = validate_startup(startup)
        action = startup["action"]
        if action != "transaction" and source.read(1):
            raise SmbError("invalid-protocol")
        # Publication/deletion require Task 2's original-owner journal/claim.
        if action == "transaction" and startup["context"]["kind"] != "read":
            raise SmbError("unsupported-coordination")
        transport = DirectTransport(
            endpoint, credentials, backend=backend_factory() if backend_factory else None
        )
        if action == "probe":
            value = transport.probe()
            transport.close()
            transport = None
            emit(sink, dict(ok=True, value=value))
            return
        if action == "initialize":
            value = transport.initialize(startup["identity"], startup["destinationId"])
            transport.close()
            transport = None
            emit(sink, dict(ok=True, value=value))
            return
        binding = startup["binding"]
        probe = transport.probe(binding["identity"])
        if (
            probe["destinationId"] != binding["destinationId"]
            or binding["security"] == "encrypted"
            and not probe["encrypted"]
        ):
            raise SmbError("identity-changed")
        emit(sink, dict(ok=True, ready=True, checkpointed=False))
        sequence = 0
        while True:
            sequence += 1
            nonce = None
            raw = read_frame(source)
            # Only a syntactically valid parsed request correlation may be echoed.
            nonce = raw.get("nonce")
            if not isinstance(nonce, str) or not NONCE.fullmatch(nonce):
                nonce = None
            request = validate_rpc(raw, sequence)
            action = request["action"]
            if action == "read":
                for data in transport.stream(request["path"], request["maxBytes"]):
                    emit(sink, dict(id=sequence, nonce=nonce, bytes=len(data)))
                    sink.write(data)
                    sink.flush()
                emit(sink, dict(id=sequence, nonce=nonce, ok=True, value=None))
            elif action == "list":
                transport.revalidate()
                handle = (
                    transport.root if not request["path"] else transport.pin(request["path"], True)
                )
                value = transport.listing(handle)
                transport.revalidate()
                emit(sink, dict(id=sequence, nonce=nonce, ok=True, value=value))
            elif action == "checkpoint":
                emit(sink, dict(id=sequence, nonce=nonce, ok=True, value=None))
            elif action == "close":
                transport.close()
                transport = None
                emit(sink, dict(id=sequence, nonce=nonce, ok=True, value=None))
                return
            else:
                raise SmbError("unsupported-coordination")
    except Exception as error:
        code = error.code if isinstance(error, SmbError) else "transport-unavailable"
        value = dict(ok=False, error=code)
        if sequence is not None:
            value["id"] = sequence
            value["nonce"] = nonce
        emit(sink, value)
    finally:
        if transport:
            try:
                transport.close()
            except Exception:
                pass


def main():
    logging.disable(logging.CRITICAL)
    # SDK exceptions/loggers must never escape to stderr or protocol output.
    try:
        serve(sys.stdin.buffer, sys.stdout.buffer)
    except Exception:
        pass


if __name__ == "__main__":
    main()
