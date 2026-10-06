"""Shared advisory ownership for release installation, update and uninstall."""
import argparse
import fcntl
import os
from pathlib import Path
import stat
import subprocess
import sys


class LockError(ValueError):
    pass


def lock_path(home):
    home = Path(home)
    if not home.is_absolute():
        raise LockError('The installation directory must be absolute.')
    home = home.resolve()
    if home in [Path('/'), Path.home().resolve()] or home in Path.home().resolve().parents:
        raise LockError('Use a dedicated installation directory.')
    # A sibling inode survives deletion of HEED_HOME by the uninstaller.
    return home.parent / ('.' + home.name.lstrip('.') + '-installation.lock')


class InstallationLock:
    def __init__(self, home, inherited_fd=None):
        self.path = lock_path(home)
        self.inherited_fd = inherited_fd
        self.fd = None

    def __enter__(self):
        candidate = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            candidate = os.open(self.path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
            info = os.fstat(candidate)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise LockError('The installation lock is not a private owned regular file.')
            if self.inherited_fd is not None:
                inherited = os.fstat(self.inherited_fd)
                if (inherited.st_dev, inherited.st_ino) != (info.st_dev, info.st_ino):
                    raise LockError('The inherited installation lock does not match this installation.')
                os.close(candidate); candidate = os.dup(self.inherited_fd)
            fcntl.flock(candidate, fcntl.LOCK_EX | fcntl.LOCK_NB)
            os.set_inheritable(candidate, True)
            self.fd = candidate
            return self
        except (OSError, ValueError) as error:
            if candidate is not None:
                try: os.close(candidate)
                except OSError: pass
            if isinstance(error, LockError):
                raise
            raise LockError('Heed has another installation or update in progress, or the lock cannot be verified. Retry after it finishes.') from error

    def __exit__(self, *args):
        if self.fd is not None:
            # Explicit LOCK_UN would also unlock the inherited descriptor in a surviving child.
            os.close(self.fd); self.fd = None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    run = commands.add_parser('run'); run.add_argument('--home', required=True)
    run.add_argument('arguments', nargs=argparse.REMAINDER)
    verify = commands.add_parser('verify'); verify.add_argument('--home', required=True)
    verify.add_argument('--fd', required=True, type=int)
    args = parser.parse_args(argv)
    try:
        inherited = args.fd if args.command == 'verify' else os.environ.get('HEED_INSTALL_LOCK_FD')
        with InstallationLock(Path(args.home), None if inherited is None else int(inherited)) as lock:
            if args.command == 'verify':
                return 0
            command = args.arguments[1:] if args.arguments[:1] == ['--'] else args.arguments
            if not command:
                raise LockError('An installation command is required.')
            result = subprocess.run(command, env={**os.environ, 'HEED_INSTALL_LOCK_FD': str(lock.fd)}, pass_fds=(lock.fd,))
            return result.returncode if result.returncode >= 0 else 128 - result.returncode
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
