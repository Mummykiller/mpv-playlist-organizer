import logging
import os
import uuid
import time
import json
import subprocess
import threading
from urllib.request import urlopen
from .base_handler import BaseHandler
from .. import native_link

SERVER_PREFIX = "server_"
SERVER_EXT = ".m3u"

class PlaybackHandler(BaseHandler):
    def handle_play(self, request: native_link.PlaybackRequest):
        url_item = request.url_item
        folder_id = request.folder_id
        if not folder_id or not url_item:
            return native_link.failure("Missing folderId or url_item for play action.")

        try:
            settings = self.file_io.get_settings()
            for key, value in request.settings.__dict__.items():
                if value is not None:
                    settings[key] = value

            first_call_result = self.mpv_session.start(
                url_item, folder_id, settings, self.file_io,
                geometry=request.geometry, custom_width=request.custom_width, 
                custom_height=request.custom_height, custom_mpv_flags=request.custom_mpv_flags, 
                automatic_mpv_flags=request.automatic_mpv_flags, 
                start_paused=request.start_paused, force_terminal=request.force_terminal
            )
            
            if not first_call_result["success"] or first_call_result.get("handled_directly"):
                return first_call_result

            enriched_url_items = first_call_result["enriched_url_items"]
            enriched_item = enriched_url_items[0]

            result = self.mpv_session.start(
                enriched_item, folder_id, settings, self.file_io,
                geometry=request.geometry, custom_width=request.custom_width, 
                custom_height=request.custom_height, custom_mpv_flags=request.custom_mpv_flags, 
                automatic_mpv_flags=request.automatic_mpv_flags, 
                start_paused=request.start_paused, enriched_items_list=enriched_url_items,
                headers=enriched_item.get('headers'),
                ytdl_raw_options=enriched_item.get('ytdl_raw_options'),
                use_ytdl_mpv=enriched_item.get('use_ytdl_mpv', False),
                is_youtube=enriched_item.get('is_youtube', False),
                disable_http_persistent=enriched_item.get('disable_http_persistent', False),
                force_terminal=request.force_terminal
            )
            return result if result else native_link.failure("Failed to start MPV session.")
        except Exception as e:
            if "Launch cancelled" in str(e):
                self.mpv_session.clear()
                return native_link.failure("Cancelled")
            raise e

    def handle_play_batch(self, request: native_link.PlaybackRequest):
        playlist = request.playlist
        folder_id = request.folder_id
        if not folder_id or not playlist:
            return native_link.failure("Missing folderId or playlist for play_batch action.")

        try:
            settings = self.file_io.get_settings()
            for key, value in request.settings.__dict__.items():
                if value is not None:
                    settings[key] = value

            first_call_result = self.mpv_session.start(
                playlist, folder_id, settings, self.file_io,
                geometry=request.geometry, custom_width=request.custom_width, 
                custom_height=request.custom_height, custom_mpv_flags=request.custom_mpv_flags, 
                automatic_mpv_flags=request.automatic_mpv_flags, 
                start_paused=request.start_paused, force_terminal=request.force_terminal
            )
            
            if not first_call_result["success"]:
                return first_call_result

            enriched_url_items = first_call_result["enriched_url_items"]
            first_item = enriched_url_items[0] if enriched_url_items else {}

            result = self.mpv_session.start(
                enriched_url_items, folder_id, settings, self.file_io,
                geometry=request.geometry, custom_width=request.custom_width, 
                custom_height=request.custom_height, custom_mpv_flags=request.custom_mpv_flags, 
                automatic_mpv_flags=request.automatic_mpv_flags, 
                start_paused=request.start_paused, enriched_items_list=enriched_url_items,
                headers=first_item.get('headers'),
                ytdl_raw_options=first_item.get('ytdl_raw_options'),
                use_ytdl_mpv=any(item.get('use_ytdl_mpv', False) for item in enriched_url_items),
                is_youtube=any(item.get('is_youtube', False) for item in enriched_url_items),
                disable_http_persistent=first_item.get('disable_http_persistent', False),
                force_terminal=request.force_terminal
            )
            return result
        except Exception as e:
            if "Launch cancelled" in str(e):
                self.mpv_session.clear()
                return native_link.failure("Cancelled")
            raise e

    def handle_append(self, request: native_link.PlaybackRequest):
        url_item = request.url_item
        url_items_list = request.url_items
        folder_id = request.folder_id 
        if not folder_id or (not url_item and not url_items_list):
            return native_link.failure("Missing folderId or items for append action.")
        
        playlist = self.file_io.get_playlist_shard(folder_id)
        all_folders_context = {folder_id: {"playlist": playlist}}
        items_to_process = url_items_list if url_items_list else [url_item]
        
        final_processed_items = []
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=5) as executor:
            def process_wrapper(item):
                processed, _ = self._process_url_item(item, folder_id, all_folders_context)
                return processed
            results = list(executor.map(process_wrapper, items_to_process))
            for processed_list in results:
                final_processed_items.extend(processed_list)

        if not final_processed_items:
            return native_link.success(message="No new items to append.")

        self.file_io.save_playlist_shard(folder_id, all_folders_context[folder_id]['playlist'])
        return self.mpv_session.append_batch(final_processed_items, folder_id=folder_id)

    def handle_remove_item_live(self, request: native_link.LiveUpdateRequest):
        if not request.folder_id or not request.item_id:
            return native_link.failure("Missing folderId or item_id.")
        return self.mpv_session.remove(request.item_id, request.folder_id)

    def handle_reorder_live(self, request: native_link.LiveUpdateRequest):
        if not request.folder_id or not request.new_order:
            return native_link.failure("Missing folderId or new_order.")
        return self.mpv_session.reorder(request.folder_id, request.new_order)

    def handle_clear_live(self, request: native_link.LiveUpdateRequest):
        if not request.folder_id:
            return native_link.failure("Missing folderId.")
        return self.mpv_session.clear_live(request.folder_id)

    def handle_close_mpv(self, request: native_link.LiveUpdateRequest):
        # Determine if we should signal launch cancellation (if it's not even running)
        is_running = self.mpv_session.is_alive and self.mpv_session.pid is not None
        if is_running:
            if self.mpv_session.ipc_manager and self.mpv_session.ipc_manager.is_connected():
                pass
            else:
                is_running = self.ipc_utils.is_process_alive(self.mpv_session.pid, self.mpv_session.ipc_path)
        
        if not is_running:
            self.mpv_session.launch_cancelled = True
            
        response = self.mpv_session.close()
        self._stop_local_m3u_server()
        return response

    def handle_is_mpv_running(self, request: native_link.LiveUpdateRequest):
        # 1. Check logical state
        is_running = self.mpv_session.is_alive and self.mpv_session.pid is not None
        
        # 2. Verify with IPC if we have a connection
        if is_running:
            if self.mpv_session.ipc_manager and self.mpv_session.ipc_manager.is_connected():
                # Simple ping - if it fails, we don't immediately kill the session
                # because the process might just be busy or starting up.
                res = self.mpv_session.ipc_manager.send({"command": ["get_property", "pid"]}, timeout=0.5, expect_response=True)
                if not res or res.get("error") != "success":
                    # If IPC fails but PID is still there, it's just 'unresponsive' not 'dead'
                    if not self.ipc_utils.is_pid_running(self.mpv_session.pid):
                        is_running = False
            else:
                # No active manager, use the utility check
                is_running = self.ipc_utils.is_process_alive(self.mpv_session.pid, self.mpv_session.ipc_path)

        # 3. Only clear if the process is actually gone
        if not is_running and self.mpv_session.pid:
            if not self.ipc_utils.is_pid_running(self.mpv_session.pid):
                logging.info(f"is_mpv_running: PID {self.mpv_session.pid} is gone. Cleaning up.")
                self.mpv_session.clear()

        return native_link.success({
            "is_running": is_running,
            "folderId": self.mpv_session.owner_folder_id if is_running else None
        })

    def handle_get_playback_status(self, request: native_link.LiveUpdateRequest):
        # 1. Check logical state
        is_running = self.mpv_session.is_alive and self.mpv_session.pid is not None
        
        # 2. Verify with IPC
        if is_running:
            if self.mpv_session.ipc_manager and self.mpv_session.ipc_manager.is_connected():
                # We'll rely on the property fetches below. If they fail,
                # we'll double check the PID before giving up.
                pass
            else:
                is_running = self.ipc_utils.is_process_alive(self.mpv_session.pid, self.mpv_session.ipc_path)

        if not is_running:
            # ONLY clear if the process is actually dead
            if self.mpv_session.pid and not self.ipc_utils.is_pid_running(self.mpv_session.pid):
                logging.info(f"get_playback_status: PID {self.mpv_session.pid} is gone. Cleaning up.")
                self.mpv_session.clear()
                return native_link.success({"is_running": False, "is_paused": False})
            elif self.mpv_session.pid:
                # PID is still there, just IPC failed. Treat as running but state unknown.
                is_running = True
            else:
                return native_link.success({"is_running": False, "is_paused": False})
        
        is_paused = self.mpv_session.get_pause_state()
        is_idle = self.mpv_session.get_idle_state()
        session_ids = [item.get('id') for item in (self.mpv_session.playlist or []) if item.get('id')]
        
        # If we couldn't get IPC state but PID is still alive, fallback to safe defaults
        # instead of letting the UI think the session is dead.
        if is_paused is None: is_paused = False
        if is_idle is None: is_idle = False
        
        # Get the latest last_played_id from tracker or session
        last_played_id = None
        if self.mpv_session.playlist_tracker:
            last_played_id = self.mpv_session.playlist_tracker.last_played_id
        
        # Fallback to session metadata if tracker isn't ready
        if not last_played_id and self.mpv_session.playlist:
            # Check for the last played id in the session's local cache
            last_played_id = getattr(self.mpv_session, 'last_played_id_cache', None)

        return native_link.success({
            "is_running": True,
            "is_paused": is_paused if is_paused is not None else False,
            "is_idle": is_idle if is_idle is not None else False,
            "folderId": self.mpv_session.owner_folder_id,
            "lastPlayedId": last_played_id,
            "session_ids": session_ids
        })

    def handle_play_new_instance(self, request: native_link.PlaybackRequest):
        return self._launch_unmanaged_mpv(
            request.playlist or [], request.geometry, request.custom_width,
            request.custom_height, request.custom_mpv_flags, request.automatic_mpv_flags
        )

    def _launch_unmanaged_mpv(self, playlist, geometry, custom_width, custom_height, custom_mpv_flags, automatic_mpv_flags):
        mpv_exe = self.file_io.get_mpv_executable()
        settings = self.file_io.get_settings()
        try:
            full_command, has_terminal_flag = self.services.construct_mpv_command(
                mpv_exe=mpv_exe, url=playlist, geometry=geometry,
                custom_width=custom_width, custom_height=custom_height,
                custom_mpv_flags=custom_mpv_flags, automatic_mpv_flags=automatic_mpv_flags,
                settings=settings, playlist_start_index=0
            )
            process = subprocess.Popen(full_command, **self.services.get_mpv_popen_kwargs(has_terminal_flag))
            threading.Thread(target=self.log_stream, args=(process.stderr, logging.warning, None), daemon=True).start()
            return native_link.success(message="New MPV instance launched.")
        except Exception as e:
            logging.error(f"Error launching unmanaged mpv: {e}")
            return native_link.failure(f"Error launching new mpv instance: {e}")

    def _start_local_m3u_server(self, m3u_content):
        with self.server_lock:
            if not self.temp_m3u_file_for_server:
                self.temp_m3u_file_for_server = os.path.join(self.temp_playlists_dir, f"{SERVER_PREFIX}{os.getpid()}{SERVER_EXT}")
            with open(self.temp_m3u_file_for_server, 'w', encoding='utf-8') as f:
                f.write(m3u_content)

            if self.playlist_server_process and self.playlist_server_process.poll() is None:
                base_url = f"http://localhost:{self.playlist_server_port}/playlist.m3u"
                return f"{base_url}?token={self.server_token}" if self.server_token else base_url

            server_path = os.path.join(self.script_dir, "playlist_server.py")
            if not os.path.exists(server_path): return None

            server_env = os.environ.copy()
            server_env["MPV_PLAYLIST_TOKEN"] = self.server_token
            try:
                self.playlist_server_process = subprocess.Popen(
                    [sys.executable, server_path, '--port', '0', '--file', self.temp_m3u_file_for_server],
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1, env=server_env
                )
                start_time = time.time()
                while time.time() - start_time < 5:
                    line = self.playlist_server_process.stdout.readline()
                    if not line: break
                    try:
                        data = json.loads(line.strip())
                        if data.get("status") == "running" and data.get("port"):
                            self.playlist_server_port = int(data.get("port"))
                            break
                    except json.JSONDecodeError: pass
                
                def consume_stderr(proc):
                    for line in iter(proc.stderr.readline, ''): logging.info(f"Server stderr: {line.strip()}")
                    proc.stderr.close()
                threading.Thread(target=consume_stderr, args=(self.playlist_server_process,), daemon=True).start()

                if self.playlist_server_port is None: raise RuntimeError("Port detection failed.")
                fetch_url = f"http://localhost:{self.playlist_server_port}/playlist.m3u?token={self.server_token}"
                for _ in range(30):
                    try:
                        with urlopen(fetch_url, timeout=0.2) as r:
                            if r.getcode() == 200: return fetch_url
                    except Exception: pass
                    time.sleep(0.2)
                raise RuntimeError("Server timeout.")
            except Exception as e:
                logging.error(f"Failed to start M3U server: {e}")
                self._stop_unlocked()
                return None

    def _stop_local_m3u_server(self):
        with self.server_lock: self._stop_unlocked()

    def _stop_unlocked(self):
        if self.playlist_server_process:
            try:
                self.playlist_server_process.terminate()
                self.playlist_server_process.wait(timeout=2)
            except Exception:
                try: self.playlist_server_process.kill()
                except Exception: pass
            self.playlist_server_process = self.playlist_server_port = None
            time.sleep(0.2)
        if self.temp_m3u_file_for_server and os.path.exists(self.temp_m3u_file_for_server):
            try: os.remove(self.temp_m3u_file_for_server)
            except Exception: pass
            self.temp_m3u_file_for_server = None

    def handle_play_m3u(self, request: native_link.PlaybackRequest):
        m3u_data = request.m3u_data
        folder_id = request.folder_id or str(uuid.uuid4())
        if not m3u_data or 'type' not in m3u_data or 'value' not in m3u_data:
            return native_link.failure("Missing or malformed 'm3u_data'.")

        settings = self.file_io.get_settings()
        is_simple_play = m3u_data.get('type') == 'items' and not request.play_new_instance
        if is_simple_play and self.mpv_session.is_alive and self.mpv_session.owner_folder_id == folder_id:
            incoming_items = m3u_data.get('value', [])
            current_ids = {item.get('id') for item in (self.mpv_session.playlist or []) if item.get('id')}
            if not any(item.get('id') and item.get('id') not in current_ids for item in incoming_items):
                if self.mpv_session.ipc_manager:
                    self.mpv_session.ipc_manager.send({"command": ["cycle", "pause"]})
                    return native_link.success(already_active=True)

        m3u_source = m3u_data['value']
        m3u_type = m3u_data['type']
        target_folder = self.file_io.get_folder_data(folder_id) or {"playlist": []}

        for key, value in request.settings.__dict__.items():
            if value is not None: settings[key] = value
        
        if m3u_type == 'items' and not request.play_new_instance:
            return self.mpv_session.start(
                m3u_source, folder_id, settings, self.file_io,
                geometry=request.geometry, custom_width=request.custom_width, 
                custom_height=request.custom_height, custom_mpv_flags=request.custom_mpv_flags, 
                automatic_mpv_flags=request.automatic_mpv_flags, 
                start_paused=request.start_paused, force_terminal=request.force_terminal
            )

        try:
            with self.server_lock:
                first_call_result = self.mpv_session.start(
                    m3u_source, folder_id, settings, self.file_io,
                    geometry=request.geometry, custom_width=request.custom_width, 
                    custom_height=request.custom_height, custom_mpv_flags=request.custom_mpv_flags, 
                    automatic_mpv_flags=request.automatic_mpv_flags, 
                    start_paused=request.start_paused, force_terminal=request.force_terminal
                )
                if not first_call_result["success"] or first_call_result.get("handled_directly"):
                    return first_call_result

                enriched_url_items = first_call_result["enriched_url_items"]
                enriched_m3u_content = first_call_result["enriched_m3u_content"]

                if self.mpv_session.is_alive and self.mpv_session.owner_folder_id == folder_id:
                    current_ids = {item['id'] for item in self.mpv_session.playlist if 'id' in item}
                    new_items = [item for item in enriched_url_items if item.get('id') and item.get('id') not in current_ids]
                    
                    if self.temp_m3u_file_for_server and os.path.exists(self.temp_m3u_file_for_server):
                        with open(self.temp_m3u_file_for_server, 'w', encoding='utf-8') as f:
                            f.write(enriched_m3u_content)
                    
                    if new_items:
                        from concurrent.futures import ThreadPoolExecutor
                        all_folders_context = {folder_id: {"playlist": target_folder.get('playlist', [])}}
                        with ThreadPoolExecutor(max_workers=5) as executor:
                            def process_wrapper(item):
                                processed, _ = self._process_url_item(item, folder_id, all_folders_context)
                                return processed
                            processed_new_items = []
                            for res in executor.map(process_wrapper, new_items): processed_new_items.extend(res)
                        return self.mpv_session.append_batch(processed_new_items, folder_id=folder_id)
                    else:
                        if self.mpv_session.ipc_manager:
                            self.mpv_session.ipc_manager.send({"command": ["cycle", "pause"]})
                        return native_link.success(already_active=True)

                if not self.temp_m3u_file_for_server:
                    self.temp_m3u_file_for_server = os.path.join(self.temp_playlists_dir, f"temp_playlist_{uuid.uuid4().hex}.m3u")
                with open(self.temp_m3u_file_for_server, 'w', encoding='utf-8') as f:
                    f.write(enriched_m3u_content)

                playlist_start_index = 0
                last_played_id = target_folder.get("last_played_id")
                if settings.get("enable_smart_resume", True) and last_played_id:
                    for idx, item in enumerate(enriched_url_items):
                        if item.get('id') == last_played_id:
                            playlist_start_index = idx
                            break

                first_item = enriched_url_items[playlist_start_index] if playlist_start_index < len(enriched_url_items) else (enriched_url_items[0] if enriched_url_items else {})
                local_server_url = self._start_local_m3u_server(enriched_m3u_content)
                if not local_server_url: raise RuntimeError("Server failed.")
                
                return self.mpv_session.start(
                    local_server_url, folder_id, settings, self.file_io,
                    geometry=request.geometry, custom_width=request.custom_width, 
                    custom_height=request.custom_height, custom_mpv_flags=request.custom_mpv_flags, 
                    automatic_mpv_flags=request.automatic_mpv_flags, 
                    start_paused=request.start_paused, enriched_items_list=enriched_url_items,
                    headers=first_item.get('headers'), ytdl_raw_options=first_item.get('ytdl_raw_options'),
                    use_ytdl_mpv=any(item.get('use_ytdl_mpv', False) for item in enriched_url_items),
                    is_youtube=first_item.get('is_youtube', False),
                    disable_http_persistent=first_item.get('disable_http_persistent', False),
                    force_terminal=request.force_terminal, playlist_start_index=playlist_start_index
                )
        except Exception as e:
            if "Launch cancelled" in str(e):
                self.mpv_session.clear()
                return native_link.failure("Cancelled")
            self._stop_local_m3u_server()
            return native_link.failure(f"Error playing M3U: {str(e)}")
