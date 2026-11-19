---
name: storage-and-state-sync
description: >-
  Governs state persistence, granular bucket storage, file concurrency locking, sharding,
  and settings synchronization drift guards. Load this skill whenever modifying
  `utils/storageManager.js`, `file_io.py`, `utils/file_lock.py`,
  adding or editing settings in either JS or Python, or working on watched item state.
---

# Storage, Persistence & State Synchronization

This skill defines the dual browser/native persistence architecture, cross-process file locking, playlist sharding, settings drift prevention, and watched-state separation.

> [!IMPORTANT]
> For `chrome.storage.local` bucket schemas, `DATA_DIR` file layout, `FileLock` / `_atomic_json_dump` implementation details, and `watched` vs. `marked_as_watched` specifications, see [references/STORAGE_SCHEMA_AND_LOCKING.md](references/STORAGE_SCHEMA_AND_LOCKING.md).

---

## 1. Dual-Layer Storage Architecture

- **Browser Storage (`utils/storageManager.js:StorageManager`):** Authoritative source of truth for the extension UI and playlist membership (item additions/deletions). Partitions data across granular `chrome.storage.local` buckets (`mpv_folder_index`, `mpv_folder_data_<folderId>`, `mpv_settings`, `mpv_meta_cache_<domain>`) and serializes writes through `this.writeQueue`.
- **Native Disk Storage (`file_io.py`, `utils/file_lock.py:FileLock`):** Local disk backup and IPC state mirror inside `file_io.DATA_DIR`. Uses sharded playlists (`DATA_DIR/playlists/<folderId>.json`), `FileLock` advisory locking, and `_atomic_json_dump` (`.tmp` → `fsync` → validated `.bak` → `os.replace`).
- **Last-Write-Wins Merge (`file_io.py:_merge_playlists`):** Reconciles item-level metadata (`resume_time`, `watched`, `marked_as_watched`, `title`) using `last_modified` millisecond timestamps while respecting browser playlist membership.

---

## 2. Settings Synchronization Drift Guard (`testing_tools/scripts/test_robustness.py`)

`test_robustness.py:test_settings_synchronization` enforces parity between Python backend defaults and JavaScript default settings:
- Extracts all keys from `file_io.py:get_settings()` (`default_settings`) and `utils/security.py:ALLOWED_SETTINGS_KEYS`.
- Extracts all keys from `utils/storageManager.js:_getDefaultData()` (`settings.uiPreferences.global`), converts `camelCase` to `snake_case`, and asserts every key is synchronized across both layers (except explicit `ui_only_keys` declared in `test_robustness.py` / `background/handlers/ui_state.js:UI_ONLY_KEYS`).

> [!CAUTION]
> **Rule When Adding a New Setting:**
> Any new backend-synced setting **must** be added simultaneously to:
> 1. `file_io.py:get_settings()` (`default_settings`)
> 2. `utils/security.py:ALLOWED_SETTINGS_KEYS`
> 3. `utils/storageManager.js:_getDefaultData()` (`settings.uiPreferences.global`)

---

## 3. Audit Guardrails

1. **No unlocked read-modify-write:** Any read followed by a write on an index or shard must execute within a single lock scope via `file_io.py:update_shard(folder_id, update_fn, update_index=...)`. Lock acquisition order is always `INDEX_FILE` → `shard_path`.
2. **OS advisory locks (`utils/file_lock.py:FileLock`):** Always use `FileLock` (`fcntl.flock` on POSIX with `fstat`/`stat` inode verification; `msvcrt.locking` on Windows) rather than raw PID files.
3. **Never overwrite user config on read failure:** Distinguish a *missing* `config.json` (initialize defaults) from a *corrupt/unreadable* file (keep file on disk, restore from `.bak`, and preserve user data). `get_settings()` caches by `os.path.getmtime(CONFIG_FILE)`.
4. **Guard destructive shard pruning (`file_io.py:save_library_batch`):** Refuse empty `folders_to_save` payloads when `index.json` is non-empty, and move removed shards into `DATA_DIR/playlists/trash/` (`_move_orphan_to_trash`) with a timestamp suffix rather than unlinking them immediately.
5. **Validate before backing up (`_atomic_json_dump`):** Only copy the existing primary file to `.bak` after verifying it parses as non-empty valid JSON.
6. **Restore snapshots on commit failure (`playlist_tracker.py`):** If a periodic disk commit fails, merge the in-flight snapshot back into the in-memory tracking state so resume positions and watched flags are never lost.
7. **Separate `watched` from `marked_as_watched`:** Local viewing completion (`watched`) must never be rolled back if remote `yt-dlp --mark-watched` synchronization (`marked_as_watched`) fails.
