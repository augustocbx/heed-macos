"""Content-free synthetic regressions for the real final attribution pipeline."""
import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch
import transcription_server as ts


def speech(start, end, text):
    return {"start": start, "end": end, "text": text}


def voice(start, end, emb):
    return {"start": start, "end": end, "emb": emb}


class FinalPipelineTests(unittest.TestCase):
    def finalize(self, mic, system, mic_diar, sys_diar, language="en", failed=False, dual=True, mono_result=None):
        with tempfile.TemporaryDirectory() as root:
            source = os.path.join(root, "synthetic.wav")
            open(source, "wb").close()
            raw = SimpleNamespace(diarize=lambda path: (_ for _ in ()).throw(RuntimeError("private worker payload")) if failed else {"segments": sys_diar if path.endswith("sys.wav") else mic_diar})
            # Preserve real temporary-audio cleanup while making channel identity deterministic.
            paths = iter([os.path.join(root, "mic.wav"), os.path.join(root, "sys.wav")])
            with patch("managed_work.temporary_audio", side_effect=lambda *args: next(paths)), patch.object(ts, "_ffmpeg_channel"), patch.object(ts, "_aec_clean", side_effect=lambda mic, sys: mic), patch.object(ts, "_wav_rms_peak", return_value=(.03, 2000)), patch("engines._wav_duration", return_value=30), patch("engines.ParakeetEngine") as asr, patch("engines.tokens_to_segments", side_effect=[system, mic] if dual else [mic]), patch("engines.get_parakeet_diar", return_value=raw), patch("engines.is_apple_silicon", return_value=True), patch.object(ts, "_diarize_parakeet", side_effect=lambda path: mono_result if mono_result is not None else raw.diarize(path)), patch.object(ts, "match_voice", return_value=(None, 0)), patch.object(ts, "current_backend", return_value="wespeaker"), patch.object(ts, "_diar_session", SimpleNamespace(speakers=[], backend="wespeaker")):
                result = ts.finalize_recording(source, language, manual=True, is_dual=dual)
                asr.return_value.close.assert_called_once()
                return result

    def test_mic_dominant_mixed_cluster_keeps_local_words_and_timestamps(self):
        for language, text in [("en", "My local contribution is separate."), ("pt", "Minha contribuição local é diferente.")]:
            with self.subTest(language=language):
                result = self.finalize([speech(4, 14, text)], [speech(4, 5.5, "Remote participant")], [voice(4, 14, [1, 0])], [voice(4, 5.5, [1, 0])], language)
                self.assertEqual([(s["start"], s["end"], s["text"]) for s in result["turns"] if s["channel"] == "mic"], [(4, 14, text)])

    def test_short_distinct_mic_speaker_is_not_absorbed_by_remote(self):
        for duration in [1.5, .6]:
            with self.subTest(duration=duration):
                labels, _ = ts.cluster_segments([{**voice(0, 10, [1, 0]), "ch": "sys"}, {**voice(12, 12 + duration, [0, 1]), "ch": "mic"}])
                self.assertNotEqual(labels[0], labels[1])

    def test_missing_or_invalid_embeddings_preserve_both_channels_with_fallback(self):
        for embedding in [None, [], [float("nan"), 0], [0, 0]]:
            with self.subTest(embedding=embedding):
                result = self.finalize([speech(10, 12, "Local recognized phrase")], [speech(0, 3, "Remote recognized phrase")], [voice(10, 12, embedding)], [voice(0, 3, embedding)])
                self.assertEqual(len(result["turns"]), 2)
                self.assertTrue(all(s.get("attribution") == "fallback" for s in result["turns"]))
                self.assertEqual(result["diagnostics"]["channels"]["mic"]["fallbackSegments"], 1)
                self.assertNotIn("emb", repr(result["diagnostics"]))

    def test_failed_diarization_keeps_asr_and_content_free_warning(self):
        result = self.finalize([speech(10, 12, "Local phrase")], [speech(0, 3, "Remote phrase")], [], [], failed=True)
        self.assertEqual(len(result["turns"]), 2)
        self.assertTrue(result["diagnostics"]["channels"]["mic"]["diarizationFailed"])
        self.assertNotIn("private worker payload", repr(result))

    def test_no_system_window_and_overlapping_different_speech_are_retained(self):
        mic = [speech(0, 2, "A separate local phrase"), speech(10, 12, "Another local phrase")]
        result = self.finalize(mic, [speech(0, 2, "A different remote phrase")], [voice(0, 12, [1, 0])], [voice(0, 2, [1, 0])])
        self.assertEqual([s["text"] for s in result["turns"] if s["channel"] == "mic"], [s["text"] for s in mic])

    def test_missing_temporal_attribution_does_not_name_by_nearest_distant_voice(self):
        result = self.finalize([speech(15, 18, "A separate local phrase")], [], [voice(0, 3, [1, 0])], [])
        self.assertEqual(result["turns"][0].get("attribution"), "fallback")

    def test_single_channel_missing_or_failed_diarization_keeps_text(self):
        for failed in [False, True]:
            with self.subTest(failed=failed):
                result = self.finalize([speech(2, 4, "Microphone recognized words")], [], [], [], failed=failed, dual=False)
                self.assertEqual(result["turns"][0]["text"], "Microphone recognized words")
                self.assertEqual(result["turns"][0]["attribution"], "fallback")
                self.assertEqual(result["speakers"], ["Microphone (unattributed)"])
                self.assertEqual(result["diagnostics"]["channels"]["mic"]["diarizationFailed"], failed)

    def test_single_channel_embedding_counts_and_labels_reflect_attribution_evidence(self):
        for embeddings, expected in [({"Speaker 1": [1, 0]}, "Speaker 1"), ({}, "Microphone (unattributed)")]:
            with self.subTest(embeddings=bool(embeddings)):
                d = {"segments": [{"start": 2, "end": 4, "speaker": "Speaker 1"}], "embeddings": embeddings}
                result = self.finalize([speech(2, 4, "Microphone recognized words")], [], [], [], dual=False, mono_result=d)
                self.assertEqual(result["turns"][0]["speaker"], expected)
                self.assertEqual(result["diagnostics"]["channels"]["mic"]["usableEmbeddings"], int(bool(embeddings)))
                self.assertEqual(result["turns"][0].get("attribution"), None if embeddings else "fallback")

    def test_native_diarization_failure_is_flagged_without_private_error(self):
        import engines
        engine = SimpleNamespace(_request=lambda request: {"ok": False, "error": "Private native error"})
        self.assertEqual(engines.ParakeetEngine.diarize(engine, "synthetic.wav"), {"segments": [], "embeddings": {}, "failed": True})
        with patch("engines.get_parakeet_diar", return_value=SimpleNamespace(diarize=lambda path: {"segments": [], "embeddings": {}, "failed": True})):
            self.assertTrue(ts._diarize_parakeet("synthetic.wav").get("failed"))

    def test_genuine_echo_is_removed_and_all_mic_loss_is_reported(self):
        words = "The next meeting starts tomorrow morning."
        result = self.finalize([speech(1, 4, words)], [speech(1, 4, words)], [voice(1, 4, [1, 0])], [voice(1, 4, [1, 0])])
        self.assertEqual([s["channel"] for s in result["turns"]], ["sys"])
        self.assertEqual(result["diagnostics"]["channels"]["mic"]["discardReasons"], {"echo-text-and-time": 1})
        self.assertIn("microphone-all-asr-filtered", result["diagnostics"]["warnings"])


if __name__ == "__main__":
    unittest.main()
