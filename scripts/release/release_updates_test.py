import hashlib
import io
import json
import pathlib
import tarfile
import tempfile
import unittest
import urllib.error
from unittest.mock import patch

try:
    import release_updates as updates
except ModuleNotFoundError:
    updates = None

REPO = "augustocbx/heed-macos"
BASE = "https://github.com/%s/releases/download/v1.10.0/" % REPO
API = "https://api.github.com/repos/%s/releases?per_page=100&page=" % REPO


def manifest():
    def asset(name, body):
        return {"name": name, "url": BASE + name, "size": len(body),
                "sha256": hashlib.sha256(body).hexdigest()}
    return {"schema": 1, "app": "heed", "repository": REPO, "version": "1.10.0", "tag": "v1.10.0",
            "commit": "a" * 40, "minimumMacOS": "14.0", "architectures": ["arm64"],
            "assets": {"installer": asset("install.sh", b"installer"),
                       "payload": asset("heed-macos-1.10.0-arm64.tar.gz", b"payload")}}


def release(version, **extra):
    return {"tag_name": "v" + version, "draft": False, "prerelease": False,
            "html_url": "https://github.com/%s/releases/tag/v%s" % (REPO, version), **extra}


class Response(io.BytesIO):
    def __init__(self, body, headers=None, url="https://github.com/asset"):
        super().__init__(body if isinstance(body, bytes) else json.dumps(body).encode())
        self.headers = headers or {}
        self.status = 200
        self.url = url

    def geturl(self):
        return self.url


class Transport:
    def __init__(self, routes):
        self.routes = routes
        self.calls = []

    def __call__(self, url, timeout):
        self.calls.append(url)
        result = self.routes[url]
        if isinstance(result, Exception):
            raise result
        body, headers = result if isinstance(result, tuple) else (result, {})
        return Response(body, headers, url)


class UpdateTest(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(updates, "The release update helper has not been implemented")


class VersionTests(UpdateTest):
    def test_semantic_precedence(self):
        for left, right, expected in [("1.10.0", "1.9.9", 1), ("1.0.0", "1.0.0-rc.10", 1),
                                      ("1.0.0-rc.2", "1.0.0-rc.10", -1),
                                      ("1.0.0+one", "1.0.0+two", 0), ("2.0.0", "10.0.0", -1)]:
            self.assertEqual(updates.compare_versions(left, right), expected)

    def test_invalid_versions_are_rejected(self):
        for value in ["01.0.0", "1.0", "1.0.0-01", "1.0.0-", "1.0.0;touch x"]:
            with self.assertRaises(updates.UpdateError):
                updates.compare_versions(value, "1.0.0")

    def test_only_highest_stable_upgrade_is_selected(self):
        candidates = [release("1.9.0"), release("1.10.0"), release("99.0.0", draft=True),
                      release("50.0.0", prerelease=True), release("30.0.0-rc.1"), release("01.0.0")]
        self.assertEqual(updates.select_release(candidates, "1.0.0")["tag_name"], "v1.10.0")
        self.assertIsNone(updates.select_release(candidates, "1.10.0"))


class ReleaseTests(UpdateTest):
    def check(self, routes, installed="1.0.0", arch="arm64", os_version="14.0"):
        return updates.check_release(installed, arch, os_version, Transport(routes))

    def test_valid_manifest_and_release_notes(self):
        result = self.check({API + "1": [release("1.10.0")], BASE + "release-manifest.json": manifest()})
        self.assertEqual(result["state"], "available")
        self.assertEqual(result["release"]["manifest"]["version"], "1.10.0")
        self.assertEqual(result["release"]["notesURL"], "https://github.com/%s/releases/tag/v1.10.0" % REPO)

    def test_empty_published_releases_are_up_to_date(self):
        self.assertEqual(self.check({API + "1": []})["state"], "upToDate")

    def test_failed_transport_is_never_up_to_date(self):
        for error in [OSError("offline"), ValueError("invalid response")]:
            result = self.check({API + "1": error})
            self.assertEqual(result["state"], "checkFailed")
            self.assertIsNotNone(result["errorCode"])

    def test_rate_limit_malformed_and_oversized_metadata_are_failures(self):
        for response in [urllib.error.HTTPError(API + "1", 429, "limited", {}, None), b"not JSON", b"x" * (2 * 1024 * 1024 + 1)]:
            result = self.check({API + "1": response})
            self.assertEqual(result["state"], "checkFailed")
        self.assertEqual(self.check({API + "1": urllib.error.HTTPError(API + "1", 403, "limited", {}, None)})["errorCode"], "rate-limited")

    def test_manifest_identity_compatibility_and_asset_contract(self):
        for field, value in [("schema", True), ("version", "1.9.0"), ("repository", "other/repo"),
                             ("commit", "bad"), ("minimumMacOS", "100.0"), ("architectures", ["x86_64"])]:
            data = manifest(); data[field] = value
            result = self.check({API + "1": [release("1.10.0")], BASE + "release-manifest.json": data})
            self.assertEqual(result["state"], "checkFailed", field)
        for field, value in [("url", "http://github.com/other"), ("name", "../install.sh"),
                             ("size", 0), ("sha256", "bad")]:
            data = manifest(); data["assets"]["installer"][field] = value
            self.assertEqual(self.check({API + "1": [release("1.10.0")], BASE + "release-manifest.json": data})["state"], "checkFailed")

    def test_incomplete_pagination_fails_without_following_untrusted_links(self):
        transport = Transport({API + str(page): ([release("1.0.0")],
                             {"Link": '<https://unrelated.invalid/page>; rel="next"'}) for page in [1, 2, 3]})
        result = updates.check_release("1.0.0", "arm64", "14.0", transport)
        self.assertEqual(result["state"], "checkFailed")
        self.assertEqual(transport.calls, [API + "1", API + "2", API + "3"])

    def test_invalid_release_notes_url_is_rejected(self):
        result = self.check({API + "1": [release("1.10.0", html_url="https://unrelated.invalid/")]})
        self.assertEqual(result["state"], "checkFailed")


class IntegrityTests(UpdateTest):
    def test_verified_download_and_progress(self):
        asset = manifest()["assets"]["payload"]
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / asset["name"]
            progress = []
            self.assertEqual(updates.download_verified(asset, path, Transport({asset["url"]: b"payload"}),
                                                       lambda done, total: progress.append((done, total))), path)
            self.assertEqual(path.read_bytes(), b"payload")
            self.assertEqual(progress[-1], (7, 7))

    def test_corruption_truncation_and_interruption_leave_no_partial_file(self):
        asset = manifest()["assets"]["payload"]
        for body in [b"wrong!!", b"short", b"payload extra", OSError("interrupted")]:
            with tempfile.TemporaryDirectory() as directory:
                path = pathlib.Path(directory) / asset["name"]
                with self.assertRaises(updates.UpdateError):
                    updates.download_verified(asset, path, Transport({asset["url"]: body}), lambda *args: None)
                self.assertFalse(path.exists())

    def test_existing_file_or_symlink_is_never_overwritten(self):
        asset = manifest()["assets"]["payload"]
        with tempfile.TemporaryDirectory() as directory:
            old = pathlib.Path(directory) / "kept"; old.write_text("preserved")
            link = pathlib.Path(directory) / "link"; link.symlink_to(old)
            for destination in [old, link]:
                with self.assertRaises(updates.UpdateError):
                    updates.download_verified(asset, destination, Transport({asset["url"]: b"payload"}), lambda *args: None)
            self.assertEqual(old.read_text(), "preserved")

    def archive(self, path, extra=None, metadata=None):
        root = "heed-macos-1.10.0-arm64"
        value = {key: manifest()[key] for key in ["app", "version", "tag", "commit", "repository", "architectures", "minimumMacOS"]}
        value.update(metadata or {})
        with tarfile.open(path, "w:gz") as archive:
            body = json.dumps(value).encode()
            entry = tarfile.TarInfo(root + "/release.json"); entry.size = len(body)
            archive.addfile(entry, io.BytesIO(body))
            if extra:
                for entry in extra:
                    archive.addfile(entry, io.BytesIO(b"x" * entry.size))

    def test_safe_archive_matches_selected_release(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "payload.tar.gz"; self.archive(path)
            self.assertEqual(updates.validate_archive(path, manifest()), "heed-macos-1.10.0-arm64")
            self.archive(path, metadata={"commit": "b" * 40})
            with self.assertRaises(updates.UpdateError):
                updates.validate_archive(path, manifest())

    def test_unsafe_entries_and_duplicates_are_rejected(self):
        for name in ["/tmp/evil", "../evil", "heed-macos-1.10.0-arm64/../evil", "heed-macos-1.10.0-arm64/release.json"]:
            with tempfile.TemporaryDirectory() as directory:
                path = pathlib.Path(directory) / "payload.tar.gz"
                self.archive(path, [tarfile.TarInfo(name)])
                with self.assertRaises(updates.UpdateError):
                    updates.validate_archive(path, manifest())
        for kind in [tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.CHRTYPE, tarfile.FIFOTYPE]:
            with tempfile.TemporaryDirectory() as directory:
                path = pathlib.Path(directory) / "payload.tar.gz"
                entry = tarfile.TarInfo("heed-macos-1.10.0-arm64/link"); entry.type = kind; entry.linkname = "../../outside"
                self.archive(path, [entry])
                with self.assertRaises(updates.UpdateError):
                    updates.validate_archive(path, manifest())

    def test_download_overall_deadline_cannot_be_extended_by_progress(self):
        asset = manifest()["assets"]["payload"]
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / asset["name"]
            with patch.object(updates.time, "monotonic", side_effect=[0, 0, 901, 902]):
                with self.assertRaises(updates.UpdateError):
                    updates.download_verified(asset, path, Transport({asset["url"]: b"payload"}), lambda *args: None)
            self.assertFalse(path.exists())


if __name__ == "__main__":
    unittest.main()
