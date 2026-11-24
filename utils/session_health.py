import json
import logging
import os
import threading
import time
import file_io
from utils import ipc_utils


def start_health_watcher(session):
    """Starts a background thread to poll MPV health via IPC."""
    initial_folder = None

    def watcher(gen):
        logging.info(f"[PY][Health] Starting watcher for folder '{initial_folder}' (gen {gen}).")
        last_health = "ok"
        consecutive_failures = 0

        while True:
            with session.sync_lock:
                is_alive = session.is_alive
                ipc = session.ipc_manager
                pid = session.pid
                ipc_path = session.ipc_path
                folder_id = session.owner_folder_id
                current_gen = getattr(session, "session_generation", 0)

            if not is_alive or not ipc or current_gen != gen:
                break

            try:
                if ipc.get_property("pid", timeout=0.3):
                    current_health = "ok"
                    consecutive_failures = 0
                else:
                    consecutive_failures += 1
                    current_health = "stale" if consecutive_failures < 3 else "dead"
            except Exception as e:
                logging.debug(f"[PY][Health] IPC ping error: {e}")
                consecutive_failures += 1
                current_health = "stale" if consecutive_failures < 3 else "dead"

            if current_health != last_health:
                last_health = current_health
                with session.sync_lock:
                    if getattr(session, "session_generation", 0) == gen:
                        session.health = current_health
                logging.info(f"[PY][Health] State changed to: {current_health}")

                session.send_message({
                    "action": "playback_health_changed",
                    "folder_id": folder_id,
                    "health": current_health
                })

            if current_health == "dead":
                if not ipc_utils.is_pid_running(pid) or not ipc_utils.verify_mpv_process(pid, ipc_path=ipc_path):
                    logging.warning("[PY][Health] PID is gone or no longer MPV. Clearing session state.")
                    session.clear(session_generation=gen)
                    break
                time.sleep(1.0)
                continue

            time.sleep(0.5)
        logging.info("[PY][Health] Watcher stopped.")

    with session.sync_lock:
        watcher_gen = getattr(session, "session_generation", 0)
        initial_folder = session.owner_folder_id
        existing_thread = getattr(session, "health_watcher_thread", None)
        if (
            existing_thread
            and existing_thread.is_alive()
            and getattr(existing_thread, "_watcher_gen", None) == watcher_gen
        ):
            return

        new_thread = threading.Thread(target=watcher, args=(watcher_gen,), daemon=True)
        new_thread._watcher_gen = watcher_gen
        session.health_watcher_thread = new_thread
        new_thread.start()


SAFE_OUTBOUND_PAYLOAD_SIZE = 800 * 1024

_TRIM_CANDIDATE_FIELDS = (
    "enrichedM3uContent", "enriched_m3u_content",
    "playlist",
    "enrichedUrlItems", "enriched_url_items",
)


def persist_session_atomic(session):
    """Saves current session metadata to disk atomically with 0o600 permissions."""
    session_data = {
        "pid": session.pid,
        "ipc_path": session.ipc_path,
        "owner_folder_id": session.owner_folder_id,
        "token": getattr(session, 'current_token', None),
        "create_time": getattr(session, 'create_time', None),
        "session_generation": getattr(session, 'session_generation', 0)
    }
    if file_io._atomic_json_dump(session_data, session.session_file, create_backup=False, indent=None, mode=0o600):
        logging.info(f"[PY][Session] Saved session data to {session.session_file}")
    else:
        logging.warning(f"[PY][Session] Failed to write session file: {session.session_file}")


def trim_oversized_reply(payload, max_bytes=SAFE_OUTBOUND_PAYLOAD_SIZE, camel_case=False):
    """Omits optional large preview fields if serialized payload exceeds max_bytes."""
    if not isinstance(payload, dict):
        return payload
    try:
        encoded = json.dumps(payload, default=str).encode('utf-8')
    except (TypeError, ValueError):
        return payload
    if len(encoded) <= max_bytes:
        return payload

    trimmed_fields = []
    for field in _TRIM_CANDIDATE_FIELDS:
        if field in payload:
            payload.pop(field, None)
            trimmed_fields.append(field)
            try:
                if len(json.dumps(payload, default=str).encode('utf-8')) <= max_bytes:
                    break
            except (TypeError, ValueError):
                break

    if trimmed_fields:
        flag_key = "payloadTruncated" if camel_case else "payload_truncated"
        payload[flag_key] = True
        new_size = len(json.dumps(payload, default=str).encode('utf-8'))
        logging.warning(
            f"[PY] Outbound reply exceeded {max_bytes} bytes; "
            f"omitted {trimmed_fields} to stay under Chrome's 1 MiB limit (new size: {new_size} bytes)."
        )
    return payload


def restore_session(session):
    """Checks for a persisted session file and restores state if the process is still alive."""
    with session.sync_lock:
        if session.is_alive and session.pid and ipc_utils.is_pid_running(session.pid):
            logging.info(f"[PY][Session] Restore: Already connected to PID {session.pid}.")
            return trim_oversized_reply({
                "was_stale": False,
                "folder_id": session.owner_folder_id,
                "last_played_id": getattr(session, 'last_played_id_cache', None),
                "is_paused": bool(session.get_pause_state()),
                "is_idle": bool(session.get_idle_state()),
                "token": getattr(session, 'current_token', None),
                "playlist": session.playlist
            })

        if not os.path.exists(session.session_file):
            return None

        logging.info(f"[PY][Session] Found session file: {session.session_file}. Checking for live process.")
        pid = None
        ipc_path = None
        try:
            with open(session.session_file, 'r', encoding='utf-8') as f:
                session_data = json.load(f)

            pid = session_data.get("pid")
            ipc_path = session_data.get("ipc_path")
            owner_folder_id = session_data.get("owner_folder_id")
            token = session_data.get("token")

            if not all([pid, ipc_path, owner_folder_id]):
                raise ValueError("Session file is malformed.")

            actual_mpv_pid = None
            temp_manager = ipc_utils.IPCSocketManager()
            if temp_manager.connect(ipc_path, timeout=1.5, start_event_reader=False):
                actual_mpv_pid = temp_manager.get_property("pid", timeout=1.0)
                temp_manager.close()

            is_alive = False
            if actual_mpv_pid:
                is_alive = True
            elif ipc_utils.verify_mpv_process(pid, ipc_path=ipc_path):
                is_alive = True
                logging.warning(f"[PY][Session] Restore: Verified MPV PID {pid} is running, attempting attachment.")

            if is_alive:
                folder_data = file_io.get_folder_data(owner_folder_id)
                if not folder_data:
                    raise RuntimeError(f"Could not find data for restored folder '{owner_folder_id}'.")

                session.pid = actual_mpv_pid if actual_mpv_pid else pid
                session.ipc_path = ipc_path
                session.owner_folder_id = owner_folder_id
                session.current_token = token
                session.is_alive = True

                if actual_mpv_pid and actual_mpv_pid != pid:
                    session.persist_session()

                session.ipc_manager = ipc_utils.IPCSocketManager()
                if not session.ipc_manager.connect(session.ipc_path, timeout=3.0):
                    logging.error("[PY][Session] Restore: Persistent IPC connection failed.")
                    session.pid = None
                    session.ipc_path = None
                    session.owner_folder_id = None
                    session.current_token = None
                    session.is_alive = False
                    if session.ipc_manager:
                        session.ipc_manager.close()
                        session.ipc_manager = None
                    return None

                session._sync_playlist_from_mpv()
                session.register_ipc_callbacks()

                last_played_id = None
                try:
                    last_played_id = session.ipc_manager.get_property("user-data/id", timeout=1.0)
                    if not last_played_id:
                        curr_path = session.ipc_manager.get_property("path")
                        if curr_path:
                            for item in session.playlist:
                                if item.get('url') == curr_path or item.get('original_url') == curr_path:
                                    last_played_id = item.get('id')
                                    break
                    session.last_played_id_cache = last_played_id
                except Exception as e:
                    logging.warning(f"Failed to query active item during restore: {e}")

                from playlist_tracker import PlaylistTracker
                if session.playlist_tracker:
                    session.playlist_tracker.stop_tracking()

                session.playlist_tracker = PlaylistTracker(
                    owner_folder_id, session.playlist, file_io,
                    file_io.get_settings(), session.ipc_path, session.send_message
                )

                if last_played_id:
                    with session.playlist_tracker.lock:
                        session.playlist_tracker.current_id = last_played_id
                        session.playlist_tracker.last_played_id = last_played_id

                session.session_generation += 1
                session.manual_quit = False
                session.create_time = session_data.get("create_time", time.time())
                session.dispatched_exit_generations.discard(session.session_generation)

                session.playlist_tracker.start_tracking()
                session._start_health_watcher()
                session.launcher.start_restored_process_watcher(session.pid, ipc_path, owner_folder_id)

                logging.info(f"[PY][Session] Successfully restored session for folder '{owner_folder_id}'. Active item: {last_played_id}")
                return trim_oversized_reply({
                    "was_stale": False,
                    "folder_id": owner_folder_id,
                    "last_played_id": last_played_id,
                    "is_paused": session.get_pause_state(),
                    "is_idle": session.get_idle_state(),
                    "token": token,
                    "playlist": session.playlist
                })

            logging.warning(f"[PY][Session] Stale or unverified session for PID {pid} found. Cleaning up.")
            if os.path.exists(session.session_file):
                try:
                    os.remove(session.session_file)
                except OSError as e:
                    logging.debug(f"[PY][Session] Could not remove stale session file {session.session_file}: {e}")
            return {"was_stale": True, "folder_id": owner_folder_id, "return_code": -1}

        except Exception as e:
            logging.warning(f"[PY][Session] Could not restore session: {e}.")
            session.pid = None
            session.ipc_path = None
            session.owner_folder_id = None
            session.current_token = None
            session.is_alive = False
            if session.ipc_manager:
                try:
                    session.ipc_manager.close()
                except Exception as ce:
                    logging.debug(f"[PY][Session] Error closing ipc_manager on restore exception: {ce}")
                session.ipc_manager = None

            if not (pid and ipc_utils.verify_mpv_process(pid, ipc_path=ipc_path)):
                if os.path.exists(session.session_file):
                    try:
                        os.remove(session.session_file)
                    except OSError as se:
                        logging.debug(f"[PY][Session] Could not remove invalid session file {session.session_file}: {se}")
            else:
                logging.info(f"[PY][Session] Preserving session.json for verified PID {pid} despite transient restore error.")
            return None
