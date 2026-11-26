# Native Messaging Protocol Specification & Models Reference

This reference details the binary framing, message envelopes, case-translation preservation rules, and typed request dataclass mappings for the bridge between the Chrome Extension and Python Native Host.

---

## 1. Binary Framing & Stream I/O (`native_host.py`)

Communication occurs over standard streams (`stdin` / `stdout`) using Chrome's 32-bit native messaging framing protocol:

```
[4 Bytes: Message Length (Little-Endian Uint32)] [N Bytes: UTF-8 Encoded JSON]
```

- **Inbound Reader (`native_host.py:get_message`):**
  - Reads the 4-byte length header via `struct.unpack('@I', raw_length)[0]`.
  - Enforces `security.SECURITY_LIMITS['MAX_IPC_MESSAGE_SIZE']` (5 MB) before reading the payload buffer.
  - Terminates cleanly (`sys.exit(0)`) on `stdin` EOF.
- **Outbound Writer (`native_host.py:send_message_binary`):**
  - Acquires `print_lock` (`threading.Lock()`) to serialize concurrent thread writes.
  - Recursively masks filesystem paths (`security.mask_path`) specifically inside the `"log"` field of outbound dicts.
  - Translates `snake_case` keys to `camelCase` via `utils/native_link/responder.py:_translate_keys`.
  - Soft-trims optional preview fields (`enrichedM3uContent`/`enriched_m3u_content`, `playlist`, `enrichedUrlItems`/`enriched_url_items`) above `SAFE_OUTBOUND_PAYLOAD_SIZE` (800 KB, setting `payloadTruncated: true`) and hard-blocks payloads exceeding `MAX_OUTBOUND_MESSAGE_SIZE` (900 KB), returning `native_link.failure` with the caller's `request_id`.
- **CLI Mode Bypass (`native_host.py:send_message_cli` & `set_active_sender`):**
  - When invoked via terminal CLI (`mpv-cli` / `native_host.py list|play`), swaps the active sender to `send_message_cli` so binary length-prefixed frames are never written to terminal `stdout`.

---

## 2. Message Envelopes & Unsolicited Events

### Request Envelope (JS → Python)
```javascript
{
  action: "play",           // ALWAYS snake_case
  request_id: "req_123",    // Preserved verbatim (correlates Promise & Python ContextVar log tag)
  folder_id?: "Default",    // Optional folder identifier
  ...data                   // Remaining payload fields in camelCase
}
```

### Response Envelope (Python → JS)
```javascript
{
  success: true,            // Operation status boolean
  request_id: "req_123",    // Preserved verbatim
  result?: { ... },         // Optional payload result
  error?: "Error message",  // Error string if success is false
  log?: {                   // Optional path-masked UI log notification
    text: "...",
    type: "info" | "error"
  }
}
```

### Unsolicited Native Events (`utils/nativeConnection.module.js:addNativeListener`)
Pushed asynchronously from Python over `stdout` without a `request_id`:
- `mpv_exited`, `mpv_quitting`, `session_restored`, `playback_status_changed`, `playback_health_changed`, `item_natural_completion`
- `update_last_played`, `update_item_resume_time`, `update_item_marked_as_watched`, `update_item_title`
- `task_update`, `ytdlp_update_check`, `log`

---

## 3. Case-Translation Whitelists & Subtree Preservation

| Layer | File & Symbol | Preserved Keys / Map Containers |
| :--- | :--- | :--- |
| **JS Normalizer** | `utils/commUtils.module.js:normalizeKeys` | • `NORMALIZE_WHITELIST`: `request_id`, `url`, `m3u8`, `mp4`<br>• `PRESERVE_MAP_KEYS` (preserves immediate child keys): `customNames`, `custom_names`, `folders`, `domains` |
| **Python Inbound Translator** | `utils/native_link/translator.py:_normalize_message` | • `WHITELIST`: `request_id`, `url`, `m3u8`<br>• Immediate child keys preserved under: `data`, `folders`, `domains`, `headers`, `http_headers`, `httpHeaders`, `custom_names`, `customNames`<br>• `SUBTREE_PRESERVE_KEYS` (entire subtree preserved): `youtube_tools`, `youtubeTools`, `shinku_library`, `shinkuLibrary`, `shinku_extension_settings`, `shinkuExtensionSettings` |
| **Python Outbound Responder** | `utils/native_link/responder.py:_translate_keys` | • Preserves `request_id`, `url`, `m3u8`, and any key containing `"://"`<br>• Immediate child keys preserved under: `folders`, `headers`, `http_headers`, `httpHeaders`, `domains`<br>• Preserves `SUBTREE_PRESERVE_KEYS` and `preserve_data_keys=True` (`import_from_file`) |

---

## 4. Typed Request Dataclasses (`utils/native_link/models.py` & `translator.py:ACTION_MAP`)

| Dataclass | Mapped `action` Values |
| :--- | :--- |
| **`PlaybackRequest`** | `play`, `play_batch`, `play_m3u`, `append`, `play_new_instance` |
| **`LiveUpdateRequest`** | `remove_item_live`, `reorder_live`, `clear_live`, `update_item_marked_as_watched`, `is_mpv_running`, `get_playback_status`, `close_mpv` |
| **`DataSyncRequest`** | `export_data`, `export_playlists`, `export_all_playlists_separately`, `import_from_file`, `set_ui_preferences`, `get_unified_diagnostics`, `get_smart_reorder`, `get_metadata_cache`, `cancel_task` |
| **`ServiceRequest`** | `get_anilist_releases`, `check_dependencies` |
| **`LogRequest`** | `log_event` |
| **`LogBrowserErrorRequest`** | `log_browser_error` |
| **`BaseRequest`** | `ping`, `restore_session`, `list_import_files`, `open_export_folder`, `run_ytdlp_update`, `get_ui_preferences`, `get_default_automatic_flags` |

> [!IMPORTANT]
> Any new field added to a request payload in JS **must** be declared on the corresponding dataclass in `utils/native_link/models.py` and mapped in `utils/native_link/translator.py:translate`, or it will be silently dropped during model instantiation. `testing_tools/generate_bridge_contract.py` syncs `models.py` and `ACTION_MAP` into `testing_tools/scripts/bridge_contract.js`.
