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


def wave_metadata(source_path):
    """Read bounded RIFF/RF64 metadata without Python wave's RIFF-only limitation."""
    import struct
    size = os.path.getsize(source_path)
    with open(source_path, "rb") as audio:
        header = audio.read(min(size, 1048576))
    if len(header) < 12 or header[:4] not in (b"RIFF", b"RF64") or header[8:12] != b"WAVE":
        raise ValueError("Invalid WAV; preserve the source and import supported audio")
    offset, format_ok, data_ok, large_data = 12, False, False, None
    while offset + 8 <= len(header):
        name, length = header[offset:offset + 4], struct.unpack_from("<I", header, offset + 4)[0]
        start = offset + 8
        if name == b"ds64" and length >= 28 and start + 28 <= len(header):
            large_data = struct.unpack_from("<Q", header, start + 8)[0]
        if name == b"fmt ":
            if length < 16 or start + length > len(header):
                raise ValueError("Unsupported WAV header")
            codec, channels, rate = struct.unpack_from("<HHI", header, start)
            alignment, bits = struct.unpack_from("<HH", header, start + 12)
            if codec == 65534 and length >= 40:
                codec = struct.unpack_from("<H", header, start + 24)[0]
            if codec not in (1, 3) or channels < 1 or rate < 1 or bits not in (8, 16, 24, 32, 64) or alignment != channels * bits // 8:
                raise ValueError("Unsupported WAV format")
            format_ok = True
        if name == b"data":
            count = large_data if length == 0xffffffff else length
            if count is None or start + count > size:
                raise ValueError("Truncated WAV; preserve the source for recovery")
            data_ok = True
            break
        offset = start + length + length % 2
    if not format_ok or not data_ok:
        raise ValueError("Unsupported WAV header; normalize the source within the configured quota")

    return {"channels": channels, "sample_rate": rate, "sample_bits": bits, "data_bytes": count, "data_offset": start, "duration": count / alignment / rate}


def validate_processing_wave(source_path):
    """Bound mono16k PCM16 channel copies by the retained source before any writer/model."""
    metadata = wave_metadata(source_path)
    if metadata["channels"] not in (1, 2) or metadata["sample_rate"] < 16000 or metadata["sample_bits"] < 16:
        raise ValueError("Recovery WAV working copies exceed the source budget; import it to normalize within the configured quota")
    return metadata
