import unittest
from unittest.mock import patch
from meeting_language import choose_language, detect_meeting_language


class MeetingLanguageTests(unittest.TestCase):
    def test_portuguese_majority_survives_english_greeting(self):
        self.assertEqual(choose_language([{"en": .9, "pt": .1}, {"en": .05, "pt": .95},
                                         {"en": .1, "pt": .9}])["language"], "pt")

    def test_english(self):
        result = choose_language([{"en": .97, "pt": .01}])
        self.assertEqual(result["language"], "en")
        self.assertGreater(result["confidence"], .98)

    def test_silence_has_no_claimed_confidence(self):
        self.assertEqual(choose_language([]), {"language": "en", "confidence": 0.0, "samples": 0})

    def test_invalid_worker_output_fails_instead_of_guessing(self):
        with patch("meeting_language.subprocess.run") as run:
            run.return_value.stdout = '{"language":"es"}'
            with self.assertRaises(ValueError):
                detect_meeting_language("audio.wav")

    def test_worker_failure_is_not_silently_english(self):
        import subprocess
        with patch("meeting_language.subprocess.run", side_effect=subprocess.TimeoutExpired("detect", 180)):
            with self.assertRaises(subprocess.TimeoutExpired):
                detect_meeting_language("audio.wav")



class FinalLanguageContractTests(unittest.TestCase):
    def test_full_final_pass_uses_detected_language_instead_of_live_hint(self):
        import types
        import transcription_server as server
        import engines
        import tempfile, wave, os
        audio = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        audio.close()
        self.addCleanup(os.unlink, audio.name)
        with wave.open(audio.name, "wb") as wav:
            wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000)
            wav.writeframes(b"\0\0" * 200000)
        asr = types.SimpleNamespace(close=lambda: None, transcribe_ts=lambda path, language: {
            "tokens": [{"text": language, "start": 0.0, "end": 1.0}]})
        with patch("meeting_language.detect_meeting_language", return_value={"language": "pt", "confidence": .99, "samples": 1}), \
             patch.object(engines, "ParakeetEngine", return_value=asr), \
             patch.object(engines, "is_apple_silicon", return_value=True), \
             patch.object(engines, "tokens_to_segments", return_value=[{"start": 0, "end": 1, "text": "Portuguese final"}]), \
             patch.object(server, "_ffmpeg_channel"), \
             patch.object(server, "_diarize_parakeet", return_value={"segments": [{"start": 0, "end": 1, "speaker": "Speaker 1"}], "speakers": ["Speaker 1"]}):
            result = server.finalize_recording(audio.name, language="en", is_dual=False)
        self.assertEqual(result["language"], "pt")
        self.assertTrue(result["finalized"])
        self.assertEqual(result["duration"], 12.5)
        self.assertEqual(result["turns"][0]["text"], "Portuguese final")
        self.assertEqual(result["turns"][0]["channel"], "mic")


if __name__ == "__main__":
    unittest.main()
