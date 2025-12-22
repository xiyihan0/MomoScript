from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, MutableMapping, Optional, Sequence


@dataclass(frozen=True)
class TypstSandboxOptions:
    timeout_s: Optional[float] = 30.0
    max_mem_mb: Optional[int] = 2048
    rayon_threads: Optional[int] = 4
    procgov_bin: Optional[str] = None
    enable_procgov: bool = True


def _merge_env(extra_env: Optional[Mapping[str, str]], rayon_threads: Optional[int]) -> dict[str, str]:
    env: MutableMapping[str, str] = dict(os.environ)
    if extra_env:
        env.update({str(k): str(v) for k, v in extra_env.items()})
    if rayon_threads and rayon_threads > 0:
        env.setdefault("RAYON_NUM_THREADS", str(int(rayon_threads)))
    return dict(env)


def _find_procgov(explicit: Optional[str]) -> Optional[str]:
    if explicit:
        p = shutil.which(explicit) or explicit
        return p
    return shutil.which("procgov") or shutil.which("procgov.exe")


def _run_plain(
    cmd: Sequence[str],
    *,
    cwd: Optional[Path],
    env: Mapping[str, str],
    timeout_s: Optional[float],
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        list(cmd),
        cwd=str(cwd) if cwd else None,
        env=dict(env),
        capture_output=True,
        text=True,
        timeout=timeout_s if timeout_s and timeout_s > 0 else None,
    )


def _run_with_procgov(
    cmd: Sequence[str],
    *,
    cwd: Optional[Path],
    env: Mapping[str, str],
    timeout_s: Optional[float],
    max_mem_mb: Optional[int],
    procgov_path: str,
) -> subprocess.CompletedProcess[str]:
    pg: list[str] = [procgov_path, "--nomonitor", "--recursive"]
    if max_mem_mb and max_mem_mb > 0:
        pg.extend(["--maxmem", f"{int(max_mem_mb)}M"])
    if timeout_s and timeout_s > 0:
        # procgov expects clock-time timeout in milliseconds.
        pg.extend(["--timeout", str(int(float(timeout_s) * 1000))])
    pg.append("--")
    wrapped = pg + list(cmd)
    # Still keep a small python-side timeout as a last resort (e.g. procgov missing monitor).
    py_timeout = None
    if timeout_s and timeout_s > 0:
        py_timeout = float(timeout_s) + 5.0
    return _run_plain(wrapped, cwd=cwd, env=env, timeout_s=py_timeout)


def _run_with_windows_job_object(
    cmd: Sequence[str],
    *,
    cwd: Optional[Path],
    env: Mapping[str, str],
    timeout_s: Optional[float],
    max_mem_mb: int,
) -> subprocess.CompletedProcess[str]:
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    CreateJobObjectW = kernel32.CreateJobObjectW
    CreateJobObjectW.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]
    CreateJobObjectW.restype = wintypes.HANDLE

    SetInformationJobObject = kernel32.SetInformationJobObject
    SetInformationJobObject.argtypes = [wintypes.HANDLE, wintypes.INT, wintypes.LPVOID, wintypes.DWORD]
    SetInformationJobObject.restype = wintypes.BOOL

    AssignProcessToJobObject = kernel32.AssignProcessToJobObject
    AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    AssignProcessToJobObject.restype = wintypes.BOOL

    TerminateJobObject = kernel32.TerminateJobObject
    TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
    TerminateJobObject.restype = wintypes.BOOL

    CloseHandle = kernel32.CloseHandle
    CloseHandle.argtypes = [wintypes.HANDLE]
    CloseHandle.restype = wintypes.BOOL

    class IO_COUNTERS(ctypes.Structure):
        _fields_ = [
            ("ReadOperationCount", ctypes.c_ulonglong),
            ("WriteOperationCount", ctypes.c_ulonglong),
            ("OtherOperationCount", ctypes.c_ulonglong),
            ("ReadTransferCount", ctypes.c_ulonglong),
            ("WriteTransferCount", ctypes.c_ulonglong),
            ("OtherTransferCount", ctypes.c_ulonglong),
        ]

    class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_longlong),
            ("PerJobUserTimeLimit", ctypes.c_longlong),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
            ("IoInfo", IO_COUNTERS),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    JobObjectExtendedLimitInformation = 9
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
    JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x00000100

    hjob = CreateJobObjectW(None, None)
    if not hjob:
        raise OSError(ctypes.get_last_error(), "CreateJobObjectW failed")

    try:
        info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_PROCESS_MEMORY
        info.ProcessMemoryLimit = int(max_mem_mb) * 1024 * 1024
        ok = SetInformationJobObject(hjob, JobObjectExtendedLimitInformation, ctypes.byref(info), ctypes.sizeof(info))
        if not ok:
            raise OSError(ctypes.get_last_error(), "SetInformationJobObject failed")

        proc = subprocess.Popen(
            list(cmd),
            cwd=str(cwd) if cwd else None,
            env=dict(env),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            # Best-effort: attach process to job object so the memory limit applies.
            ph = getattr(proc, "_handle", None)
            if ph is None:
                # Fall back to a plain run (still with timeout / rayon threads).
                try:
                    proc.kill()
                except Exception:
                    pass
                out, err = proc.communicate()
                return subprocess.CompletedProcess(list(cmd), proc.returncode, out, err)
            ok = AssignProcessToJobObject(hjob, wintypes.HANDLE(int(ph)))
            if not ok:
                # If we can't attach to a job object, still return the process output
                # instead of hard failing.
                try:
                    proc.kill()
                except Exception:
                    pass
                out, err = proc.communicate()
                return subprocess.CompletedProcess(list(cmd), proc.returncode, out, err)

            try:
                out, err = proc.communicate(timeout=timeout_s if timeout_s and timeout_s > 0 else None)
            except subprocess.TimeoutExpired:
                TerminateJobObject(hjob, 1)
                out, err = proc.communicate()
            return subprocess.CompletedProcess(list(cmd), proc.returncode, out, err)
        finally:
            try:
                if proc.poll() is None:
                    TerminateJobObject(hjob, 1)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
    finally:
        CloseHandle(hjob)


def run_typst_sandboxed(
    cmd: Sequence[str],
    *,
    cwd: Optional[Path] = None,
    extra_env: Optional[Mapping[str, str]] = None,
    options: TypstSandboxOptions = TypstSandboxOptions(),
) -> subprocess.CompletedProcess[str]:
    env = _merge_env(extra_env, options.rayon_threads)

    if os.name == "nt":
        # Prefer procgov if available (it uses job objects too, and supports recursive kills).
        if options.enable_procgov and (options.timeout_s or options.max_mem_mb):
            procgov = _find_procgov(options.procgov_bin)
            if procgov:
                return _run_with_procgov(
                    cmd,
                    cwd=cwd,
                    env=env,
                    timeout_s=options.timeout_s,
                    max_mem_mb=options.max_mem_mb,
                    procgov_path=procgov,
                )

        if options.max_mem_mb and options.max_mem_mb > 0:
            return _run_with_windows_job_object(
                cmd,
                cwd=cwd,
                env=env,
                timeout_s=options.timeout_s,
                max_mem_mb=int(options.max_mem_mb),
            )

        return _run_plain(cmd, cwd=cwd, env=env, timeout_s=options.timeout_s)

    # Non-Windows: rely on python timeout + optional RLIMIT_AS for a best-effort memory cap.
    preexec_fn = None
    if options.max_mem_mb and options.max_mem_mb > 0 and hasattr(os, "fork"):
        try:
            import resource  # type: ignore

            max_bytes = int(options.max_mem_mb) * 1024 * 1024

            def _limit() -> None:
                try:
                    resource.setrlimit(resource.RLIMIT_AS, (max_bytes, max_bytes))
                except Exception:
                    pass

            preexec_fn = _limit
        except Exception:
            preexec_fn = None

    return subprocess.run(
        list(cmd),
        cwd=str(cwd) if cwd else None,
        env=dict(env),
        capture_output=True,
        text=True,
        timeout=options.timeout_s if options.timeout_s and options.timeout_s > 0 else None,
        preexec_fn=preexec_fn,  # type: ignore[arg-type]
    )
