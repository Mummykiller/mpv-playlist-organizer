import logging
import uuid
from .base_handler import BaseHandler
from .registry import command
from .. import native_link

class PlaybackHandler(BaseHandler):
    def __init__(self, ctx):
        super().__init__(ctx)
        from ..m3u_server import M3UServer
        self.m3u_server = M3UServer(ctx.script_dir, ctx.temp_playlists_dir, self.server_token)

    def _orchestrate_playback(self, request: native_link.PlaybackRequest, input_type: str):
        """
        Unified pipeline for all playback types.
        1. Resolve Input -> List[Item]
        2. Active Session Pre-check
        3. Parallel Enrichment
        4. Session Launch/Append
        """
        folder_id = request.folder_id or str(uuid.uuid4())
        settings = self._get_merged_settings(request.settings)
        
        # 1. Resolve Input
        raw_input = None
        if input_type == 'single':
            # Direct User Click: Strip any existing resume_time to ensure it starts at 0s
            # unless the request explicitly provided a fresh one (rare).
            if request.url_item and 'resume_time' in request.url_item:
                request.url_item['resume_time'] = None
            raw_input = [request.url_item]
        elif input_type == 'batch':
            raw_input = request.playlist
        elif input_type == 'm3u':
            m3u_data = request.m3u_data
            if not m3u_data or 'value' not in m3u_data:
                msg = "Missing M3U data."
                return native_link.failure(msg, log={"text": f"[Native Host]: {msg}", "type": "error"})
            raw_input = m3u_data['value']
        
        # Resolve to standard list of items
        items, is_expanded = self.item_processor.resolve_input_items(
            raw_input, None, (request.url_item or {}).get('headers')
        )
        
        if not items:
            msg = "Could not resolve any playable items."
            return native_link.failure(msg, log={"text": f"[Native Host]: {msg}", "type": "error"})

        # 2. Active Session Pre-check (Already Active / Pause Cycle)
        if not request.play_new_instance and self.mpv_session.is_alive and self.mpv_session.owner_folder_id == folder_id:
            # We cycle pause if:
            # 1. Single click on the item that is ALREADY playing.
            # 2. Clicking 'Play' on a folder that is already fully loaded in MPV.
            
            if self.mpv_session.ipc_manager and self.mpv_session.ipc_manager.is_connected():
                # Get the actual ID from MPV in real-time
                res = self.mpv_session.ipc_manager.send({"command": ["get_property", "user-data/id"]}, expect_response=True, timeout=0.5)
                current_playing_id = res.get("data") if res and res.get("error") == "success" else None
                
                should_toggle_pause = False
                
                if input_type == 'single' and request.url_item:
                    target_id = request.url_item.get('id')
                    if target_id and current_playing_id == target_id:
                        should_toggle_pause = True
                elif input_type == 'batch' or input_type == 'm3u':
                    # For batches, check if we're adding anything new
                    current_ids = {item.get('id') for item in (self.mpv_session.playlist or []) if item.get('id')}
                    new_items = [item for item in items if self.item_processor.ensure_id(item)['id'] not in current_ids]
                    if not new_items:
                        should_toggle_pause = True

                if should_toggle_pause:
                    logging.info(f"[PY][Handler] Active session for {folder_id}. Toggling pause.")
                    self.mpv_session.ipc_manager.send({"command": ["cycle", "pause"]})
                    return native_link.success(already_active=True)

        # 3. Parallel Enrichment & Initial Launch
        launch_payload = items if len(items) > 1 else items[0]
        
        try:
            first_call_result = self.mpv_session.start(
                launch_payload, folder_id, settings, self.file_io,
                geometry=request.geometry, custom_width=request.custom_width, 
                custom_height=request.custom_height, custom_mpv_flags=request.custom_mpv_flags, 
                automatic_mpv_flags=request.automatic_mpv_flags, 
                start_paused=request.start_paused, force_terminal=request.force_terminal,
                playlist_start_id=request.playlist_start_id
            )
            
            if not first_call_result["success"] or first_call_result.get("handled_directly"):
                return first_call_result

            # Final Launch Orchestration
            enriched_url_items = first_call_result["enriched_url_items"]
            first_item = enriched_url_items[0] if enriched_url_items else {}
            enriched_m3u_content = first_call_result.get("enriched_m3u_content")
            
            target_payload = enriched_url_items
            if enriched_m3u_content and (input_type == 'm3u' or len(enriched_url_items) > 1):
                local_server_url = self.m3u_server.start(enriched_m3u_content)
                if local_server_url:
                    target_payload = local_server_url

            return self.mpv_session.start(
                target_payload, folder_id, settings, self.file_io,
                geometry=request.geometry, custom_width=request.custom_width, 
                custom_height=request.custom_height, custom_mpv_flags=request.custom_mpv_flags, 
                automatic_mpv_flags=request.automatic_mpv_flags, 
                start_paused=request.start_paused, enriched_items_list=enriched_url_items,
                headers=first_item.get('headers'),
                ytdl_raw_options=first_item.get('ytdl_raw_options'),
                use_ytdl_mpv=any(item.get('use_ytdl_mpv', False) for item in enriched_url_items),
                is_youtube=any(item.get('is_youtube', False) for item in enriched_url_items),
                disable_http_persistent=first_item.get('disable_http_persistent', False),
                force_terminal=request.force_terminal,
                playlist_start_id=request.playlist_start_id
            )
        except Exception as e:
            if "Launch cancelled" in str(e):
                self.mpv_session.clear()
                return native_link.failure("Cancelled")
            raise e

    @command('play')
    def handle_play(self, request: native_link.PlaybackRequest):
        if not request.folder_id or not request.url_item:
            return native_link.failure("Missing folderId or url_item for play action.")
        return self._orchestrate_playback(request, 'single')

    @command('play_batch')
    def handle_play_batch(self, request: native_link.PlaybackRequest):
        if not request.folder_id or not request.playlist:
            return native_link.failure("Missing folderId or playlist for play_batch action.")
        return self._orchestrate_playback(request, 'batch')

    @command('play_m3u')
    def handle_play_m3u(self, request: native_link.PlaybackRequest):
        return self._orchestrate_playback(request, 'm3u')

    @command('append')
    def handle_append(self, request: native_link.PlaybackRequest):
        url_item = request.url_item
        url_items_list = request.url_items
        folder_id = request.folder_id 
        if not folder_id or (not url_item and not url_items_list):
            return native_link.failure("Missing folderId or items for append action.")
        
        items_to_process = url_items_list if url_items_list else [url_item]
        settings = self._get_merged_settings(request.settings)
        
        final_processed_items = []
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=5) as executor:
            def process_wrapper(item):
                # Direct enrichment without folder context overhead
                return self.item_processor.enrich_single_item(
                    item, folder_id, 
                    session_cookies=self.mpv_session.session_cookies, 
                    sync_lock=self.mpv_session.sync_lock,
                    settings=settings, 
                    session=self.mpv_session
                )
            results = list(executor.map(process_wrapper, items_to_process))
            for processed_list in results:
                final_processed_items.extend(processed_list)
        
        # Filter out empty results (e.g. enrichment failures that returned empty list)
        final_processed_items = [i for i in final_processed_items if i]

        if not final_processed_items:
            return native_link.success(message="No new items to append.")

        # Update the local shard so that tracker and UI refreshes see the new data.
        # Use a Set to prevent duplicates if the shard already has these IDs.
        playlist = self.file_io.get_playlist_shard(folder_id)
        existing_ids = {itm.get('id') for itm in playlist if itm.get('id')}
        unique_new_items = [itm for itm in final_processed_items if itm.get('id') not in existing_ids]
        
        if unique_new_items:
            playlist.extend(unique_new_items)
            self.file_io.save_playlist_shard(folder_id, playlist)

        # Pass to session manager which handles internal list synchronization
        return self.mpv_session.append_batch(final_processed_items, folder_id=folder_id)

    @command('remove_item_live')
    def handle_remove_item_live(self, request: native_link.LiveUpdateRequest):
        if not request.folder_id or not request.item_id:
            return native_link.failure("Missing folderId or item_id.")
        return self.mpv_session.remove(request.item_id, request.folder_id)

    @command('reorder_live')
    def handle_reorder_live(self, request: native_link.LiveUpdateRequest):
        if not request.folder_id or not request.new_order:
            return native_link.failure("Missing folderId or new_order.")
        return self.mpv_session.reorder(request.folder_id, request.new_order)

    @command('clear_live')
    def handle_clear_live(self, request: native_link.LiveUpdateRequest):
        if not request.folder_id:
            return native_link.failure("Missing folderId.")
        return self.mpv_session.clear_live(request.folder_id)

    @command('close_mpv')
    def handle_close_mpv(self, request: native_link.LiveUpdateRequest):
        is_running = self.mpv_session.is_alive and self.mpv_session.pid is not None
        if not is_running:
            self.mpv_session.launch_cancelled = True
            
        response = self.mpv_session.close()
        self.m3u_server.stop()
        return response

    @command('is_mpv_running')
    def handle_is_mpv_running(self, request: native_link.LiveUpdateRequest):
        is_running = self.mpv_session.is_alive and self.mpv_session.pid is not None
        if is_running:
            if self.mpv_session.ipc_manager and self.mpv_session.ipc_manager.is_connected():
                res = self.mpv_session.ipc_manager.send({"command": ["get_property", "pid"]}, timeout=0.5, expect_response=True)
                if not res or res.get("error") != "success":
                    if not self.ipc_utils.is_pid_running(self.mpv_session.pid):
                        is_running = False
            else:
                is_running = self.ipc_utils.is_process_alive(self.mpv_session.pid, self.mpv_session.ipc_path)

        if not is_running and self.mpv_session.pid:
            if not self.ipc_utils.is_pid_running(self.mpv_session.pid):
                self.mpv_session.clear()

        return native_link.success({
            "is_running": is_running,
            "folderId": self.mpv_session.owner_folder_id if is_running else None
        })

    @command('get_playback_status')
    def handle_get_playback_status(self, request: native_link.LiveUpdateRequest):
        is_running = self.mpv_session.is_alive and self.mpv_session.pid is not None
        if is_running:
            if not (self.mpv_session.ipc_manager and self.mpv_session.ipc_manager.is_connected()):
                is_running = self.ipc_utils.is_process_alive(self.mpv_session.pid, self.mpv_session.ipc_path)

        if not is_running:
            if self.mpv_session.pid and not self.ipc_utils.is_pid_running(self.mpv_session.pid):
                self.mpv_session.clear()
                return native_link.success({"is_running": False, "is_paused": False})
            elif self.mpv_session.pid:
                is_running = True
            else:
                return native_link.success({"is_running": False, "is_paused": False})
        
        is_paused = self.mpv_session.get_pause_state()
        is_idle = self.mpv_session.get_idle_state()
        session_ids = [item.get('id') for item in (self.mpv_session.playlist or []) if item.get('id')]
        
        if is_paused is None: is_paused = False
        if is_idle is None: is_idle = False
        
        last_played_id = None
        if self.mpv_session.playlist_tracker:
            last_played_id = getattr(self.mpv_session.playlist_tracker, 'last_played_id', None)
        
        if not last_played_id:
            last_played_id = getattr(self.mpv_session, 'last_played_id_cache', None)

        return native_link.success({
            "is_running": True,
            "is_paused": is_paused,
            "is_idle": is_idle,
            "folderId": self.mpv_session.owner_folder_id,
            "lastPlayedId": last_played_id,
            "session_ids": session_ids
        })

    @command('play_new_instance')
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
            threading.Thread(target=self.ctx.log_stream, args=(process.stderr, logging.warning, None), daemon=True).start()
            return native_link.success(message="New MPV instance launched.")
        except Exception as e:
            logging.error(f"Error launching unmanaged mpv: {e}")
            return native_link.failure(f"Error launching new mpv instance: {e}")

    def _stop_local_m3u_server(self):
        """Helper for external cleanup (atexit)."""
        self.m3u_server.stop()