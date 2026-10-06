import http.server
import json
import os
import pathlib
import tempfile
import threading
import unittest

import heed_release


class Server:
    """Serves fixed JSON (or text) per path on a free loopback port."""

    def __init__(self, routes):
        handler_routes = routes

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                body, kind = handler_routes.get(self.path, ("not found", "text/plain"))
                data = body.encode() if isinstance(body, str) else json.dumps(body).encode()
                self.send_response(200 if self.path in handler_routes else 404)
                self.send_header("Content-Type", kind)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


def api(version="1.2.0", commit="abc"):
    return ({"app": "heed", "component": "api", "version": version, "commit": commit}, "application/json")


class IdentityTest(unittest.TestCase):
    def test_accepts_only_the_expected_heed_build(self):
        ok = {"app": "heed", "component": "api", "version": "1.2.0", "commit": "abc"}
        self.assertIsNone(heed_release.identity_problem("api", 200, ok, "1.2.0", "abc"))
        self.assertIn("expected 1.2.0", heed_release.identity_problem("api", 200, dict(ok, version="1.1.0"), "1.2.0"))
        self.assertIn("different Heed build", heed_release.identity_problem("api", 200, dict(ok, commit="def"), "1.2.0", "abc"))

    def test_other_applications_are_not_heed(self):
        self.assertIn("another application", heed_release.identity_problem("api", 200, None, "1.2.0"))
        self.assertIn("another application", heed_release.identity_problem("api", 200, {"status": "ok", "version": "1.2.0"}, "1.2.0"))
        self.assertIn("another application", heed_release.identity_problem("transcription", 200, {"whisper": True}, "1.2.0"))
        self.assertEqual(heed_release.identity_problem("api", None, None, "1.2.0"), "not responding")

    def test_wait_ready_checks_every_service(self):
        server = Server({"/api/version": api(), "/health": ({"service": "heed-transcription", "version": "1.2.0", "commit": "abc"}, "application/json")})
        try:
            port = str(server.port)
            self.assertEqual(heed_release.main(["wait-ready", "--version", "1.2.0", "--commit", "abc", "--timeout", "1",
                                                "--api-port", port, "--ui-port", port, "--transcription-port", port]), 0)
        finally:
            server.close()

    def test_wait_ready_fails_fast_on_a_foreign_application(self):
        server = Server({"/api/version": ("<html>Other app</html>", "text/html"), "/health": ("<html></html>", "text/html")})
        try:
            port = str(server.port)
            self.assertEqual(heed_release.main(["wait-ready", "--version", "1.2.0", "--timeout", "30", "--interval", "0.1",
                                                "--foreign-grace", "0.3", "--api-port", port, "--ui-port", port,
                                                "--transcription-port", port]), 2)
        finally:
            server.close()


class BusyTest(unittest.TestCase):
    def status(self, body):
        server = Server({"/api/desktop/control/status": (body, "application/json")})
        try:
            return heed_release.main(["busy", "--api-port", str(server.port)])
        finally:
            server.close()

    def test_busy_states_refuse(self):
        self.assertEqual(self.status({"recording": False, "processing": False, "pending": False, "starting": False}), 0)
        self.assertEqual(self.status({"recording": False, "processing": True}), 1)
        self.assertEqual(self.status("not json"), 2)
        self.assertEqual(self.status({"status": "ok"}), 2)


class PermissionsTest(unittest.TestCase):
    def check(self, permissions):
        server = Server({"/api/desktop/permissions": ({"controllerConnected": True, "permissions": permissions, "pending": False}, "application/json")})
        try:
            return heed_release.main(["permissions", "--timeout", "1", "--api-port", str(server.port)])
        finally:
            server.close()

    def test_reports_missing_required_permissions(self):
        self.assertEqual(self.check({"microphone": "authorized", "screenCapture": True, "slackLogs": None}), 0)
        self.assertEqual(self.check({"microphone": "authorized", "screenCapture": False, "slackLogs": True}), 3)
        self.assertEqual(self.check({"microphone": "denied", "screenCapture": True, "slackLogs": False}), 3)

    def test_menu_app_not_reporting(self):
        server = Server({"/api/desktop/permissions": ({"controllerConnected": False, "permissions": None}, "application/json")})
        try:
            self.assertEqual(heed_release.main(["permissions", "--timeout", "0", "--api-port", str(server.port)]), 4)
        finally:
            server.close()


class FilesTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(os.path.realpath(self.temp.name))

    def tearDown(self):
        self.temp.cleanup()

    def test_only_heed_checkout_recordings_are_owned(self):
        checkout = self.root / "heed"
        (checkout / "recordings").mkdir(parents=True)
        (checkout / "package.json").write_text('{"name": "heed"}')
        self.assertTrue(heed_release.owned_recordings(str(checkout / "recordings"), home=str(self.root)))
        other = self.root / "other" / "recordings"
        other.mkdir(parents=True)
        (self.root / "other" / "package.json").write_text('{"name": "other"}')
        self.assertFalse(heed_release.owned_recordings(str(other), home=str(self.root)))
        link = self.root / "link" / "recordings"
        link.parent.mkdir()
        link.symlink_to(checkout / "recordings")
        self.assertFalse(heed_release.owned_recordings(str(link), home=str(self.root)))
        self.assertFalse(heed_release.owned_recordings(str(self.root), home=str(self.root)))

    def test_state_round_trip(self):
        state = str(self.root / "install.json")
        heed_release.main(["state", state, "--set", "version=1.0.0", "--add", "homebrewInstalled=ffmpeg", "--add", "homebrewInstalled=ffmpeg"])
        data = json.loads(pathlib.Path(state).read_text())
        self.assertEqual(data, {"version": "1.0.0", "homebrewInstalled": ["ffmpeg"]})

    def test_native_host_moves_only_from_heed_roots(self):
        host = self.root / heed_release.NATIVE_HOST_DIRS[0] / heed_release.NATIVE_HOST_NAME
        host.parent.mkdir(parents=True)
        old = self.root / "old"
        (old / "packages/desktop/browser-meet").mkdir(parents=True)
        host.write_text(json.dumps({"name": "local.heed.meet", "path": str(old / "packages/desktop/browser-meet/native-host.py")}))
        heed_release.main(["migrate-native-hosts", "--home", str(self.root), "--new-root", "/new", "--old-root", str(old)])
        self.assertEqual(json.loads(host.read_text())["path"], "/new/packages/desktop/browser-meet/native-host.py")
        host.write_text(json.dumps({"name": "local.heed.meet", "path": "/elsewhere/native-host.py"}))
        heed_release.main(["migrate-native-hosts", "--home", str(self.root), "--new-root", "/new", "--old-root", str(old)])
        self.assertEqual(json.loads(host.read_text())["path"], "/elsewhere/native-host.py")


if __name__ == "__main__":
    unittest.main()
