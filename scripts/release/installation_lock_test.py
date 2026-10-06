import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import json

try:
    import installation_lock as locks
except ModuleNotFoundError:
    locks = None


class LockTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(locks, 'The installation-wide lock has not been implemented')
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name) / '.heed'

    def test_two_independent_installers_cannot_overlap(self):
        with locks.InstallationLock(self.home):
            with self.assertRaises(locks.LockError):
                with locks.InstallationLock(self.home):
                    self.fail('Concurrent installation was admitted')
        with locks.InstallationLock(self.home):
            pass

    def test_borrowed_descriptor_closure_does_not_unlock_the_coordinator(self):
        with locks.InstallationLock(self.home) as coordinator:
            with locks.InstallationLock(self.home, coordinator.fd):
                pass
            with self.assertRaises(locks.LockError):
                with locks.InstallationLock(self.home):
                    self.fail('The installer released the coordinator lock')

    def test_child_keeps_lock_after_parent_closes_its_descriptor(self):
        code = ('import sys; from pathlib import Path; from installation_lock import InstallationLock; '
                'lock=InstallationLock(Path(sys.argv[1]),int(sys.argv[2])); lock.__enter__(); '
                'print("ready",flush=True); sys.stdin.readline(); lock.__exit__(None,None,None)')
        child = None
        try:
            with locks.InstallationLock(self.home) as parent:
                child = subprocess.Popen([sys.executable, '-c', code, str(self.home), str(parent.fd)],
                                         pass_fds=(parent.fd,), stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
                                         env={**os.environ, 'PYTHONPATH': str(Path(__file__).parent)})
                self.assertEqual(child.stdout.readline().strip(), 'ready')
            with self.assertRaises(locks.LockError):
                with locks.InstallationLock(self.home):
                    self.fail('A surviving installer lost its lock')
            child.communicate('\n', timeout=3)
            self.assertEqual(child.returncode, 0)
        finally:
            if child and child.poll() is None:
                child.kill(); child.wait()
        with locks.InstallationLock(self.home):
            pass

    def test_uninstall_cannot_remove_the_lock_inode_before_completing(self):
        self.home.mkdir()
        with locks.InstallationLock(self.home):
            shutil.rmtree(self.home)
            with self.assertRaises(locks.LockError):
                with locks.InstallationLock(self.home):
                    self.fail('Deleting runtime data bypassed the lock')

    def test_forged_closed_and_symlinked_lock_descriptors_are_refused(self):
        other = Path(self.temp.name) / 'other'; other.write_text('preserve')
        with other.open('r') as file:
            with self.assertRaises(locks.LockError):
                with locks.InstallationLock(self.home, file.fileno()):
                    pass
        with self.assertRaises(locks.LockError):
            with locks.InstallationLock(self.home, 98765):
                pass
        path = locks.lock_path(self.home); path.unlink(missing_ok=True); path.symlink_to(other)
        with self.assertRaises(locks.LockError):
            with locks.InstallationLock(self.home):
                pass
        self.assertEqual(other.read_text(), 'preserve')

    def test_cli_serializes_and_preserves_child_exit_status(self):
        command = [sys.executable, str(Path(__file__).with_name('installation_lock.py')), 'run', '--home', str(self.home), '--',
                   sys.executable, '-c', 'import sys;sys.exit(7)']
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(result.returncode, 7)
        with locks.InstallationLock(self.home):
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 7)
            self.assertIn('another installation', result.stderr)

    def payload(self):
        root = Path(self.temp.name) / 'payload'; root.mkdir()
        source = Path(__file__).resolve().parents[2]
        (root / 'scripts/release').mkdir(parents=True)
        for name in ['heed_release.py', 'installation_lock.py']:
            shutil.copy2(source / 'scripts/release' / name, root / 'scripts/release' / name)
        shutil.copy2(source / 'scripts/service_config.py', root / 'scripts/service_config.py')
        (root / 'config').mkdir(); shutil.copy2(source / 'config/service-ports.json', root / 'config/service-ports.json')
        shutil.copy2(source / 'scripts/release/install.sh', root / 'install.sh')
        (root / 'release.json').write_text(json.dumps({'app':'heed', 'version':'1.2.0', 'commit':'a'*40}))
        for binary in ['packages/transcription/native/heed-parakeet/.build/release/heed-parakeet',
                       'packages/transcription/native/heed-parakeet/.build/release/heed-syscap',
                       'packages/desktop/macos/.build/Heed', 'packages/desktop/native-keychain/.build/heed-keychain',
                       'packages/desktop/icloud-folder/.build/heed-icloud']:
            path=root/binary;path.parent.mkdir(parents=True,exist_ok=True);path.write_text('fixture')
        shims=Path(self.temp.name)/'shims';shims.mkdir()
        for name, body in [('uname','if [ "$1" = -m ]; then echo arm64; else echo Darwin; fi'),
                           ('sw_vers','echo 14.0'), ('xcode-select','exit 0'), ('brew','exit 1'), ('id','echo 501')]:
            path=shims/name;path.write_text('#!/bin/sh\n'+body+'\n');path.chmod(0o755)
        user=Path(self.temp.name)/'user';user.mkdir()
        return root, {**os.environ,'HOME':str(user),'HEED_HOME':str(self.home),'HEED_APP_DIR':str(user/'.heed-app'),
                      'PATH':str(shims)+':'+os.environ['PATH']}

    def test_real_installer_refuses_lock_contention_before_preparing_components(self):
        root, env=self.payload()
        with locks.InstallationLock(self.home):
            result=subprocess.run(['/bin/bash', str(root/'install.sh'), '--payload', str(root)],
                                  env=env, stdin=subprocess.DEVNULL, capture_output=True,text=True,timeout=10)
            self.assertNotEqual(result.returncode,0)
            self.assertIn('another installation',result.stdout+result.stderr)
            self.assertFalse((self.home/'runtime/versions').exists())

    def test_real_uninstaller_refuses_lock_contention_before_prompt_or_removal(self):
        root, env=self.payload(); (self.home/'runtime').mkdir(parents=True)
        (self.home/'runtime/current').symlink_to(root)
        with locks.InstallationLock(self.home):
            result=subprocess.run(['/bin/bash',str(Path(__file__).with_name('uninstall.sh'))],env=env,
                                  stdin=subprocess.DEVNULL,capture_output=True,text=True,timeout=10)
            self.assertNotEqual(result.returncode,0)
            self.assertIn('another installation',result.stdout+result.stderr)
            self.assertTrue((self.home/'runtime/current').is_symlink())


if __name__ == '__main__':
    unittest.main()
