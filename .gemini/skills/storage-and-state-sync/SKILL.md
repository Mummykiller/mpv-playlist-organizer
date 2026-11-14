---
name: storage-and-state-sync
description: >-
  Governs state persistence, granular bucket storage, file concurrency locking, sharding,
  and settings synchronization drift guards. Load this skill whenever modifying
  `utils/storageManager.js`, `file_io.py` (FileLock, atomic writes, playlist sharding),
  adding or editing settings in either JS or Python, or working on watched item state.
---

# Storage, Persistence & State Synchronization

This skill defines the data storage architecture, multi-process file locking, playlist sharding, settings drift prevention, and the watched state separation rules.

---

## 1. Storage Architecture Overview

The system maintains two distinct persistence layers tailored to their respective runtime environments:

```
┌──────────────────────────────────────────────┐     Sync      ┌──────────────────────────────────────────────┐
│ JavaScript Storage (Browser)                 │ ────────────> │ Python File I/O (Native Disk)                │
│ utils/storageManager.js                      │ <──────────── │ file_io.py                                   │
├──────────────────────────────────────────────┤               ├──────────────────────────────────────────────┤
│ • Source of truth for Browser UI.            │               │ • Local disk backup and IPC synchronization. │
│ • Backed by chrome.storage.local.            │               │ • Atomic JSON writes (.tmp -> replace).      │
│ • Granular bucket partitioning.              │               │ • Cross-process FileLock with retry loop.    │
│ • Write serialization queue.                 │               │ • Sharded playlists in data/playlists/.      │
└──────────────────────────────────────────────┘               └──────────────────────────────────────────────┘
```

---

## 2. JavaScript Granular Bucket Storage (`StorageManager`)

To prevent performance degradation with large playlists, data is split into isolated storage buckets in `chrome.storage.local`:

| Bucket Key | Type | Description |
| :--- | :--- | :--- |
| `mpv_storage_version` | `number` | Schema version (currently v2). |
| `mpv_folder_index` | `string[]` | Ordered array of folder IDs (e.g. `["Default", "Anime"]`). |
| `mpv_folder_data_<folderId>` | `object` | Shard containing `{ playlist: Item[], lastPlayedId: string }` for a single folder. |
| `mpv_settings` | `object` | Global settings, UI preferences, keybindings, and domain overrides. |
| `mpv_meta_cache_<domain>` | `object` | Cached titles and headers for web domains to accelerate UI loading. |

### Storage Write Queue & Cache

- **Serialized Writes:** All save calls chain onto `this.writeQueue = this.writeQueue.then(...)` to prevent read-modify-write race conditions in asynchronous event loops.
- **Self-Healing Casing Purge:** During startup (`_migrateToCamelCaseSettings`), `StorageManager` inspects `uiPreferences.global` and purges any stray `snake_case` keys to prevent pollution from legacy or backend sync drift.

---

## 3. Python Backend File I/O (`file_io.py`)

### Directory Layout

- `data/config.json`: Backend settings, tool paths (`mpv`, `ffmpeg`, `yt-dlp`, `node`), decoder options.
- `data/session.json`: Active playback session and process metadata.
- `data/index.json`: Master index of folder metadata and folder ordering.
- `data/playlists/<folderId>.json`: Sharded playlist JSON for each folder.
- `data/flags/`: Temporary handshake files and control flags.

### Cross-Process Concurrency with `FileLock`

`utils/file_lock.py:FileLock` (re-exported by `file_io.py`) provides atomic, cross-process and thread-safe locking:
1. **Thread Synchronization & Re-Entrancy:** Acquires a per-normalized-path `threading.RLock()` and tracks thread-local recursion counts (`_held_locks.counters`) to prevent thread contention and allow re-entrant acquisition within the same Python thread.
2. **OS-Level Advisory File Lock:** Opens `<filepath>.lock` (`0o600`) and acquires a kernel-managed advisory lock:
   - **POSIX (Linux / macOS):** Uses `fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)` and verifies inode identity (`os.fstat(fd)` vs `os.stat(self.lockfile)`) to guard against concurrent unlinks.
   - **Windows:** Uses `msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)`.
   - Because OS-level locks are automatically released by the kernel if a holding process crashes or exits, stale locks are cleared without fragile PID-timestamp breaking races (the current holder's PID is written to the lockfile for diagnostic logging only).
3. **Read-Only / Permission Fallback:** If the lock directory or filesystem is read-only (`EROFS` / `EACCES`), `FileLock` logs a warning and degrades gracefully to the in-process thread `RLock`.
4. **Retry Loop:** Polls at `delay` (50ms) intervals up to `timeout` (5.0s default) before raising a `RuntimeError` reporting the holder PID.

### Atomic Write Pattern

All writes to disk (`file_io.save_json`) enforce the atomic write cycle:
```
1. Write payload to <file>.tmp
2. Force write buffer to physical storage using os.fsync(fd)
3. Close descriptor and execute atomic replace: os.replace(<file>.tmp, <file>)
4. Maintain <file>.bak copy as automatic recovery fallback
```

### Playlist Sharding & Merge Logic

- `_merge_playlists(existing_playlist, new_playlist)`:
  - Performs **Last-Write-Wins** reconciliation based on `last_modified` millisecond timestamps.
  - The browser is the authoritative source of truth for playlist membership and item deletions.

---

## 4. Settings Synchronization Drift Guard

The test suite enforces strict synchronization between Python backend settings and JavaScript default settings.

### The Drift Guard Test (`test_settings_synchronization`)

Located in `testing_tools/scripts/test_robustness.py`:
- Parses `file_io.py:get_settings()` and extracts all dictionary keys.
- Parses `utils/storageManager.js:_getDefaultData()` and extracts all keys in `uiPreferences.global`.
- Converts JS `camelCase` keys to `snake_case`.
- Asserts that every setting key exists in **both** files (excluding explicit `ui_only_keys`: `minimized`, `mode`, `log_visible`, `pinned`, `position`, `top`, `left`, `right`, `bottom`, `anilist_panel_visible`, `lock_anilist_panel`, `force_panel_attached`, `anilist_attach_on_open`, `minimized_stub_position`, `dependency_status`, `mpv`, `ytdlp`, `ffmpeg`, `node`).

> [!CAUTION]
> **Rule When Adding a New Setting:**
> Whenever you add a new configuration setting, you **MUST** declare it in **both**:
> 1. `file_io.py:get_settings()` in the default dictionary.
> 2. `utils/storageManager.js:_getDefaultData()` under `settings.uiPreferences.global`.
> Failing to declare it in both places will immediately cause `test_robustness.py` and `verify_changes.py` to fail.

---

## 5. The "Watched" vs "Marked as Watched" Separation

To guarantee local viewing history is never corrupted or cleared by remote network failures or third-party API issues, the system strictly separates local playback completion from remote account synchronization:

```
┌─────────────────────────────────────────────────────────────┐
│ 1. watched (Local Playback History)                         │
├─────────────────────────────────────────────────────────────┤
│ • Automatically set to true after 30 seconds of playback or │
│   upon natural video completion (detected via on_completion)│
│ • Controls the UI green checkmark (✔) and dimmed list row.  │
│ • Stored locally in playlist shards. NEVER cleared by sync. │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ 2. marked_as_watched (Remote Service Sync)                  │
├─────────────────────────────────────────────────────────────┤
│ • Set to true ONLY when yt-dlp successfully registers the   │
│   item in remote account history (e.g., YouTube watch hist) │
│ • Controls the manual checkbox input in the UI list.        │
│ • Represents external confirmation status.                  │
└─────────────────────────────────────────────────────────────┘
```

---

## 6. Storage Troubleshooting Checklist

- **"File lock acquisition timeout":** A previous process crashed while holding a `.lock` file without recording a valid PID. Inspect `data/*.lock` files and verify process IDs.
- **Missing Setting Value / Undefined in UI:** Check whether the setting is declared in `_getDefaultData()` in `utils/storageManager.js`. If missing, newly installed extensions or clean profiles will not have the key initialized.
- **Test Failure in `test_settings_synchronization`:** You added a setting in JS or Python without mirroring it in the other environment. Compare `file_io.py:get_settings()` with `utils/storageManager.js:_getDefaultData()`.


---

## 7. Audit Guardrails (added after the Nov 2026 code review; see `CODE_REVIEW.md`)

1. **No unlocked read-modify-write.** Any `get_*` followed by `save_*` on the same index or shard must happen inside one lock scope. Add and use `update_shard(folder_id, fn)`-style helpers instead of separate get/save calls. Lock order is always INDEX → shard.
2. **Prefer OS locks.** PID-file locks have stale-detection races and PID-reuse false positives. Prefer `fcntl.flock` (POSIX) / `msvcrt.locking` (Windows), which the OS releases on process death. If the lock falls back to thread-only (EROFS/EACCES), log it loudly.
3. **Never overwrite user data on a read failure.** Distinguish *missing* (write defaults) from *unreadable/corrupt* (keep the file, use `.bak`, surface an error). `get_settings()` must not write on read, and should cache by mtime.
4. **Destructive pruning needs guards.** `save_library_batch` (non-incremental) must refuse an empty or far-smaller-than-index payload, and should move removed shards to a `trash/` dir with a timed purge, not delete them.
5. **Back up only valid files.** Validate the current file before copying it over `.bak`. fsync the directory after `os.replace`.
6. **Snapshot-and-clear must be restorable.** If a commit fails (lock timeout, disk error), merge the snapshot back into the in-memory cache. Never drop resume times or watched flags on error.
7. **Shared mutable state needs one lock.** Sets and dicts touched by the tracking thread, the IPC reader thread, and callbacks (`played_item_ids`, `threshold_met_ids`, caches) are guarded by `self.lock`. Copy lists on entry instead of aliasing another component's list.
8. **Session identity.** Waiter and watcher threads capture a session generation token (or PID) at start. `clear()` ignores callers whose token is stale, and `manual_quit` is captured at waiter start.
9. **Service-worker memory is not storage:** see the MV3 rules in `bridge-and-protocol`.
