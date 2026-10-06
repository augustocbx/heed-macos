import os
import tempfile
import unittest
from managed_work import temporary_audio


class ManagedAudioWorkTests(unittest.TestCase):
    def test_working_audio_remains_inside_the_reserved_job(self):
        with tempfile.TemporaryDirectory() as root:
            job = os.path.join(root, "reserved-job")
            os.mkdir(job)
            path = temporary_audio(os.path.join(root, "capture.wav"), job)
            self.assertEqual(os.path.dirname(path), job)
            self.assertTrue(os.path.isfile(path))

    def test_default_keeps_work_beside_managed_source(self):
        with tempfile.TemporaryDirectory() as root:
            path = temporary_audio(os.path.join(root, "chunk.wav"))
            self.assertEqual(os.path.dirname(path), root)

    def test_unavailable_or_symlinked_working_directory_is_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(ValueError):
                temporary_audio("source.wav", os.path.join(root, "missing"))
            link = os.path.join(root, "link")
            os.symlink(root, link)
            with self.assertRaises(ValueError):
                temporary_audio("source.wav", link)

    def test_unsafe_recovery_rate_is_rejected_before_model_or_channel_writers(self):
        import wave
        from unittest.mock import patch
        import transcription_server
        with tempfile.TemporaryDirectory() as root:
            source = os.path.join(root, "low-rate.wav")
            with wave.open(source, "wb") as audio:
                audio.setnchannels(2)
                audio.setsampwidth(1)
                audio.setframerate(4000)
                audio.writeframes(bytes(49 * 4000 * 2))
            with patch("engines.ParakeetEngine") as model, patch.object(transcription_server, "_ffmpeg_channel") as writer:
                with self.assertRaisesRegex(ValueError, "working copies"):
                    transcription_server.finalize_recording(source, "en", True, manual=True, work_directory=root)
                model.assert_not_called()
                writer.assert_not_called()
            with self.assertRaisesRegex(ValueError, "working copies"):
                transcription_server.split_stereo(source, root)

    def test_rf64_metadata_and_duration_support_larger_configured_capture_limits(self):
        import struct
        import engines
        from managed_work import wave_metadata, validate_processing_wave
        with tempfile.TemporaryDirectory() as root:
            source = os.path.join(root, "rf64.wav")
            data = bytes(3200)
            ds64 = b"ds64" + struct.pack("<IQQQI", 28, 3272, len(data), 1600, 0)
            fmt = b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, 16000, 32000, 2, 16)
            with open(source, "wb") as audio:
                audio.write(b"RF64" + struct.pack("<I", 0xffffffff) + b"WAVE" + ds64 + fmt + b"data" + struct.pack("<I", 0xffffffff) + data)
            self.assertEqual(wave_metadata(source)["duration"], 0.1)
            self.assertEqual(engines._wav_duration(source), 0.1)
            self.assertEqual(validate_processing_wave(source)["channels"], 1)
