"""Inspect an owned child without reaping it, including macOS CPython 3.12.

Darwin's public sys/wait.h exposes waitid even when CPython omits os.waitid.
The ctypes declarations below match LP64 sys/signal.h siginfo_t and sys/wait.h
idtype_t/id_t; no private API, installed binary, or compilation is needed.
"""
import ctypes
import errno
import os
import sys


class _DarwinSigval(ctypes.Union):
    _fields_ = [('integer', ctypes.c_int), ('pointer', ctypes.c_void_p)]


class _DarwinSiginfo(ctypes.Structure):
    _fields_ = [('si_signo', ctypes.c_int), ('si_errno', ctypes.c_int),
                ('si_code', ctypes.c_int), ('si_pid', ctypes.c_int),
                ('si_uid', ctypes.c_uint), ('si_status', ctypes.c_int),
                ('si_addr', ctypes.c_void_p), ('si_value', _DarwinSigval),
                ('si_band', ctypes.c_long), ('padding', ctypes.c_ulong * 7)]


def _darwin_child_exited(pid):
    if sys.platform != 'darwin' or ctypes.sizeof(ctypes.c_void_p) != 8:
        raise RuntimeError('Unreaped process ownership checks are unavailable')
    # Darwin public enum P_PID=1; WEXITED=4, WNOHANG=1, WNOWAIT=32.
    # Do not depend on optional CPython os.P_PID/os.waitid bindings.
    info = _DarwinSiginfo()
    waitid = ctypes.CDLL(None, use_errno=True).waitid
    waitid.argtypes = [ctypes.c_int, ctypes.c_uint, ctypes.POINTER(_DarwinSiginfo), ctypes.c_int]
    waitid.restype = ctypes.c_int
    result = waitid(1, pid, ctypes.byref(info), 4 | 1 | 32)
    if result != 0:
        error = ctypes.get_errno()
        if error == errno.ECHILD:
            raise ChildProcessError(error, 'Child ownership is unavailable')
        raise OSError(error, 'Unreaped child inspection failed')
    return info.si_pid == pid


def child_exited_without_reaping(pid):
    waitid = getattr(os, 'waitid', None)
    if waitid is None:
        return _darwin_child_exited(pid)
    result = waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
    return result is not None and result.si_pid == pid
