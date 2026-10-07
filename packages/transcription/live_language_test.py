"""Actual model identity determines language admission; metadata is not quality evidence."""
import importlib
import json
import sys
import unittest
from unittest.mock import patch
from types import SimpleNamespace
import engines
from native_worker import NativeWorker


class LiveLanguageTests(unittest.TestCase):
    def capability(self, *args, **kwargs):
        try:
            module = importlib.import_module("live_language")
        except ModuleNotFoundError:
            module = None
        self.assertIsNotNone(module, "Registered model capability contract is missing")
        return module.path_capability(*args, **kwargs)

    def test_multilingual_registered_whisper_supports_pt_without_quality_claim(self):
        for kind in ("mlx", "ctranslate2"):
            for model in ("tiny", "base", "small", "medium", "large-v3"):
                with self.subTest(kind=kind, model=model):
                    value = self.capability(kind, model, "chunk", False)
                    self.assertEqual(value["supportedLanguages"], ["en", "pt"])
                    self.assertEqual(value["automatic"], {"modelSupported": True, "pipelineAvailable": True, "offered": False})
                    self.assertEqual(value["mixedLanguage"], "unverified")
                    self.assertEqual(value["state"], "lazy")
                    self.assertIsNone(value["modelRevision"])
                    self.assertTrue(value["modelIdentity"].startswith(kind + ":"))

    def test_english_only_and_custom_models_do_not_acquire_pt_from_family(self):
        for kind in ("mlx", "ctranslate2"):
            for model in ("tiny.en", "base.en", "small.en", "medium.en"):
                with self.subTest(kind=kind, model=model):
                    value = self.capability(kind, model, "chunk", True)
                    self.assertEqual(value["supportedLanguages"], ["en"])
                    self.assertFalse(value["automatic"]["modelSupported"])
            for model in ("custom", "/private/model", "owner/whisper-base"):
                value = self.capability(kind, model, "chunk", False)
                self.assertEqual(value["supportedLanguages"], [])
                self.assertEqual(value["state"], "unavailable")
                self.assertIsNone(value["modelIdentity"])
                self.assertNotIn("/private", json.dumps(value))

    def test_live_mlx_and_native_final_have_distinct_identity_and_auto_policy(self):
        live = self.capability("mlx", "base", "chunk", True)
        final = self.capability("parakeet", "parakeet-v3", "full", True)
        self.assertEqual(final["supportedLanguages"], ["en", "pt"])
        self.assertFalse(final["automatic"]["modelSupported"])
        self.assertTrue(final["automatic"]["pipelineAvailable"])
        self.assertFalse(final["automatic"]["offered"])
        module = importlib.import_module("live_language")
        descriptor = module.language_capabilities(live, final)
        self.assertEqual(descriptor["schemaVersion"], 1)
        self.assertEqual(descriptor["live"]["engine"], "mlx")
        self.assertEqual(descriptor["final"]["engine"], "parakeet")
        self.assertEqual(len(descriptor["capabilityKey"]), 64)
        self.assertNotEqual(descriptor["capabilityKey"], module.language_capabilities(self.capability("mlx", "tiny", "chunk", True), final)["capabilityKey"])

    def test_disabled_path_does_not_report_loaded_preview_or_adaptive_candidates(self):
        value = self.capability("mlx", "base", "chunk", False, enabled=False)
        self.assertEqual(value["state"], "disabled")
        self.assertEqual(value["adaptiveModels"], [])
        unknown = self.capability("unknown", "base", "chunk", True)
        self.assertEqual(unknown["supportedLanguages"], [])
        self.assertEqual(unknown["state"], "unavailable")
        for kind in ("mlx", "ctranslate2"):
            streaming=self.capability(kind,"base","stream",True)
            self.assertEqual(streaming["state"],"unavailable")
            self.assertEqual(streaming["supportedLanguages"],[])

    def test_unknown_mlx_is_rejected_before_importing_or_using_small(self):
        with patch.dict(sys.modules, {"mlx_whisper": SimpleNamespace()}):
            with self.assertRaisesRegex(ValueError, "Unknown MLX model"):
                engines.MLXEngine("unregistered")

    def test_native_ready_metadata_is_retained_from_exact_ready_message(self):
        code = 'import json,time;print(json.dumps({"status":"noise","engine":"wrong"}));print(json.dumps({"ready":True,"engine":"mlx","model":"base","mode":"chunk"}));time.sleep(30)'
        worker = NativeWorker([sys.executable, "-u", "-c", code], startup_timeout=5, shutdown_timeout=.1)
        self.addCleanup(worker.close)
        self.assertEqual(getattr(worker, "ready_info", None), {"ready": True, "engine": "mlx", "model": "base", "mode": "chunk"})

    def test_health_uses_preview_instance_and_does_not_load_final_native_engine(self):
        import transcription_server as server
        with patch.object(server, "active_engine", "parakeet"), patch.object(server, "whisper_model_live", SimpleNamespace(kind="mlx", model_name="base", alive=True)), patch.object(server, "whisper_model_live_name", "base"), patch.object(server, "preview_enabled", True), patch("engines.get_parakeet", side_effect=AssertionError("Health must not warm native inference")):
            helper = getattr(server, "_language_capabilities", None)
            self.assertTrue(callable(helper), "Health capability descriptor is missing")
            value = helper()
            self.assertEqual(value["live"]["engine"], "mlx")
            self.assertEqual(value["live"]["model"], "base")
            self.assertEqual(value["final"]["engine"], "parakeet")
            self.assertEqual(value["final"]["model"], "parakeet-v3")

    def test_preview_ready_mismatch_reaps_owned_worker(self):
        import subprocess
        from preview_worker import PreviewWhisper
        real_spawn = subprocess.Popen
        owned = []
        def spawn(command, **kwargs):
            process = real_spawn([sys.executable, "-u", "-c", 'import json,time;print(json.dumps({"ready":True,"capability":{"engine":"ctranslate2"}}));time.sleep(30)'], **kwargs)
            owned.append(process)
            return process
        with patch("native_worker.subprocess.Popen", side_effect=spawn):
            with self.assertRaisesRegex(RuntimeError, "identity mismatch"):
                PreviewWhisper("base", "mlx", {})
        self.assertEqual(len(owned), 1)
        self.assertIsNotNone(owned[0].poll())


if __name__ == "__main__":
    unittest.main()


class AdmittedPreviewTests(unittest.TestCase):
    def options(self):
        return {"realTimeTranscription":True,"requestedLanguage":"pt","effectiveLanguage":"pt","engine":"mlx","mode":"chunk","initialModel":"base","initialModelIdentity":"mlx:mlx-community/whisper-base-mlx","capabilityKey":"a"*64,"compatibleModels":["mlx:mlx-community/whisper-base-mlx","mlx:mlx-community/whisper-tiny-mlx"]}

    def test_configure_keeps_admitted_language_and_rejects_unknown_or_cross_family_models(self):
        import transcription_server as server
        with patch.object(server,"whisper_model_live",None), patch.object(server,"live_governor",None):
            server.configure_preview(True, self.options())
            self.addCleanup(server.configure_preview, True)
            self.assertEqual(server._preview_language({"language":"pt","task":"transcribe"}), "pt")
            for body in ({"language":"en"},{"language":"auto"},{"language":"pt","task":"translate"}):
                with self.assertRaises(ValueError):server._preview_language(body)
            for changes in ({"effectiveLanguage":"en"},{"compatibleModels":["ctranslate2:Systran/faster-whisper-base"]},{"initialModel":"base.en"}):
                with self.assertRaises(ValueError):server.configure_preview(True,{**self.options(),**changes})
            self.assertEqual(server.preview_live_options["effectiveLanguage"],"pt")

    def test_adaptation_stays_same_family_and_uses_pt_for_warmup(self):
        import transcription_server as server
        calls=[]
        class Model:
            kind="mlx"
            alive=True
            def __init__(self,model,*args):self.model_name=model
            def transcribe(self,path,**options):calls.append((self.model_name, options));return iter([]),SimpleNamespace(language="pt")
            def close(self):pass
        with patch.object(server,"preview_live_options",self.options(),create=True),patch.object(server,"active_engine","parakeet"),patch.object(server,"whisper_model_live",Model("base")),patch.object(server,"whisper_model_live_name","base"),patch("preview_worker.PreviewWhisper",Model):
            self.assertFalse(server._swap_live_model("base.en"))
            self.assertFalse(server._swap_live_model("custom"))
            self.assertTrue(server._swap_live_model("tiny"))
            self.assertEqual(calls,[("tiny",{"language":"pt","task":"transcribe"})])
            server._arm_live_governor()
            self.assertIsNotNone(server.live_governor, "Native final must not disable the MLX live governor")
            governor=server.live_governor
            for _ in range(3):decision=governor.observe(2,3)
            self.assertEqual(decision.live_model,"tiny")
            for _ in range(3):decision=governor.observe(2,.1)
            self.assertEqual(decision.interval_ms,2000)
            for _ in range(3):decision=governor.observe(2,.1)
            self.assertEqual(decision.live_model,"base")

    def test_stream_override_rejects_before_native_inference(self):
        import io
        import transcription_server as server
        result=[]
        handler=object.__new__(server.Handler)
        body=json.dumps({"language":"en","task":"translate","channel":"mic"}).encode()
        handler.path="/stream/start";handler.headers={"Content-Length":str(len(body))};handler.rfile=io.BytesIO(body)
        handler._json=lambda value,status=200:result.append((value,status))
        with patch.object(server,"preview_live_options",self.options()),patch("engines.get_parakeet",side_effect=AssertionError("Invalid request admitted native inference")):
            handler._post()
        self.assertEqual(result[0][1],400)

    def test_chunk_reports_model_used_before_compatible_governor_swap(self):
        import io
        import transcription_server as server
        result=[]
        class Model:
            kind="mlx";model_name="base";alive=True
            def transcribe(self,path,**options):
                self.options=options
                return iter([SimpleNamespace(start=.25,end=1.25,text="Palavras originais")]),SimpleNamespace(language="pt")
        model=Model()
        handler=object.__new__(server.Handler)
        body=json.dumps({"language":"pt","task":"transcribe","wav_path":"synthetic-absent.wav","audio_s":2}).encode()
        handler.path="/transcribe-live";handler.headers={"Content-Length":str(len(body))};handler.rfile=io.BytesIO(body)
        handler._json=lambda value,status=200:result.append((value,status))
        governor=SimpleNamespace(observe=lambda *args:SimpleNamespace(changed=True,live_model="tiny",interval_ms=3000,reason="Controlled slow window"))
        with patch.object(server,"preview_live_options",self.options()),patch.object(server,"whisper_model_live",model),patch.object(server,"whisper_model_live_name","base"),patch.object(server,"live_governor",governor),patch.object(server,"_swap_live_model",side_effect=lambda name:setattr(server,"whisper_model_live_name",name)):
            handler._post()
        self.assertEqual(model.options["language"],"pt");self.assertEqual(model.options["task"],"transcribe")
        self.assertEqual(result[0][0]["model"],"base")
        self.assertEqual(result[0][0]["modelIdentity"],"mlx:mlx-community/whisper-base-mlx")
        self.assertEqual(result[0][0]["gov"]["live_model"],"tiny")
