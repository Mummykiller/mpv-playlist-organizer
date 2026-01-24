# MPV Playlist Organizer: General Project Guide

> **🤖 AGENT INSTRUCTIONS:**
> *   **Context Awareness:** Use sections relevant to your task (e.g., Ignore "Native Protocol" if fixing CSS).
> *   **Explicit Key Matching:** The system does **NOT** automate case conversion. You must use the exact keys expected by the other side.
> *   **Scope:** Strict security/architecture rules apply to the *Core App*. Standalone scripts or tools may use simpler patterns where appropriate.

## 1. System Overview
The project is a hybrid media management application consisting of three distinct runtime environments that function as a single system.

### Core Components
1.  **Frontend (Chrome Extension):**
    - **Role:** User Interface, URL capture, and state management.
    - **Entry Point:** `background.js` (Service Worker).
    - **Logic:** `background/handlers/` (routing) and `utils/` (business logic).
2.  **Backend (Python Native Host):**
    - **Role:** File I/O, heavy lifting (yt-dlp resolution), process orchestration.
    - **Entry Point:** `native_host.py`.
    - **Communication:** Standard Input/Output (`stdin`/`stdout`) via Native Messaging API.
3.  **Playback Engine (MPV):**
    - **Control:** Controlled by Backend via JSON-IPC.
    - **Internal:** Lua scripts in `mpv_scripts/` handle hooks/events.

## 2. Naming Conventions (Key Matching Rules)
**Strictly adhere to agreed-upon keys to prevent bridge failures.**

| Context | Style | Agent Action |
| :--- | :--- | :--- |
| **Python** | `snake_case` | Use `snake_case` for internal Python logic. |
| **JavaScript** | `camelCase` | Use `camelCase` for internal JS logic. |
| **The Bridge** | **Manual Matching** | Action names are strictly `snake_case` (e.g., `play_batch`). Payload keys vary. |

*Note:* Bridge Actions (the `action` key) are strictly `snake_case`. Payload keys vary; always check `native_host_handlers.py` or the JS caller to see what the other side expects (e.g., Python looks for `folderId` and `request_id`).

## 3. Communication Protocol
- **Schema:** Responses are `{ success, request_id, result?, error?, log? }`.
- **Requests:** JS sends `request_id` (the key name is strictly snake_case in the message object to match Python).
- **Request ID Preservation:** The key `request_id` is explicitly excluded from `camelCase` conversion in both `native_link/responder.py` and `nativeConnection.module.js` to ensure the asynchronous promise-matching logic never fails.
- **Logs:** Python can include a `log: { text, type }` object in any response to trigger a UI notification via `nativeConnection.js`.
- **Events:** Python sends unsolicited events (e.g., `mpv_exited`) which JS listeners dispatch to handlers.

## 4. Playback Architecture (Hybrid Mode)
*Crucial for tasks involving playback logic or `mpv_scripts/`.*

### Mode A: Stream Resolution (e.g., YouTube)
- **Mechanism:** `native_host_handlers.py` uses `services.py` and `yt-dlp` to resolve URLs.
- **Cookies:** Uses `VolatileCookieManager` to extract cookies to temporary files, passed to MPV via `cookies-file` to avoid permission issues with some browsers.

### Mode B: Direct Stream (e.g., AnimePahe)
- **Logic:** Direct playback with injected headers (`Referer`, `User-Agent`).
- **Mechanism:** Handled dynamically by `adaptive_headers.lua`.

## 5. State & Persistence
- **JS Storage (Source of Truth):** `utils/storageManager.js` (uses Granular/Bucket storage).
- **Python Storage (Backup/Sync):** `session.json` (active session metadata), `index.json` (folder metadata index), and `playlists/*.json` (sharded playlist content).
- **Sharding:** Playlists are sharded on disk to ensure performance with large libraries. Use `file_io.py`'s `get_playlist_shard(folder_id)` to load content lazily.
- **Sync:** JS updates are pushed to Python via `export_data` action.

## 6. Data Structures (Reference)
**Typical Playlist Item:**
```json
{
  "id": "uuid-string",
  "url": "https://...",
  "original_url": "https://...",
  "title": "Video Title",
  "is_youtube": true,
  "settings": {},
  "resume_time": 0.0,
  "marked_as_watched": false
}
```

## 7. Security & Safety
- **Command Execution:** Use `subprocess.Popen` with appropriate arguments and environment whitelisting (see `session_services.py`).
- **Sanitization:** `file_io.py` and `utils/security.py` contain `sanitize_string` for filenames and URLs. Ensure manual validation of all other inputs.
- **Isolation:** The Native Host is a separate process. It cannot access `window` or `document`.

## 8. Development & Testing
- **JS Build Loop:** After editing any `*.module.js` file in `utils/`, you **MUST** run `python3 testing_tools/generate_js.py` to update the legacy files used by content scripts.
- **Frontend Reload:** `chrome://extensions` -> Reload.
- **Backend Reload:** **Restart the Browser** (Native Host persists until browser exit).
- **MPV Reload:** Restart the player instance or reload the script in MPV.
- **Diagnostics:** Use `installer.py` -> "Run Diagnostics" or the `get_diagnostics` action via the bridge to inspect `DiagnosticCollector` logs.
- **Legacy Tests:** `testing_tools/test_bridge_protocol.py` is deprecated.

## 9. JavaScript Build Process
The project uses a custom Python script to maintain compatibility between ES Modules (Background) and Global Scope (Content Scripts).

- **Source of Truth:** Always edit the `*.module.js` files in `utils/`.
- **Generation:** Run `python3 testing_tools/generate_js.py`.
- **Why:** Chrome Content Scripts do not natively support ES Module imports from extension resources without complex bundling. This script "transpiles" modules into namespaced globals (`MPV_INTERNAL`, `MPV_SECURITY`).

## 10. Translation & Normalization Layers
The system uses centralized "Translators" to handle the bridge between `snake_case` (Python) and `camelCase` (JS). **NEVER** manually patch keys in logic handlers; always update the relevant translator.

### Internal JS-to-JS (UI -> Background)
- **Location:** `background/handler_factory.js` -> `normalizeRequest()`.
- **Purpose:** Converts keys like `played_ids` to `playedIds` before they reach background logic. All handlers created via `createHandler` benefit from this automatically.

### Outgoing JS-to-Python (Background -> Native Host)
- **Location:** `utils/native_link/translator.py` -> `translate()`.
- **Purpose:** Maps incoming JSON messages to Python Dataclasses and ensures `folderId` (JS) is correctly read as `folder_id` (Python).

### Incoming Python-to-JS (Native Host -> UI)
- **Location:** `utils/nativeConnection.module.js` -> `normalizePayload()`.
- **Purpose:** Converts Python's response keys back into JS-friendly `camelCase`. 
- **Outgoing Python Responses:** `utils/native_link/responder.py` uses `_translate_keys` to recursively convert all Python `snake_case` keys to `camelCase` before sending them to the browser.
- **Implementation Detail:** If adding a new payload key that doesn't follow standard conversion (e.g., an abbreviation like `m3u_url`), ensure it is explicitly mapped in `translator.py`'s `translate()` function.
- **Source of Truth:** Edit the `.module.js` file and run the generator.
