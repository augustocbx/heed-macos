"""Stable query receipts never use the session-scoped CREATE FileId."""

import re
from protocol import SmbError, exact

WIDTHS = dict(serverGuid=32, volumeSerial=8, volumeCreated=16, rootId=16, rootCreated=16)


def stable_hex(value, width):
    if type(value) is int:
        if not 0 < value < (1 << (width * 4)) - 1:
            raise SmbError("unsupported-identity")
        value = f"{value:0{width}x}"
    if (
        not isinstance(value, str)
        or not re.fullmatch("[a-f0-9]{" + str(width) + "}", value)
        or set(value) in ({"0"}, {"f"})
    ):
        raise SmbError("unsupported-identity")
    return value


def validate_identity(value):
    exact(value, WIDTHS)
    result = {k: stable_hex(value[k], w) for k, w in WIDTHS.items()}
    if any(int(result[k], 16) >= 0x8000000000000000 for k in ("rootCreated", "volumeCreated")):
        raise SmbError("unsupported-identity")
    return result


def receipt(server_guid, metadata):
    return validate_identity(
        dict(
            serverGuid=server_guid,
            volumeSerial=metadata["volumeSerial"],
            volumeCreated=metadata["volumeCreated"],
            rootId=metadata["objectId"],
            rootCreated=metadata["created"],
        )
    )


def validate_metadata(value, directory):
    for k, width in [("objectId", 16), ("created", 16), ("volumeSerial", 8), ("volumeCreated", 16)]:
        stable_hex(value[k], width)
    if any(int(value[k], 16) >= 0x8000000000000000 for k in ("created", "volumeCreated")):
        raise SmbError("unsupported-identity")
    if (
        value.get("reparse") is not False
        or value.get("deletePending") is not False
        or value.get("links") != 1
        or value.get("directory") is not directory
        or type(value.get("bytes")) is not int
        or value["bytes"] < 0
    ):
        raise SmbError("unsupported-namespace")
    return value


def same_object(a, b):
    return all(
        a.get(k) == b.get(k)
        for k in ("objectId", "created", "volumeSerial", "volumeCreated", "directory")
    )
