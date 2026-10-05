import unittest
from unittest.mock import patch
import transcription_server as server


class ManualTranscriptionTests(unittest.TestCase):
    def run_final(self, **options):
        with patch("meeting_language.detect_meeting_language", return_value={"language": "pt", "samples": 1}) as detect, \
             patch("manual_transcription.transcribe_complete", return_value=[{"start": 1.25, "end": 3.75, "text": "Manual result"}]) as transcribe, \
             patch("engines.ParakeetEngine") as native, \
             patch("engines.is_apple_silicon", return_value=True), \
             patch.object(server, "_ffmpeg_channel"), \
             patch.object(server, "_diarize_parakeet", return_value={"segments": [], "speakers": []}):
            result = server.finalize_recording("audio.wav", is_dual=False, **options)
        return result, detect, transcribe, native

    def test_explicit_language_skips_detector_and_preserves_timestamps(self):
        previous = (server.whisper_model_live, server.whisper_model_live_name, server.live_tuning.copy())
        result, detect, transcribe, native = self.run_final(language="en", final_model="small", manual=True)
        self.assertEqual((server.whisper_model_live, server.whisper_model_live_name, server.live_tuning), previous)
        detect.assert_not_called()
        native.assert_not_called()
        self.assertEqual(transcribe.call_args.args[1:], ("small", "en"))
        self.assertEqual(result["language"], "en")
        self.assertEqual(result["model"], "small")
        self.assertEqual(result["turns"][0]["start"], 1.25)
        self.assertTrue(result["finalized"])

    def test_manual_auto_detects_portuguese_before_complete_pass(self):
        result, detect, transcribe, _ = self.run_final(language="auto", final_model="base", manual=True)
        detect.assert_called_once_with("audio.wav")
        self.assertEqual(transcribe.call_args.args[1:], ("base", "pt"))
        self.assertEqual(result["language"], "pt")

    def test_unknown_model_rejected_before_loading(self):
        with self.assertRaisesRegex(ValueError, "model"):
            self.run_final(language="en", final_model="unknown", manual=True)

    def test_unknown_language_rejected_before_loading(self):
        with self.assertRaisesRegex(ValueError, "language"):
            self.run_final(language="de", final_model="base", manual=True)

    def test_worker_failure_propagates(self):
        with patch("manual_transcription.transcribe_complete", side_effect=RuntimeError("offline failure")), \
             patch("engines.is_apple_silicon", return_value=True), \
             patch.object(server, "_ffmpeg_channel"), \
             patch.object(server, "_diarize_parakeet", return_value={"segments": []}):
            with self.assertRaisesRegex(RuntimeError, "offline failure"):
                server.finalize_recording("audio.wav", "en", False, final_model="base", manual=True)


if __name__ == "__main__":
    unittest.main()
