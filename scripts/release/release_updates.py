"""Bounded stable-release discovery and verified assets; macOS system Python compatible."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request

REPOSITORY = "augustocbx/heed-macos"
API = "https://api.github.com/repos/%s/releases?per_page=100&page=" % REPOSITORY
JSON_LIMIT = 2 * 1024 * 1024
ASSET_LIMIT = 1024 * 1024 * 1024
VERSION = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$")


class UpdateError(ValueError):
    def __init__(self, code, detail):
        super().__init__(detail)
        self.code = code


def version_parts(value):
    match = VERSION.fullmatch(value) if isinstance(value, str) else None
    if not match:
        raise UpdateError("invalid-version", "Invalid semantic version.")
    prerelease = match.group(4)
    if prerelease and any(part.isdigit() and len(part) > 1 and part[0] == "0" for part in prerelease.split(".")):
        raise UpdateError("invalid-version", "Invalid numeric prerelease identifier.")
    return tuple(int(match.group(n)) for n in [1, 2, 3]), prerelease.split(".") if prerelease else []


def compare_versions(left, right):
    a, ap = version_parts(left); b, bp = version_parts(right)
    if a != b:
        return (a > b) - (a < b)
    if not ap or not bp:
        return (not ap) - (not bp)
    for first, second in zip(ap, bp):
        if first == second:
            continue
        if first.isdigit() and second.isdigit():
            return (int(first) > int(second)) - (int(first) < int(second))
        if first.isdigit() != second.isdigit():
            return -1 if first.isdigit() else 1
        return (first > second) - (first < second)
    return (len(ap) > len(bp)) - (len(ap) < len(bp))


def select_release(releases, installed):
    version_parts(installed)
    selected = None
    for release in releases:
        if not isinstance(release, dict) or release.get("draft") is not False or release.get("prerelease") is not False:
            continue
        tag = release.get("tag_name")
        if not isinstance(tag, str) or not tag.startswith("v"):
            continue
        value = tag[1:]
        try:
            if version_parts(value)[1] or compare_versions(value, installed) <= 0:
                continue
        except UpdateError:
            continue
        if selected is None or compare_versions(value, selected["tag_name"][1:]) > 0:
            selected = release
    return selected


class ReleaseRedirectPolicy(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, newurl):
        parsed = urllib.parse.urlsplit(newurl)
        if parsed.scheme != "https" or parsed.hostname not in {
                "github.com", "api.github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"} or parsed.username or parsed.password:
            raise UpdateError("invalid-url", "The release download redirected to an untrusted address.")
        return super().redirect_request(request, response, code, message, headers, newurl)


def transport(url, timeout):
    request = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json", "User-Agent": "Heed-macOS-updater"})
    return urllib.request.build_opener(ReleaseRedirectPolicy()).open(request, timeout=timeout)


def _remaining(deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise UpdateError("timeout", "The update request exceeded its time limit. Retry when the connection is available.")
    return min(15, remaining)


def _chunk(response, deadline):
    timeout = _remaining(deadline)
    # read1 returns available bytes instead of waiting for a whole chunk during a trickle stream.
    socket = getattr(getattr(getattr(response, "fp", None), "raw", None), "_sock", None)
    if socket is not None:
        socket.settimeout(timeout)
    data = response.read1(65536)
    _remaining(deadline)
    return data


def _json(url, request_transport, deadline):
    with request_transport(url, timeout=_remaining(deadline)) as response:
        if response.status != 200:
            raise UpdateError("check-failed", "The release endpoint did not return a successful response.")
        body = bytearray()
        while True:
            data = _chunk(response, deadline)
            if not data:
                break
            body.extend(data)
            if len(body) > JSON_LIMIT:
                raise UpdateError("invalid-metadata", "The release metadata exceeds its size limit.")
        return json.loads(body), response.headers


def validate_manifest(data, version, architecture, macos):
    tag = "v" + version
    if not isinstance(data, dict) or type(data.get("schema")) is not int or data["schema"] != 1 or any(
            data.get(key) != expected for key, expected in [("app", "heed"), ("repository", REPOSITORY), ("version", version), ("tag", tag)]):
        raise UpdateError("invalid-metadata", "The release manifest does not identify the selected Heed release.")
    if not isinstance(data.get("commit"), str) or not re.fullmatch(r"[a-f0-9]{40}", data["commit"]):
        raise UpdateError("invalid-metadata", "The release commit is invalid.")
    minimum = data.get("minimumMacOS")
    if not isinstance(minimum, str) or not re.fullmatch(r"[0-9]+\.[0-9]+(?:\.[0-9]+)?", minimum):
        raise UpdateError("invalid-metadata", "The minimum macOS version is invalid.")
    def os_parts(value):
        if not re.fullmatch(r"[0-9]+\.[0-9]+(?:\.[0-9]+)?", value):
            raise UpdateError("incompatible", "Could not determine the macOS version.")
        return tuple(int(part) for part in value.split(".")) + (0,) * (3 - len(value.split(".")))
    if architecture != "arm64" or not isinstance(data.get("architectures"), list) or architecture not in data["architectures"] or os_parts(macos) < os_parts(minimum):
        raise UpdateError("incompatible", "This release requires a compatible Apple Silicon Mac and macOS version.")
    assets = data.get("assets")
    if not isinstance(assets, dict):
        raise UpdateError("missing-artifact", "The selected release is missing installation assets.")
    for kind, name in [("installer", "install.sh"), ("payload", "heed-macos-%s-arm64.tar.gz" % version)]:
        asset = assets.get(kind)
        expected_url = "https://github.com/%s/releases/download/%s/%s" % (REPOSITORY, tag, name)
        if not isinstance(asset, dict) or asset.get("name") != name or asset.get("url") != expected_url:
            raise UpdateError("missing-artifact", "The selected release has missing or invalid %s metadata." % kind)
        if type(asset.get("size")) is not int or not 0 < asset["size"] <= ASSET_LIMIT or not isinstance(asset.get("sha256"), str) or not re.fullmatch(r"[a-f0-9]{64}", asset["sha256"]):
            raise UpdateError("invalid-metadata", "The %s size or digest is invalid." % kind)
    return data


def check_release(installed, architecture, macos, request_transport=transport):
    result = {"schema": 1, "state": "checkFailed", "installedVersion": installed, "release": None, "errorCode": None}
    try:
        version_parts(installed)
        deadline = time.monotonic() + 60
        releases = []
        for page in [1, 2, 3]:
            values, headers = _json(API + str(page), request_transport, deadline)
            if not isinstance(values, list):
                raise UpdateError("invalid-metadata", "GitHub did not return a release list.")
            releases.extend(values)
            if not re.search(r'rel=["\']next["\']', headers.get("Link", "")):
                break
        else:
            raise UpdateError("incomplete-check", "The bounded release lookup is incomplete. Try again later.")
        selected = select_release(releases, installed)
        if selected is None:
            result["state"] = "upToDate"
        else:
            tag = selected["tag_name"]
            notes = "https://github.com/%s/releases/tag/%s" % (REPOSITORY, tag)
            if selected.get("html_url") != notes:
                raise UpdateError("invalid-url", "The release-notes address is invalid.")
            data, _ = _json("https://github.com/%s/releases/download/%s/release-manifest.json" % (REPOSITORY, tag), request_transport, deadline)
            result.update(state="available", release={"manifest": validate_manifest(data, tag[1:], architecture, macos), "notesURL": notes})
    except (UpdateError, OSError, ValueError, urllib.error.URLError) as error:
        result["errorCode"] = error.code if isinstance(error, UpdateError) else "rate-limited" if getattr(error, "code", None) in [403, 429] else "check-failed"
    return result


def download_verified(asset, destination, request_transport=transport, progress=lambda *args: None):
    destination = Path(destination)
    created = False
    try:
        if type(asset.get("size")) is not int or not 0 < asset["size"] <= ASSET_LIMIT:
            raise UpdateError("invalid-metadata", "Invalid download size.")
        deadline = time.monotonic() + 900
        digest = hashlib.sha256(); count = 0
        descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        created = True
        with os.fdopen(descriptor, "wb") as output, request_transport(asset["url"], timeout=_remaining(deadline)) as response:
            if response.status != 200:
                raise UpdateError("download-failed", "The asset download was not successful.")
            while True:
                data = _chunk(response, deadline)
                if not data:
                    break
                count += len(data)
                if count > asset["size"]:
                    raise UpdateError("integrity-failed", "The downloaded artifact is larger than the selected release asset.")
                output.write(data); digest.update(data); progress(count, asset["size"])
            output.flush(); os.fsync(output.fileno())
        if count != asset["size"] or digest.hexdigest() != asset["sha256"]:
            raise UpdateError("integrity-failed", "The release artifact failed its size or SHA-256 check. Download it again.")
        return destination
    except (OSError, ValueError, urllib.error.URLError) as error:
        if created:
            destination.unlink()
        if isinstance(error, UpdateError):
            raise
        raise UpdateError("download-failed", "The artifact download was interrupted or its destination is unavailable.") from error


def validate_archive(archive, manifest):
    root = "heed-macos-%s-arm64" % manifest["version"]
    seen = set(); total = 0; metadata = None
    try:
        with tarfile.open(archive, "r:gz") as payload:
            for member in payload:
                path = PurePosixPath(member.name)
                if path.is_absolute() or ".." in path.parts or not path.parts or path.parts[0] != root or str(path) in seen:
                    raise UpdateError("invalid-archive", "The archive has duplicate or unsafe paths.")
                seen.add(str(path)); total += member.size
                if len(seen) > 100000 or total > 2 * ASSET_LIMIT or not (member.isfile() or member.isdir()):
                    raise UpdateError("invalid-archive", "The archive contains unsupported entries or exceeds its size limit.")
                if str(path) == root + "/release.json":
                    if not member.isfile() or member.size > JSON_LIMIT:
                        raise UpdateError("invalid-archive", "Invalid payload metadata.")
                    metadata = json.load(payload.extractfile(member))
        if not isinstance(metadata, dict) or any(metadata.get(key) != manifest.get(key) for key in ["app", "version", "tag", "commit", "repository", "architectures", "minimumMacOS"]):
            raise UpdateError("invalid-archive", "The payload does not match the selected release manifest.")
        return root
    except (OSError, tarfile.TarError, ValueError) as error:
        if isinstance(error, UpdateError):
            raise
        raise UpdateError("invalid-archive", "The release archive could not be verified.") from error
