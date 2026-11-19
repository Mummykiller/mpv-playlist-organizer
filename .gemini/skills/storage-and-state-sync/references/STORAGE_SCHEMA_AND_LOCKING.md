# Storage Buckets, FileLock & Watched State Specification

This reference documents the JavaScript `chrome.storage.local` bucket schema, the Python `DATA_DIR` file layout, `FileLock` and `_atomic_json_dump` mechanics, and the `watched` vs. `marked_as_watched` state separation.

---

## 1. JavaScript Granular Bucket Schema (`utils/storageManager.js:StorageManager`)

| Bucket Key | Type | Description |
| :--- | :--- | :--- |
| `mpv_storage_version` | `number` | Schema version (`CURRENT_VERSION = 2`). |
| `mpv_folder_index` | `string[]` | Ordered array of folder IDs (e.g., `["Default", "Anime"]`). |
| `mpv_folder_data_<folderId>` | `object` | Per-folder shard containing `{ playlist: Item[], lastPlayedId: string }`. |
| `mpv_settings` | `object` | Global settings, UI preferences (`uiPreferences.global` and `uiPreferences.domains`), keybindings, and domain overrides. |
| `mpv_meta_cache_<domain>` | `object` | Domain-sharded cached titles and headers to accelerate UI loading. |

- **Serialized Writes:** All save calls chain onto `this.writeQueue = this.writeQueue.then(...)` to prevent read-modify-write race conditions.
- **Self-Healing Casing Purge (`_migrateToCamelCaseSettings`):** On startup, `StorageManager` inspects `uiPreferences.global` and purges stray `snake_case` keys.

---

## 2. Python `DATA_DIR` Layout & Atomic Locking (`file_io.py`, `utils/file_lock.py`)

`file_io.get_user_data_dir()` resolves `DATA_DIR` to the platform user data directory (`~/.local/share/MPVPlaylistOrganizer` on Linux, `%APPDATA%\MPVPlaylistOrganizer` on Windows, `~/Library/Application Support/MPVPlaylistOrganizer` on macOS):

- `DATA_DIR/config.json` (+ `.bak`): Backend settings, tool paths (`mpv_path`, `ffmpeg_path`, `ytdlp_path`, `node_path`, `terminal_emulator`), and UI preferences mirror.
- `DATA_DIR/session.json`: Active playback session metadata (created with `0o600` permissions via `utils/session_health.py:persist_session_atomic`).
- `DATA_DIR/index.json` (+ `.bak`): Master index of folder metadata and item counts.
- `DATA_DIR/playlists/<folderId>.json` (+ `.bak`): Sharded playlist JSON for each folder (validated via `file_io._get_safe_shard_path`).
- `DATA_DIR/playlists/trash/`: Quarantine directory for orphaned shards (`_move_orphan_to_trash`).
- `DATA_DIR/exported/`: Sandboxed export/import directory (`EXPORT_DIR`).
- `DATA_DIR/flags/`: Temporary handshake JSON files (`handshake_*.json`) and natural completion flags (`mpv_natural_completion_<pid>.flag`).

### `utils/file_lock.py:FileLock` Mechanics
1. **In-Process Re-Entrant Lock:** Acquires a per-normalized-path `threading.RLock()` and tracks thread-local recursion counts (`_held_locks.counters`).
2. **Cross-Process OS Advisory Lock:** Opens `<filepath>.lock` with `os.open(..., os.O_CREAT | os.O_RDWR, 0o600)`:
   - **POSIX:** `fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)` followed by `os.fstat(fd)` vs. `os.stat(self.lockfile)` (`st_ino`/`st_dev`) verification to defeat concurrent unlink races.
   - **Windows:** `msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)` with a retry loop in `_remove_lock_file` on release.
3. **Read-Only Fallback:** On `EROFS`/`EACCES`, logs a warning and degrades gracefully to the in-process `RLock`.
4. **Timeout:** Polls at `delay=0.05`s intervals up to `timeout=5.0`s before raising `RuntimeError` reporting the holder PID.

### Atomic Write & Recovery Cycle (`file_io.py:_atomic_json_dump` & `_safe_json_load`)
1. Write JSON to per-PID/thread `<filepath>.<pid>.<tid>.tmp`, flush, and call `os.fsync(f.fileno())`.
2. If `<filepath>` already exists, parse it first to confirm it is valid non-empty JSON before copying to `<filepath>.bak` (never overwrite a healthy `.bak` with a corrupt primary file).
3. Atomically replace the target via `os.replace(tmp_file, filepath)`.
4. On load (`_safe_json_load`), automatically fall back to `<filepath>.bak` if the primary file is corrupt.

---

## 3. `watched` vs. `marked_as_watched` State Separation

| Field (Python / JS) | Trigger Condition | UI Representation & Persistence Rule |
| :--- | :--- | :--- |
| **`watched`** (`watched`) | Set to `true` after **30 seconds** of confirmed forward playback (`playlist_tracker.py`) or natural EOF (`on_completion.lua`). | Controls the green checkmark (`✔`) and dimmed item row. Stored locally in playlist shards and **never** cleared by remote sync failures. |
| **`marked_as_watched`** (`markedAsWatched`) | Set to `true` **only** when `yt-dlp --mark-watched` succeeds against the remote service (e.g., YouTube watch history) or when manually toggled by the user. | Controls the manual watch-history checkbox in the playlist UI. |
