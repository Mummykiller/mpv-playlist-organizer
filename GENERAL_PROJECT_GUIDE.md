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
  "watched": false,
  "marked_as_watched": false
}
```

### The "Watched" vs "Marked as Watched" Distinction
To ensure local progress is never lost due to network or sync failures, these flags MUST remain decoupled:
- **`watched` (Personal History):** A local fact. Set to `true` automatically after 30s of playback or natural completion. It controls UI "graying out" and the visual ✔ checkmark.
- **`marked_as_watched` (Remote Sync):** A network status. Set to `true` ONLY if the `yt-dlp` script successfully syncs the video to the external service (YouTube). It controls the checked state of the UI checkbox.

**Why they are separate:** If external sync fails (expired cookies, offline), the local `watched` flag preserves the user's history so the item still looks completed in the library. Manual UI toggles strictly affect `marked_as_watched` to allow pre-syncing without falsifying local history.

## 7. Security & Safety
For detailed protocols, input validation rules, and architectural safety standards, refer to the **SECURITY.md** file in the project root. This is the single source of truth for all security adherence.

- **Command Execution:** Use `subprocess.Popen` with appropriate arguments and environment whitelisting (see `session_services.py`).
- **Sanitization:** All inputs MUST be sanitized using the context-aware functions in `utils/security.py` or `file_io.py`.
- **Isolation:** The Native Host is a separate process. It cannot access `window` or `document`.

## 8. Development & Testing
- **JS Build Loop:** After editing any `*.module.js` file in `utils/`, you **MUST** run `python3 testing_tools/generate_js.py` to update the legacy files used by content scripts.
- **Full Verification:** To automate the build and testing workflow, run `python3 verify_changes.py` from the project root. This sequentially runs the JS generator and the full test suite.
- **Frontend Reload:** `chrome://extensions` -> Reload.
- **Backend Reload:** **Restart the Browser** (Native Host persists until browser exit).
- **MPV Reload:** Restart the player instance or reload the script in MPV.
- **Automated Testing:** Run `python3 testing_tools/run_suite.py` to execute the full batched test suite (Backend, JS, and Integration).

### Testing Blueprint & Standards
To maintain a clean and reliable environment, all new tests must follow these rules:

1.  **Storage:** All test scripts live in `testing_tools/scripts/`.
2.  **Python Tests:**
    - **Inheritance:** Always inherit from `BaseTestCase` in `testing_tools/base_test.py`.
    - **Discovery:** Name files `test_<name>.py` to be automatically picked up by the runner.
    - **Utilities:** Use `self.test_dir` for file I/O and `self.mock_send` to verify bridge messages.
3.  **JavaScript Tests:**
    - **Environment:** Run in Node.js (mocking browser globals like `navigator` where necessary).
    - **Registration:** Manually add new JS test filenames to the `js_tests` list in `testing_tools/run_suite.py`.
    - **Scope:** Focus on protocol parity and logic that doesn't require the Chrome Extension runtime.
4.  **Verification:** A task is not complete until `run_suite.py` passes with all batches green.

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

## 11. Unified Logging & Diagnostics
The system uses a high-performance, non-blocking logging architecture that synchronizes events between JavaScript and Python using a shared correlation ID.

### Core Principles
1.  **Zero Latency:** All disk I/O in Python occurs on a background thread (`QueueListener`). Native Messaging is never blocked by log writes.
2.  **Request Correlation:** Every user action is tagged with a `request_id`. This ID is preserved across the bridge, allowing you to trace a single click from the JS Popup through to the MPV process logs.
3.  **Security at the Core:** Path masking (PII protection) is handled automatically by the `SecurityFormatter` in Python. Home directories and project roots are replaced with `<HOME>` or `<DATA_DIR>` before hitting the disk.
4.  **Unified Persistence:** JavaScript `ERROR` and `FATAL` logs are automatically pushed to the Python `native_host.log` via the `log_event` bridge action.

### JavaScript Logging (`utils/SystemLogger.module.js`)
- **Singleton:** Access via `import { logger } from "./SystemLogger.module.js"`.
- **Flood Gate:** Implements rate-limiting (max 10 logs/sec). Identical rapid-fire errors are collapsed to prevent bridge saturation.
- **Level Sync:** During the handshake, JS receives the current Python log level and silences all JS logs below that level to save bandwidth.

### Python Logging (`utils/logger.py`)
- **Context-Aware:** Uses `ContextVar` to automatically associate log entries with the active `request_id` without manual passing.
- **Subprocess Integration:** Use `logger.observe_stream(tag="MPV")` to wrap `yt-dlp` or `mpv` stderr. It includes automated detection for site-specific errors (e.g., YouTube 403/410) to trigger auto-updates.
- **Log Streams:**
    - `native_host.log`: Main business logic and persistent JS logs.
    - `ipc_events.log`: High-frequency MPV state data (throttled).

### Developer API Reference

| Action | JS | Python |
| :--- | :--- | :--- |
| **Standard Log** | `logger.info("msg")` | `logger.info("msg")` |
| **UI Notification** | `{ uiNotify: true }` | `logger.info("msg", ui_notify=True)` |
| **Trace Duration** | N/A | `@logger.trace(name="Task")` |
| **Safe Execution** | N/A | `@logger.catch(ui_alert=True)` |
| **Correlation** | `logger.runWithContext(id, fn)` | Handled by `task_wrapper` |

### Diagnostics Export
A unified diagnostic report can be generated via the `get_unified_diagnostics` action. This merges:
1.  JS Environment Metadata (Browser, OS, Version).
2.  JS Breadcrumbs (Last 20 UI actions).
3.  The last 50KB of `native_host.log` and `ipc_events.log`.
4.  Active Python session metadata.
