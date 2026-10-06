"""Synthetic filesystem fixtures; never mount or enumerate a real SMB share."""
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("smb_filesystem", Path(__file__).with_name("smb-filesystem.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FilesystemTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.mount = {"type": "smbfs", "fsid": "1:2", "sourceHash": "a" * 64, "mountPath": str(self.root), "readOnly": False}
        self.fs = module.SafeShare(str(self.root), self.mount, probe=lambda fd: dict(self.mount))

    def tearDown(self):
        self.fs.close()
        self.temp.cleanup()

    def test_component_containment_and_symlinks(self):
        for path in ("../x", "/x", "objects/../x", "objects//x", "objects/%2e", "objects\\x"):
            with self.assertRaises(module.ShareError):
                self.fs.read(path, 10)
        (self.root / "objects").symlink_to(Path(tempfile.gettempdir()))
        with self.assertRaises((module.ShareError, OSError)):
            self.fs.read("objects/x", 10)

    def test_immutable_publication_and_bounded_read(self):
        import hashlib
        content = b"complete transcript"
        hash_value = hashlib.sha256(content).hexdigest()
        self.fs.write("meetings/a/meeting.json", io.BytesIO(content), len(content), hash_value)
        self.assertEqual(self.fs.read("meetings/a/meeting.json", len(content)), content)
        self.fs.write("meetings/a/meeting.json", io.BytesIO(content), len(content), hash_value)
        with self.assertRaises(module.ShareError):
            self.fs.write("meetings/a/meeting.json", io.BytesIO(b"different"), 9, hashlib.sha256(b"different").hexdigest())
        with self.assertRaises(module.ShareError):
            self.fs.read("meetings/a/meeting.json", 3)

    def test_short_overrun_or_wrong_hash_never_commit(self):
        for content, count, hash_value in [(b"x", 2, "a" * 64), (b"xxx", 2, "a" * 64), (b"xx", 2, "a" * 64)]:
            with self.assertRaises(module.ShareError):
                self.fs.write("objects/test", io.BytesIO(content), count, hash_value)
            self.assertFalse((self.root / "objects/test").exists())
            self.assertEqual(list((self.root / "objects").glob(".heed-*")), [])

    def test_mount_loss_replacement_and_read_only_fail_before_writes(self):
        for changes in ({"type": "apfs"}, {"fsid": "3:4"}, {"sourceHash": "b" * 64}, {"readOnly": True}):
            original = dict(self.mount)
            self.mount.update(changes)
            with self.assertRaises(module.ShareError):
                self.fs.write("objects/x", io.BytesIO(b"x"), 1, "a" * 64)
            self.assertFalse((self.root / "objects").exists())
            self.mount.update(original)

    def test_root_replacement_uses_old_descriptor_never_new_local_folder(self):
        import hashlib
        moved = self.root.with_name(self.root.name + "-old")
        self.root.rename(moved)
        self.root.mkdir()
        try:
            self.fs.write("objects/x", io.BytesIO(b"x"), 1, hashlib.sha256(b"x").hexdigest())
            self.assertFalse((self.root / "objects").exists())
            self.assertTrue((moved / "objects/x").exists())
        finally:
            import shutil
            shutil.rmtree(moved)

    def test_security_flags_are_active_not_supported(self):
        for value in [{"SIGNING_SUPPORTED": True}, {"ENCRYPTION_SUPPORTED": True}, {"SMB_VERSION": "SMB_1", "SIGNING_ON": True}]:
            self.assertEqual(module.security_capabilities([value])["security"], "unknown")
        signed = module.security_capabilities([{"SMB_VERSION": "SMB_3.1.1", "SIGNING_ON": True}])
        self.assertEqual(signed["security"], "signed")
        encrypted = module.security_capabilities([{"SMB_VERSION": "SMB_3.0", "ENCRYPTION_REQUIRED": True}])
        self.assertEqual(encrypted["security"], "encrypted")
        self.assertEqual(module.security_capabilities([{ "SERVER_NAME": "private", "SMB_VERSION": "SMB_3.1.1", "SIGNING_ON": True}]), signed)

    def test_retry_reclaims_only_owned_interrupted_staging(self):
        import hashlib
        import uuid
        owner = str(uuid.uuid4())
        digest = hashlib.sha256(b"complete").hexdigest()
        (self.root / "objects").mkdir()
        temporary = self.root / "objects" / (".heed-" + owner + "-" + digest[:16])
        temporary.write_bytes(b"interrupted")
        other = self.root / "objects/.heed-other-device"
        other.write_bytes(b"retain")
        self.fs.write("objects/" + digest, io.BytesIO(b"complete"), 8, digest, owner)
        self.assertFalse(temporary.exists())
        self.assertEqual(other.read_bytes(), b"retain")
        self.assertEqual((self.root / "objects" / digest).read_bytes(), b"complete")

    @unittest.skipUnless(os.sys.platform == "darwin", "Public Darwin filesystem metadata")
    def test_native_statfs_rejects_fixture_local_volume(self):
        info = module.mounted_share(self.fs.fd)
        self.assertNotEqual(info["type"], "smbfs")
        self.assertRegex(info["sourceHash"], r"^[a-f0-9]{64}$")
        with self.assertRaises(module.ShareError):
            module.SafeShare(str(self.root))

    def test_discovery_is_bounded_no_symlink_or_partial(self):
        (self.root / "commits/a").mkdir(parents=True)
        (self.root / "commits/a/ok.json").write_text("{}")
        (self.root / "commits/a/.heed-partial").write_text("{}");
        self.assertEqual(self.fs.list_commits(10), ["commits/a/ok.json"])
        (self.root / "commits/b").symlink_to(self.root / "commits/a")
        with self.assertRaises((module.ShareError, OSError)):
            self.fs.list_commits(10)


if __name__ == "__main__":
    unittest.main()
