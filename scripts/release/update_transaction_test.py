import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

try: import update_transaction as updater
except ModuleNotFoundError: updater = None
from installation_lock import InstallationLock
from release_updates import UpdateError


class TransactionTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(updater, 'Detached update coordination is missing')
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name) / '.heed'
        self.context = updater.UpdateContext(Path(__file__).resolve().parents[2], self.home,
                                             Path(self.temp.name)/'app', '1.0.0', 'a'*40, 'arm64', '14.0')
        self.manifest = {'schema':1, 'app':'heed', 'repository':'augustocbx/heed-macos', 'version':'1.2.0',
                         'tag':'v1.2.0','commit':'b'*40,'architectures':['arm64'],'minimumMacOS':'14.0',
                         'assets': {kind:{'name':name,'url':'https://github.com/augustocbx/heed-macos/releases/download/v1.2.0/'+name,
                                          'size':5,'sha256':'c'*64} for kind,name in [('installer','install.sh'),('payload','heed-macos-1.2.0-arm64.tar.gz')]}}
        self.release = {'manifest':self.manifest, 'notesURL':'https://github.com/augustocbx/heed-macos/releases/tag/v1.2.0'}
        self.calls=[]
        self.dependencies=updater.TransactionDependencies(
            activity=lambda ctx:{'maintenanceProtocol':2,'processingKinds':[]},
            maintenance=lambda ctx,owner,transaction,acquire:self.calls.append(('lease',acquire)),
            services=lambda ctx,version,commit:True,
            permissions=lambda ctx:self.report(),
            installer=lambda ctx,installer,payload,lock,transaction,owner:self.calls.append(('install',transaction)) or 0,
        )

    def report(self, **permissions):
        return {'controllerConnected':True,'updatedAt':__import__('time').time()*1000,
                'build':{'version':'1.2.0','commit':'b'*40,'instanceId':'new-menu'},
                'permissions':{'microphone':'authorized','screenCapture':True,'slackLogs':None,**permissions}}

    def fake_download(self, asset, destination, *args, **kwargs):
        Path(destination).write_bytes(b'fixture'); return Path(destination)

    def run_fixture(self):
        with patch('update_transaction.download_verified',side_effect=self.fake_download), \
             patch('update_transaction.validate_archive',return_value='heed-macos-1.2.0-arm64'), \
             patch('update_transaction.extract_payload',side_effect=lambda archive,directory,name: directory/name):
            return updater.run_update(self.context,self.release,self.dependencies)

    def test_success_requires_services_and_fresh_permissions_before_releasing_lease(self):
        state=self.run_fixture()
        self.assertEqual(state['phase'],'completed'); self.assertEqual(state['permissionState'],'authorized')
        self.assertEqual([call[0] for call in self.calls],['lease','install','lease'])
        self.assertFalse(self.calls[-1][1])
        self.assertEqual(updater.current_state(self.context)['transactionId'],state['transactionId'])

    def test_busy_requires_explicit_retry_and_never_invokes_installer(self):
        self.dependencies.activity=lambda ctx:{'maintenanceProtocol':2,'processingKinds':['notes']}
        state=self.run_fixture(); self.assertEqual(state['phase'],'waitingForIdle'); self.assertEqual(self.calls,[])
        self.dependencies.activity=lambda ctx:{'maintenanceProtocol':2,'processingKinds':[]}
        self.assertEqual(updater.current_state(self.context)['phase'],'waitingForIdle'); self.assertEqual(self.calls,[])

    def test_unsupported_activity_prevents_download_or_control(self):
        self.dependencies.activity=lambda ctx:{'processingKinds':[]}
        self.assertEqual(self.run_fixture()['errorCode'],'unsupported-maintenance'); self.assertEqual(self.calls,[])

    def test_failed_download_preserves_old_version_without_acquiring_maintenance(self):
        with patch('update_transaction.download_verified',side_effect=UpdateError('integrity-failed','bad digest')):
            state=updater.run_update(self.context,self.release,self.dependencies)
        self.assertEqual(state['phase'],'failed'); self.assertEqual(state['errorCode'],'integrity-failed')
        self.assertEqual(state['recovery'],'notReplaced'); self.assertEqual(self.calls,[])

    def test_installer_success_without_target_readiness_is_not_success(self):
        self.dependencies.services=lambda *args:False
        state=self.run_fixture(); self.assertEqual(state['phase'],'failed')
        self.assertEqual(state['recovery'],'recoveryRequired'); self.assertNotIn(('lease',False),self.calls)

    def test_missing_permissions_do_not_fail_verified_installation(self):
        self.dependencies.permissions=lambda ctx:self.report(microphone='denied')
        state=self.run_fixture(); self.assertEqual(state['phase'],'completed')
        self.assertEqual(state['permissionState'],'attention'); self.assertEqual(self.calls[-1],('lease',False))

    def test_permission_reports_require_exact_fresh_build_and_valid_required_values(self):
        for field,value in [('updatedAt',0),('controllerConnected',False),('build',{'version':'1.0.0','commit':'a'*40})]:
            report=self.report();report[field]=value
            self.assertEqual(updater.permission_outcome(report,'1.2.0','b'*40)['permissionState'],'unknown')
        self.assertEqual(updater.permission_outcome(self.report(microphone='restricted'),'1.2.0','b'*40)['permissionState'],'restricted')
        self.assertEqual(updater.permission_outcome(self.report(microphone='notDetermined'),'1.2.0','b'*40)['permissionState'],'attention')

    def test_concurrent_installer_prevents_update_and_recovery(self):
        with InstallationLock(self.home):
            with self.assertRaises(ValueError): updater.run_update(self.context,self.release,self.dependencies)
            with self.assertRaises(ValueError): updater.reconcile_transaction(self.context,self.dependencies)
        self.assertEqual(self.calls,[])

    def test_pinned_manifest_and_notes_revalidated_before_control(self):
        self.manifest['assets']['installer']['url']='https://untrusted.example/install.sh'
        self.assertEqual(self.run_fixture()['phase'],'failed'); self.assertEqual(self.calls,[])

    def test_symlinked_current_state_is_rejected_without_touching_private_file(self):
        self.home.mkdir(mode=0o700); outside=Path(self.temp.name)/'private';outside.write_text('preserve')
        (self.home/'update.json').symlink_to(outside)
        with self.assertRaises(ValueError): updater.current_state(self.context)
        self.assertEqual(outside.read_text(),'preserve')


if __name__ == '__main__': unittest.main()
