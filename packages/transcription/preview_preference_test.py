"""Regression boundaries: disabled startup never acquires preview models; leases guard release."""
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
import transcription_server as server


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
        script = 'import sys,json;print(json.dumps({"ready":True}),flush=True)\nfor line in sys.stdin:\n body=json.loads(line);print(json.dumps({"ok":True,"language":body["language"],"segments":[{"start":1.25,"end":2.75,"text":"Fixture words"}]}),flush=True)'
        popen = subprocess.Popen
        def fixture(_command, **kwargs): return popen([sys.executable, '-u', '-c', script], **kwargs)
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
        script = 'import sys,time;print("{\\"ready\\":true}",flush=True);sys.stdin.readline();time.sleep(30)'
        popen = subprocess.Popen
        with patch('native_worker.subprocess.Popen', side_effect=lambda _command,**kwargs:popen([sys.executable,'-u','-c',script],**kwargs)):
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
