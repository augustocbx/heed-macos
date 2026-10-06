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

    def test_same_owner_concurrent_retry_never_reclaims_live_stage(self):
        import hashlib
        import uuid
        owner = str(uuid.uuid4())
        content = b"complete"
        digest = hashlib.sha256(content).hexdigest()
        attempts = []
        outer = self

        class Interleaved(io.BytesIO):
            def read(self, size=-1):
                if not attempts:
                    try:
                        outer.fs.write("objects/" + digest, io.BytesIO(content), len(content), digest, owner)
                        attempts.append("unexpected success")
                    except module.ShareError:
                        attempts.append("busy")
                return super().read(size)

        self.fs.write("objects/" + digest, Interleaved(content), len(content), digest, owner)
        self.assertEqual(attempts, ["busy"])
        self.assertEqual((self.root / "objects" / digest).read_bytes(), content)

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


class TransactionTests(unittest.TestCase):
    def setUp(self):
        import uuid
        self.temp = tempfile.TemporaryDirectory(prefix="heed-smb-transaction-")
        self.base = Path(self.temp.name).resolve()
        self.root = self.base / "share"
        self.app = self.base / "private"
        self.root.mkdir(); self.app.mkdir()
        self.destination = str(uuid.uuid4())
        self.request = {"root": str(self.root), "identity": {"type": "smbfs", "fsid": "1:2", "sourceHash": "a" * 64, "mountPath": str(self.root), "readOnly": False}, "destinationId": self.destination, "operationId": str(uuid.uuid4()), "deviceId": str(uuid.uuid4()), "kind": "read"}
        (self.root / "heed-library.json").write_text(json.dumps({"format": "heed-portable-library", "schemaVersion": 2, "destinationId": self.destination}))
        self.calls = []
        self.transactions = []

    def tearDown(self):
        for tx in reversed(self.transactions): tx.close()
        self.temp.cleanup()

    def transaction(self, app=None, request=None, physical="11111111-1111-4111-8111-111111111111"):
        def probe(fd):
            self.calls.append(fd)
            return dict(self.request["identity"])
        if not hasattr(module, "Transaction"): self.fail("SMB v2 guardian is missing: no native ownership boundary")
        tx = module.Transaction(str(app or self.app), request or self.request, probe=probe, physical=lambda: physical, security=lambda path: {"security": "signed"})
        self.transactions.append(tx)
        return tx

    def test_single_claim_excludes_other_private_instance_and_live_same_owner(self):
        import uuid
        first = self.transaction()
        with self.assertRaises(module.ShareError): self.transaction()
        other = self.base / "other"; other.mkdir()
        request = {**self.request, "operationId": str(uuid.uuid4())}
        with self.assertRaises(module.ShareError): self.transaction(other, request)
        self.assertTrue((self.root / ".heed-v2-lease/owner.json").exists())
        self.assertTrue((self.root / "heed-library.json").exists())

    def test_unsupported_atomic_volume_refuses_before_remote_claim(self):
        from unittest.mock import patch
        with patch.object(module,'volume_atomic_operations',return_value=False):
            with self.assertRaisesRegex(module.ShareError,'unsupported-filesystem'):self.transaction()
        self.assertFalse((self.root/'.heed-v2-lease').exists())
        self.assertEqual(sorted(p.name for p in self.root.iterdir()),['heed-library.json'])

    def test_sigkill_known_owner_inode_before_claim_checkpoint_resumes_exact_prepared_operation(self):
        import subprocess,sys,select
        code=f"""import importlib.util,json,os,time
s=importlib.util.spec_from_file_location('native',{str(module.__file__)!r});m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
r=json.loads({json.dumps(self.request)!r});original=m.Transaction.write_all
def partial(fd,data):
 try:v=json.loads(data)
 except ValueError:v=None
 if isinstance(v,dict) and set(v)=={{'version','destinationId','deviceId','operationId','nonce'}}:
  os.write(fd,data[:10]);os.fsync(fd);print('owner-partial',flush=True);time.sleep(60)
 original(fd,data)
m.Transaction.write_all=staticmethod(partial)
m.Transaction({str(self.app)!r},r,probe=lambda fd:r['identity'],physical=lambda:'11111111-1111-4111-8111-111111111111',security=lambda p:{{'security':'signed'}})
"""
        child=subprocess.Popen([sys.executable,'-u','-c',code],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        try:
            self.assertTrue(select.select([child.stdout],[],[],5)[0]);self.assertEqual(child.stdout.readline(),b'owner-partial\n')
            child.kill();child.wait(timeout=5)
        finally:
            if child.poll() is None:child.kill()
            child.wait(timeout=5);child.stdout.close();child.stderr.close()
        tx=self.transaction();tx.checkpoint();tx.release()
        self.assertFalse((self.root/'.heed-v2-lease').exists())

    def test_sigterm_during_owner_create_waits_for_durable_inode_receipt(self):
        import subprocess,sys,select,signal
        code=f"""import importlib.util,json,os,time,signal,sys
s=importlib.util.spec_from_file_location('native',{str(module.__file__)!r});m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
signal.signal(signal.SIGTERM,lambda a,b:sys.exit(1))
r=json.loads({json.dumps(self.request)!r});original=m.os.open
def create(path,*args,**kwargs):
 fd=original(path,*args,**kwargs)
 if path=='owner.json':print('owner-created',flush=True);time.sleep(.3)
 return fd
m.os.open=create
m.Transaction({str(self.app)!r},r,probe=lambda fd:r['identity'],physical=lambda:'11111111-1111-4111-8111-111111111111',security=lambda p:{{'security':'signed'}})
"""
        child=subprocess.Popen([sys.executable,'-u','-c',code],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        try:
            self.assertTrue(select.select([child.stdout],[],[],5)[0]);self.assertEqual(child.stdout.readline(),b'owner-created\n')
            child.send_signal(signal.SIGTERM);child.wait(timeout=5)
            journal=json.loads(next((self.app/'library/catalog/transactions').glob('*.json')).read_text())
            self.assertIsNotNone(journal['receipt']['owner'])
        finally:
            if child.poll() is None:child.kill()
            child.wait(timeout=5);child.stdout.close();child.stderr.close()
        tx=self.transaction();tx.checkpoint();tx.release()
        self.assertFalse((self.root/'.heed-v2-lease').exists())

    def test_sigkill_before_owner_inode_receipt_never_adopts_unknown_allocation(self):
        import subprocess,sys,select
        code=f"""import importlib.util,json,os,time
s=importlib.util.spec_from_file_location('native',{str(module.__file__)!r});m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
r=json.loads({json.dumps(self.request)!r});original=m.os.open
def create(path,*args,**kwargs):
 fd=original(path,*args,**kwargs)
 if path=='owner.json':print('unknown-owner',flush=True);time.sleep(60)
 return fd
m.os.open=create
m.Transaction({str(self.app)!r},r,probe=lambda fd:r['identity'],physical=lambda:'11111111-1111-4111-8111-111111111111',security=lambda p:{{'security':'signed'}})
"""
        child=subprocess.Popen([sys.executable,'-u','-c',code],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        try:
            self.assertTrue(select.select([child.stdout],[],[],5)[0]);self.assertEqual(child.stdout.readline(),b'unknown-owner\n')
            child.kill();child.wait(timeout=5)
        finally:
            if child.poll() is None:child.kill()
            child.wait(timeout=5);child.stdout.close();child.stderr.close()
        owner=self.root/'.heed-v2-lease/owner.json';before=owner.stat().st_ino
        with self.assertRaises(module.ShareError):self.transaction()
        self.assertEqual(owner.stat().st_ino,before);self.assertEqual(owner.read_bytes(),b'')
        self.assertTrue(next((self.app/'library/catalog/transactions').glob('*.json')).exists())

    def test_uncheckpointed_death_preserves_claim_and_exact_dead_origin_can_resume(self):
        first = self.transaction()
        with self.assertRaises(module.ShareError): first.release()
        first.close()
        resumed = self.transaction()
        resumed.checkpoint(); resumed.release()
        self.assertFalse((self.root / ".heed-v2-lease").exists())
        self.assertEqual(list(self.root.glob(".heed-v2-released-*")), [])
        with self.assertRaises(module.ShareError): resumed.check()

    def test_copied_or_changed_physical_origin_fails_before_any_remote_probe(self):
        import shutil
        first = self.transaction(); first.close()
        copied = self.base / "copied"; shutil.copytree(self.app, copied)
        count = len(self.calls)
        with self.assertRaises(module.ShareError): self.transaction(copied)
        self.assertEqual(len(self.calls), count)
        with self.assertRaises(module.ShareError): self.transaction(physical="22222222-2222-4222-8222-222222222222")
        self.assertEqual(len(self.calls), count)
        self.assertTrue((self.root / ".heed-v2-lease/owner.json").exists())

    def test_guard_replacement_links_and_unknown_hardware_fail_before_remote_probe(self):
        first = self.transaction(); first.close()
        guard = self.app / "library/catalog/transactions" / (self.destination + ".guard")
        guard.rename(guard.with_suffix(".original")); guard.write_bytes(b"")
        count = len(self.calls)
        with self.assertRaises(module.ShareError): self.transaction()
        self.assertEqual(len(self.calls), count)
        guard.unlink(); guard.symlink_to(guard.with_suffix(".original"))
        with self.assertRaises(module.ShareError): self.transaction()
        self.assertEqual(len(self.calls), count)
        guard.unlink(); os.link(guard.with_suffix(".original"), guard)
        with self.assertRaises(module.ShareError): self.transaction()
        self.assertEqual(len(self.calls), count)
        with self.assertRaises(module.ShareError): self.transaction(physical="")
        self.assertEqual(len(self.calls), count)

    def test_real_second_process_cannot_resume_live_orphan_and_sigkill_then_allows_exact_recovery(self):
        import subprocess, sys, select
        source = str(Path(__file__).with_name("smb-filesystem.py"))
        code = f"import importlib.util,json,time\ns=importlib.util.spec_from_file_location('native',{source!r});m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nr=json.loads({json.dumps(self.request)!r})\nt=m.Transaction({str(self.app)!r},r,probe=lambda fd:r['identity'],physical=lambda:'11111111-1111-4111-8111-111111111111',security=lambda path:{{'security':'signed'}})\nprint('owned',flush=True)\ntime.sleep(60)"
        child = subprocess.Popen([sys.executable, '-u', '-c', code], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            self.assertTrue(select.select([child.stdout], [], [], 10)[0], 'fixture guardian did not become ready')
            self.assertEqual(child.stdout.readline().strip(), b'owned')
            count = len(self.calls)
            with self.assertRaises(module.ShareError): self.transaction()
            self.assertEqual(len(self.calls), count)
            child.kill(); child.wait(timeout=5)
            resumed = self.transaction(); resumed.checkpoint(); resumed.release()
            self.assertFalse((self.root / '.heed-v2-lease').exists())
        finally:
            if child.poll() is None: child.kill()
            child.wait(); child.stdout.close(); child.stderr.close()

    def test_claim_release_crash_after_atomic_rename_never_strands_active_lease(self):
        from unittest.mock import patch
        tx = self.transaction(); tx.checkpoint()
        original = module.exclusive_rename
        def crash(*args):
            original(*args)
            raise OSError('injected death after whole-claim rename')
        with patch.object(module, 'exclusive_rename', side_effect=crash):
            with self.assertRaises(OSError): tx.release()
        tx.close()
        self.assertFalse((self.root / '.heed-v2-lease').exists())
        self.assertEqual(len(list(self.root.glob('.heed-v2-released-*'))), 1)
        with self.assertRaises(module.ShareError): self.transaction()
        self.assertEqual(list(self.root.glob('.heed-v2-released-*')), [])

    def test_release_recovery_before_rename_after_owner_cleanup_and_after_directory_cleanup(self):
        from unittest.mock import patch
        for phase in ('before-rename', 'after-owner', 'after-directory'):
            with self.subTest(phase=phase):
                tx = self.transaction(); tx.checkpoint()
                if phase == 'before-rename':
                    with patch.object(module, 'exclusive_rename', side_effect=OSError('injected crash')):
                        with self.assertRaises(OSError): tx.release()
                elif phase == 'after-owner':
                    original = module.os.fsync
                    def fail(fd):
                        if (self.root / ('.heed-v2-released-' + tx.journal['nonce'])).exists() and not (self.root / ('.heed-v2-released-' + tx.journal['nonce']) / 'owner.json').exists():
                            raise OSError('injected crash')
                        return original(fd)
                    with patch.object(module.os, 'fsync', side_effect=fail):
                        with self.assertRaises(OSError): tx.release()
                else:
                    original = module.os.unlink
                    def fail(name, **kwargs):
                        if name == tx.journal_name: raise OSError('injected crash')
                        return original(name, **kwargs)
                    with patch.object(module.os, 'unlink', side_effect=fail):
                        with self.assertRaises(OSError): tx.release()
                tx.close()
                with self.assertRaises(module.ShareError): self.transaction()
                self.assertFalse((self.root / '.heed-v2-lease').exists())
                self.assertEqual(list(self.root.glob('.heed-v2-released-*')), [])
                self.assertFalse((self.app / 'library/catalog/transactions' / tx.journal_name).exists())

    def test_private_catalog_parent_replacement_and_unknown_hardware_block_before_effects(self):
        tx = self.transaction()
        catalog = self.app / 'library/catalog/transactions'
        catalog.rename(catalog.with_name('original-transactions')); catalog.mkdir()
        with self.assertRaises(module.ShareError): tx.check()
        # Separate fresh private instance proves unavailable hardware is itself
        # refused before mount probing, independently of a malformed guard.
        other = self.base / 'no-hardware'; other.mkdir()
        count = len(self.calls)
        with self.assertRaises(module.ShareError): self.transaction(other, physical='')
        self.assertEqual(len(self.calls), count)

    def test_exact_quarantine_recovery_after_rename_and_unlink_never_broadens_targets(self):
        from unittest.mock import patch
        tx = self.deletion(); target = self.record['artifacts'][0]
        original = module.exclusive_rename
        def crash(*args):
            original(*args)
            raise OSError('injected death after quarantine rename')
        with patch.object(module, 'exclusive_rename', side_effect=crash):
            with self.assertRaises(OSError): tx.remove_exact(self.record['jobId'], target)
        tx.close(); resumed = self.transaction()
        self.assertEqual(resumed.remove_exact(self.record['jobId'], target), 'removed')
        payload = self.record['artifacts'][1]
        original = module.os.fsync
        def fail(fd):
            if not (self.root / payload['path']).exists() and not list((self.root / 'control/quarantine' / self.record['jobId']).iterdir()):
                raise OSError('injected lost unlink acknowledgement')
            return original(fd)
        with patch.object(module.os, 'fsync', side_effect=fail):
            with self.assertRaises(OSError): resumed.remove_exact(self.record['jobId'], payload)
        resumed.close(); again = self.transaction()
        self.assertEqual(again.remove_exact(self.record['jobId'], payload), 'already-removed')
        self.assertEqual((self.root / self.record['artifacts'][2]['path']).read_bytes(), self.manifest_bytes)

    def test_legacy_header_rejects_v2_and_read_only_or_unknown_security_cannot_claim(self):
        fs = module.SafeShare(str(self.root), self.request['identity'], probe=lambda fd:self.request['identity'])
        try:
            with self.assertRaises(module.ShareError): fs.header()
        finally: fs.close()
        self.request['readOnly'] = True
        with self.assertRaises(module.ShareError): self.transaction()
        self.assertFalse((self.root / '.heed-v2-lease').exists())
        self.request['readOnly'] = False
        with self.assertRaises(module.ShareError): module.Transaction(str(self.app), self.request, probe=lambda fd:self.request['identity'], physical=lambda:'11111111-1111-4111-8111-111111111111', security=lambda path:{'security':'unknown'})
        self.assertFalse((self.root / '.heed-v2-lease').exists())

    def test_guardian_recovers_only_exact_owned_private_staging(self):
        tx = self.transaction()
        temporary = self.app / 'library/catalog/transactions' / ('.' + tx.journal_name + '.' + tx.journal['nonce'])
        temporary.write_text(json.dumps(tx.journal))
        tx.checkpoint()
        self.assertFalse(temporary.exists())
        temporary.write_text('{}')
        with self.assertRaises(module.ShareError): tx.checkpoint()
        self.assertEqual(temporary.read_text(), '{}')

    def bundle(self):
        import uuid, hashlib
        self.meeting = str(uuid.uuid4()); self.revision = str(uuid.uuid4()); self.library = str(uuid.uuid4())
        self.prefix = 'meetings/' + self.meeting + '/revisions/' + self.revision
        self.payload = json.dumps({'schemaVersion': 1, 'meetingId': self.meeting, 'title': 'Synthetic', 'audio': None}, separators=(',', ':')).encode()
        self.manifest = {'schemaVersion': 1, 'libraryId': self.library, 'meetingId': self.meeting, 'revisionId': self.revision, 'parents': [], 'artifacts': [{'path': 'meeting.json', 'bytes': len(self.payload), 'sha256': hashlib.sha256(self.payload).hexdigest()}]}
        self.manifest_bytes = json.dumps(self.manifest, separators=(',', ':')).encode()
        self.marker = {'schemaVersion': 1, 'libraryId': self.library, 'meetingId': self.meeting, 'revisionId': self.revision, 'deviceId': self.request['deviceId'], 'manifestPath': self.prefix + '/manifest.json', 'manifestHash': hashlib.sha256(self.manifest_bytes).hexdigest()}
        self.marker_bytes = json.dumps(self.marker, separators=(',', ':')).encode()
        self.marker_path = 'commits/' + self.marker['deviceId'] + '/' + self.revision + '.json'
        self.request['kind'] = 'publish'
        return self.transaction()

    def put(self, tx, path, data):
        import hashlib
        tx.write(path, io.BytesIO(data), len(data), hashlib.sha256(data).hexdigest())

    def publication(self):
        tx = self.bundle()
        self.put(tx, self.prefix + '/manifest.json', self.manifest_bytes)
        self.put(tx, self.prefix + '/meeting.json', self.payload)
        self.put(tx, self.marker_path, self.marker_bytes)
        tx.checkpoint(); tx.release(); tx.close()
        return tx

    def deletion(self):
        import uuid, hashlib
        self.publication()
        self.request.update(kind='delete', operationId=str(uuid.uuid4()))
        tx = self.transaction()
        self.record = {'version': 1, 'jobId': self.request['operationId'], 'destinationId': self.destination, 'revisions': [{k: self.marker[k] for k in ('libraryId', 'meetingId', 'revisionId', 'manifestHash')} | {'parents': []}], 'artifacts': [{'path': path, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()} for path, data in [(self.marker_path, self.marker_bytes), (self.prefix + '/meeting.json', self.payload), (self.prefix + '/manifest.json', self.manifest_bytes)]]}
        tx.write_deletion(self.record)
        return tx

    def test_exclusive_admission_precedes_payload_and_collisions_never_restore_or_overwrite(self):
        tx = self.bundle()
        with self.assertRaises(module.ShareError): self.put(tx, self.prefix + '/meeting.json', self.payload)
        self.assertFalse((self.root / self.prefix / 'meeting.json').exists())
        self.put(tx, self.prefix + '/manifest.json', self.manifest_bytes)
        self.put(tx, self.prefix + '/manifest.json', self.manifest_bytes)
        tx.checkpoint(); tx.release(); tx.close()
        import uuid
        self.request['operationId'] = str(uuid.uuid4())
        other = self.transaction()
        with self.assertRaises(module.ShareError): self.put(other, self.prefix + '/manifest.json', self.manifest_bytes)
        self.assertEqual((self.root / self.prefix / 'manifest.json').read_bytes(), self.manifest_bytes)

    def test_inventory_pending_controls_and_every_effect_invalidates_checkpoint(self):
        tx = self.bundle()
        self.put(tx, self.prefix + '/manifest.json', self.manifest_bytes)
        intent = {'version': 1, 'id': self.revision, 'deviceId': self.request['deviceId'], 'revision': {k: self.marker[k] for k in ('libraryId', 'meetingId', 'revisionId')}}
        tx.checkpoint(); tx.write_pending(intent)
        with self.assertRaises(module.ShareError): tx.release()
        self.assertEqual(tx.inventory()['pending'], [intent])
        self.put(tx, self.prefix + '/meeting.json', self.payload); self.put(tx, self.marker_path, self.marker_bytes)
        self.assertEqual(tx.inventory()['commits'], [self.marker])
        tx.checkpoint(); tx.retire_pending(intent)
        with self.assertRaises(module.ShareError): tx.release()
        self.assertEqual(tx.inventory()['pending'], [])
        (self.root / 'control/pending/unknown').write_text('{}')
        with self.assertRaises(module.ShareError): tx.inventory()

    def test_exact_metadata_unlink_fence_retry_and_shared_audio_never_removed(self):
        import hashlib, uuid
        tx = self.deletion()
        for artifact in self.record['artifacts']:
            self.assertEqual(tx.remove_exact(self.record['jobId'], artifact), 'removed')
            self.assertFalse((self.root / artifact['path']).exists())
            self.assertEqual(tx.remove_exact(self.record['jobId'], artifact), 'already-removed')
        fence = {'kind': 'heed-deleted-revision', 'version': 1, 'jobId': self.record['jobId'], 'destinationId': self.destination, 'revision': self.record['revisions'][0], 'artifact': self.record['artifacts'][-1]}
        tx.write_fence(fence); tx.write_fence(fence)
        self.assertEqual(tx.remove_exact(self.record['jobId'], self.record['artifacts'][-1]), 'already-removed')
        audio = b'known audio'; digest = hashlib.sha256(audio).hexdigest()
        (self.root / 'objects').mkdir(); (self.root / 'objects' / digest).write_bytes(audio)
        with self.assertRaises(module.ShareError): tx.remove_exact(self.record['jobId'], {'path': 'objects/' + digest, 'bytes': len(audio), 'sha256': digest})
        self.assertEqual((self.root / 'objects' / digest).read_bytes(), audio)
        tx.checkpoint(); tx.release(); tx.close()
        self.request.update(kind='publish', operationId=str(uuid.uuid4()), deviceId=str(uuid.uuid4()))
        fresh = self.transaction()
        with self.assertRaises(module.ShareError): self.put(fresh, self.prefix + '/manifest.json', self.manifest_bytes)
        with self.assertRaises(module.ShareError): self.put(fresh, self.prefix + '/meeting.json', self.payload)
        self.assertEqual(fresh.inventory()['commits'], [])
        self.assertEqual(fresh.inventory()['deletions'], [self.record])

    def test_mid_stream_header_swap_never_publishes_payload_or_commit(self):
        tx = self.bundle(); outer = self
        class SwapHeader(io.BytesIO):
            def read(self, size=-1):
                (outer.root / 'heed-library.json').write_text(json.dumps({'format':'heed-portable-library', 'schemaVersion':2, 'destinationId':'22222222-2222-4222-8222-222222222222'}))
                return super().read(size)
        import hashlib
        with self.assertRaises(module.ShareError): tx.write(self.prefix + '/manifest.json', SwapHeader(self.manifest_bytes), len(self.manifest_bytes), hashlib.sha256(self.manifest_bytes).hexdigest())
        self.assertFalse((self.root / self.marker_path).exists())
        self.assertFalse((self.root / self.prefix / 'meeting.json').exists())

    def test_unknown_control_quarantine_and_hidden_entries_block_destructive_inventory(self):
        tx = self.deletion()
        quarantine = self.root / 'control/quarantine' / self.record['jobId']; quarantine.mkdir(parents=True)
        (quarantine / 'unknown').write_bytes(b'preserve')
        with self.assertRaises(module.ShareError): tx.inventory()
        self.assertEqual((quarantine / 'unknown').read_bytes(), b'preserve')
        (quarantine / 'unknown').unlink()
        (self.root / 'control/deletions/.heed-unknown').write_bytes(b'preserve')
        with self.assertRaises(module.ShareError): tx.inventory()
        self.assertEqual((self.root / 'control/deletions/.heed-unknown').read_bytes(), b'preserve')

    def test_partial_caller_frame_never_creates_canonical_admission(self):
        import hashlib
        tx = self.bundle()
        with self.assertRaises(module.ShareError): tx.write(self.prefix + '/manifest.json', io.BytesIO(self.manifest_bytes[:10]), len(self.manifest_bytes), hashlib.sha256(self.manifest_bytes).hexdigest())
        self.assertFalse((self.root / self.prefix / 'manifest.json').exists())
        tx.checkpoint(); tx.release()
        self.assertFalse((self.root / '.heed-v2-lease').exists())
        self.assertFalse((self.root / self.marker_path).exists())

    def test_interrupted_admission_stage_is_not_visible_and_original_inode_can_resume(self):
        tx = self.bundle(); original = tx.write_all
        def interrupted(fd, data):
            if data != self.manifest_bytes: return original(fd, data)
            os.write(fd, data[:10]); os.fsync(fd)
            raise InterruptedError('synthetic interruption')
        tx.write_all = interrupted
        with self.assertRaises(InterruptedError): self.put(tx, self.prefix + '/manifest.json', self.manifest_bytes)
        self.assertFalse((self.root / self.prefix / 'manifest.json').exists())
        with self.assertRaises(module.ShareError): tx.checkpoint()
        tx.close(); resumed = self.transaction()
        self.put(resumed, self.prefix + '/manifest.json', self.manifest_bytes)
        self.assertEqual((self.root / self.prefix / 'manifest.json').read_bytes(), self.manifest_bytes)
        resumed.checkpoint(); resumed.release()

    def test_interrupted_fence_stage_is_not_visible_and_exact_delete_owner_can_resume(self):
        tx = self.deletion()
        for item in self.record['artifacts']: tx.remove_exact(self.record['jobId'], item)
        fence = {'kind':'heed-deleted-revision','version':1,'jobId':self.record['jobId'],'destinationId':self.destination,'revision':self.record['revisions'][0],'artifact':self.record['artifacts'][-1]}
        original = tx.write_all
        def interrupted(fd, data):
            if data != module.json_bytes(fence): return original(fd, data)
            os.write(fd, data[:10]); os.fsync(fd)
            raise InterruptedError('synthetic interruption')
        tx.write_all = interrupted
        with self.assertRaises(InterruptedError): tx.write_fence(fence)
        self.assertFalse((self.root / fence['artifact']['path']).exists())
        tx.close(); resumed = self.transaction()
        resumed.write_fence(fence); resumed.checkpoint(); resumed.release()
        self.assertEqual(json.loads((self.root / fence['artifact']['path']).read_bytes()), fence)

    def killed_canonical_writer(self, fence=False, after_rename=False, before_receipt=False, terminate=False):
        import subprocess, sys, select
        tx = self.deletion() if fence else self.bundle(); tx.close()
        value = {'kind':'heed-deleted-revision','version':1,'jobId':self.record['jobId'],'destinationId':self.destination,'revision':self.record['revisions'][0],'artifact':self.record['artifacts'][-1]} if fence else None
        if fence:
            tx = self.transaction()
            for item in self.record['artifacts']: tx.remove_exact(self.record['jobId'], item)
            tx.close()
        expected = module.json_bytes(value) if fence else self.manifest_bytes
        code = f"""import importlib.util,json,os,time,signal,sys
s=importlib.util.spec_from_file_location('native',{str(module.__file__)!r});m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
signal.signal(signal.SIGTERM,lambda a,b:sys.exit(1))
r=json.loads({json.dumps(self.request)!r});t=m.Transaction({str(self.app)!r},r,probe=lambda fd:r['identity'],physical=lambda:'11111111-1111-4111-8111-111111111111',security=lambda p:{{'security':'signed'}})
expected={expected!r}
original=t.write_all
def stop():
 print('interrupted',flush=True);time.sleep(.3 if {terminate!r} else 60)
def write(fd,data):
 if data==expected and not {after_rename!r} and not {before_receipt!r}:
  os.write(fd,data[:10]);os.fsync(fd);stop()
 return original(fd,data)
t.write_all=write
rename=m.exclusive_rename
def renamed(*args):
 rename(*args)
 if args[-1]=='manifest.json' and {after_rename!r}:stop()
m.exclusive_rename=renamed
save=t.save_journal
def saved():
 if {before_receipt!r} and any(a.get('inode') is not None for a in t.journal['admissions'].values()):stop()
 save()
t.save_journal=saved
"""
        code += f"t.write_fence(json.loads({json.dumps(value)!r}))\n" if fence else f"import io,hashlib\nt.write({self.prefix + '/manifest.json'!r},io.BytesIO(expected),len(expected),hashlib.sha256(expected).hexdigest())\n"
        child = subprocess.Popen([sys.executable,'-u','-c',code],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        try:
            self.assertTrue(select.select([child.stdout],[],[],5)[0]);self.assertEqual(child.stdout.readline(),b'interrupted\n')
            self.assertEqual((self.root/self.prefix/'manifest.json').exists(),after_rename)
            with self.assertRaises(module.ShareError): self.transaction()
            if terminate:child.terminate()
            else:child.kill()
            child.wait(timeout=5)
        finally:
            if child.poll() is None:child.kill()
            child.wait(timeout=5);child.stdout.close();child.stderr.close()
        return value

    def test_sigkill_partial_pinned_admission_stage_original_owner_resumes(self):
        self.killed_canonical_writer()
        tx=self.transaction();self.put(tx,self.prefix+'/manifest.json',self.manifest_bytes);tx.checkpoint();tx.release()
        self.assertEqual((self.root/self.prefix/'manifest.json').read_bytes(),self.manifest_bytes)

    def test_sigkill_after_exclusive_admission_rename_original_inode_resumes(self):
        self.killed_canonical_writer(after_rename=True)
        tx=self.transaction();self.put(tx,self.prefix+'/manifest.json',self.manifest_bytes);tx.checkpoint();tx.release()
        self.assertEqual((self.root/self.prefix/'manifest.json').read_bytes(),self.manifest_bytes)

    def test_sigkill_partial_pinned_fence_stage_original_delete_owner_resumes(self):
        fence=self.killed_canonical_writer(fence=True)
        tx=self.transaction();tx.write_fence(fence);tx.checkpoint();tx.release()
        self.assertEqual(json.loads((self.root/self.prefix/'manifest.json').read_bytes()),fence)

    def test_sigterm_before_admission_receipt_is_deferred_until_inode_proof_is_durable(self):
        self.killed_canonical_writer(before_receipt=True,terminate=True)
        tx=self.transaction();self.put(tx,self.prefix+'/manifest.json',self.manifest_bytes);tx.checkpoint();tx.release()
        self.assertEqual((self.root/self.prefix/'manifest.json').read_bytes(),self.manifest_bytes)

    def test_sigkill_create_before_inode_receipt_preserves_unknown_stage_without_publication(self):
        self.killed_canonical_writer(before_receipt=True)
        tx=self.transaction();stages=list((self.root/self.prefix).glob('.heed-*.stage'))
        self.assertEqual(len(stages),1)
        with self.assertRaises(module.ShareError):self.put(tx,self.prefix+'/manifest.json',self.manifest_bytes)
        with self.assertRaises(module.ShareError):tx.checkpoint()
        self.assertTrue(stages[0].exists());self.assertFalse((self.root/self.prefix/'manifest.json').exists())

    def test_quarantine_allocation_failure_does_not_leak_parent_descriptor(self):
        tx=self.deletion();original=tx.fs.directory
        def directory(parts, create=False):
            if parts[:2]==['control','quarantine']:raise OSError('injected allocation failure')
            return original(parts,create)
        tx.fs.directory=directory
        before=len(os.listdir('/dev/fd'))
        for _ in range(20):
            with self.assertRaises(OSError):tx.remove_exact(self.record['jobId'],self.record['artifacts'][0])
        self.assertEqual(len(os.listdir('/dev/fd')),before)
        self.assertTrue((self.root/self.record['artifacts'][0]['path']).exists())

    def test_changed_pinned_staging_prefix_is_never_repaired_or_unlinked(self):
        tx=self.bundle();original=tx.write_all
        def interrupted(fd,data):
            if data==self.manifest_bytes:os.write(fd,data[:10]);raise InterruptedError('interrupted')
            return original(fd,data)
        tx.write_all=interrupted
        with self.assertRaises(InterruptedError):self.put(tx,self.prefix+'/manifest.json',self.manifest_bytes)
        stage=next((self.root/self.prefix).glob('.heed-*.stage'));stage.write_bytes(b'foreign')
        tx.close();resumed=self.transaction()
        with self.assertRaises(module.ShareError):self.put(resumed,self.prefix+'/manifest.json',self.manifest_bytes)
        self.assertEqual(stage.read_bytes(),b'foreign');self.assertFalse((self.root/self.prefix/'manifest.json').exists())

    def test_quarantine_hash_failure_retains_unexpected_source_and_claim(self):
        tx = self.deletion(); artifact = self.record['artifacts'][0]
        (self.root / artifact['path']).write_bytes(b'unexpected')
        with self.assertRaises(module.ShareError): tx.remove_exact(self.record['jobId'], artifact)
        self.assertEqual((self.root / artifact['path']).read_bytes(), b'unexpected')
        self.assertTrue((self.root / '.heed-v2-lease/owner.json').exists())
        with self.assertRaises(module.ShareError): tx.release()

    def test_mid_stream_guard_replacement_stops_before_publication(self):
        tx = self.bundle(); outer = self
        class ReplaceGuard(io.BytesIO):
            def read(self, size=-1):
                if not hasattr(self, 'changed'):
                    self.changed = True
                    guard = outer.app / 'library/catalog/transactions' / (outer.destination + '.guard')
                    guard.rename(guard.with_suffix('.old')); guard.write_bytes(b'')
                return super().read(size)
        import hashlib
        with self.assertRaises(module.ShareError): tx.write(self.prefix + '/manifest.json', ReplaceGuard(self.manifest_bytes), len(self.manifest_bytes), hashlib.sha256(self.manifest_bytes).hexdigest())
        self.assertFalse((self.root / self.prefix / 'meeting.json').exists())

    def test_unknown_claim_contents_prevent_release_without_losing_owner_record(self):
        tx = self.transaction(); tx.checkpoint()
        (self.root / ".heed-v2-lease/unknown").write_bytes(b"preserve")
        with self.assertRaises(module.ShareError): tx.release()
        self.assertTrue((self.root / ".heed-v2-lease/owner.json").exists())
        self.assertEqual((self.root / ".heed-v2-lease/unknown").read_bytes(), b"preserve")


if __name__ == "__main__":
    unittest.main()
