"""GatewaySupervisor — manages the memory-tencentdb Gateway Node.js sidecar process.

On initialize(), checks if the Gateway is already running. If not, starts
it as a subprocess and waits for /health to become available.

On shutdown(), sends a flush signal and waits for clean exit.
"""

from __future__ import annotations

import logging
import os
import shlex
import signal
import subprocess
import threading
import time
from typing import IO, Optional, Set

from .client import MemoryTencentdbSdkClient

logger = logging.getLogger(__name__)

# Default Gateway address
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8420

# Health check parameters
HEALTH_CHECK_INTERVAL = 0.5  # seconds between checks
HEALTH_CHECK_MAX_WAIT = 30   # max seconds to wait for Gateway to start
HEALTH_CHECK_RETRIES = 3     # retries for is_running check

# Log file guard parameters
LOG_TAIL_BYTES_ON_CRASH = 2048  # bytes of stderr log to surface on startup crash
LOG_FILE_MAX_BYTES = 10 * 1024 * 1024  # hard target per active stdout/stderr file
LOG_FILE_RETAIN_BYTES = 1 * 1024 * 1024  # diagnostic tail preserved as <path>.1
LOG_GUARD_INTERVAL_SECS = 0.25
LOG_GUARD_SHUTDOWN_TIMEOUT_SECS = 2.0


class GatewaySupervisor:
    """Manages the memory-tencentdb Gateway sidecar lifecycle."""

    def __init__(
        self,
        host: str = DEFAULT_HOST,
        port: int = DEFAULT_PORT,
        gateway_cmd: Optional[str] = None,
        api_key: Optional[str] = None,
    ):
        """Construct the supervisor.

        Args:
            host: Gateway bind host.
            port: Gateway bind port.
            gateway_cmd: Shell command to spawn the Gateway. Falls back to
                ``MEMORY_TENCENTDB_GATEWAY_CMD`` env var when None.
            api_key: Optional Gateway Bearer token used by the **client**
                (every outbound request adds ``Authorization: Bearer <key>``).
                The supervisor does NOT propagate this value to the spawned
                Gateway's environment — turning auth on at the Gateway is the
                operator's responsibility (set ``TDAI_GATEWAY_API_KEY`` /
                ``server.apiKey`` on the Gateway side directly, in the same
                place you'd configure its port and data dir). Both ends must
                see the same secret; the plugin only handles the client half.
                ``None`` / empty means "do not attach an Authorization
                header", which preserves the legacy default.
        """
        self._host = host
        self._port = port
        self._base_url = f"http://{host}:{port}"
        self._api_key = (api_key or "").strip() or None
        self._client = MemoryTencentdbSdkClient(
            base_url=self._base_url,
            timeout=5,
            api_key=self._api_key,
        )
        self._process: Optional[subprocess.Popen] = None
        # File handles for child's stdout/stderr. Kept open for the lifetime of
        # the process so the kernel pipe buffer never fills up (otherwise the
        # Gateway's event loop would block on write() after ~64 KB of logs).
        self._stdout_log: Optional[IO[bytes]] = None
        self._stderr_log: Optional[IO[bytes]] = None
        self._stdout_log_path: Optional[str] = None
        self._stderr_log_path: Optional[str] = None
        self._log_guard_thread: Optional[threading.Thread] = None
        self._log_guard_stop = threading.Event()
        # A persistent filesystem failure must not emit a warning every 250ms.
        # Clear a path from this set after a successful guard pass so a later,
        # distinct failure is still visible.
        self._log_guard_failed_paths: Set[str] = set()

        # Resolve Gateway command
        # Priority: explicit arg > MEMORY_TENCENTDB_GATEWAY_CMD env
        self._gateway_cmd = gateway_cmd or os.environ.get("MEMORY_TENCENTDB_GATEWAY_CMD", "")

    def is_running(self) -> bool:
        """Check if the Gateway is currently responding to health checks."""
        for _ in range(HEALTH_CHECK_RETRIES):
            try:
                result = self._client.health(timeout=2)
                return result.get("status") in ("ok", "degraded")
            except Exception:
                time.sleep(0.2)
        return False

    def is_process_alive(self) -> bool:
        """Return True iff we have spawned a child and it has not exited.

        Distinct from ``is_running()``:
          * ``is_running`` performs a network health check — slow, but works
            even when the Gateway was started externally (systemd, manual run).
          * ``is_process_alive`` only inspects our own ``Popen`` handle — fast,
            and lets the watchdog notice an exited child without paying for an
            HTTP round-trip every tick.

        Returns False when we never spawned a child, or when the child has
        exited (``poll()`` returns a non-None code). The watchdog combines
        both checks: ``is_process_alive() or is_running()`` — only when both
        say "no" do we attempt a re-spawn.
        """
        proc = self._process
        if proc is None:
            return False
        return proc.poll() is None

    def _reap_dead_process(self) -> None:
        """Drop the reference to a child we spawned that has since exited.

        Called from ``ensure_running`` so that a re-spawn after a crash does
        not leak the previous ``Popen`` handle (the kernel still owns the
        zombie until ``wait()``-style call). Safe to call when the process
        is still alive — it's a no-op in that case.
        """
        proc = self._process
        if proc is None:
            return
        if proc.poll() is None:
            return  # still alive
        try:
            # poll() already reaped the child via waitpid internally on POSIX,
            # so there is nothing more to do here. Just drop our handle and
            # close the log files we opened for this run.
            rc = proc.returncode
            logger.warning(
                "memory-tencentdb Gateway: previous child exited (code=%s); "
                "reaping before respawn.", rc,
            )
        finally:
            self._process = None
            self._close_log_handles()

    def ensure_running(self) -> bool:
        """Ensure the Gateway is running. Start it if not.

        Returns True if the Gateway is available, False if startup failed.
        """
        if self.is_running():
            logger.info("memory-tencentdb Gateway already running at %s", self._base_url)
            return True

        # If we previously spawned a child and it has since died, drop the
        # stale Popen handle so the new spawn below isn't shadowed by a
        # zombie reference. Without this, a crashed-then-respawned Gateway
        # would keep ``self._process`` pointing at the dead PID forever and
        # ``is_process_alive()`` would mislead the watchdog.
        self._reap_dead_process()

        # Try to start the Gateway
        if not self._gateway_cmd:
            logger.warning(
                "memory-tencentdb Gateway is not running and no gateway command configured. "
                "Set MEMORY_TENCENTDB_GATEWAY_CMD environment variable or pass gateway_cmd to supervisor. "
                "memory-tencentdb memory will be unavailable."
            )
            return False

        logger.info("Starting memory-tencentdb Gateway: %s", self._gateway_cmd)

        try:
            env = os.environ.copy()
            env["MEMORY_TENCENTDB_GATEWAY_PORT"] = str(self._port)
            env["MEMORY_TENCENTDB_GATEWAY_HOST"] = self._host
            # The Node Gateway reads TDAI_GATEWAY_{HOST,PORT}. Keep the
            # MEMORY_TENCENTDB_* names for the Python provider contract, but
            # also populate the Gateway-native names unless the operator set
            # them explicitly.
            env.setdefault("TDAI_GATEWAY_PORT", str(self._port))
            env.setdefault("TDAI_GATEWAY_HOST", self._host)
            # Hermes-facing LLM env names predate the Gateway's TDAI_LLM_*
            # names. Mirror them into the child process so Windows-native
            # Hermes installs do not have to set both sets by hand.
            if not env.get("TDAI_LLM_API_KEY") and env.get("MEMORY_TENCENTDB_LLM_API_KEY"):
                env["TDAI_LLM_API_KEY"] = env["MEMORY_TENCENTDB_LLM_API_KEY"]
            if not env.get("TDAI_LLM_BASE_URL") and env.get("MEMORY_TENCENTDB_LLM_BASE_URL"):
                env["TDAI_LLM_BASE_URL"] = env["MEMORY_TENCENTDB_LLM_BASE_URL"]
            if not env.get("TDAI_LLM_MODEL") and env.get("MEMORY_TENCENTDB_LLM_MODEL"):
                env["TDAI_LLM_MODEL"] = env["MEMORY_TENCENTDB_LLM_MODEL"]
            # Note: we deliberately do NOT inject TDAI_GATEWAY_API_KEY into
            # the child's env from here. Whether the Gateway enforces auth is
            # the operator's call — they configure it on the Gateway side
            # (env, yaml, docker run, systemd unit) just like any other
            # Gateway setting. The supervisor's ``api_key`` is purely the
            # client-side Bearer token used for outbound requests.

            # Redirect child stdout/stderr to log files instead of PIPE.
            # Using PIPE without an active reader will deadlock the child once
            # the pipe buffer (~64 KB) fills up. A log directory next to the
            # data dir keeps logs inspectable on crash while eliminating the
            # blocking risk entirely.
            log_dir = self._resolve_log_dir()
            try:
                os.makedirs(log_dir, exist_ok=True)
            except OSError as e:
                logger.warning(
                    "memory-tencentdb Gateway: failed to create log dir %s (%s); "
                    "falling back to DEVNULL", log_dir, e,
                )
                log_dir = None

            if log_dir is not None:
                stdout_path = os.path.join(log_dir, "gateway.stdout.log")
                stderr_path = os.path.join(log_dir, "gateway.stderr.log")
                # Append mode: preserve previous runs for postmortem.
                self._stdout_log = open(stdout_path, "ab", buffering=0)
                self._stderr_log = open(stderr_path, "ab", buffering=0)
                self._stdout_log_path = stdout_path
                self._stderr_log_path = stderr_path
                # Bound files left by previous runs before the child starts.
                # The same in-place truncation method is then used at runtime,
                # preserving the inode referenced by the inherited handles.
                self._enforce_log_limits()
                stdout_target: object = self._stdout_log
                stderr_target: object = self._stderr_log
            else:
                self._stdout_log_path = None
                self._stderr_log_path = None
                stdout_target = subprocess.DEVNULL
                stderr_target = subprocess.DEVNULL

            if os.name == "nt":
                creationflags = 0
                if hasattr(subprocess, "CREATE_NEW_PROCESS_GROUP"):
                    creationflags |= subprocess.CREATE_NEW_PROCESS_GROUP
                self._process = subprocess.Popen(
                    self._gateway_cmd,
                    shell=True,
                    env=env,
                    stdout=stdout_target,
                    stderr=stderr_target,
                    creationflags=creationflags,
                )
            else:
                self._process = subprocess.Popen(
                    shlex.split(self._gateway_cmd),
                    env=env,
                    stdout=stdout_target,
                    stderr=stderr_target,
                    start_new_session=True,  # Detach from parent process group
                )
            self._start_log_guard()
        except Exception as e:
            logger.error("Failed to start memory-tencentdb Gateway: %s", e)
            self._close_log_handles()
            return False

        # Wait for health check
        return self._wait_for_health()

    def _resolve_log_dir(self) -> str:
        """Pick a directory to store Gateway stdout/stderr logs.

        Priority:
          1. ``MEMORY_TENCENTDB_LOG_DIR`` env var
          2. ``~/.hermes/logs/memory_tencentdb`` (hermes-style log location)
          3. ``<cwd>/.memory-tencentdb-logs`` (last-resort fallback if $HOME
             is not set — unusual on real systems, but e.g. hermetic tests)

        Note: the supervisor intentionally does *not* derive this from the
        Gateway's data dir — the Gateway owns that path and the supervisor
        no longer tracks it. Keeping our log dir in the hermes log tree also
        avoids interleaving Gateway logs with user-facing memory data.
        """
        env_dir = os.environ.get("MEMORY_TENCENTDB_LOG_DIR")
        if env_dir:
            return env_dir
        home = os.environ.get("HOME") or os.environ.get("USERPROFILE")
        if home:
            return os.path.join(home, ".hermes", "logs", "memory_tencentdb")
        return os.path.join(os.getcwd(), ".memory-tencentdb-logs")

    def _close_log_handles(self) -> None:
        """Stop the log guard, then close handles; safe to call repeatedly."""
        self._stop_log_guard()
        for attr in ("_stdout_log", "_stderr_log"):
            handle: Optional[IO[bytes]] = getattr(self, attr, None)
            if handle is not None:
                try:
                    handle.close()
                except Exception:
                    pass
                setattr(self, attr, None)

    def _start_log_guard(self) -> None:
        """Start the runtime log-size guard when file logging is active."""
        if self._log_guard_thread is not None and self._log_guard_thread.is_alive():
            return
        if not any((self._stdout_log_path, self._stderr_log_path)):
            return

        self._log_guard_stop.clear()
        thread = threading.Thread(
            target=self._log_guard_loop,
            name="memory-tencentdb-log-guard",
            daemon=True,
        )
        self._log_guard_thread = thread
        thread.start()

    def _stop_log_guard(self) -> None:
        """Signal and join the log guard before its file handles are closed."""
        self._log_guard_stop.set()
        thread = self._log_guard_thread
        self._log_guard_thread = None
        if thread is None or thread is threading.current_thread():
            return

        thread.join(timeout=LOG_GUARD_SHUTDOWN_TIMEOUT_SECS)
        if thread.is_alive():
            logger.warning(
                "memory-tencentdb Gateway log guard did not exit within %.1fs; "
                "continuing shutdown.",
                LOG_GUARD_SHUTDOWN_TIMEOUT_SECS,
            )

    def _log_guard_loop(self) -> None:
        """Periodically cap active Gateway logs without replacing their inode."""
        while not self._log_guard_stop.wait(timeout=LOG_GUARD_INTERVAL_SECS):
            self._enforce_log_limits()

    def _enforce_log_limits(self) -> None:
        """Preserve a bounded tail and truncate oversized active logs in place."""
        pairs = (
            (self._stdout_log_path, self._stdout_log),
            (self._stderr_log_path, self._stderr_log),
        )
        for path, handle in pairs:
            if not path or handle is None or handle.closed:
                continue
            try:
                self._enforce_log_limit(path, handle)
                self._log_guard_failed_paths.discard(path)
            except Exception as e:
                if path not in self._log_guard_failed_paths:
                    logger.warning(
                        "memory-tencentdb Gateway: failed to bound log file %s (%s); "
                        "child logging remains active.",
                        path,
                        e,
                    )
                    self._log_guard_failed_paths.add(path)

    @staticmethod
    def _enforce_log_limit(path: str, handle: IO[bytes]) -> None:
        """Rotate one oversized file while keeping ``handle`` and its inode live."""
        size = os.path.getsize(path)
        if size <= LOG_FILE_MAX_BYTES:
            return

        retain_bytes = min(LOG_FILE_RETAIN_BYTES, size)
        with open(path, "rb") as source:
            if retain_bytes < size:
                source.seek(-retain_bytes, os.SEEK_END)
            tail = source.read(retain_bytes)

        rotated_path = f"{path}.1"
        temporary_path = (
            f"{rotated_path}.{os.getpid()}.{threading.get_ident()}.tmp"
        )
        try:
            with open(temporary_path, "wb") as rotated:
                rotated.write(tail)
            os.replace(temporary_path, rotated_path)
        finally:
            try:
                os.unlink(temporary_path)
            except FileNotFoundError:
                pass

        # Truncate through the parent's existing handle. The child inherited
        # the same open file description, so it keeps writing to this inode
        # after truncation on both POSIX and Windows.
        handle.flush()
        handle.truncate(0)
        logger.info(
            "memory-tencentdb Gateway: bounded oversized log %s "
            "(size=%d, retained=%d at %s)",
            path,
            size,
            retain_bytes,
            rotated_path,
        )

    def _tail_stderr_log(self, max_bytes: int = LOG_TAIL_BYTES_ON_CRASH) -> str:
        """Return the last `max_bytes` of the stderr log for crash diagnostics."""
        path = self._stderr_log_path
        if not path:
            return ""
        try:
            size = os.path.getsize(path)
            with open(path, "rb") as f:
                if size > max_bytes:
                    f.seek(-max_bytes, os.SEEK_END)
                return f.read().decode("utf-8", errors="replace")
        except Exception:
            return ""

    def _wait_for_health(self) -> bool:
        """Wait for the Gateway to become healthy."""
        start = time.monotonic()
        while time.monotonic() - start < HEALTH_CHECK_MAX_WAIT:
            # Check if process died
            if self._process and self._process.poll() is not None:
                rc = self._process.returncode
                # Freeze log rotation before reading the crash tail so the
                # diagnostic does not race a concurrent truncate.
                self._stop_log_guard()
                # stderr was redirected to a log file; tail it for diagnostics.
                stderr = self._tail_stderr_log()[:500]
                logger.error(
                    "memory-tencentdb Gateway process exited with code %d during startup. "
                    "stderr_log=%s tail=%s",
                    rc, self._stderr_log_path or "<none>", stderr,
                )
                self._close_log_handles()
                return False

            try:
                result = self._client.health(timeout=2)
                if result.get("status") in ("ok", "degraded"):
                    logger.info(
                        "memory-tencentdb Gateway is ready (took %.1fs)",
                        time.monotonic() - start,
                    )
                    return True
            except Exception:
                pass

            time.sleep(HEALTH_CHECK_INTERVAL)

        logger.error(
            "memory-tencentdb Gateway did not become healthy within %ds",
            HEALTH_CHECK_MAX_WAIT,
        )
        return False

    def shutdown(self) -> None:
        """Shut down the managed Gateway process (if we started it)."""
        if self._process is None:
            self._close_log_handles()
            return

        logger.info("Shutting down memory-tencentdb Gateway...")

        try:
            if os.name == "nt":
                self._terminate_windows_process_tree(self._process.pid)
            else:
                # Send SIGTERM for graceful shutdown.
                self._process.terminate()
            try:
                self._process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                logger.warning("memory-tencentdb Gateway did not exit in 10s, sending SIGKILL")
                if os.name == "nt":
                    self._kill_windows_process_tree(self._process.pid)
                else:
                    self._process.kill()
                self._process.wait(timeout=5)
        except Exception as e:
            logger.warning("Error shutting down memory-tencentdb Gateway: %s", e)
        finally:
            self._process = None
            self._close_log_handles()

    def _terminate_windows_process_tree(self, pid: int) -> None:
        """Terminate the shell-owned Windows process tree for the Gateway."""
        try:
            self._process.send_signal(signal.CTRL_BREAK_EVENT)  # type: ignore[union-attr]
        except Exception:
            pass
        subprocess.run(
            ["taskkill", "/T", "/PID", str(pid)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )

    def _kill_windows_process_tree(self, pid: int) -> None:
        """Force-kill the shell-owned Windows process tree for the Gateway."""
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(pid)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )

    @property
    def client(self) -> MemoryTencentdbSdkClient:
        """Get the HTTP client for making API calls."""
        return self._client
