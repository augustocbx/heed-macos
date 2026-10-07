"""Regression boundaries: disabled startup never acquires preview models; leases guard release."""
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
import transcription_server as server
from live_language import path_capability
READY = json.dumps({"ready":True,"capability":path_capability("mlx","base","chunk",True)})


class PreviewPreferenceTests(unittest.TestCase):
    def setUp(self): server.configure_preview(True)
    def tearDown(self): server.configure_preview(True)
    def test_disabled_native_startup_skips_asr_and_diarization_warmup(self):
        devices = {"whisper":"cpu", "pyannote":"cpu", "gpu_available":False,
                   "ram_mb":16000, "cpu_count":4}
        with tempfile.TemporaryDirectory() as directory, \
             patch.dict("os.environ", {"HEED_APP_DIR":directory}), \
             patch.object(server, "get_device_config", return_value=devices), \
             patch("capability.probe", side_effect=RuntimeError("controlled profile")) as probe, \
             patch("engines.select_engine_kind", return_value="parakeet"), \
             patch("engines.parakeet_available", return_value=True), \
             patch("engines.get_parakeet_diar") as diar, \
             patch.object(server, "_ensure_whisper_live") as asr:
            Path(directory, "config.json").write_text(json.dumps({"real_time_transcription":False}))
            server.configure_preview(server.saved_preview_preference())
            server.load_models()
            probe.assert_not_called()
            asr.assert_not_called()
            diar.assert_not_called()
            self.assertTrue(server.models_ready["whisper"])
            self.assertTrue(server.models_warm)
            self.assertFalse(server.preview_enabled)

    def test_fresh_service_reads_disabled_device_preference_without_loading_models(self):
        import os
        import subprocess
        import sys
        with tempfile.TemporaryDirectory() as directory:
            Path(directory,'config.json').write_text('{"real_time_transcription":false}')
            result=subprocess.run([sys.executable,'-c','import transcription_server as s;print(s.preview_enabled,s.whisper_model_live)'],
                env=dict(os.environ,HEED_APP_DIR=directory,PYTHONPATH=str(Path(__file__).parent)),capture_output=True,text=True,check=True,timeout=5)
            self.assertEqual(result.stdout.strip(),'False None')

    def test_python_only_restart_preserves_active_mode_in_both_preference_directions(self):
        import os
        import subprocess
        import sys
        from http.server import BaseHTTPRequestHandler
        owner_snapshot={}
        class Owner(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_GET(self):
                body=owner_snapshot if self.path.startswith('/api/recording/status') else {'service':'heed-api','protocolVersion':1,'checkoutRoot':str(Path(server.__file__).resolve().parents[2])}
                data=json.dumps(body).encode();self.send_response(200);self.end_headers();self.wfile.write(data)
        owner=server.ThreadingHTTPServer(('127.0.0.1',0),Owner);thread=threading.Thread(target=owner.serve_forever,daemon=True);thread.start()
        try:
            for active,saved in [(False,True),(True,False)]:
                with self.subTest(active=active,saved=saved),tempfile.TemporaryDirectory() as directory:
                    Path(directory,'config.json').write_text(json.dumps({'real_time_transcription':saved,'live_speech_language':'en'}))
                    snapshot={'state':'recording','meetingId':'active-fixture','revision':5,'startedAt':100,
                              'path':str(Path(directory,'capture.wav')),'seconds':1,'mode':'both','segments':[],
                              'speakerNames':{},'session':None,'error':None,'maintenance':False,'realTimeTranscription':active}
                    options={'realTimeTranscription':active,'requestedLanguage':'pt','effectiveLanguage':'pt' if active else None,'engine':'mlx' if active else None,'mode':'chunk' if active else None,'initialModel':'base' if active else None,'initialModelIdentity':'mlx:mlx-community/whisper-base-mlx' if active else None,'capabilityKey':'a'*64 if active else None,'compatibleModels':['mlx:mlx-community/whisper-base-mlx'] if active else []}
                    snapshot['liveOptions']=options
                    owner_snapshot.update(snapshot)
                    Path(directory,'recording-manifest.json').write_text(json.dumps({'version':1,'snapshot':snapshot,'receipts':{}}))
                    result=subprocess.run([sys.executable,'-c','import transcription_server as s;print(s.preview_enabled,(s.preview_live_options or {}).get(\"effectiveLanguage\"))'],
                        env=dict(os.environ,HEED_APP_DIR=directory,HEED_API_PORT=str(owner.server_address[1]),PYTHONPATH=str(Path(__file__).parent)),capture_output=True,text=True,check=True,timeout=5)
                    self.assertEqual(result.stdout.strip(),str(active)+(' pt' if active else ' None'))
        finally:owner.shutdown();owner.server_close();thread.join(1)

    def test_unverified_active_manifest_cannot_warm_stale_preview_resources(self):
        from preview_preference import startup_preview_preference
        with tempfile.TemporaryDirectory() as directory,patch.dict('os.environ',{'HEED_APP_DIR':directory,'HEED_API_PORT':'65534'}):
            Path(directory,'config.json').write_text('{"real_time_transcription":true}')
            snapshot={'state':'recording','meetingId':'stale-fixture','revision':2,'mode':'both','segments':[],'realTimeTranscription':True}
            Path(directory,'recording-manifest.json').write_text(json.dumps({'version':1,'snapshot':snapshot}))
            self.assertFalse(startup_preview_preference())

    def test_startup_cannot_overwrite_an_admitted_mode_with_a_later_saved_preference(self):
        observed=[]
        with tempfile.TemporaryDirectory() as directory, patch.dict('os.environ',{'HEED_APP_DIR':directory}), \
             patch.object(server,'_load_models',side_effect=lambda:observed.append(server.preview_enabled)):
            Path(directory,'config.json').write_text('{"real_time_transcription":false}')
            server.configure_preview(True)
            server.load_models()
            self.assertEqual(observed,[True])

    def test_release_waits_for_active_preview_and_preserves_shared_final(self):
        # A separate preview instance is closed only after the live request lease ends.
        class Model:
            closed = False
            def close(self): self.closed = True
        owned, final = Model(), Model()
        entered, release, finished = threading.Event(), threading.Event(), threading.Event()
        with patch.object(server, "whisper_model_live", owned), patch.object(server, "whisper_model", final):
            def active():
                with server.preview_lease():
                    entered.set(); release.wait(2)
            worker = threading.Thread(target=active)
            worker.start(); self.assertTrue(entered.wait(1))
            toggle = threading.Thread(target=lambda: (server.configure_preview(False), finished.set()))
            toggle.start()
            self.assertFalse(finished.wait(.05)); self.assertFalse(owned.closed)
            release.set(); worker.join(1); toggle.join(1)
            self.assertTrue(finished.is_set()); self.assertTrue(owned.closed)
            self.assertFalse(final.closed); self.assertIs(server.whisper_model, final)
        server.configure_preview(True)

    def test_independent_live_jobs_can_overlap_while_release_waits_for_both(self):
        first,second,release=threading.Event(),threading.Event(),threading.Event()
        def active(entered):
            with server.preview_lease():entered.set();release.wait(2)
        workers=[threading.Thread(target=active,args=(entered,)) for entered in (first,second)]
        try:
            workers[0].start();self.assertTrue(first.wait(1))
            workers[1].start();self.assertTrue(second.wait(.3),'ASR and diarization admission must not serialize')
        finally:
            release.set()
            for worker in workers:worker.join(2)

    def test_shared_model_is_not_closed_and_reenabling_is_lazy(self):
        class Model:
            def close(self): raise AssertionError("shared final model closed")
        shared = Model()
        with patch.object(server, "whisper_model_live", shared), patch.object(server, "whisper_model", shared):
            server.configure_preview(False)
            self.assertIs(server.whisper_model, shared)
            self.assertIsNone(server.whisper_model_live)
            server.configure_preview(True)
            self.assertIsNone(server.whisper_model_live)
            with server.preview_lease(): pass


    def test_saved_off_then_enable_restores_governor_adaptation_without_loading_preview(self):
        with patch.object(server,'live_governor',None),patch.object(server,'active_engine','ctranslate2'),patch.object(server,'whisper_model_live_name','base'):
            server.configure_preview(False);server.configure_preview(True)
            self.assertIsNotNone(server.live_governor)
            decisions=[server.live_governor.observe(3,3) for _ in range(3)]
            self.assertEqual(decisions[-1].live_model,'tiny')

    def test_off_on_resets_governor_for_the_next_recording(self):
        from governor import RuntimeGovernor
        original=RuntimeGovernor(start_model='small',ceiling='small',floor='tiny')
        with patch.object(server,'live_governor',original),patch.object(server,'active_engine','mlx'),patch.object(server,'whisper_model_live_name','small'):
            server.configure_preview(False);server.configure_preview(True)
            self.assertIsNotNone(server.live_governor)
            decisions=[server.live_governor.observe(3,3) for _ in range(3)]
            self.assertEqual(decisions[-1].live_model,'base')


class PreviewHTTPTests(unittest.TestCase):
    def test_disabled_http_rejects_every_live_boundary_without_model_loading(self):
        from http.client import HTTPConnection
        service = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        thread = threading.Thread(target=service.serve_forever, daemon=True);thread.start()
        def post(path, body):
            connection = HTTPConnection(*service.server_address, timeout=2)
            connection.request('POST', path, json.dumps(body), {'Content-Type':'application/json'})
            response = connection.getresponse(); result = response.status, json.loads(response.read());connection.close();return result
        try:
            self.assertEqual(post('/preview/configure', {'enabled':'false'})[0], 400)
            self.assertEqual(post('/preview/configure', {'enabled':False})[0], 200)
            with patch.object(server, '_ensure_whisper_live', side_effect=AssertionError('preview model loaded')), \
                 patch('engines.get_parakeet_diar', side_effect=AssertionError('live diarizer loaded')):
                for path in ['/transcribe-live','/stream/start','/stream/feed','/stream/finish','/diar/start','/diar/feed','/diar/finish','/diar/live','/mic/filter']:
                    self.assertEqual(post(path, {'wav_path':'never-read.wav'})[0], 409, path)
            self.assertEqual(post('/preview/configure', {'enabled':True})[0], 200)
        finally:
            server.configure_preview(True); service.shutdown();service.server_close();thread.join(1)

    def test_owned_preview_transport_returns_segments_and_disable_reaps_it(self):
        import subprocess
        import sys
        from preview_worker import PreviewWhisper
        script = 'import sys,json;print(READY_PAYLOAD,flush=True)\nfor line in sys.stdin:\n body=json.loads(line);print(json.dumps({"ok":True,"language":body["language"],"segments":[{"start":1.25,"end":2.75,"text":"Fixture words"}]}),flush=True)'
        popen = subprocess.Popen
        def fixture(_command, **kwargs): return popen([sys.executable, '-u', '-c', script.replace('READY_PAYLOAD', repr(READY))], **kwargs)
        server.configure_preview(True)
        with patch('native_worker.subprocess.Popen', side_effect=fixture):
            model = PreviewWhisper('base', 'mlx', {})
        try:
            with patch.object(server, 'whisper_model_live', model), patch.object(server, 'whisper_model', object()):
                with server.preview_lease():
                    segments, info = model.transcribe('fixture.wav', language='pt')
                    segment = list(segments)[0]
                    self.assertEqual((segment.start,segment.end,segment.text,info.language),(1.25,2.75,'Fixture words','pt'))
                server.configure_preview(False)
                self.assertIsNotNone(model.worker.proc.returncode)
                self.assertIsNone(server.whisper_model_live)
        finally: model.close();server.configure_preview(True)

class InstallerWarmupTests(unittest.TestCase):
    def test_installer_warms_only_final_language_detection_when_preview_is_disabled(self):
        import sys
        from types import ModuleType, SimpleNamespace
        import meeting_language
        calls = []
        mlx = ModuleType('mlx'); core = ModuleType('mlx.core'); core.float16 = 'fp16'; core.eval = lambda value: None; mlx.core=core
        whisper = ModuleType('mlx_whisper'); whisper.transcribe=lambda *args,**kwargs:calls.append(args)
        load = ModuleType('mlx_whisper.load_models'); load.load_model=lambda *args,**kwargs:SimpleNamespace(parameters=lambda:[])
        audio = ModuleType('mlx_whisper.audio'); audio.log_mel_spectrogram=lambda value:value; audio.pad_or_trim=lambda value:value
        with tempfile.TemporaryDirectory() as directory, patch.dict('os.environ',{'HEED_APP_DIR':directory}), \
             patch.dict(sys.modules,{'numpy':ModuleType('numpy'),'mlx':mlx,'mlx.core':core,'mlx_whisper':whisper,'mlx_whisper.load_models':load,'mlx_whisper.audio':audio}):
            Path(directory,'config.json').write_text('{"real_time_transcription":false}')
            result = meeting_language.worker()
            self.assertEqual(calls, [])
            self.assertIsNone(result['live_model'])
            self.assertTrue(result['ready'])


class PreviewWorkerOwnershipTests(unittest.TestCase):
    def make_hung_preview(self):
        import subprocess
        import sys
        from preview_worker import PreviewWhisper
        script = 'import sys,time;print('+repr(READY)+',flush=True);sys.stdin.readline();time.sleep(30)'
        popen = subprocess.Popen
        with patch('native_worker.subprocess.Popen', side_effect=lambda _command,**kwargs:popen([sys.executable,'-u','-c',script.replace('READY_PAYLOAD', repr(READY))],**kwargs)):
            return PreviewWhisper('base','mlx',{})

    def test_preview_deadline_reaps_only_its_owned_process(self):
        import subprocess
        import sys
        unrelated = subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'])
        model = self.make_hung_preview()
        try:
            with patch('preview_worker.NATIVE_LIVE_TIMEOUT_SECONDS',.1):
                with self.assertRaises(TimeoutError):model.transcribe('fixture.wav',language='en')
            self.assertIsNotNone(model.worker.proc.returncode)
            self.assertIsNone(unrelated.poll())
        finally:model.close();unrelated.terminate();unrelated.wait(timeout=2)

    def test_next_live_request_recreates_a_timed_out_owned_preview(self):
        import subprocess
        import sys
        from preview_worker import PreviewWhisper
        failed=self.make_hung_preview()
        with patch('preview_worker.NATIVE_LIVE_TIMEOUT_SECONDS',.1):
            with self.assertRaises(TimeoutError):failed.transcribe('fixture.wav',language='en')
        script='import sys,json;print(READY_PAYLOAD,flush=True)\nfor line in sys.stdin:\n print(json.dumps({"ok":True,"language":"en","segments":[{"start":0,"end":1,"text":"Recovered preview"}]}),flush=True)'
        popen=subprocess.Popen
        server.configure_preview(True)
        with patch.object(server,'whisper_model_live',failed),patch.object(server,'active_engine','parakeet'), \
             patch('native_worker.subprocess.Popen',side_effect=lambda _command,**kwargs:popen([sys.executable,'-u','-c',script.replace('READY_PAYLOAD', repr(READY))],**kwargs)):
            replacement=None
            try:
                with server.preview_lease():
                    replacement=server._ensure_whisper_live()
                    segments,_=replacement.transcribe('fixture.wav',language='en')
                    self.assertEqual(list(segments)[0].text,'Recovered preview')
                    self.assertIsNot(replacement,failed)
            finally:
                if replacement is not None:replacement.close()
                failed.close()

    def test_preview_close_interrupts_an_inflight_request_and_reaps(self):
        import time
        model = self.make_hung_preview();errors=[]
        def transcribe():
            try:model.transcribe('fixture.wav',language='en')
            except Exception as error:errors.append(error)
        thread=threading.Thread(target=transcribe);thread.start()
        try:
            time.sleep(.05);model.close();thread.join(2)
            self.assertFalse(thread.is_alive())
            self.assertTrue(errors)
            self.assertIsNotNone(model.worker.proc.returncode)
        finally:model.close();thread.join(2)


if __name__ == "__main__": unittest.main()
