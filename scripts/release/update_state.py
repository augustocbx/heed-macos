"""Private atomic transaction files shared by the detached updater and installer."""
import json
import os
from pathlib import Path
import stat
import tempfile
import time
import uuid

FILES = {'status.json', 'transaction.json', 'installer-phase.json', 'installer-result.json'}


def directory(home, transaction):
    if str(uuid.UUID(transaction)) != transaction:
        raise ValueError('Invalid update transaction ID.')
    home = Path(home)
    if not home.is_absolute() or home.is_symlink():
        raise ValueError('Invalid update installation directory.')
    for path in [home, home / 'updates', home / 'updates' / transaction]:
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError('Update storage must be a private owned directory.')
    return home / 'updates' / transaction


def location(home, transaction, name):
    if name not in FILES: raise ValueError('Unknown update state file.')
    path = directory(home, transaction) / name
    if path.is_symlink(): raise ValueError('Update state cannot be a symbolic link.')
    return path


def read(home, transaction, name):
    path = location(home, transaction, name)
    try: fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError: return None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 2 * 1024 * 1024:
            raise ValueError('Invalid update state file.')
        data = json.loads(os.read(fd, 2 * 1024 * 1024 + 1))
        if not isinstance(data, dict) or data.get('schema') != 1 or data.get('transactionId') != transaction:
            raise ValueError('Invalid update state schema.')
        return data
    finally: os.close(fd)


def write(home, transaction, name, value):
    path = location(home, transaction, name)
    fd, temporary = tempfile.mkstemp(prefix='.' + name, dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as file:
            json.dump({**value, 'schema':1, 'transactionId':transaction, 'updatedAt':time.time()}, file)
            file.flush(); os.fsync(file.fileno())
        os.replace(temporary, path)
        parent = os.open(path.parent, os.O_RDONLY)
        try: os.fsync(parent)
        finally: os.close(parent)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)
