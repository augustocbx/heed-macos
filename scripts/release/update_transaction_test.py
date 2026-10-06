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

    def test_production_configuration_returns_validated_ports_without_mutating_environment(self):
        with patch.dict(os.environ, {}, clear=True):
            before=dict(os.environ)
            ports=updater.configuration(self.context)
            self.assertEqual(ports,{'api':48100,'ui':48101,'transcription':48102})
            self.assertEqual(dict(os.environ),before)

    def test_production_maintenance_posts_to_the_implemented_recording_endpoint(self):
        import http.server
        import threading
        transaction='22222222-2222-4222-8222-222222222222';owner='test-owner'
        paths=[]
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(handler):
                identity={'service':'heed-api','protocolVersion':1,'checkoutRoot':str(self.context.root),'pid':os.getpid()}
                raw=json.dumps(identity).encode();handler.send_response(200);handler.end_headers();handler.wfile.write(raw)
            def do_POST(handler):
                paths.append(handler.path)
                body=json.loads(handler.rfile.read(int(handler.headers['Content-Length'])))
                self.assertEqual(body['transactionId'],transaction)
                valid=handler.path=='/api/recording/maintenance'
                raw=json.dumps({'maintenance':body['acquire'],'maintenanceProtocol':2,
                                'updateTransactionId':transaction if body['acquire'] else None}).encode()
                handler.send_response(200 if valid else 404);handler.end_headers();handler.wfile.write(raw)
            def log_message(handler,*args):pass
        for port in range(49152,65536):
            try:server=http.server.ThreadingHTTPServer(('127.0.0.1',port),Handler);break
            except OSError:pass
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            with patch.object(updater,'configuration',return_value={'api':port,'ui':port+1,'transcription':port+2}):
                updater.maintenance(self.context,owner,transaction,True)
                updater.maintenance(self.context,owner,transaction,False)
        finally:server.shutdown();server.server_close();thread.join()
        self.assertEqual(paths,['/api/recording/maintenance']*2)

    def test_separately_managed_transcription_is_refused_before_any_service_request(self):
        with patch.dict(os.environ,{'HEED_TRANSCRIPTION_URL':'http://127.0.0.1:49000'},clear=True), \
             patch.object(updater.heed_release,'service_identity') as probe:
            with self.assertRaisesRegex(UpdateError,'versioned transcription'):
                updater.activity(self.context)
        probe.assert_not_called()

    def test_busy_requires_explicit_retry_and_never_invokes_installer(self):
        self.dependencies.activity=lambda ctx:{'maintenanceProtocol':2,'processingKinds':['notes']}
        state=self.run_fixture(); self.assertEqual(state['phase'],'waitingForIdle'); self.assertEqual(self.calls,[])
        self.dependencies.activity=lambda ctx:{'maintenanceProtocol':2,'processingKinds':[]}
        self.assertEqual(updater.current_state(self.context)['phase'],'waitingForIdle'); self.assertEqual(self.calls,[])

    def test_unsupported_activity_prevents_download_or_control(self):
        self.dependencies.activity=lambda ctx:{'processingKinds':[]}
        self.assertEqual(self.run_fixture()['errorCode'],'unsupported-maintenance'); self.assertEqual(self.calls,[])

    def test_durable_recovery_intent_precedes_the_maintenance_request(self):
        def acquire(ctx,owner,transaction,held):
            if held:
                state=updater.current_state(ctx)
                self.assertEqual(state['recovery'],'recoveryRequired')
                self.assertEqual(state['owner'],owner)
                self.assertEqual(state['transactionId'],transaction)
        self.dependencies.maintenance=acquire
        self.assertEqual(self.run_fixture()['phase'],'completed')

    def test_status_does_not_overwrite_completion_observed_after_taking_the_lock(self):
        initial={'schema':1,'state':'available','phase':'installing','recovery':'recoveryRequired'}
        completed={'schema':1,'state':'available','phase':'completed','permissionState':'attention','recovery':'retainedTarget'}
        command=['status','--root',str(self.context.root),'--home',str(self.home),'--version','1.0.0','--macos','14.0']
        with patch.object(updater,'current_state',side_effect=[initial,completed]),patch.object(updater,'save') as write, \
             patch('sys.stdout',new=io.StringIO()):
            self.assertEqual(updater.main(command),0)
        write.assert_not_called()

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

    def test_cli_dispatch_copies_trusted_helpers_and_hands_a_locked_descriptor_to_detached_worker(self):
        updater.save(self.context,{'state':'available','phase':None,'release':self.release})
        observed=[]; inherited=[]
        def launch(command,**options):
            observed.append((command,options))
            self.assertTrue(options['start_new_session'])
            descriptor=options['pass_fds'][0]
            self.assertEqual(options['env']['HEED_INSTALL_LOCK_FD'],str(descriptor))
            inherited.append(os.dup(descriptor))
            self.assertEqual(command[2],'worker')
            script=Path(command[1]);self.assertTrue(script.is_file())
            self.assertTrue(script.with_name('installation_lock.py').is_file())
            self.assertTrue((script.parents[2]/'config/service-ports.json').is_file())
            self.assertTrue(str(script).startswith(str(self.home/'updates')+'/'))
        try:
            with patch.object(updater.subprocess,'Popen',side_effect=launch),patch('sys.stdout',new=io.StringIO()):
                code=updater.main(['install','--root',str(self.context.root),'--home',str(self.home),
                                   '--app-dir',str(self.context.app_dir),'--version','1.0.0','--commit','a'*40,'--macos','14.0'])
            self.assertEqual(code,0);self.assertEqual(len(observed),1)
            with self.assertRaises(ValueError):
                with InstallationLock(self.home):pass
        finally:
            for descriptor in inherited:os.close(descriptor)

    def test_pinned_manifest_and_notes_revalidated_before_control(self):
        self.manifest['assets']['installer']['url']='https://untrusted.example/install.sh'
        self.assertEqual(self.run_fixture()['phase'],'failed'); self.assertEqual(self.calls,[])

    def test_symlinked_current_state_is_rejected_without_touching_private_file(self):
        self.home.mkdir(mode=0o700); outside=Path(self.temp.name)/'private';outside.write_text('preserve')
        (self.home/'update.json').symlink_to(outside)
        with self.assertRaises(ValueError): updater.current_state(self.context)
        self.assertEqual(outside.read_text(),'preserve')

    def test_tampered_log_path_and_external_current_runtime_are_refused(self):
        state=self.run_fixture()
        state['logPath']=str(Path(self.temp.name)/'private.log')
        path=self.home/'update.json';path.write_text(json.dumps(state));path.chmod(0o600)
        with self.assertRaises(ValueError):updater.current_state(self.context)
        runtime=self.home/'runtime';runtime.mkdir()
        outside=Path(self.temp.name)/'other-installation';outside.mkdir()
        (outside/'release.json').write_text(json.dumps({'app':'heed','version':'1.2.0','commit':'b'*40}))
        (runtime/'current').symlink_to(outside)
        with self.assertRaises(ValueError):updater.verified_context(self.context,state)


if __name__ == '__main__': unittest.main()
