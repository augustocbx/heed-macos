#!/usr/bin/python3
"""Chrome/Edge native messaging: sanitized call state only, loopback destination."""
import json
import re
import struct
import sys
import urllib.error
import urllib.request
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[3]/"scripts"))
from service_config import service_config,ROOT
from service_runtime import read_identity
API_URL=f"http://127.0.0.1:{service_config()['api']}"

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

KEYS = {"app", "detectorId", "sequence", "state", "callId", "capability"}

def validate(value):
    if not isinstance(value, dict) or set(value) != KEYS:
        raise ValueError("Invalid observation")
    if value["app"] != "meet" or not isinstance(value["detectorId"], str) or not re.fullmatch(r"browser:[a-zA-Z0-9_-]{1,100}", value["detectorId"]):
        raise ValueError("Unsupported detector")
    if type(value["sequence"]) is not int or not 0 <= value["sequence"] <= 9007199254740991:
        raise ValueError("Invalid sequence")
    if value["state"] not in ("active", "inactive", "unknown") or value["capability"] not in ("ready", "degraded"):
        raise ValueError("Invalid state")
    if value["callId"] is not None and (not isinstance(value["callId"], str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,100}", value["callId"])):
        raise ValueError("Invalid identity")
    if value["state"] == "active" and (value["callId"] is None or value["capability"] != "ready"):
        raise ValueError("Invalid active evidence")
    if value["state"] == "inactive" and (value["callId"] is not None or value["capability"] != "ready"):
        raise ValueError("Invalid end evidence")
    return value

def read_exact(stream, size):
    result = bytearray()
    while len(result) < size:
        chunk = stream.read(size - len(result))
        if not chunk:
            if not result:
                return None
            raise ValueError("Truncated message")
        result.extend(chunk)
    return bytes(result)

def main():
    # Browser also enforces the manifest's one explicitly authorized extension.
    if len(sys.argv) != 2 or not re.fullmatch(r"chrome-extension://[a-p]{32}/", sys.argv[1]):
        return 1
    while True:
        header = read_exact(sys.stdin.buffer, 4)
        if header is None:
            return 0
        size = struct.unpack("=I", header)[0]
        if size > 4096:
            return 1
        try:
            message = read_exact(sys.stdin.buffer, size)
            value = validate(json.loads(message))
            if not read_identity(API_URL,'heed-api',str(ROOT)):raise ValueError('Heed API identity unavailable')
            request = urllib.request.Request(API_URL+"/api/meeting-detection/report", data=json.dumps(value).encode("utf-8"), headers={"Content-Type": "application/json"}, method="POST")
            # No proxy, redirects, or arbitrary destinations; do not forward page URLs.
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
            with opener.open(request, timeout=3) as response:
                ok = response.status == 200
            result = {"ok": ok}
        except (ValueError, TypeError, urllib.error.URLError):
            result = {"ok": False, "error": "Open Heed and check Meet detection settings and the native host registration."}
        encoded = json.dumps(result).encode("utf-8")
        sys.stdout.buffer.write(struct.pack("=I", len(encoded)) + encoded)
        sys.stdout.buffer.flush()

if __name__ == "__main__":
    sys.exit(main())
