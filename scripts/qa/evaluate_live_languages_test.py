import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import os
import platform
import selectors
import socket
import subprocess
import sys

spec=importlib.util.spec_from_file_location('evaluate_live_languages',Path(__file__).with_name('evaluate-live-languages.py'))
evaluate=importlib.util.module_from_spec(spec);spec.loader.exec_module(evaluate)

class HarnessTests(unittest.TestCase):
    def test_shutdown_verification_rejects_survivors_and_ignores_reused_pids(self):
        worker={42:{'started':'same generation','command':'owned worker'}}
        self.assertEqual(evaluate.surviving_owned(worker,worker),[42])
        self.assertEqual(evaluate.surviving_owned(worker,{42:{'started':'new generation','command':'owned worker'}}),[])
        self.assertEqual(evaluate.surviving_owned(worker,{}),[])
    def test_diagnostics_are_bounded_and_disclose_clipping(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'public-fixture.stderr.log'
            evaluate.append_diagnostics(path,b'x'*1_050_000+b'last failure')
            content=path.read_bytes()
            self.assertLess(len(content),1_048_650);self.assertTrue(content.endswith(b'last failure'))
            self.assertIn(b'Earlier diagnostic bytes omitted:',content)
    @unittest.skipUnless(platform.system()=='Darwin' and Path('/usr/bin/sandbox-exec').exists(),'macOS outbound sandbox')
    def test_sandbox_denies_outbound_even_to_a_local_proxy(self):
        with socket.socket() as server:
            server.bind(('127.0.0.1',0));server.listen()
            code="import socket; s=socket.socket()\ntry:s.connect(('127.0.0.1',%d));print('allowed')\nexcept OSError:print('blocked')" % server.getsockname()[1]
            result=subprocess.run(['/usr/bin/sandbox-exec','-p',evaluate.SANDBOX,sys.executable,'-c',code],capture_output=True,text=True,timeout=5,env={**os.environ,'PYTHONDONTWRITEBYTECODE':'1'})
            self.assertEqual(result.returncode,0);self.assertEqual(result.stdout.strip(),'blocked')
    @unittest.skipUnless(platform.system()=='Darwin' and Path('/usr/bin/sandbox-exec').exists(),'macOS outbound sandbox')
    def test_sandbox_preserves_inbound_fixture_http_replies(self):
        code="import socket; s=socket.socket();s.bind(('127.0.0.1',0));s.listen();print(s.getsockname()[1],flush=True);c,_=s.accept();c.recv(1);c.sendall(b'ok');c.close();s.close()"
        child=subprocess.Popen(['/usr/bin/sandbox-exec','-p',evaluate.SANDBOX,sys.executable,'-c',code],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        try:
            with selectors.DefaultSelector() as reader:
                reader.register(child.stdout,selectors.EVENT_READ);self.assertTrue(reader.select(5))
            port=int(child.stdout.readline())
            with socket.create_connection(('127.0.0.1',port),timeout=5) as caller:caller.sendall(b'x');self.assertEqual(caller.recv(2),b'ok')
            child.communicate(timeout=5);self.assertEqual(child.returncode,0)
        finally:
            if child.poll() is None:child.kill();child.communicate(timeout=5)
    def test_committed_audio_has_exact_integrity_timing_and_public_provenance(self):
        data=evaluate.load_manifest(Path(__file__).parent/'fixtures/live-languages/manifest.json')
        self.assertEqual(len(data['fixtures']),8)
        self.assertFalse(data['humanRegionalAccentsAvailable'])
        self.assertTrue(all(record['seconds']>=1 for record in data['fixtures']))
    def test_altered_audio_fails_before_a_service_can_start(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'fixture.wav').write_bytes(b'altered')
            (root/'manifest.json').write_text(json.dumps({'schemaVersion':1,'fixtures':[{'file':'fixture.wav','sha256':'0'*64}]}))
            with self.assertRaisesRegex(ValueError,'integrity'):evaluate.load_manifest(root/'manifest.json')
    def test_escape_paths_fail_before_reading_external_audio(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'manifest.json').write_text(json.dumps({'schemaVersion':1,'fixtures':[{'file':'../private.wav','sha256':'0'*64}]}))
            with self.assertRaisesRegex(ValueError,'fixture directory'):evaluate.load_manifest(root/'manifest.json')
    def test_wrong_model_family_language_or_translation_never_becomes_benchmark_evidence(self):
        options={'engine':'mlx','initialModel':'base','initialModelIdentity':'mlx:mlx-community/whisper-base-mlx','effectiveLanguage':'pt'}
        result={'engine':'mlx','model':'base','modelIdentity':options['initialModelIdentity'],'language':'pt','task':'transcribe'}
        evaluate.verify_live(result,options)
        for key,value in [('engine','ctranslate2'),('model','tiny'),('language','en'),('task','translate'),('modelIdentity','mlx:unknown')]:
            with self.assertRaisesRegex(RuntimeError,'identity'):evaluate.verify_live({**result,key:value},options)
    def test_percentiles_and_content_free_prediction_projection(self):
        self.assertEqual(evaluate.percentile([1,2,3,4],.95),4)
        self.assertIsNone(evaluate.percentile([], .5))
        self.assertEqual(evaluate.public_result({'text':'public words','turns':[{'text':'public words','speaker':'Me','start':0,'end':2}],'embeddings':{'Me':[1,2]},'language':'pt','model':'base'})['speakerCount'],1)
        self.assertNotIn('text',evaluate.public_result({'text':'public words','turns':[]}))

if __name__=='__main__':unittest.main()
