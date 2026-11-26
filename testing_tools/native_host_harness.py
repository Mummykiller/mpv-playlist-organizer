from collections import Counter
import json
import logging
import os
import queue
import selectors
import struct
import subprocess
import sys
import tempfile
import threading
import time
import weakref
from typing import Any

sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAX_FRAME_BYTES = 5 * 1024 * 1024
MAX_STDERR_BYTES = 256 * 1024

_SEED_FILE_MAP = {
    "config": "config.json",
    "config.json": "config.json",
    "session": "session.json",
    "session.json": "session.json",
    "index": "index.json",
    "index.json": "index.json",
    "folders": "folders.json",
    "folders.json": "folders.json",
}


def pack_native_message(msg: dict[str, Any]) -> bytes:
    """Packs a dictionary as a Chrome Native Messaging 4-byte length-prefixed UTF-8 JSON frame."""
    encoded = json.dumps(msg, ensure_ascii=False).encode("utf-8")
    return struct.pack("@I", len(encoded)) + encoded


def send_native_message(proc: subprocess.Popen[bytes], msg: dict[str, Any]) -> None:
    """Writes a single 4-byte length-prefixed JSON frame to the host stdin."""
    if proc.stdin is None:
        raise ValueError("Process stdin is not available")
    proc.stdin.write(pack_native_message(msg))
    proc.stdin.flush()


class _WinPipeReader:
    """Daemon-thread + Queue reader for Windows pipes where selectors cannot watch pipes."""

    def __init__(self, stream: Any) -> None:
        self._stream = stream
        self._queue: queue.Queue[bytes | None] = queue.Queue()
        self._buf = bytearray()
        self._eof = False
        self._thread = threading.Thread(target=self._pump, name="NHWinPipeReader", daemon=True)
        self._thread.start()

    def _pump(self) -> None:
        fd: int | None = None
        try:
            fd = self._stream.fileno()
        except (AttributeError, OSError, ValueError):
            fd = None
        try:
            while True:
                if fd is not None:
                    chunk = os.read(fd, 4096)
                else:
                    chunk = self._stream.read(4096)
                if not chunk:
                    break
                self._queue.put(chunk)
        except OSError as exc:
            logging.debug("WinPipeReader stopped on OSError: %s", exc)
        finally:
            self._queue.put(None)

    def read_exact(self, size: int, deadline: float) -> tuple[bytes | None, bool]:
        while len(self._buf) < size:
            if self._eof:
                out = bytes(self._buf)
                self._buf.clear()
                return out, True
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None, False
            try:
                chunk = self._queue.get(timeout=remaining)
            except queue.Empty:
                return None, False
            if chunk is None:
                self._eof = True
                out = bytes(self._buf)
                self._buf.clear()
                return out, True
            self._buf.extend(chunk)
        out = bytes(self._buf[:size])
        del self._buf[:size]
        return out, False


_WIN_READERS: weakref.WeakKeyDictionary[Any, _WinPipeReader] = weakref.WeakKeyDictionary()
_WIN_READERS_LOCK = threading.Lock()


def _get_win_reader(stream: Any) -> _WinPipeReader:
    with _WIN_READERS_LOCK:
        reader = _WIN_READERS.get(stream)
        if reader is None:
            reader = _WinPipeReader(stream)
            try:
                _WIN_READERS[stream] = reader
            except TypeError as exc:
                logging.debug("Stream not weak-referenceable for WinPipeReader cache: %s", exc)
        return reader


def _read_exact_with_timeout(stream: Any, size: int, deadline: float) -> tuple[bytes | None, bool]:
    """Reads `size` bytes from `stream` before `deadline`. Returns (bytes_or_none, is_eof)."""
    if stream is None or size <= 0:
        return b"", True

    if sys.platform == "win32":
        return _get_win_reader(stream).read_exact(size, deadline)

    fd = stream.fileno()
    buf = bytearray()
    sel = selectors.DefaultSelector()
    try:
        sel.register(fd, selectors.EVENT_READ)
        while len(buf) < size:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None, False
            events = sel.select(timeout=remaining)
            if not events:
                return None, False
            chunk = os.read(fd, size - len(buf))
            if not chunk:
                return bytes(buf), True
            buf.extend(chunk)
        return bytes(buf), False
    finally:
        sel.close()


def _read_native_frame(proc: subprocess.Popen[bytes], timeout: float = 5.0) -> tuple[dict[str, Any] | None, bool]:
    """Reads one length-prefixed JSON frame with timeout. Returns (message_or_none, is_eof)."""
    if proc.stdout is None:
        return None, True

    deadline = time.monotonic() + max(0.02, float(timeout))
    raw_len, is_eof = _read_exact_with_timeout(proc.stdout, 4, deadline)
    if raw_len is None:
        return None, False
    if is_eof or len(raw_len) < 4:
        return None, True

    length = struct.unpack("@I", raw_len)[0]
    if length == 0 or length > MAX_FRAME_BYTES:
        return None, True

    payload, payload_eof = _read_exact_with_timeout(proc.stdout, length, deadline)
    if payload is None:
        return None, False
    if payload_eof and len(payload) < length:
        return None, True
    if len(payload) < length:
        return None, False

    return json.loads(payload.decode("utf-8")), False


def read_native_message(proc: subprocess.Popen[bytes], timeout: float = 5.0) -> dict[str, Any] | None:
    """Reads a single Native Messaging framed message with a hard timeout."""
    msg, _is_eof = _read_native_frame(proc, timeout=timeout)
    return msg


def read_native_response(
    proc: subprocess.Popen[bytes],
    request_id: str,
    timeout: float = 5.0,
) -> dict[str, Any] | None:
    """Reads framed messages until the one matching `request_id` arrives or timeout/EOF occurs."""
    deadline = time.monotonic() + max(0.05, float(timeout))
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return None
        msg, _is_eof = _read_native_frame(proc, timeout=remaining)
        if msg is None:
            return None
        if msg.get("request_id") == request_id or msg.get("requestId") == request_id:
            return msg
        logging.info("Skipping unsolicited message: %s", msg.get("action"))


def spawn_native_host(
    working_dir: str,
    project_root: str = PROJECT_ROOT,
    extra_env: dict[str, str] | None = None,
    stderr: Any = subprocess.PIPE,
) -> subprocess.Popen[bytes]:
    """Spawns native_host.py isolated to `working_dir` with unbuffered stdio pipes."""
    xdg_runtime = os.path.join(working_dir, "xdg_runtime")
    os.makedirs(xdg_runtime, mode=0o700, exist_ok=True)
    tmp_sub = os.path.join(working_dir, "tmp")
    os.makedirs(tmp_sub, exist_ok=True)

    env = os.environ.copy()
    env["XDG_DATA_HOME"] = working_dir
    env["HOME"] = working_dir
    env["XDG_RUNTIME_DIR"] = xdg_runtime
    env["TMPDIR"] = tmp_sub
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["NO_COLOR"] = "1"
    if extra_env:
        env.update(extra_env)

    script_path = os.path.join(project_root, "native_host.py")
    return subprocess.Popen(
        [sys.executable, script_path],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=stderr,
        bufsize=0,
        env=env,
        cwd=project_root,
    )


def terminate_native_host(proc: subprocess.Popen[bytes], wait_timeout: float = 1.0) -> int | None:
    """Safely terminates a native host process and closes all stdio streams."""
    if proc.stdin and not proc.stdin.closed:
        try:
            proc.stdin.close()
        except OSError as exc:
            logging.debug("Error closing host stdin: %s", exc)

    try:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=wait_timeout)
            except (subprocess.TimeoutExpired, OSError) as wait_err:
                logging.debug("Terminate wait timed out: %s", wait_err)
                proc.kill()
                proc.wait(timeout=wait_timeout)
    except (subprocess.SubprocessError, OSError) as proc_err:
        logging.debug("Error terminating proc: %s", proc_err)

    for stream in (proc.stdin, proc.stdout, proc.stderr):
        if stream and not stream.closed:
            try:
                stream.close()
            except OSError as stream_err:
                logging.debug("Error closing stream: %s", stream_err)

    return proc.returncode


def seed_data_dir(data_dir: str, seed_state: dict[str, Any]) -> None:
    """Writes validated seed JSON state into a throwaway DATA_DIR."""
    if not isinstance(seed_state, dict):
        raise ValueError("seed_state must be a JSON object")

    os.makedirs(data_dir, exist_ok=True)
    for key, value in seed_state.items():
        if key in _SEED_FILE_MAP:
            target_path = os.path.join(data_dir, _SEED_FILE_MAP[key])
            with open(target_path, "w", encoding="utf-8") as fh:
                json.dump(value, fh, indent=2)
        elif key == "playlists":
            if not isinstance(value, dict):
                raise ValueError("seed_state['playlists'] must be an object mapping folder names to payloads")
            playlists_dir = os.path.join(data_dir, "playlists")
            os.makedirs(playlists_dir, exist_ok=True)
            for folder_name, playlist_data in value.items():
                if (
                    not isinstance(folder_name, str)
                    or not folder_name
                    or "/" in folder_name
                    or "\\" in folder_name
                    or ".." in folder_name
                ):
                    raise ValueError(f"Invalid playlist shard name in seed_state: {folder_name!r}")
                fname = folder_name if folder_name.endswith(".json") else f"{folder_name}.json"
                with open(os.path.join(playlists_dir, fname), "w", encoding="utf-8") as fh:
                    json.dump(playlist_data, fh, indent=2)
        else:
            allowed = sorted(set(_SEED_FILE_MAP.keys()) | {"playlists"})
            raise ValueError(f"Unsupported seed_state key '{key}'. Allowed: {allowed}")


def _read_bounded_stderr(stderr_path: str, max_bytes: int = MAX_STDERR_BYTES) -> str:
    try:
        size = os.path.getsize(stderr_path)
        with open(stderr_path, "rb") as fh:
            if size > max_bytes:
                fh.seek(size - max_bytes)
            raw = fh.read(max_bytes)
        return raw.decode("utf-8", errors="replace")
    except OSError as exc:
        logging.debug("Error reading redirected stderr %s: %s", stderr_path, exc)
        return ""


def run_native_message_session(
    payloads: list[dict[str, Any]],
    seed_state: dict[str, Any] | None = None,
    timeout: float = 5.0,
    project_root: str = PROJECT_ROOT,
) -> dict[str, Any]:
    """Runs native_host.py against a throwaway temp DATA_DIR, sends framed JSON, and collects replies.

    Note: The returned ``data_dir`` and ``tmp_dir`` strings refer to the ephemeral directories
    used during the session, which are deleted before this function returns. Callers (such as
    ``mcp_server/tools_impl.py``) use those strings solely to redact temp paths from captured
    frames and stderr output—do not attempt filesystem access on them after return.
    """
    clamped_timeout = max(0.5, min(float(timeout), 5.0))
    expected_ids: Counter[str | int] = Counter()
    expected_unkeyed = 0
    for item in payloads:
        req_id = item.get("request_id") if "request_id" in item else item.get("requestId")
        if req_id is not None:
            if isinstance(req_id, bool) or not isinstance(req_id, (str, int)):
                raise ValueError(f"Invalid request_id {req_id!r}: must be a string, integer, or null")
            expected_ids[req_id] += 1
        else:
            expected_unkeyed += 1

    frames: list[dict[str, Any]] = []
    timed_out = False
    exit_code: int | None = None
    stderr_text = ""

    with tempfile.TemporaryDirectory(prefix="mpv_nh_sim_") as tmp_dir:
        data_dir = os.path.join(tmp_dir, "MPVPlaylistOrganizer")
        os.makedirs(data_dir, exist_ok=True)
        if seed_state is not None:
            seed_data_dir(data_dir, seed_state)

        stderr_path = os.path.join(tmp_dir, "native_host_stderr.log")
        with open(stderr_path, "wb") as stderr_fh:
            proc = spawn_native_host(tmp_dir, project_root=project_root, stderr=stderr_fh)
        try:
            deadline = time.monotonic() + clamped_timeout
            for item in payloads:
                send_native_message(proc, item)

            seen_ids: Counter[str | int] = Counter()
            seen_unkeyed = 0
            while True:
                all_seen = (
                    all(seen_ids[k] >= v for k, v in expected_ids.items())
                    and seen_unkeyed >= expected_unkeyed
                )
                if all_seen:
                    # Brief drain check for any trailing frame
                    msg, is_eof = _read_native_frame(proc, timeout=0.05)
                    if msg is None:
                        break
                    frames.append(msg)
                    continue

                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    timed_out = True
                    break

                msg, is_eof = _read_native_frame(proc, timeout=remaining)
                if msg is None:
                    if not is_eof:
                        timed_out = True
                    break

                frames.append(msg)
                resp_id = msg.get("request_id") if "request_id" in msg else msg.get("requestId")
                if (
                    resp_id is not None
                    and not isinstance(resp_id, bool)
                    and isinstance(resp_id, (str, int))
                    and resp_id in expected_ids
                ):
                    seen_ids[resp_id] += 1
                elif resp_id is None and msg.get("action") != "session_restored":
                    seen_unkeyed += 1

            # Trigger clean EOF shutdown
            if proc.stdin and not proc.stdin.closed:
                try:
                    proc.stdin.close()
                except OSError as exc:
                    logging.debug("Error closing sim host stdin: %s", exc)

            wait_budget = min(1.0, max(0.3, deadline - time.monotonic()))
            try:
                exit_code = proc.wait(timeout=wait_budget)
            except subprocess.TimeoutExpired:
                timed_out = True
                proc.terminate()
                try:
                    exit_code = proc.wait(timeout=0.5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    exit_code = proc.wait(timeout=0.5)
        finally:
            terminate_native_host(proc)

        stderr_text = _read_bounded_stderr(stderr_path)

        return {
            "frames": frames,
            "timed_out": timed_out,
            "exit_code": exit_code,
            "stderr_raw": stderr_text,
            "data_dir": data_dir,
            "tmp_dir": tmp_dir,
        }
