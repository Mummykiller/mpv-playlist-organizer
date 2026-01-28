# MPV Playlist Organizer: General Project Guide

> **🤖 AGENT INSTRUCTIONS:**
> *   **Context Awareness:** Use sections relevant to your task (e.g., Ignore "Native Protocol" if fixing CSS).
> *   **Automated Key Matching:** The system **automatically** handles case conversion (camelCase ↔ snake_case). You should still use idiomatic cases (snake in Python, camel in JS).
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
| **Python** | `snake_case` | Use `snake_case` for all Python logic. |
| **JavaScript** | `camelCase` | Use `camelCase` for all JS logic. |
| **The Bridge** | **Automated** | The system automatically translates between cases recursively. |

*Note:* Bridge Actions (the `action` key) remain `snake_case`. All payload keys are automatically converted: `camelCase` (JS) ↔ `snake_case` (Python).

## 3. Communication Protocol
- **Schema:** Responses are `{ success, request_id, result?, error?, log? }`.
- **Requests:** JS sends `request_id` (preserved during conversion).
- **Request ID Preservation:** The key `request_id` is explicitly excluded from case conversion to ensure promise-matching logic functions correctly.
- **Logs:** Python can include a `log: { text, type }` object in any response to trigger a UI notification.
- **Events:** Python sends unsolicited events which JS listeners dispatch after automatic normalization.

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
- **Diagnostics:** Use `installer.py` -> "Run Diagnostics" or the `get_native_diagnostics` action via the bridge to inspect `DiagnosticCollector` logs.
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
- **Purpose:** Recursively converts keys (e.g., `played_ids` to `playedIds`) so background handlers always receive clean `camelCase`.

### Outgoing JS-to-Python (Background -> Native Host)
- **Location:** `utils/native_link/translator.py` -> `translate()`.
- **Purpose:** Recursively normalizes all incoming keys to `snake_case` before they reach Python logic or Dataclasses.

### Incoming Python-to-JS (Native Host -> UI)
- **Location:** `utils/nativeConnection.module.js` -> `normalizePayload()`.
- **Purpose:** Recursively converts Python's `snake_case` keys back into JS-friendly `camelCase`.
- **Outgoing Python Responses:** `utils/native_link/responder.py` uses `_translate_keys` to recursively convert all keys to `camelCase` before sending.
- **Source of Truth:** Edit the `.module.js` file and run the generator.
