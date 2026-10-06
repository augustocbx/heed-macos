"""Bounded JSON and unambiguous endpoint validation; errors contain codes only."""

import ipaddress
import json
import re
import unicodedata

MAX_FRAME = 65536
MAX_RESULT = 2000000
CHUNK = 131072
MAX_BYTES = 8000000000000
MAX_ENTRIES = 10000
NONCE = re.compile(r"^[a-f0-9]{64}$")
UUID = re.compile(r"^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$")
CODES = frozenset(
    (
        "invalid-input",
        "invalid-protocol",
        "transport-unavailable",
        "runtime-unavailable",
        "unsupported-security",
        "unsupported-identity",
        "identity-changed",
        "unsupported-namespace",
        "unsupported-coordination",
        "access-denied",
        "read-only",
        "destination-exists",
        "unsupported-destination",
        "bounds-exceeded",
        "destination-busy",
        "recovery-required",
        "canonical-collision-noeffect",
        "canonical-admission-collision",
        "transaction-unavailable",
    )
)
CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]")


class SmbError(Exception):
    def __init__(self, code="transport-unavailable"):
        self.code = code if code in CODES else "transport-unavailable"
        super().__init__(self.code)


def exact(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise SmbError("invalid-input")
    return value


def text(value, maximum, empty=False):
    if (
        not isinstance(value, str)
        or len(value) > maximum
        or (not empty and not value)
        or (CONTROL.search(value) or re.search(r"[\ud800-\udfff]", value))
    ):
        raise SmbError("invalid-input")
    return value


def component(value):
    text(value, 255)
    if (
        value != unicodedata.normalize("NFC", value)
        or re.search(r"[<>|?:*\\/%]", value)
        or value in (".", "..")
        or value.endswith((".", " "))
        or re.match(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", value, re.I)
        or len(value.encode("utf-16-le")) > 510
    ):
        raise SmbError("invalid-input")
    return value


def validate_path(value, empty=False):
    text(value, 512, empty)
    if not value and empty:
        return value
    for part in value.split("/"):
        component(part)
    return value


def validate_endpoint(value):
    exact(value, ("server", "port", "share", "folder", "requireEncryption"))
    host = text(value["server"], 253)
    if re.search(r"[\s/:\\%@?#]", host):
        raise SmbError("invalid-input")
    if host.endswith("."):
        host = host[:-1]
    try:
        host = unicodedata.normalize("NFC", host).encode("idna").decode("ascii").lower()
    except (ValueError, UnicodeError):
        raise SmbError("invalid-input") from None
    if (
        not host
        or len(host) > 253
        or any(
            not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", p) for p in host.split(".")
        )
    ):
        raise SmbError("invalid-input")
    if re.fullmatch(r"(?:0x[a-f0-9]+|[0-9]+)(?:\.(?:0x[a-f0-9]+|[0-9]+))*", host):
        try:
            ipaddress.IPv4Address(host)
        except ValueError:
            raise SmbError("invalid-input") from None
    port = value["port"]
    if (
        type(port) is not int
        or not 1 <= port <= 65535
        or type(value["requireEncryption"]) is not bool
    ):
        raise SmbError("invalid-input")
    if port != 445 and (host not in ("localhost", "127.0.0.1") or not 48000 <= port <= 48999):
        raise SmbError("invalid-input")
    return dict(
        server=host,
        port=port,
        share=component(value["share"]),
        folder=validate_path(value["folder"], True),
        requireEncryption=value["requireEncryption"],
    )


def validate_credentials(value):
    exact(value, ("username", "password", "domain"))
    u = text(value["username"], 256)
    p = text(value["password"], 4096)
    d = text(value["domain"], 253, True)
    if (
        u != u.strip()
        or re.search(r"[\\/:]", u)
        or d
        and not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?", d)
    ):
        raise SmbError("invalid-input")
    return dict(username=u, password=p, domain=d)


def duplicate_free(pairs):
    result = {}
    for k, v in pairs:
        if k in result:
            raise SmbError("invalid-protocol")
        result[k] = v
    return result


def read_frame(source, maximum=MAX_FRAME):
    raw = source.readline(maximum + 2)
    if not raw or len(raw) > maximum + 1 or not raw.endswith(b"\n") or b"\r" in raw:
        raise SmbError("invalid-protocol")
    try:
        value = json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=duplicate_free,
            parse_constant=lambda _: (_ for _ in ()).throw(SmbError("invalid-protocol")),
        )
    except (ValueError, UnicodeError, RecursionError):
        raise SmbError("invalid-protocol") from None
    if not isinstance(value, dict):
        raise SmbError("invalid-protocol")
    return value


def emit(sink, value):
    data = json.dumps(value, separators=(",", ":"), ensure_ascii=True).encode() + b"\n"
    if len(data) > MAX_RESULT:
        raise SmbError("bounds-exceeded")
    sink.write(data)
    sink.flush()


def count(value):
    if type(value) is not int or not 0 <= value <= MAX_BYTES:
        raise SmbError("invalid-input")
    return value


def validate_rpc(value, sequence):
    if (
        not isinstance(value, dict)
        or type(value.get("id")) is not int
        or value["id"] != sequence
        or not isinstance(value.get("nonce"), str)
        or not NONCE.fullmatch(value["nonce"])
        or not isinstance(value.get("action"), str)
    ):
        raise SmbError("invalid-protocol")
    action = value["action"]
    fields = {
        "read": ("path", "maxBytes"),
        "write": ("path", "bytes", "sha256"),
        "list": ("path",),
        "close": (),
        "checkpoint": (),
        "inventory": (),
        "write-pending": ("value",),
        "retire-pending": ("value",),
        "write-fence": ("value",),
        "write-deletion": ("value",),
        "confirm": ("commit",),
        "remove-exact": ("jobId", "artifact"),
        "observation-digest": (),
    }
    if action not in fields:
        raise SmbError("unsupported-coordination")
    exact(value, ("id", "nonce", "action", *fields[action]))
    if "path" in value:
        validate_path(value["path"], action == "list")
    for k in ("bytes", "maxBytes"):
        if k in value:
            count(value[k])
    if "sha256" in value and (
        not isinstance(value["sha256"], str) or not re.fullmatch(r"[a-f0-9]{64}", value["sha256"])
    ):
        raise SmbError("invalid-input")
    return value
