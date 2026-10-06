"""Hash-locked offline direct SMB runtime. This tool never downloads dependencies."""

from __future__ import annotations
import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path, PurePosixPath


class RuntimeFailure(Exception):
    """Only a stable public code leaves the runtime boundary."""

    def __init__(self, code):
        self.code = code
        super().__init__(code)


PINNED = {
    "cffi": (
        "2.1.1",
        "cffi-2.1.1-cp312-cp312-macosx_11_0_arm64.whl",
        184719,
        "f81b3b8f3d4e343550fa4baa0e479bba9f2d29ce9c2e9b51d1ce1718d7442fcf",
        ["cp312-cp312-macosx_11_0_arm64"],
    ),
    "cryptography": (
        "50.0.2",
        "cryptography-50.0.2-cp311-abi3-macosx_11_0_arm64.whl",
        3914904,
        "fa8f5efb344d6908a1ce62f4a24e2e5780f825d6f53f5f50ec5ffacac72936cb",
        ["cp311-abi3-macosx_11_0_arm64"],
    ),
    "pycparser": (
        "3.0",
        "pycparser-3.0-py3-none-any.whl",
        48172,
        "b727414169a36b7d524c1c3e31839a521725078d7b2ff038656844266160a992",
        ["py3-none-any"],
    ),
    "pyspnego": (
        "0.12.4",
        "pyspnego-0.12.4-py3-none-any.whl",
        131003,
        "a29a34de1abe9e9b30d9aa1d363f8e49fc159eb7355b1f2ee86ccb3a2ce3bba9",
        ["py3-none-any"],
    ),
    "smbprotocol": (
        "1.17.0",
        "smbprotocol-1.17.0-py3-none-any.whl",
        128208,
        "bd1abff5417f5af83ca516a64ab8e5acece3dbdcf58d4e5e23e47f5165a77349",
        ["py3-none-any"],
    ),
}


def regular(path: Path, maximum=16_000_000) -> bytes:
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size > maximum:
            raise RuntimeFailure("payload-invalid")
        return path.read_bytes()
    except OSError:
        raise RuntimeFailure("payload-invalid") from None


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def unique_json(data: bytes):
    def pairs(items):
        value = {}
        for key, item in items:
            if key in value:
                raise ValueError("duplicate")
            value[key] = item
        return value

    return json.loads(data, object_pairs_hook=pairs)


def payload_dir(root: Path) -> Path:
    root = Path(root)
    target = root / "packages/server/native/smb-direct"
    if (
        not root.is_dir()
        or target.resolve() != root.resolve() / "packages/server/native/smb-direct"
    ):
        raise RuntimeFailure("payload-invalid")
    return target


def verify_payload(root: Path) -> dict:
    try:
        folder = payload_dir(root)
        data = unique_json(regular(folder / "wheel-manifest.json", 65_536))
        if (
            set(data)
            != {"schemaVersion", "python", "architecture", "minimumMacOS", "wheels"}
            or data["schemaVersion"] != 1
            or data["python"] != "3.12"
            or data["architecture"] != "arm64"
            or data["minimumMacOS"] != "14.0"
        ):
            raise ValueError("metadata")
        if not isinstance(data["wheels"], list) or len(data["wheels"]) != len(PINNED):
            raise ValueError("inventory")
        expected, lock = set(), []
        for wheel in data["wheels"]:
            if set(wheel) != {
                "name",
                "version",
                "filename",
                "size",
                "sha256",
                "tags",
                "source",
                "licenses",
            }:
                raise ValueError("wheel schema")
            name = wheel["name"]
            pin = PINNED[name]
            if (
                wheel["version"],
                wheel["filename"],
                wheel["size"],
                wheel["sha256"],
                wheel["tags"],
            ) != pin:
                raise ValueError("pin")
            if wheel["filename"] in expected:
                raise ValueError("duplicate wheel")
            expected.add(wheel["filename"])
            blob = regular(folder / "wheels" / wheel["filename"])
            if len(blob) != wheel["size"] or digest(blob) != wheel["sha256"]:
                raise ValueError("hash")
            lock.append(f"{name}=={wheel['version']} --hash=sha256:{wheel['sha256']}\n")
            with zipfile.ZipFile(folder / "wheels" / wheel["filename"]) as archive:
                names = archive.namelist()
                if len(names) != len(set(names)) or len(names) > 10_000:
                    raise ValueError("zip inventory")
                for entry in archive.infolist():
                    path = PurePosixPath(entry.filename)
                    if (
                        path.is_absolute()
                        or ".." in path.parts
                        or "\\" in entry.filename
                        or entry.file_size > 32_000_000
                        or stat.S_ISLNK(entry.external_attr >> 16)
                    ):
                        raise ValueError("unsafe zip")
                dist = name.replace("-", "_") + "-" + wheel["version"] + ".dist-info/"
                metadata = archive.read(dist + "METADATA").decode("utf-8")
                if (
                    f"Name: {name}\n" not in metadata
                    or f"Version: {wheel['version']}\n" not in metadata
                ):
                    raise ValueError("distribution")
                tags = [
                    x[5:]
                    for x in archive.read(dist + "WHEEL").decode("utf-8").splitlines()
                    if x.startswith("Tag: ")
                ]
                if (
                    tags != wheel["tags"]
                    or not wheel["licenses"]
                    or any(x not in names for x in wheel["licenses"])
                ):
                    raise ValueError("ABI or licenses")
        wheel_dir = folder / "wheels"
        if wheel_dir.is_symlink() or {x.name for x in wheel_dir.iterdir()} != expected:
            raise ValueError("wheel directory")
        if regular(folder / "requirements.lock", 65_536).decode("utf-8") != "".join(
            lock
        ):
            raise ValueError("hash lock")
        return data
    except RuntimeFailure:
        raise
    except (OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile, UnicodeError):
        raise RuntimeFailure("payload-invalid") from None


def clean_env():
    # -I additionally ignores Python environment overrides. Offline pip does not
    # load user configuration or index URLs, and subprocess output stays private.
    return {
        key: value
        for key, value in os.environ.items()
        if key not in {"PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV"}
        and not key.startswith("PIP_")
    }


def run_checked(args, timeout=90):
    try:
        value = subprocess.run(
            [str(x) for x in args],
            env=clean_env(),
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=timeout,
            check=True,
        )
        if len(value.stdout) > 2_000_000 or len(value.stderr) > 2_000_000:
            raise RuntimeFailure("runtime-unavailable")
        return value.stdout
    except (OSError, subprocess.SubprocessError):
        raise RuntimeFailure("runtime-unavailable") from None


def check_python(python):
    code = "import json,platform,sys;print(json.dumps(dict(python=f'{sys.version_info.major}.{sys.version_info.minor}',architecture=platform.machine(),system=platform.system(),macOS=platform.mac_ver()[0])))"
    try:
        data = unique_json(
            run_checked([python, "-I", "-S", "-B", "-c", code], timeout=10)
        )
        if (
            data["python"] != "3.12"
            or data["architecture"] != "arm64"
            or data["system"] != "Darwin"
            or int(data["macOS"].split(".")[0]) < 14
        ):
            raise ValueError("incompatible")
        return data
    except (KeyError, ValueError, TypeError):
        raise RuntimeFailure("runtime-unavailable") from None


def source_inventory(root):
    folder = payload_dir(root)
    if (folder / "__pycache__").exists() or (folder / "__pycache__").is_symlink():
        raise RuntimeFailure("payload-invalid")
    allowed = {
        "runtime.py",
        "guardian.py",
        "transport.py",
        "identity.py",
        "protocol.py",
        "journal.py",
        "transaction.py",
        "requirements.lock",
        "wheel-manifest.json",
        "wheels",
    }
    for child in folder.iterdir():
        if child.name == "wheels":
            if child.is_symlink() or not child.is_dir():
                raise RuntimeFailure("payload-invalid")
        elif child.name not in allowed and not (
            child.name.startswith("test_") and child.suffix == ".py"
        ):
            raise RuntimeFailure("payload-invalid")
        elif not child.is_file() or child.is_symlink():
            raise RuntimeFailure("payload-invalid")
    sources = sorted(
        x.name for x in folder.glob("*.py") if not x.name.startswith("test_")
    )
    if not {
        "runtime.py",
        "guardian.py",
        "transport.py",
        "identity.py",
        "protocol.py",
    }.issubset(sources):
        raise RuntimeFailure("payload-invalid")
    return {name: digest(regular(folder / name)) for name in sources}


def installed_expected(root):
    """Installed executable package bytes derive from immutable pinned wheels."""
    folder, files = payload_dir(root), {}
    for name, pin in PINNED.items():
        with zipfile.ZipFile(folder / "wheels" / pin[1]) as archive:
            for entry in archive.infolist():
                if entry.is_dir() or entry.filename.endswith(".dist-info/RECORD"):
                    continue
                if ".data/" in entry.filename or entry.filename.endswith(".pth"):
                    raise RuntimeFailure("payload-invalid")
                files[entry.filename] = digest(archive.read(entry))
    return files


BOOTSTRAP_BIN = {
    "python",
    "python3",
    "python3.12",
    "activate",
    "activate.csh",
    "activate.fish",
    "Activate.ps1",
    "cffi-gen-src",
    "pyspnego-parse",
}


def bootstrap_inventory(target):
    binary = target / "bin"
    if binary.is_symlink() or {x.name for x in binary.iterdir()} != BOOTSTRAP_BIN:
        raise RuntimeFailure("runtime-unavailable")
    library = target / "lib/python3.12"
    if library.is_symlink() or {x.name for x in library.iterdir()} != {"site-packages"}:
        raise RuntimeFailure("runtime-unavailable")
    return {
        name: digest(regular(target / name))
        for name in ["pyvenv.cfg", *("bin/" + x for x in sorted(BOOTSTRAP_BIN))]
    }


def verify_at(root, target, receipt):
    if (
        set(receipt)
        != {
            "schemaVersion",
            "python",
            "architecture",
            "minimumMacOS",
            "executableSha256",
            "sources",
            "payloadSha256",
            "basePython",
            "baseSha256",
            "bootstrap",
        }
        or receipt["schemaVersion"] != 1
        or receipt["python"] != "3.12"
        or receipt["architecture"] != "arm64"
        or receipt["minimumMacOS"] != "14.0"
    ):
        raise RuntimeFailure("runtime-unavailable")
    if (
        target.is_symlink()
        or target.resolve() != target.absolute()
        or (target / "bin").is_symlink()
        or receipt["sources"] != source_inventory(root)
        or receipt["payloadSha256"]
        != digest(regular(payload_dir(root) / "wheel-manifest.json"))
    ):
        raise RuntimeFailure("runtime-unavailable")
    if receipt["bootstrap"] != bootstrap_inventory(target):
        raise RuntimeFailure("runtime-unavailable")
    binary = regular(target / "bin/python")
    if digest(binary) != receipt["executableSha256"]:
        raise RuntimeFailure("runtime-unavailable")
    base = Path(receipt["basePython"])
    if not base.is_absolute() or digest(regular(base)) != receipt["baseSha256"]:
        raise RuntimeFailure("runtime-unavailable")
    # --copies uses the trusted base executable, not a mutable external symlink.
    if digest(binary) != receipt["baseSha256"]:
        raise RuntimeFailure("runtime-unavailable")
    config = regular(target / "pyvenv.cfg", 4096).decode("utf-8")
    if "include-system-site-packages = false\n" not in config or not re.search(
        r"^version = 3\.12\.\d+$", config, re.M
    ):
        raise RuntimeFailure("runtime-unavailable")
    site = target / "lib/python3.12/site-packages"
    if site.resolve() != target / "lib/python3.12/site-packages":
        raise RuntimeFailure("runtime-unavailable")
    expected = installed_expected(root)
    generated = {
        f"{name.replace('-', '_')}-{pin[0]}.dist-info/{item}"
        for name, pin in PINNED.items()
        for item in ("RECORD", "INSTALLER", "REQUESTED")
    }
    actual = set()
    for current, dirs, names in os.walk(site, followlinks=False):
        for directory in dirs:
            if (Path(current) / directory).is_symlink():
                raise RuntimeFailure("runtime-unavailable")
        for name in names:
            path = Path(current) / name
            relative = path.relative_to(site).as_posix()
            if "__pycache__" in path.parts or path.suffix == ".pyc":
                raise RuntimeFailure("runtime-unavailable")
            actual.add(relative)
            blob = regular(path)
            if relative in expected:
                if digest(blob) != expected[relative]:
                    raise RuntimeFailure("runtime-unavailable")
            elif relative not in generated:
                raise RuntimeFailure("runtime-unavailable")
    if not set(expected).issubset(actual):
        raise RuntimeFailure("runtime-unavailable")
    return receipt


def verify_runtime(root: Path) -> dict:
    try:
        root = Path(root).resolve()
        verify_payload(root)
        target = root / "runtime/smb"
        receipt = unique_json(regular(target / "receipt.json", 65_536))
        return verify_at(root, target, receipt)
    except (RuntimeFailure, OSError, ValueError, KeyError, TypeError, UnicodeError):
        raise RuntimeFailure("runtime-unavailable") from None


def self_test(root, python):
    folder = payload_dir(root)
    code = """import importlib.metadata, json, sys
from pathlib import Path
sys.path[:0] = [sys.argv[1], sys.argv[2]]
from transport import protected_connection_type, SmbProtocolBackend
from smbprotocol.file_info import FileInternalInformation, FileRenameInformation, FileDispositionInformation
from smbprotocol.open import Open, SMB2QueryInfoRequest, SMB2SetInfoRequest
from cryptography.hazmat.primitives.ciphers.aead import AESCCM
expected = json.loads(sys.argv[3])
assert all(importlib.metadata.version(k) == v for k,v in expected.items())
assert protected_connection_type() and callable(SmbProtocolBackend)
assert all(callable(getattr(Open, k)) for k in ('create', 'read', 'write', 'close', 'flush'))
for structure in (FileInternalInformation(), FileRenameInformation(), FileDispositionInformation()):
    assert structure.pack()
print(json.dumps({'ok': True}))
"""
    result = unique_json(
        run_checked(
            [
                python,
                "-I",
                "-S",
                "-B",
                "-c",
                code,
                folder,
                Path(python).parent.parent / "lib/python3.12/site-packages",
                json.dumps({name: pin[0] for name, pin in PINNED.items()}),
            ],
            timeout=30,
        )
    )
    if result != {"ok": True}:
        raise RuntimeFailure("runtime-unavailable")
    return result


def install_runtime(root: Path, python: Path) -> dict:
    root = Path(root).resolve()
    verify_payload(root)
    source_inventory(root)
    try:
        python = Path(python).resolve(strict=True)
        if not python.is_absolute():
            raise RuntimeFailure("runtime-unavailable")
        check_python(python)
        regular(python)
    except (OSError, RuntimeError):
        raise RuntimeFailure("runtime-unavailable") from None
    parent = root / "runtime"
    if parent.is_symlink():
        raise RuntimeFailure("runtime-unavailable")
    parent.mkdir(mode=0o700, exist_ok=True)
    target = parent / "smb"
    # Installed releases are immutable. Never adopt or overwrite a pre-existing
    # unknown runtime; the release installer creates a fresh stage for upgrades.
    if target.exists() or target.is_symlink():
        return verify_runtime(root)
    stage = Path(tempfile.mkdtemp(prefix=".smb-", dir=parent))
    try:
        run_checked(
            [python, "-I", "-B", "-m", "venv", "--copies", "--without-pip", stage]
        )
        folder = payload_dir(root)
        run_checked(
            [
                python,
                "-I",
                "-B",
                "-m",
                "pip",
                "--isolated",
                "--python",
                stage / "bin/python",
                "install",
                "--disable-pip-version-check",
                "--no-index",
                "--require-hashes",
                "--only-binary=:all:",
                "--no-compile",
                "--no-deps",
                "--find-links",
                folder / "wheels",
                "-r",
                folder / "requirements.lock",
            ]
        )
        receipt = dict(
            schemaVersion=1,
            python="3.12",
            architecture="arm64",
            minimumMacOS="14.0",
            executableSha256=digest(regular(stage / "bin/python")),
            sources=source_inventory(root),
            payloadSha256=digest(regular(folder / "wheel-manifest.json")),
            basePython=str(python),
            baseSha256=digest(regular(python)),
            bootstrap=bootstrap_inventory(stage),
        )
        verify_at(root, stage, receipt)
        check_python(stage / "bin/python")
        self_test(root, stage / "bin/python")
        (stage / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
        (stage / "receipt.json").chmod(0o600)
        os.rename(stage, target)
        return verify_runtime(root)
    finally:
        if stage.exists():
            shutil.rmtree(stage)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command",
        choices=(
            "verify-payload",
            "verify-python",
            "install",
            "verify",
            "self-test",
            "guardian",
        ),
    )
    parser.add_argument("root", type=Path)
    parser.add_argument("--python", type=Path)
    args = parser.parse_args()
    try:
        if args.command == "verify-payload":
            verify_payload(args.root)
        elif args.command == "verify-python":
            verify_payload(args.root)
            if args.python is None:
                raise RuntimeFailure("runtime-unavailable")
            check_python(args.python)
        elif args.command == "install":
            if args.python is None:
                raise RuntimeFailure("runtime-unavailable")
            install_runtime(args.root, args.python)
        else:
            verify_runtime(args.root)
            if args.command == "guardian":
                # Isolated mode removes cwd/script-dir imports. Add only this
                # verified release's helper directory, never PYTHONPATH or cwd.
                sys.path[:0] = [
                    str(payload_dir(args.root.resolve())),
                    str(
                        args.root.resolve() / "runtime/smb/lib/python3.12/site-packages"
                    ),
                ]
                from guardian import main as guardian_main

                guardian_main()
                return 0
            if args.command == "self-test":
                self_test(args.root, args.root.resolve() / "runtime/smb/bin/python")
        print(json.dumps({"ok": True}))
        return 0
    except (RuntimeFailure, OSError, ValueError, TypeError, KeyError):
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": (
                        "runtime-unavailable"
                        if args.command != "verify-payload"
                        else "payload-invalid"
                    ),
                }
            )
        )
        return 1


if __name__ == "__main__":
    sys.exit(main())
