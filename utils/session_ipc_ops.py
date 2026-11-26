import json
import logging
import os
import re
import time
import uuid
import file_io
import services
from utils import security, url_analyzer

ID_MATCH_RE = re.compile(r"[#&]mpv_organizer_id=([^#&]+)")


def generate_m3u_content(items):
    """Generates M3U content from a list of items."""
    m3u_lines = ["#EXTM3U"]
    for item in items:
        raw_title = item.get('title', item['url'])
        safe_title = file_io.sanitize_string(str(raw_title))

        url_to_use = item['url']
        if item.get('is_youtube') and item.get('original_url'):
            url_to_use = item['original_url']

        if item.get('id'):
            separator = "#" if "#" not in url_to_use else "&"
            url_to_use = f"{url_to_use}{separator}mpv_organizer_id={item['id']}"

        logging.debug(f"[PY][Session] Generating M3U entry: {safe_title} -> {url_to_use[:60]}...")
        m3u_lines.append(f"#EXTINF:-1,{safe_title}")
        m3u_lines.append(services.sanitize_url(url_to_use))
    return "\n".join(m3u_lines)


def sync_playlist_from_mpv(session):
    """Forces a real-time synchronization of the internal playlist from MPV reality."""
    if not session.ipc_manager or not session.ipc_manager.is_connected():
        logging.debug("[PY][Session] Sync: IPC not connected. Skipping.")
        return False

    try:
        mpv_playlist = session.ipc_manager.get_property("playlist", timeout=2.0)
        if mpv_playlist is None:
            logging.warning("[PY][Session] Sync: Failed to get playlist from MPV.")
            return False

        logging.debug(f"[PY][Session] Sync: MPV reported {len(mpv_playlist)} items.")
        current_id = session.ipc_manager.get_property("user-data/id", timeout=0.3)

        folder_data = file_io.get_folder_data(session.owner_folder_id)
        shard_playlist = folder_data.get("playlist", []) if folder_data else []

        shard_map = {item.get('id'): item for item in shard_playlist if item.get('id')}
        url_map = {url_analyzer.normalize_url(item.get('url')): item for item in shard_playlist if item.get('url')}
        orig_url_map = {url_analyzer.normalize_url(item.get('original_url')): item for item in shard_playlist if item.get('original_url')}

        synced_playlist = []
        for idx, mpv_item in enumerate(mpv_playlist):
            path = mpv_item.get('filename', '')
            match = ID_MATCH_RE.search(path)
            found_id = match.group(1) if match else None

            if not found_id and mpv_item.get('current') and current_id:
                found_id = current_id

            base_path = re.sub(r'[#&]mpv_organizer_id=[^#&]+', '', path)
            norm_path = url_analyzer.normalize_url(base_path)

            matched_item = None
            if found_id and found_id in shard_map:
                matched_item = shard_map[found_id]
            elif norm_path in url_map:
                matched_item = url_map[norm_path]
            elif norm_path in orig_url_map:
                matched_item = orig_url_map[norm_path]

            if matched_item:
                synced_playlist.append(matched_item)
            else:
                generated_id = str(uuid.uuid4())
                logging.debug(f"[PY][Session] Sync: No match for item {idx} ({path}). Generated temp ID: {generated_id}")
                synced_playlist.append({
                    "url": base_path,
                    "title": mpv_item.get('title') or base_path,
                    "id": found_id or generated_id
                })

        session.playlist = synced_playlist
        logging.info(f"[PY][Session] Reality Sync: {len(session.playlist)} items tracked.")

        if session.playlist_tracker:
            session.playlist_tracker.update_playlist_order(session.playlist)

        return True
    except Exception as e:
        logging.error(f"[PY][Session] Reality Sync Failed: {e}")
        return False


def perform_cookie_fallback(session):
    """Attempts volatile cookie extraction and live reload on YTDL cookie failure."""
    with session.sync_lock:
        if not session.is_alive or not session.ipc_manager:
            return

        try:
            item_id = session.ipc_manager.get_property("user-data/id", timeout=1.0)
            if not item_id:
                logging.debug("Fallback: Could not identify current item ID.")
                return

            target_item = next((i for i in session.playlist if i.get('id') == item_id), None)
            if not target_item:
                logging.debug(f"Fallback: Item ID {item_id} not found in local playlist.")
                return

            browser = target_item.get('cookies_browser')
            if not browser:
                logging.debug("Fallback: No browser specified for this item. Cannot extract.")
                return

            url = target_item.get('original_url') or target_item.get('url')
            logging.info(f"Fallback: Extracting cookies to RAM for {browser}...")
            session.ipc_manager.send({"command": ["show-text", "Cookie Error: Retrying with fallback...", 5000]})

            cookie_path = url_analyzer.get_cookies_file(browser, url, force_refresh=True)
            if cookie_path:
                logging.info(f"Fallback: Success. Cookie path: {cookie_path}")
                target_item['cookies_file'] = cookie_path

                settings = file_io.get_settings()
                essential_flags = services.get_essential_ytdlp_flags()
                raw_opts = target_item.get('ytdl_raw_options')
                if raw_opts:
                    raw_opts = security.sanitize_ytdlp_options(raw_opts, allow_settings_flags=False)

                final_opts = file_io.merge_ytdlp_options(raw_opts, essential_flags, allow_settings_flags=True)
                item_url = services.sanitize_url(url)

                lua_options, _ = services.construct_lua_options(
                    target_item, settings, session.SCRIPT_DIR
                )
                lua_options["cookies_file"] = cookie_path
                lua_options["use_ytdl_mpv"] = True

                session.ipc_manager.send({"command": ["script-message", "set_url_options", item_url, json.dumps(lua_options)]})
                session.ipc_manager.send({"command": ["set_property", "cookies-file", cookie_path]})
                session.ipc_manager.send({"command": ["set_property", "ytdl-raw-options", final_opts]})
                session.ipc_manager.send({"command": ["set_property", "user-data/folder-id", session.owner_folder_id]})
                session.ipc_manager.send({"command": ["set_property", "user-data/cookies-browser", target_item.get('cookies_browser', "")]})
                session.ipc_manager.send({"command": ["set_property", "user-data/project-root", session.SCRIPT_DIR]})

                reload_url = url
                if item_id and f"mpv_organizer_id={item_id}" not in reload_url:
                    sep = "#" if "#" not in reload_url else "&"
                    reload_url = f"{reload_url}{sep}mpv_organizer_id={item_id}"
                logging.info("Fallback: Reloading file with volatile cookies.")
                session.ipc_manager.send({"command": ["loadfile", reload_url, "replace"]})
            else:
                logging.warning("Fallback: Failed to extract cookies.")
                session.ipc_manager.send({"command": ["show-text", "Fallback Failed: Could not extract cookies.", 5000]})
        except Exception as e:
            logging.error(f"Fallback failed: {e}")


def append_batch_internal(session, items, mode="append", folder_id=None, quiet=False):
    """Internal append logic with strict MPV-state filtering (caller holds sync_lock)."""
    if not session.is_alive or not session.ipc_manager:
        return {"success": False, "error": "No active session."}
    if folder_id and session.owner_folder_id and session.owner_folder_id.lower() != folder_id.lower():
        logging.warning(f"[PY][Session] Aborting append_batch: folder mismatch (active='{session.owner_folder_id}', requested='{folder_id}').")
        return {"success": False, "error": "Folder mismatch for append_batch."}

    sync_success = session._sync_playlist_from_mpv()
    if session.playlist is None:
        session.playlist = []

    current_mpv_count = len(session.playlist)
    if not sync_success:
        current_mpv_count = session.ipc_manager.get_property("playlist-count", timeout=1.0, default=current_mpv_count)

    active_ids = {i.get('id') for i in session.playlist if i.get('id')}
    items_to_add = [itm for itm in items if itm.get('id') not in active_ids]

    if not items_to_add:
        logging.info("[PY][Session] All requested items already active in MPV.")
        return {"success": True, "message": "Items already in playlist."}

    logging.info(f"[PY][Session] Appending {len(items_to_add)} unique items to MPV.")
    session._remote_log(f"Session: Appending {len(items_to_add)} items to live playlist.")

    settings = file_io.get_settings()
    if mode != "prepend":
        for idx, item in enumerate(items_to_add):
            target_idx = current_mpv_count + idx
            lua_options, item_url = services.construct_lua_options(item, settings, session.SCRIPT_DIR, index=target_idx)
            session.ipc_manager.send({"command": ["script-message", "set_url_options", item_url, json.dumps(lua_options), str(target_idx)]}, expect_response=False)

    temp_path = os.path.join(session.TEMP_PLAYLISTS_DIR, f"batch_{uuid.uuid4().hex[:8]}.m3u")
    try:
        os.makedirs(session.TEMP_PLAYLISTS_DIR, mode=0o700, exist_ok=True)
        fd = os.open(temp_path, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write(session._generate_m3u_content(items_to_add))

        res = session.ipc_manager.send({"command": ["loadlist", temp_path, "append"]}, expect_response=True, timeout=5.0)
        if res and res.get("error") == "success":
            if mode == "prepend":
                for i in range(len(items_to_add)):
                    session.ipc_manager.send({"command": ["playlist-move", current_mpv_count + i, i]}, expect_response=False)
                session.playlist = items_to_add + session.playlist

                for idx, item in enumerate(session.playlist):
                    lua_options, item_url = services.construct_lua_options(item, settings, session.SCRIPT_DIR, index=idx)
                    session.ipc_manager.send({"command": ["script-message", "set_url_options", item_url, json.dumps(lua_options), str(idx)]}, expect_response=False)
            else:
                session.playlist.extend(items_to_add)

            if session.playlist_tracker:
                session.playlist_tracker.update_playlist_order(session.playlist)

            if session.ipc_manager.get_property("idle-active"):
                session.ipc_manager.send({"command": ["set_property", "pause", False]})
                session.ipc_manager.send({"command": ["playlist-next", "weak"]})

            if not quiet:
                session.ipc_manager.send({"command": ["show-text", f"Added {len(items_to_add)} items", 3000]})
            return {"success": True, "message": f"Added {len(items_to_add)} items."}
        return {"success": False, "error": f"MPV rejected loadlist: {res}"}
    except Exception as e:
        logging.error(f"Append Internal Error: {e}")
        return {"success": False, "error": str(e)}
    finally:
        if os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except OSError as e:
                logging.debug(f"[PY][Session] Could not remove temp playlist {temp_path}: {e}")


def remove_item(session, item_id, folder_id):
    """Removes an item from the active MPV playlist by ID with resilient recovery."""
    with session.sync_lock:
        logging.info(f"[PY][Session] remove() called: item_id='{item_id}', folder_id='{folder_id}'")
        if not session.is_alive or not session.owner_folder_id or not folder_id or session.owner_folder_id.lower() != folder_id.lower():
            logging.warning(f"[PY][Session] remove() aborted: alive={session.is_alive}, owner='{session.owner_folder_id}', target='{folder_id}'")
            return {"success": False, "message": "Session not active or folder mismatch."}

        session._sync_playlist_from_mpv()

        index_to_remove = -1
        target_norm = url_analyzer.normalize_url(item_id) if "://" in item_id else None

        for i, item in enumerate(session.playlist):
            if item.get('id') == item_id:
                index_to_remove = i
                logging.debug(f"[PY][Session] found item via ID match at index {i}")
                break
            if item.get('url') == item_id or item.get('original_url') == item_id:
                index_to_remove = i
                logging.debug(f"[PY][Session] found item via path match at index {i}")
                break
            if target_norm and url_analyzer.normalize_url(item.get('url')) == target_norm:
                index_to_remove = i
                logging.debug(f"[PY][Session] found item via normalized URL match at index {i}")
                break

        if index_to_remove != -1:
            logging.info(f"[PY][Session] Removing item at index {index_to_remove} (ID: {item_id})")
            res = session.ipc_manager.send({"command": ["playlist-remove", index_to_remove]}, expect_response=True)

            if not res or res.get("error") != "success":
                logging.error(f"[PY][Session] MPV rejected playlist-remove: {res}")
                return {"success": False, "error": f"MPV Error: {res.get('error') if res else 'Timeout'}"}

            removed_item = session.playlist.pop(index_to_remove)
            if session.playlist_tracker:
                session.playlist_tracker.remove_item_internal(item_id)

            title = services.sanitize_url(removed_item.get('title') or "Item")
            if len(title) > 60:
                title = title[:57] + "..."
            session.ipc_manager.send({"command": ["show-text", f"Removed: {title}", 2000]}, expect_response=False)
            return {"success": True, "message": "Item removed from live session."}

        logging.warning(f"[PY][Session] remove() failed: could not identify item '{item_id}' in live playlist.")
        return {"success": False, "message": "Item not found in live session."}


def reorder_playlist(session, folder_id, new_order_ids):
    """Reorders the live MPV playlist to match the new order of IDs."""
    with session.sync_lock:
        if not session.is_alive or not session.ipc_manager:
            return {"success": False, "error": "No active session."}

        if not session.owner_folder_id or session.owner_folder_id.lower() != folder_id.lower():
            return {"success": False, "error": "Folder mismatch for live reorder."}

        session._sync_playlist_from_mpv()
        logging.info(f"[PY][Session] Reordering live playlist for '{folder_id}'. New order size: {len(new_order_ids)}")

        moves_made = 0
        current_playlist = list(session.playlist)
        actual_mpv_index = 0

        for entry in (new_order_ids or []):
            target_id = entry.get('id') if isinstance(entry, dict) else entry
            if not target_id:
                continue

            current_idx = -1
            for i, itm in enumerate(current_playlist):
                if itm.get('id') == target_id:
                    current_idx = i
                    break

            if current_idx != -1:
                if current_idx != actual_mpv_index:
                    res = session.ipc_manager.send({"command": ["playlist-move", current_idx, actual_mpv_index]})
                    if res and res.get("error") == "success":
                        item = current_playlist.pop(current_idx)
                        current_playlist.insert(actual_mpv_index, item)
                        moves_made += 1
                    else:
                        logging.warning(f"[PY][Session] Failed to move item {target_id} from {current_idx} to {actual_mpv_index}: {res}")
                actual_mpv_index += 1

        if moves_made > 0:
            session.playlist = current_playlist
            logging.info(f"[PY][Session] Live reorder complete. Performed {moves_made} moves.")
            if session.playlist_tracker:
                session.playlist_tracker.update_playlist_order(session.playlist)

            if session.ipc_manager and session.ipc_manager.is_connected():
                settings = file_io.get_settings()
                for idx, item in enumerate(session.playlist):
                    lua_options, item_url = services.construct_lua_options(
                        item, settings, session.SCRIPT_DIR, index=idx
                    )
                    session.ipc_manager.send({"command": ["script-message", "set_url_options", item_url, json.dumps(lua_options), str(idx)]}, expect_response=False)
                session.ipc_manager.send({"command": ["show-text", f"Playlist reordered ({moves_made} moves)", 2000]}, expect_response=False)

        return {"success": True, "moves": moves_made}


def clear_live_playlist(session, folder_id):
    """Clears all items from the active MPV playlist except the currently playing file."""
    with session.sync_lock:
        if not session.ipc_manager:
            return {"success": False, "reason": "No active IPC manager."}
        if not session.is_alive or not session.owner_folder_id or not folder_id or session.owner_folder_id.lower() != folder_id.lower():
            return {"success": False, "reason": "Session not active or folder mismatch.", "message": "Session not active or folder mismatch."}

        logging.info(f"Clearing live MPV playlist for folder '{folder_id}'.")
        session.ipc_manager.send({"command": ["playlist-clear"]}, expect_response=True)

        current_id = None
        if session.playlist_tracker and getattr(session.playlist_tracker, 'current_id', None):
            current_id = session.playlist_tracker.current_id
        if not current_id:
            prop_id = session.ipc_manager.get_property("user-data/id", timeout=0.3)
            if isinstance(prop_id, str) and prop_id:
                current_id = prop_id
        if not current_id:
            current_id = getattr(session, 'last_played_id_cache', None)

        if current_id:
            kept_items = [i for i in session.playlist if i.get('id') == current_id]
        else:
            kept_items = [i for i in session.playlist if i.get('currently_playing')][:1]

        session.playlist = kept_items
        if session.playlist_tracker:
            session.playlist_tracker.update_playlist_order(session.playlist)

        session.ipc_manager.send({"command": ["show-text", "Playlist cleared", 2000]}, expect_response=True)
        return {"success": True, "message": "Live playlist cleared."}


def hot_swap_item(session, launch_item, folder_id, settings, url_items_list):
    """Performs a non-destructive hot swap to launch_item in an active session (caller holds sync_lock)."""
    logging.info("[PY][Session] Same folder active. Attempting hot swap.")
    if not (session.ipc_manager and session.ipc_manager.is_connected()):
        logging.info(f"[PY][Session] Session already active for folder '{folder_id}' but IPC disconnected. Returning already_active=True.")
        return {
            "success": True,
            "already_active": True,
            "handled_directly": True,
            "enriched_url_items": url_items_list,
            "enriched_m3u_content": session._generate_m3u_content(url_items_list)
        }

    logging.info(f"Hot Swap: Switching active session to item: {launch_item.get('title')}")
    session._sync_playlist_from_mpv()
    logging.info("[PY][Session] hot-swap - Getting MPV playlist.")
    mpv_playlist_urls = session.ipc_manager.get_property("playlist", default=[])

    target_url = services.sanitize_url(launch_item['url'])
    if launch_item.get('is_youtube') and launch_item.get('original_url'):
        target_url = services.sanitize_url(launch_item['original_url'])

    item_id = launch_item.get('id')
    if item_id:
        sep = "#" if "#" not in target_url else "&"
        target_url = f"{target_url}{sep}mpv_organizer_id={item_id}"

    target_index = -1
    clean_target_url = target_url.split('#')[0].split('&mpv_organizer_id=')[0]

    for idx, mpv_item in enumerate(mpv_playlist_urls):
        fname = mpv_item.get('filename', '')
        if item_id and f"mpv_organizer_id={item_id}" in fname:
            target_index = idx
            break
        clean_fname = fname.split('#')[0].split('&mpv_organizer_id=')[0]
        if clean_fname == clean_target_url:
            target_index = idx
            break

    essential_flags = services.get_essential_ytdlp_flags()
    raw_opts = launch_item.get('ytdl_raw_options')
    if raw_opts:
        raw_opts = security.sanitize_ytdlp_options(raw_opts, allow_settings_flags=False)
    raw_cookies_browser = launch_item.get('cookies_browser')
    if security.is_safe_cookie_browser(raw_cookies_browser):
        browser_opt = f"cookies-from-browser={raw_cookies_browser.strip()}"
        raw_opts = f"{raw_opts},{browser_opt}" if raw_opts else browser_opt
    final_item_raw_opts = file_io.merge_ytdlp_options(raw_opts, essential_flags, allow_settings_flags=True)

    lua_options, _ = services.construct_lua_options(launch_item, settings, session.SCRIPT_DIR)

    logging.info("[PY][Session] hot-swap - Setting properties.")
    session.ipc_manager.send({"command": ["set_property", "user-data/hot-swap-options", json.dumps(lua_options)]})
    orig_url = launch_item.get('original_url') or launch_item.get('url', '')
    session.ipc_manager.send({"command": ["set_property", "user-data/original-url", services.sanitize_url(orig_url)]})
    session.ipc_manager.send({"command": ["set_property", "user-data/id", item_id or ""]})
    session.ipc_manager.send({"command": ["set_property", "ytdl", "yes" if launch_item.get('is_youtube') or launch_item.get('use_ytdl_mpv') else "no"]})
    session.ipc_manager.send({"command": ["set_property", "ytdl-raw-options", final_item_raw_opts]})

    raw_cookies_file = launch_item.get('cookies_file')
    if raw_cookies_file and security.is_safe_cookie_file(raw_cookies_file):
        session.ipc_manager.send({"command": ["set_property", "cookies-file", raw_cookies_file]})

    if lua_options.get('headers') and isinstance(lua_options['headers'], dict):
        safe_headers = security.sanitize_http_headers(lua_options['headers'])
        ua = safe_headers.get('User-Agent')
        ref = safe_headers.get('Referer')
        if ua:
            session.ipc_manager.send({"command": ["set_property", "user-agent", ua]})
        if ref:
            session.ipc_manager.send({"command": ["set_property", "referrer", ref]})

    if settings.get('enable_precise_resume', True):
        try:
            start_time = int(float(lua_options.get('resume_time') or 0))
            if start_time > 0:
                session.ipc_manager.send({"command": ["set_property", "user-data/primed-resume-time", str(start_time)]})
        except (ValueError, TypeError) as e:
            logging.debug(f"[PY][Session] Failed to parse primed resume time: {e}")

    if target_index != -1:
        logging.info(f"Hot Swap: Item exists at index {target_index}. Jumping.")
        session.ipc_manager.send({"command": ["set_property", "playlist-pos", target_index]})
    else:
        logging.info("Hot Swap: Item not in MPV. Appending and jumping.")
        session.ipc_manager.send({"command": ["loadfile", target_url, "append"]})
        time.sleep(0.1)

        new_count = session.ipc_manager.get_property("playlist-count", default=1)
        session.ipc_manager.send({"command": ["set_property", "playlist-pos", new_count - 1]})

        if session.playlist is not None:
            session.playlist.append(launch_item)
            if session.playlist_tracker:
                session.playlist_tracker.add_item(launch_item)

    return {
        "success": True,
        "already_active": True,
        "handled_directly": True,
        "message": f"Switched to item: {launch_item.get('title')}",
        "enriched_url_items": url_items_list
    }
