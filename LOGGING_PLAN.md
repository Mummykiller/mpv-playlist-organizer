# MPV Playlist Organizer: Unified Cross-Environment Logging Plan

## 1. Objectives
*   **Unified Traceability:** Synchronize logs between the Chrome Extension (JS) and the Native Host (Python) using shared Request IDs.
*   **Persistence:** Enable the JavaScript side to persist critical logs into the Python `native_host.log` file for permanent storage.
*   **Non-Blocking & Efficient:** Maintain high performance by using asynchronous, "fire-and-forget" logging with rate-limiting to prevent bridge flooding.
*   **Centralized Diagnostics:** Create a single source of truth for troubleshooting that merges JS errors, Python system logs, and environment metadata.

## 2. System Architecture

### Components
1.  **JS `SystemLogger` (The Hub):** A new singleton in `utils/SystemLogger.js` that manages levels, rate-limiting, and the remote pipeline.
2.  **The Logging Bridge:** Utilizes the existing `Native Messaging` protocol (`callNativeHost`) to transport log strings from JS to Python.
3.  **Python `QueueListener`:** Leverages the existing non-blocking logging queue in `utils/logger.py` to write JS-originating logs to disk.
4.  **Correlation Engine:** Uses the `request_id` to prefix logs on both sides, integrated into the `nativeLink` wrapper for automatic context extraction.

---

## 3. JavaScript Implementation (`SystemLogger.js`)

### Features
*   **Levels:** `DEBUG`, `INFO`, `WARN`, `ERROR`, `FATAL`.
*   **Flood Gate (Throttling):** Implements a rate limiter. If logs exceed 10/second, it collapses subsequent identical logs into a single "X occurred N more times" entry to protect the bridge.
*   **Log Level Synchronization:** During the initial handshake, JS receives the Native Host's current log level and silences any JS logs below that level to save bandwidth.
*   **Connection Buffering:** Buffers up to 50 logs while disconnected, flushing them once the bridge is established.
*   **Automatic Context:** Integrated with the `nativeLink` promise chain to automatically attach the active `request_id` to logs generated during that request's lifecycle.

---

## 4. Python Implementation (`utils/logger.py` & Handlers)

### Handshake & Sync
*   **Level Broadcast:** Upon connection (in `restore_session`), Python includes its current `log_level` in the response so JS can synchronize.
*   **The `log_event` Action:** Receives JS logs and places them into the Python `logging` queue.
*   **Format:** JS logs are formatted as `[JS-CONTEXT] [Req: ID] Message`.

### Enhanced UI Notifications
Refine the `_send_ui_notification` hook to ensure background threads can send logs to the UI without interrupting the main thread's `stdout` responses.

---

## 5. Unified Diagnostics Pipeline

### Phase 1: Environment Metadata
The "Unified Report" will automatically capture:
*   Extension Version
*   Browser Version (User Agent)
*   Operating System
*   Native Host Status (Python version, dependency health)

### Phase 2: The "Unified Report" Action
A new action `get_unified_diagnostics` will:
1.  Collect JS `DiagnosticCollector` errors and Environment Metadata.
2.  Send them to Python.
3.  Python appends the tail of `native_host.log` and `ipc_events.log`.
4.  Returns a single, sanitized JSON blob for the "Copy Debug Info" feature.

---

## 6. Safety & Integrity Rules

*   **Rate Limiting:** Critical for preventing extension freezes if a JS loop crashes.
*   **Case Conversion Safety:** Uses a flat payload structure (`message`, `level`, `context`) to avoid bridge translation errors.
*   **Memory Management:** JS buffers are strictly capped at 50 items.
*   **Security:** Existing `SecurityFormatter` in Python will continue to mask sensitive paths in all incoming JS log strings.

## 7. Migration Steps
1.  **Create `utils/SystemLogger.module.js`** with throttling and level-sync logic.
2.  **Update Handshake:** Modify Python's `restore_session` to return the log level.
3.  **Add `log_event` action** to the Python registry.
4.  **Integrate `nativeLink`:** Wrap `callNativeHost` to provide automatic context to the logger.
5.  **Refactor:** Replace legacy `console.log` and update the Settings UI for the Unified Report.
