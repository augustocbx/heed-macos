"""Place temporary audio inside the caller's quota-reserved working directory."""
import os
import tempfile


def temporary_audio(source_path, work_directory=None):
    directory = work_directory or os.path.dirname(os.path.abspath(source_path))
    if not isinstance(directory, str) or not os.path.isdir(directory) or os.path.islink(directory):
        raise ValueError("Managed audio working directory is unavailable")
    descriptor, path = tempfile.mkstemp(prefix="heed-work-", suffix=".wav", dir=directory)
    os.close(descriptor)
    return path
