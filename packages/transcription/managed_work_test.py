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
