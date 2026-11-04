# MPV Playlist Organizer: General Project Guide

> **🤖 AGENT INSTRUCTIONS:**
> *   **Context Awareness:** Use sections relevant to your task (e.g., ignore "Native Protocol" if working on UI/CSS).
> *   **Automated Key Matching:** The system **automatically** handles case conversion (`camelCase` ↔ `snake_case`). Write idiomatic cases (`snake_case` in Python, `camelCase` in JavaScript).
> *   **Golden Build Rule:** Always edit `*.module.js` source files in `utils/`. **NEVER** edit generated `utils/*.js` files directly. Run `python3 verify_changes.py` to rebuild and run the full test suite.
> *   **Scope:** Strict security and architecture rules apply to the *Core App*. Standalone scripts or tools may use simpler patterns where appropriate.

---

## 1. System Overview & Architecture

The application is a hybrid media management system consisting of three distinct runtime environments that coordinate seamlessly:

```mermaid
flowchart LR
    subgraph Browser ["Chrome Extension (Browser)"]
        SW["Service Worker<br/><code>background.js</code>"]
        Popup["Popup UI<br/><code>popup.html / popup.js</code>"]
        CS["Content Script<br/><code>content.js / Shadow DOM</code>"]
    end

    subgraph Native ["Python Native Messaging Host"]
        Host["Native Host<br/><code>native_host.py</code>"]
        Handlers["Request Handlers<br/><code>utils/handlers/</code>"]
        Disk["Storage & Shards<br/><code>file_io.py / data/</code>"]
    end

    subgraph Player ["MPV Media Player"]
        MPV["mpv Process"]
        Lua["Lua Scripts<br/><code>mpv_scripts/*.lua</code>"]
        IPC["JSON-IPC Socket / Pipe"]
    end

    Popup <-->|chrome.runtime| SW
    CS <-->|chrome.runtime| SW
    SW <-->|Native Messaging (stdin/stdout)| Host
    Host --> Handlers
    Handlers --> Disk
    Handlers <-->|JSON-IPC| IPC
    IPC <--> MPV
    MPV --- Lua
```

### Core Components
1. **Frontend (Chrome Extension / Manifest V3):**
   - **Background Service Worker (`background.js`):** Coordinates messaging, native host lifecycle, active playback sessions (`background/playback_manager.js`), tab broadcasting (`background/ui_broadcaster.js`), and request routing (`background/handlers/`).
   - **Extension Popup (`popup.html`, `popup.js`, `popup.css`):** Extension action window providing full folder management, settings configuration, AniList release schedule browsing, and manual playlist manipulation via [`PlaylistRenderer`](file:///home/shinku/Documents/mpv-playlist-organizer/utils/PlaylistRenderer.js).
   - **In-Page Overlay Controller (`content.js`, `utils/MpvController.js`, `utils/UIManager.js`):** Injected into web pages (e.g., YouTube, streaming sites) inside an isolated Shadow DOM tree. Provides floating controller, minimized stub, quick-actions bar (A, B, C, ⚡), and live reordering.
2. **Backend (Python Native Host):**
   - **Entry Point (`native_host.py`):** Communicates with the Chrome service worker via standard binary-length-prefixed JSON on `stdin`/`stdout`.
   - **Handlers (`utils/handlers/`):** Dispatches commands to `PlaybackHandler`, `DataHandler`, `SettingsHandler`, and `DependencyAnilistHandler`.
   - **Process & Session Orchestration (`mpv_session.py`, `playlist_tracker.py`, `utils/session_services.py`):** Spawns and manages mpv processes, monitors playback progress via IPC, resolves streams using `yt-dlp`, and manages volatile cookie extraction.
   - **Storage Engine (`file_io.py`):** Atomic file I/O with cross-process file locks (`FileLock`), playlist sharding, and backup persistence.
3. **Playback Engine (MPV & Lua):**
   - **Process Control:** Controlled bi-directionally via mpv's JSON-IPC socket/pipe (`utils/ipc_utils.py`).
   - **Lua Scripts (`mpv_scripts/`):**
     - `adaptive_headers.lua`: Injects custom HTTP headers (`Referer`, `User-Agent`) dynamically for restricted streams (e.g., AnimePahe).
     - `on_completion.lua`: Detects playlist end/natural completion and exits with status code `99` (`MPV_PLAYLIST_COMPLETED_EXIT_CODE`) to notify backend of natural completion.

---

## 2. Naming Conventions & Case Conversion

**Strictly adhere to agreed-upon keys to prevent bridge and protocol failures.**

| Context | Style | Agent Action |
| :--- | :--- | :--- |
| **Python Backend** | `snake_case` | Use `snake_case` for all Python logic, methods, and dictionary keys. |
| **JavaScript Frontend** | `camelCase` | Use `camelCase` for all JS variables, functions, and object keys. |
| **The Bridge** | **Automated** | The system automatically translates between cases recursively. |

*Note:* Bridge action names (the `action` key) always remain `snake_case` (e.g., `"play"`, `"get_ui_preferences"`, `"remove_item"`, `"log_event"`). All other payload keys are automatically converted: `camelCase` (JS) ↔ `snake_case` (Python).

---

## 3. Documentation Standards (Comment Architecture)

**Core Principle:** Code explains the *Action*; comments explain the *Intent*. Prioritize self-documenting code over narration.

### Permitted Comment Types
1. **Functional Logic-Guards:**
   - **Role:** Signals intentional logic boundaries to prevent accidental "optimizations" or regressions.
   - **Usage:** Mandatory for index checks, safety rails, and boundary logic.
   - **Example:** `if index < len(queue) - 1: # Guard: Prevents premature EOF termination`
2. **Architectural Context:**
   - **Role:** Explains non-obvious workarounds for cross-platform, browser sandbox, or IPC limitations.
   - **Usage:** Use when the "Why" cannot be inferred from the syntax (e.g., race conditions, OS-specific delays, Shadow DOM cross-origin restrictions).
   - **Example:** `# Workaround: Inject styles as textContent in <style> to prevent cross-origin stylesheet block on YouTube.`

### Prohibited Comment Types
- **Redundant "What" Narration:** Do not describe literal operations that are self-explanatory (e.g., `# Loop through list`, `# Increment counter`).
- **Style Rewrites:** Do not modify existing comments for subjective wording changes. If a comment lacks technical value per the standards above, **omit or remove it**.

---

## 4. Communication Protocol & Architecture

### Message Shape
- **Requests (JS → Python):** `{ action: "string", folder_id?: "string", request_id: "uuid", ...data }`
- **Responses (Python → JS):** `{ success: boolean, request_id: "uuid", result?: any, error?: string, log?: { text: string, type: "info"|"error" } }`
- **Request ID Preservation:** The key `request_id` is explicitly excluded from case conversion so promise-matching logic resolves correctly.
- **Unsolicited Events (Python → JS):** Sent by the native host (e.g., `mpv_quitting`, `mpv_exited`, `mpv_event`). Received by `nativeConnection.module.js` and dispatched to registered listeners after recursive key normalization.
- **Tab Broadcasting (JS → Tabs):** Background service worker communicates with content scripts via `chrome.tabs.sendMessage()` or `background/ui_broadcaster.js` (`broadcastToTabs`).

---

## 5. Playback Architecture & Launch Modes

The system operates in two playback modes:

### Mode A: Stream Resolution (e.g., YouTube, Twitch)
- **Resolution:** `url_analyzer.py` checks URL properties and platform compatibility. `yt-dlp` extracts direct stream URLs and metadata.
- **Volatile Cookie Extraction:** `VolatileCookieManager` dumps temporary browser cookies to an isolated temporary file passed to mpv via `--cookies-file` to bypass permission restrictions on locked browser profile databases.

### Mode B: Direct Stream (e.g., AnimePahe, HLS/m3u8, direct media URLs)
- **Header Injection:** Custom headers (`Referer`, `User-Agent`) are passed via command-line arguments and `adaptive_headers.lua`.
- **Local M3U Streaming Server:** For complex multi-item playlists, `utils/m3u_server.py` hosts a local loopback HTTP server that serves generated M3U playlists directly to mpv.

### Handshake File Mechanism
For both managed and unmanaged (⚡) MPV instances:
1. `services.create_handshake_file(...)` generates a temporary JSON handshake file in `data/flags/handshake_<uuid>.json`.
2. Windows backslashes are normalized to forward slashes for mpv compatibility.
3. The flag `--script-opts=mpv_organizer-handshake=<path>` is appended to mpv launch arguments, allowing mpv Lua scripts to read runtime session options securely without shell escape vulnerabilities.

---

## 6. State Management & Persistence

### 1. JavaScript Storage (Source of Truth for Browser UI)
Managed by [`StorageManager`](file:///home/shinku/Documents/mpv-playlist-organizer/utils/storageManager.js) using Chrome's `chrome.storage.local` with granular "Bucket" storage:
- `mpv_storage_version`: Schema version.
- `mpv_folders_index`: Array of folder IDs and folder display order.
- `mpv_folder_<folderId>`: Sharded storage containing playlist items and `lastPlayedId` for a single folder.
- `mpv_settings`: Global settings, UI preferences, keybindings, and domain-specific UI overrides.
- `mpv_meta_cache_<domain>`: Cached video metadata (titles, headers) to accelerate UI loading on repetitive domains.

### 2. Python Storage (Local Backup, IPC Sync & Native File System)
Managed by [`file_io.py`](file:///home/shinku/Documents/mpv-playlist-organizer/file_io.py):
- `data/config.json`: Backend settings, tool paths (`mpv`, `ffmpeg`, `yt-dlp`, `node`), network overrides, and decoder options.
- `data/session.json`: Active playback session state and process metadata.
- `data/index.json`: Master index of folders and folder orders.
- `data/playlists/<folderId>.json`: Sharded playlist items on disk.
- `data/flags/`: Temporary handshake files and control flags.

### 3. The "Watched" vs "Marked as Watched" Separation
To guarantee local viewing history is never wiped by external network sync issues:
- **`watched` (Local History):** Automatically marked `true` after 30 seconds of playback or natural video completion. Drives the UI ✔ checkmark and dimmed row appearance.
- **`marked_as_watched` (Remote Sync):** Set to `true` **only** when `yt-dlp` successfully syncs the item to the remote service (e.g. YouTube account history). Drives the manual checkbox in the UI.

---

## 7. UI, CSS & Shadow DOM Architecture

### Dual Surface Architecture
1. **Popup Window (`popup.html`):**
   - Standard browser extension popup window.
   - Uses `shared.css` and `popup.css`.
   - Directly renders items using [`PlaylistRenderer`](file:///home/shinku/Documents/mpv-playlist-organizer/utils/PlaylistRenderer.js).
2. **On-Page Injected Controller (`content.js`):**
   - Embedded directly into web pages (e.g., YouTube, anime sites).
   - Encapsulated inside Shadow DOM trees attached to host elements:
     - `#m3u8-controller-host`: Full & compact controller overlays.
     - `#m3u8-minimized-host`: Floating minimized launcher button.
     - `#anilist-panel-host`: Floating draggable AniList schedule panel.
   - Controlled by [`MpvController`](file:///home/shinku/Documents/mpv-playlist-organizer/utils/MpvController.js), [`UIManager`](file:///home/shinku/Documents/mpv-playlist-organizer/utils/UIManager.js), and [`PlaylistUI`](file:///home/shinku/Documents/mpv-playlist-organizer/utils/PlaylistUI.js).

### Stylesheet Rules & Shadow DOM Injection
- **`shared.css`:** Contains shared UI components (action buttons, checkmarks, AniList list items, animation keyframes).
- **`content.css`:** On-page controller layout, drag/resize handles, minimized stub.
- **`popup.css`:** Extension popup layout, modal dialogs, folder tabs, settings menu.
- ⚠️ **Critical Shadow DOM Rule:** Never use `<link rel="stylesheet" href="chrome-extension://...">` inside in-page Shadow Roots. Web pages with strict Content Security Policies or cross-origin isolation (such as YouTube) block external extension stylesheet links with `Unsafe attempt to load URL... Domains, protocols and ports must match`. [`UIManager._injectStyles`](file:///home/shinku/Documents/mpv-playlist-organizer/utils/UIManager.js#L18-L47) prefetches the CSS text via the content script's extension privileges and injects it directly into `<style>` tags within the Shadow Roots.

---

## 8. Security & Boundaries

Detailed validation rules are defined in [`SECURITY.md`](file:///home/shinku/Documents/mpv-playlist-organizer/SECURITY.md). Core principles include:

1. **Shared Limits (Synchronized between JS and Python):**
   - `MAX_URL_LENGTH`: `4096` characters.
   - `MAX_PLAYLIST_ITEMS`: `10000` items per folder.
   - `MAX_TITLE_LENGTH`: `512` characters.
   - `MAX_FOLDER_NAME_LENGTH`: `128` characters.
2. **Allowed Protocols:** Only `http:`, `https:`, and `magnet:` are permitted.
3. **Subprocess Isolation:** Commands are executed strictly through `subprocess.Popen` with argument arrays (never `shell=True`) and an environment variable whitelist (`get_mpv_popen_kwargs`).
4. **Path Traversal Protection:** All file operations in `file_io.py` validate paths against `DATA_DIR` using `validate_safe_path()` to eliminate directory traversal risks.

---

## 9. JavaScript Build Process

Chrome Content Scripts cannot natively use ES Module `import` statements across local extension resources without complex bundling. To solve this cleanly without bulky bundlers:

```
utils/*.module.js (ES Module Source of Truth)
       │
       ▼  python3 testing_tools/generate_js.py
utils/*.js        (Auto-generated Global / Namespaced for Content Scripts)
```

### Module Mapping Table

| Source Module | Generated Target | Global Namespace |
| :--- | :--- | :--- |
| `utils/SystemLogger.module.js` | `utils/SystemLogger.js` | `window.MPV_INTERNAL.logger` |
| `utils/anilist_renderer.module.js` | `utils/anilist_renderer.js` | `window.MPV_INTERNAL.AniListRenderer` |
| `utils/commUtils.module.js` | `utils/commUtils.js` | `window.MPV_INTERNAL` |
| `utils/security.module.js` | `utils/security.js` | `window.MPV_SECURITY` |
| `utils/nativeConnection.module.js` | `utils/nativeConnection.js` | `window.MPV_INTERNAL` |
| `utils/MpvInterface.module.js` | `utils/MpvInterface.js` | `window.MPV_INTERNAL.MpvInterface` |
| `utils/domUtils.module.js` | `utils/domUtils.js` | `window.MPV_INTERNAL.domUtils` |

> ⚠️ **Rule:** Always edit the `*.module.js` file. Running `python3 verify_changes.py` automatically updates the corresponding `.js` files.

---

## 10. Translation & Normalization Layers

The system maintains centralized translation layers between `snake_case` (Python) and `camelCase` (JS). **Never** manually patch casing in individual logic handlers.

1. **Internal JS Requests (UI → Background):**
   - Handled in `background/handler_factory.js` (`normalizeRequest`).
   - Recursively converts incoming payload keys to clean `camelCase`.
2. **Outgoing JS to Python (Background → Native Host):**
   - Handled in `utils/native_link/translator.py` (`translate`).
   - Normalizes keys to `snake_case` before reaching Python dataclasses.
3. **Incoming Python to JS (Native Host → UI):**
   - Handled in `utils/nativeConnection.module.js` (`normalizePayload`) and `utils/native_link/responder.py` (`_translate_keys`).
   - Normalizes keys to `camelCase` before reaching UI listeners.

---

## 11. Unified Logging & Diagnostics

- **Non-blocking Disk I/O:** Python logging runs on a background `QueueListener` thread.
- **Request Correlation:** User actions carry a `request_id` that propagates from JS UI through native messaging into Python logs.
- **PII / Path Masking:** Sensitive absolute paths are masked to `<HOME>` or `<DATA_DIR>` by `SecurityFormatter` before hitting disk.
- **JS Error Forwarding:** JavaScript `ERROR` and `FATAL` logs forward to `native_host.log` via the `log_event` action.
- **Diagnostics Report:** The `get_unified_diagnostics` action collects browser metadata, recent JS breadcrumbs, system dependency status, and the tail of `native_host.log` and `ipc_events.log`.

---

## 12. Development, Verification & Testing

### Verification Workflow
Before committing any changes, run the unified verification script from the repository root:
```bash
python3 verify_changes.py
```
This script sequentially:
1. Rebuilds all generated `utils/*.js` files from `utils/*.module.js`.
2. Runs **Batch 1: Backend Logic & Robustness** (Python unit tests, handshake generation, settings drift guard, crash repro).
3. Runs **Batch 2: Frontend Logic & Bridge** (Node/JSDOM protocol tests, build syntax checks for generated files and background handlers).
4. Runs **Batch 3: Cross-Environment Integration** (Logging pipeline and diagnostics).

### Testing Standards & Authoring
- **Test Directory:** All automated test scripts reside in `testing_tools/scripts/`.
- **Python Tests:** Inherit from `BaseTestCase` in `testing_tools/base_test.py`. Use `self.test_dir` for isolated file operations and `self.mock_send` to verify bridge messages.
- **Settings Drift Guard:** `test_settings_synchronization` in `test_robustness.py` asserts that all settings keys in `file_io.py:get_settings()` and `storageManager.js:_getDefaultData()` remain strictly synchronized.
- **Syntax Checks:** `run_suite.py` automatically runs `node --check` across all generated `utils/*.js` files, `background.js`, and all `background/handlers/*.js`.

---

## 13. Reloading & Developer Troubleshooting

| Component | How to Reload | Notes |
| :--- | :--- | :--- |
| **Extension UI / Popup** | Close and reopen the popup | Popup reloads on every open. |
| **Content Scripts** | Refresh the web page (`F5`) | Content scripts reload on page navigation. |
| **Service Worker (`background.js`)** | Go to `chrome://extensions` and click 🔄 **Reload** | Needed when modifying `background/`, `manifest.json`, or root scripts. |
| **Python Native Host** | **Restart the browser** or terminate the `python3 native_host.py` process | Chrome holds the native host process open for the duration of the browser session. |
| **MPV Scripts** | Restart MPV or re-trigger playback | Active MPV processes hold loaded Lua scripts in memory. |

### Common Error Checklist
- **"Service worker registration failed. Status code: 15":** A JavaScript syntax error or top-level import error in `background.js` or one of its imported handlers. Run `node -c background/handlers/<file>.js` to isolate.
- **"Unsafe attempt to load URL... Domains, protocols and ports must match":** A `<link rel="stylesheet">` pointing to `chrome-extension://` was injected into a web page Shadow DOM. Use programmatic `<style>` injection with `textContent` instead.
- **"Bridge call timeout / receiving end does not exist":** Native host crashed on boot or browser needs a full restart to reconnect to the updated native messaging host manifest. Check `data/native_host.log` for Python tracebacks.

