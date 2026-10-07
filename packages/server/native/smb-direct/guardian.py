#!/usr/bin/env python3
"""Credential-on-stdin whole-operation guardian with sanitized bounded framing."""

import logging
import sys
from identity import validate_identity
from journal import pending_transactions
from protocol import (
    SmbError,
    UUID,
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
from transaction import Transaction
from acceptance import observe_parent, validate_parent_bounds, public_spec, bootstrap, preflight_workspace


def validate_binding(value):
    b = exact(
        value,
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
    for key in ("id", "destinationId", "connectionGeneration", "credentialRef"):
        if not isinstance(b[key], str) or not UUID.fullmatch(b[key]):
            raise SmbError("invalid-input")
    text(b["name"], 120)
    validate_identity(b["identity"])
    validate_endpoint(b["endpoint"])
    if (
        type(b["destinationVersion"]) is not int
        or b["destinationVersion"] != 3
        or type(b["readOnly"]) is not bool
        or b["security"] not in ("signed", "encrypted")
    ):
        raise SmbError("invalid-input")
    return b


def validate_app_dir(value):
    value = text(value, 4096)
    if not value.startswith("/") or any(p in (".", "..") for p in value.split("/")):
        raise SmbError("invalid-input")
    return value


def validate_startup(value):
    if type(value.get("protocol")) is not int or value["protocol"] != 1:
        raise SmbError("invalid-protocol")
    action = value.get("action")
    if action == "pending":
        exact(value, ("protocol", "action", "binding", "appDir"))
        validate_binding(value["binding"])
        validate_app_dir(value["appDir"])
        return None, None
    fields = {
        "probe": (),
        "qa-observe-parent": ("identity",),
        "qa-open-owned-authority": ("binding", "spec", "workspace", "selectedScope", "role"),
        "qa-create-child": ("binding", "spec", "workspace", "selectedScope"),
        "qa-join-child": ("binding", "spec", "workspace", "selectedScope", "evidence"),
        "initialize": ("identity", "destinationId"),
        "transaction": ("binding", "context", "appDir"),
    }
    if action not in fields:
        raise SmbError("invalid-protocol")
    exact(value, ("protocol", "action", "endpoint", "credentials", *fields[action]))
    endpoint = validate_endpoint(value["endpoint"])
    credentials = validate_credentials(value["credentials"])
    if action == "qa-open-owned-authority":
        validate_binding(value["binding"])
        from acceptance_authority import validate_startup as validate_authority
        validate_authority(value)
    if action in ("qa-create-child", "qa-join-child"):
        binding = validate_binding(value["binding"])
        spec = public_spec(value["spec"])
        if binding["endpoint"] != endpoint or value["selectedScope"] != ("parent" if action == "qa-create-child" else "child"):
            raise SmbError("invalid-input")
        workspace = exact(value["workspace"], ("path", "identity", "receipts", "quota"))
        validate_app_dir(workspace["path"])
        validate_parent_bounds(endpoint)
        if action == "qa-create-child" and 1 + len(endpoint["folder"].split("/")) >= 64:
            raise SmbError("bounds-exceeded")
        if action == "qa-join-child":
            from acceptance import validate_evidence
            validate_evidence(value["evidence"], spec)
            if endpoint["folder"].split("/")[-1] != spec["child"]:
                raise SmbError("invalid-input")
    if action == "qa-observe-parent":
        validate_identity(value["identity"])
        validate_parent_bounds(endpoint)
    if action == "initialize":
        validate_identity(value["identity"])
        if not isinstance(value["destinationId"], str) or not UUID.fullmatch(
            value["destinationId"]
        ):
            raise SmbError("invalid-input")
    if action == "transaction":
        binding = validate_binding(value["binding"])
        if validate_endpoint(binding["endpoint"]) != endpoint:
            raise SmbError("invalid-input")
        c = exact(value["context"], ("operationId", "deviceId", "kind"))
        if any(
            not isinstance(c[k], str) or not UUID.fullmatch(c[k])
            for k in ("operationId", "deviceId")
        ) or c["kind"] not in ("read", "publish", "delete"):
            raise SmbError("invalid-input")
        validate_app_dir(value["appDir"])
    return endpoint, credentials


class ProgressSource:
    def __init__(self, source, progress):
        self.source, self.progress = source, progress

    def read(self, size):
        data = self.source.read(size)
        if data:
            self.progress()
        return data


def serve(source, sink, backend_factory=None):
    transport = transaction = None
    sequence = nonce = None
    try:
        startup = read_frame(source)
        endpoint, credentials = validate_startup(startup)
        action = startup["action"]
        if action == "qa-open-owned-authority":
            from acceptance_authority import serve_authority
            serve_authority(startup, source, sink, backend_factory)
            return
        if action != "transaction" and source.read(1):
            raise SmbError("invalid-protocol")
        if action == "pending":
            emit(
                sink,
                dict(
                    ok=True,
                    value=pending_transactions(startup["binding"], startup["appDir"]),
                ),
            )
            return
        if action in ("qa-create-child", "qa-join-child"):
            preflight_workspace(startup)
        transport = DirectTransport(
            endpoint,
            credentials,
            backend=backend_factory() if backend_factory else None,
        )
        if action in ("qa-create-child", "qa-join-child"):
            value = bootstrap(transport, startup)
            transport.close()
            transport = None
            emit(sink, dict(ok=True, value=value))
            return
        if action == "qa-observe-parent":
            value = observe_parent(transport, startup["identity"])
            transport.close()
            transport = None
            emit(sink, dict(ok=True, value=value))
            return
        if action in ("probe", "initialize"):
            value = (
                transport.probe()
                if action == "probe"
                else transport.initialize(startup["identity"], startup["destinationId"])
            )
            transport.close()
            transport = None
            emit(sink, dict(ok=True, value=value))
            return
        transaction = Transaction(
            transport, startup["binding"], startup["context"], startup["appDir"]
        )
        emit(
            sink,
            dict(
                ok=True,
                ready=True,
                checkpointed=transaction.journal.data["phase"]
                in ("checkpointed", "releasing", "released"),
            ),
        )
        sequence = 0
        while True:
            sequence += 1
            nonce = None
            raw = read_frame(source)
            nonce = raw.get("nonce")
            if not isinstance(nonce, str) or not NONCE.fullmatch(nonce):
                nonce = None
            request = validate_rpc(raw, sequence)
            action = request["action"]
            value = None
            if action == "read":
                for data in transaction.stream(request["path"], request["maxBytes"]):
                    emit(sink, dict(id=sequence, nonce=nonce, bytes=len(data)))
                    sink.write(data)
                    sink.flush()
            elif action == "list":
                value = transaction.listing(request["path"])
            elif action == "inventory":
                value = transaction.inventory()
            elif action == "write":
                reader = ProgressSource(
                    source,
                    lambda: emit(sink, dict(id=sequence, nonce=nonce, progress=True)),
                )
                transaction.write(request["path"], reader, request["bytes"], request["sha256"])
            elif action == "write-pending":
                transaction.write_pending(request["value"])
            elif action == "retire-pending":
                transaction.retire_pending(request["value"])
            elif action == "write-fence":
                transaction.write_fence(request["value"])
            elif action == "write-deletion":
                transaction.write_deletion(request["value"])
            elif action == "confirm":
                value = transaction.confirm(request["commit"])
            elif action == "remove-exact":
                value = transaction.remove_exact(request["jobId"],request["artifact"])
            elif action == "observation-digest":
                value = transaction.observation_digest()
            elif action == "checkpoint":
                transaction.checkpoint()
            elif action == "close":
                transaction.close()
                transaction = None
                transport = None
                emit(sink, dict(id=sequence, nonce=nonce, ok=True, value=None))
                return
            else:
                raise SmbError("unsupported-coordination")
            emit(sink, dict(id=sequence, nonce=nonce, ok=True, value=value))
    except Exception as error:
        code = error.code if isinstance(error, SmbError) else "transport-unavailable"
        value = dict(ok=False, error=code)
        if sequence is not None:
            value.update(id=sequence, nonce=nonce)
        emit(sink, value)
    finally:
        if transaction:
            transaction.abort()
        elif transport:
            try:
                transport.close()
            except Exception:
                pass


def main():
    logging.disable(logging.CRITICAL)
    try:
        serve(sys.stdin.buffer, sys.stdout.buffer)
    except Exception:
        pass


if __name__ == "__main__":
    main()
