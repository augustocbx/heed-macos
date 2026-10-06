"""Offline dependency/runtime safety; fixtures contain public package bytes only."""

import importlib.util
import json
import shutil
import tempfile
import unittest
from pathlib import Path

MODULE = Path(__file__).with_name("runtime.py")


class RuntimeFixture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location("smb_runtime", MODULE)
        cls.runtime = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.runtime)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="heed-smb-runtime-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        source = Path(__file__).resolve().parent
        self.payload = self.root / "packages/server/native/smb-direct"
        self.payload.mkdir(parents=True)
        for name in ("wheel-manifest.json", "requirements.lock"):
            shutil.copyfile(source / name, self.payload / name)
        shutil.copytree(source / "wheels", self.payload / "wheels")

    def manifest(self, change):
        path = self.payload / "wheel-manifest.json"
        value = json.loads(path.read_text())
        change(value)
        path.write_text(json.dumps(value))

    def rejected(self, code):
        with self.assertRaises(self.runtime.RuntimeFailure) as caught:
            self.runtime.verify_payload(self.root)
        self.assertEqual(caught.exception.code, code)


class PayloadTests(RuntimeFixture):
    def test_complete_hash_locked_payload_has_only_five_pinned_packages(self):
        value = self.runtime.verify_payload(self.root)
        self.assertEqual(value["python"], "3.12")
        self.assertEqual(value["architecture"], "arm64")
        self.assertEqual(value["minimumMacOS"], "14.0")
        self.assertEqual(
            {x["name"]: x["version"] for x in value["wheels"]},
            {
                "smbprotocol": "1.17.0",
                "cryptography": "50.0.2",
                "pyspnego": "0.12.4",
                "cffi": "2.1.1",
                "pycparser": "3.0",
            },
        )

    def test_missing_wheel_refuses_without_creating_runtime(self):
        next((self.payload / "wheels").iterdir()).unlink()
        self.rejected("payload-invalid")
        self.assertFalse((self.root / "runtime").exists())

    def test_extra_wheel_refuses_without_adopting_an_unreviewed_package(self):
        (self.payload / "wheels/unreviewed.whl").write_bytes(b"public sentinel")
        self.rejected("payload-invalid")

    def test_corrupt_wheel_and_rewritten_hash_lock_refuse(self):
        wheel = next((self.payload / "wheels").iterdir())
        wheel.write_bytes(wheel.read_bytes() + b"corrupt")
        self.rejected("payload-invalid")

    def test_replaced_wheel_symlink_refuses(self):
        wheel = next((self.payload / "wheels").iterdir())
        outside = self.root / "outside.whl"
        wheel.rename(outside)
        wheel.symlink_to(outside)
        self.rejected("payload-invalid")

    def test_wrong_python_architecture_and_minimum_os_metadata_refuse(self):
        for key, value in (
            ("python", "3.14"),
            ("architecture", "x86_64"),
            ("minimumMacOS", "15.0"),
        ):
            with self.subTest(key=key):
                original = (self.payload / "wheel-manifest.json").read_bytes()
                self.manifest(lambda manifest: manifest.__setitem__(key, value))
                self.rejected("payload-invalid")
                (self.payload / "wheel-manifest.json").write_bytes(original)

    def test_incompatible_platform_tag_refuses_even_with_correct_package_name(self):
        self.manifest(
            lambda manifest: manifest["wheels"][0].__setitem__(
                "tags", ["cp312-cp312-win_amd64"]
            )
        )
        self.rejected("payload-invalid")

    def test_requirements_lock_cannot_omit_hashes_or_dependencies(self):
        (self.payload / "requirements.lock").write_text("smbprotocol==1.17.0\n")
        self.rejected("payload-invalid")

    def test_receiptless_or_substituted_runtime_is_unavailable(self):
        target = self.root / "runtime/smb"
        target.mkdir(parents=True)
        (target / "private-sentinel").write_text("preserve prior runtime")
        with self.assertRaises(self.runtime.RuntimeFailure) as caught:
            self.runtime.verify_runtime(self.root)
        self.assertEqual(caught.exception.code, "runtime-unavailable")
        self.assertEqual(
            (target / "private-sentinel").read_text(), "preserve prior runtime"
        )

    def test_missing_base_preserves_old_runtime_without_pip_or_download(self):
        target = self.root / "runtime/smb"
        target.mkdir(parents=True)
        sentinel = target / "private-sentinel"
        sentinel.write_text("preserve prior runtime")
        with self.assertRaises(self.runtime.RuntimeFailure):
            self.runtime.install_runtime(self.root, self.root / "missing-python")
        self.assertEqual(sentinel.read_text(), "preserve prior runtime")


class InstallTests(RuntimeFixture):
    # Real isolated interpreter + public offline wheels; no SMB endpoint or account.
    def setUp(self):
        super().setUp()
        for source in MODULE.parent.glob("*.py"):
            if not source.name.startswith("test_"):
                shutil.copyfile(source, self.payload / source.name)
        self.python = Path(
            __import__("os").environ.get(
                "HEED_SMB_PYTHON", "/opt/homebrew/bin/python3.12"
            )
        )
        if not self.python.exists():
            self.python = Path(__import__("sys").executable)

    def test_offline_install_detaches_and_checks_real_sdk(self):
        receipt = self.runtime.install_runtime(self.root, self.python)
        self.assertEqual(receipt["schemaVersion"], 1)
        self.assertEqual(self.runtime.verify_runtime(self.root)["python"], "3.12")
        result = __import__("subprocess").run(
            [
                str(self.root / "runtime/smb/bin/python"),
                "-I",
                "-B",
                str(self.payload / "runtime.py"),
                "self-test",
                str(self.root),
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(__import__("json").loads(result.stdout), {"ok": True})

    def test_selftest_failure_preserves_old_runtime_and_cleans_staging(self):
        (self.payload / "transport.py").write_text(
            "raise RuntimeError('private sentinel')\n"
        )
        previous = self.root / "previous-release/runtime/smb"
        previous.mkdir(parents=True)
        (previous / "sentinel").write_text("prior")
        with self.assertRaises(self.runtime.RuntimeFailure) as caught:
            self.runtime.install_runtime(self.root, self.python)
        self.assertEqual(caught.exception.code, "runtime-unavailable")
        self.assertEqual((previous / "sentinel").read_text(), "prior")
        self.assertEqual(list((self.root / "runtime").iterdir()), [])

    def test_offline_pip_failure_preserves_old_runtime(self):
        from unittest.mock import patch

        previous = self.root / "previous-release/runtime/smb"
        previous.mkdir(parents=True)
        (previous / "sentinel").write_text("prior")
        original, calls = self.runtime.run_checked, []

        def fail_pip(args, timeout=90):
            if "install" in args:
                calls.append(args)
                raise self.runtime.RuntimeFailure("runtime-unavailable")
            return original(args, timeout)

        with patch.object(self.runtime, "run_checked", side_effect=fail_pip):
            with self.assertRaises(self.runtime.RuntimeFailure):
                self.runtime.install_runtime(self.root, self.python)
        self.assertEqual(len(calls), 1)
        self.assertIn("--no-index", calls[0])
        self.assertIn("--require-hashes", calls[0])
        self.assertEqual((previous / "sentinel").read_text(), "prior")
        self.assertEqual(list((self.root / "runtime").iterdir()), [])

    def test_actual_wrong_interpreter_is_rejected_before_runtime_effects(self):
        other = self.root / "python"
        for key, value in (
            ("python", "3.14"),
            ("architecture", "x86_64"),
            ("macOS", "13.0"),
        ):
            with self.subTest(key=key):
                metadata = dict(
                    python="3.12", architecture="arm64", system="Darwin", macOS="27.0"
                )
                metadata[key] = value
                other.write_text(
                    "#!/bin/sh\nprintf '%s' '" + json.dumps(metadata) + "'\n"
                )
                other.chmod(0o700)
                with self.assertRaises(self.runtime.RuntimeFailure):
                    self.runtime.install_runtime(self.root, other)
                self.assertFalse((self.root / "runtime").exists())

    def test_substituted_executable_package_or_injected_pth_is_unavailable(self):
        self.runtime.install_runtime(self.root, self.python)
        target = self.root / "runtime/smb"
        site = target / "lib/python3.12/site-packages"
        for path in (target / "bin/python", site / "smbprotocol/connection.py"):
            with self.subTest(path=path.name):
                original = path.read_bytes()
                path.write_bytes(original + b"altered")
                with self.assertRaises(self.runtime.RuntimeFailure):
                    self.runtime.verify_runtime(self.root)
                path.write_bytes(original)
        injected = site / "unreviewed.pth"
        injected.write_text("import os\n")
        with self.assertRaises(self.runtime.RuntimeFailure):
            self.runtime.verify_runtime(self.root)
        injected.unlink()
        self.runtime.verify_runtime(self.root)

    def test_unverified_bytecode_cannot_replace_verified_source(self):
        self.runtime.install_runtime(self.root, self.python)
        cache = (
            self.root
            / "runtime/smb/lib/python3.12/site-packages/smbprotocol/__pycache__"
        )
        cache.mkdir()
        (cache / "connection.cpython-312.pyc").write_bytes(b"unreviewed code")
        with self.assertRaises(self.runtime.RuntimeFailure):
            self.runtime.verify_runtime(self.root)

    def test_helper_bytecode_cannot_bypass_verified_source(self):
        self.runtime.install_runtime(self.root, self.python)
        cache = self.payload / "__pycache__"
        cache.mkdir()
        (cache / "transport.cpython-312.pyc").write_bytes(b"unreviewed code")
        with self.assertRaises(self.runtime.RuntimeFailure):
            self.runtime.verify_runtime(self.root)


if __name__ == "__main__":
    unittest.main()
