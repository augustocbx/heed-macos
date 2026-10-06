"""Bounded local lifecycle metadata, including streaming compatibility with old UI status.

Only allowlisted top-level scalars survive projection. Opaque values are validated
byte by byte, never decoded or accumulated. Limits deliberately refuse unusually
large old snapshots; failure never establishes idle or authorizes lifecycle effects.
"""
import http.client
import io
import json
import os
import time
from urllib.parse import urlsplit

BUSY_KEYS = ('recording', 'processing', 'pending', 'starting', 'audioWork')
IDENTITY_KEYS = ('service', 'protocolVersion', 'checkoutRoot', 'pid')
FIELDS = frozenset((*BUSY_KEYS, *IDENTITY_KEYS, 'maintenance'))
ERROR = 'Could not verify bounded Heed lifecycle metadata. No services were changed.'


class Projector:
    def __init__(self, stream, max_bytes=16*1024*1024, max_depth=64,
                 max_tokens=100000, max_key=4096, max_keys=128,
                 max_string=8*1024*1024, deadline=None):
        self.stream = stream
        self.max_bytes, self.max_depth, self.max_tokens = max_bytes, max_depth, max_tokens
        self.max_key, self.max_keys, self.max_string = max_key, max_keys, max_string
        self.deadline = time.monotonic()+5 if deadline is None else deadline
        self.chunk = b''
        self.offset = self.total = self.tokens = 0
        self.result = {}

    def peek(self):
        if time.monotonic() >= self.deadline: raise ValueError(ERROR)
        if self.offset == len(self.chunk):
            read = getattr(self.stream, 'read1', self.stream.read)
            self.chunk = read(min(4096, self.max_bytes-self.total+1))
            self.offset = 0
            self.total += len(self.chunk)
            if self.total > self.max_bytes: raise ValueError(ERROR)
        return self.chunk[self.offset] if self.chunk else -1

    def take(self):
        value = self.peek()
        if value < 0: raise ValueError(ERROR)
        self.offset += 1
        return value

    def expect(self, value):
        if self.take() != value: raise ValueError(ERROR)

    def whitespace(self):
        while self.peek() in (32, 9, 10, 13): self.take()

    def string(self, retain=False, key=False):
        self.expect(34)
        output = bytearray(b'"') if retain else None
        count = 0
        limit = self.max_key if key else (4096 if retain else self.max_string)
        def byte():
            nonlocal count
            value = self.take(); count += 1
            if count > limit: raise ValueError(ERROR)
            if output is not None: output.append(value)
            return value
        while True:
            value = byte()
            if value == 34: break
            if value < 32: raise ValueError(ERROR)
            if value == 92:
                escaped = byte()
                if escaped == 117:
                    for _ in range(4):
                        if byte() not in b'0123456789abcdefABCDEF': raise ValueError(ERROR)
                elif escaped not in b'"\\/bfnrt': raise ValueError(ERROR)
            elif value >= 128:
                # Validate UTF-8 scalar encodings without decoding opaque content.
                if 194 <= value <= 223: length, low, high = 1, 128, 191
                elif 224 <= value <= 239:
                    length, low, high = 2, (160 if value == 224 else 128), (159 if value == 237 else 191)
                elif 240 <= value <= 244:
                    length, low, high = 3, (144 if value == 240 else 128), (143 if value == 244 else 191)
                else: raise ValueError(ERROR)
                if not low <= byte() <= high: raise ValueError(ERROR)
                for _ in range(length-1):
                    if not 128 <= byte() <= 191: raise ValueError(ERROR)
        return json.loads(output) if retain else None

    def value(self, depth=0, field=None):
        self.tokens += 1
        if depth > self.max_depth or self.tokens > self.max_tokens: raise ValueError(ERROR)
        self.whitespace()
        first = self.peek()
        if field in (*BUSY_KEYS, 'maintenance') and first not in (116, 102): raise ValueError(ERROR)
        if field in ('service', 'checkoutRoot') and first != 34: raise ValueError(ERROR)
        if field in ('pid', 'protocolVersion') and first not in b'-0123456789': raise ValueError(ERROR)
        if first == 123:
            self.take(); self.whitespace(); keys = set()
            if self.peek() != 125:
                while True:
                    key = self.string(retain=depth == 0, key=True)
                    if depth == 0:
                        if key in keys or len(keys) >= self.max_keys: raise ValueError(ERROR)
                        keys.add(key)
                    self.whitespace(); self.expect(58)
                    selected = key if depth == 0 and key in FIELDS else None
                    value = self.value(depth+1, selected)
                    if selected is not None: self.result[selected] = value
                    self.whitespace()
                    if self.peek() != 44: break
                    self.take(); self.whitespace()
            self.expect(125)
        elif first == 91:
            self.take(); self.whitespace()
            if self.peek() != 93:
                while True:
                    self.value(depth+1); self.whitespace()
                    if self.peek() != 44: break
                    self.take()
            self.expect(93)
        elif first == 34: return self.string(retain=field is not None)
        elif first in (116, 102, 110):
            literal, result = {116:(b'true', True), 102:(b'false', False), 110:(b'null', None)}[first]
            for byte in literal: self.expect(byte)
            return result
        else:
            # JSON number grammar; bounded token even when its value is skipped.
            output = bytearray() if field is not None else None
            count = 0
            integer = True
            def digit():
                nonlocal count
                value = self.take(); count += 1
                if count > 128: raise ValueError(ERROR)
                if output is not None: output.append(value)
            if self.peek() == 45: digit()
            if self.peek() == 48: digit()
            elif 49 <= self.peek() <= 57:
                while 48 <= self.peek() <= 57: digit()
            else: raise ValueError(ERROR)
            if self.peek() == 46:
                integer = False
                digit()
                if not 48 <= self.peek() <= 57: raise ValueError(ERROR)
                while 48 <= self.peek() <= 57: digit()
            if self.peek() in (69, 101):
                integer = False
                digit()
                if self.peek() in (43, 45): digit()
                if not 48 <= self.peek() <= 57: raise ValueError(ERROR)
                while 48 <= self.peek() <= 57: digit()
            if field is not None:
                if not integer: raise ValueError(ERROR)
                return int(output)

    def run(self):
        self.whitespace()
        if self.peek() != 123: raise ValueError(ERROR)
        self.value(); self.whitespace()
        if self.peek() != -1: raise ValueError(ERROR)
        return self.result


def project(stream, **limits):
    return Projector(stream, **limits).run()


class DeadlineReader(io.RawIOBase):
    """Enforce the same deadline during headers, chunk framing and body reads."""
    def __init__(self, sock, deadline): self.sock, self.deadline = sock, deadline
    def readable(self): return True
    def readinto(self, buffer):
        remaining = self.deadline-time.monotonic()
        if remaining <= 0: raise ValueError(ERROR)
        self.sock.settimeout(remaining)
        return self.sock.recv_into(buffer)


class DeadlineSocket:
    def __init__(self, sock, deadline): self.sock, self.deadline = sock, deadline
    def makefile(self, *args): return io.BufferedReader(DeadlineReader(self.sock, self.deadline))
    def sendall(self, data):
        remaining = self.deadline-time.monotonic()
        if remaining <= 0: raise ValueError(ERROR)
        self.sock.settimeout(remaining); self.sock.sendall(data)
    def close(self): pass  # request() owns the socket until the response is consumed.


def request(base, path, body=None, max_bytes=16*1024*1024, timeout=5):
    parsed = urlsplit(base)
    if parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost') or not parsed.port or parsed.path not in ('', '/') or parsed.query or parsed.fragment or parsed.username or parsed.password:
        raise ValueError(ERROR)
    deadline = time.monotonic()+timeout
    connection = http.client.HTTPConnection('127.0.0.1', parsed.port, timeout=timeout)
    raw_socket = None
    try:
        connection.connect()
        raw_socket = connection.sock
        connection.sock = DeadlineSocket(connection.sock, deadline)
        payload = None if body is None else json.dumps(body).encode()
        connection.request('GET' if body is None else 'POST', path, payload, {'Content-Type':'application/json', 'Connection':'close'})
        with connection.getresponse() as response:
            if response.status != 200: return response.status, None
            result = project(response, max_bytes=max_bytes, deadline=deadline)
            if response.length not in (None, 0): raise ValueError(ERROR)
            return response.status, result
    except (OSError, http.client.HTTPException, ValueError, TypeError):
        raise ValueError(ERROR) from None
    finally:
        connection.close()
        if raw_socket is not None: raw_socket.close()


def valid_identity(data, root, pid=None):
    return (isinstance(data, dict) and data.get('service') == 'heed-api'
            and type(data.get('protocolVersion')) is int and data['protocolVersion'] == 1
            and isinstance(data.get('checkoutRoot'), str) and data['checkoutRoot'].startswith('/')
            and os.path.realpath(data['checkoutRoot']) == os.path.realpath(root)
            and type(data.get('pid')) is int and data['pid'] > 0
            and (pid is None or data['pid'] == pid))


def read_status_with_capability(base, identity):
    code, data = request(base, '/api/recording/lifecycle', max_bytes=65536)
    legacy_negotiated = code in (404, 405)
    if legacy_negotiated:
        code, data = request(base, '/api/desktop/control/status')
        # Identity is independently verified by the caller. Old snapshots may lack
        # identity, but any supplied identity must match completely.
        if data and any(key in data for key in IDENTITY_KEYS) and not valid_identity(data, identity['checkoutRoot'], identity['pid']): raise ValueError(ERROR)
    elif not valid_identity(data, identity['checkoutRoot'], identity['pid']) or type(data.get('maintenance')) is not bool:
        raise ValueError(ERROR)
    if code != 200 or not isinstance(data, dict) or not all(type(data.get(key)) is bool for key in BUSY_KEYS): raise ValueError(ERROR)
    return data, legacy_negotiated


def read_status(base, identity):
    return read_status_with_capability(base, identity)[0]
