# MPV Playlist Organizer: Refined Logging & Diagnostics Plan (V2)

## 1. Objectives
*   **Zero Latency:** All disk I/O occurs on a background thread (`QueueListener`) to ensure Native Messaging never blocks.
*   **Request Correlation:** Every log entry is tagged with a `request_id` to trace actions from the Browser UI through the Python backend.
*   **Unified Feedback:** Single API to log to disk AND notify the user via the browser UI.
*   **Automated Security:** Path masking (PII protection) is handled at the logging core, not the call site.
*   **Subprocess Integration:** Standardize how `mpv` and `yt-dlp` stderr streams are captured and filtered.

## 2. Technical Architecture

### The Background Worker (`utils/logger.py`)
- **Queue System:** Use `queue.Queue` (thread-safe) to buffer log records.
- **Listener:** A dedicated daemon thread that consumes the queue and writes to `RotatingFileHandler`.
- **Formatting:** A custom `SecurityFormatter` that automatically applies `security.mask_path` to all messages.

### Log Streams
1.  **`MAIN`**: Business logic, file I/O, and session management (`native_host.log`).
2.  **`IPC`**: High-frequency socket traffic from MPV (`ipc_events.log`).
3.  **`TRACE`**: Function entry/exit data and performance metrics.

## 3. The Refined API

### Global Initialization
```python
import logger
# Called in native_host.py
logger.initialize(data_dir, level=logging.DEBUG)
```

### Context-Aware Logging
We will use Python's `ContextVar` or a thread-local storage to track the current `request_id` automatically within a task.
```python
# The logger will automatically include [Req: 5a2b] in the file log
logger.info("Starting playback resolution", ui_notify=True) 
```

### Decorator Suite (The "Observation" Layer)
*   **`@logger.trace(name="Optional")`**: Logs "ENTERING" and "EXITING" with execution time and correlation ID.
*   **`@logger.catch(ui_alert=True)`**: Automatically logs full tracebacks and sends a "Fatal Error" notification to the browser if it crashes.
*   **`@logger.observe_stream(tag="MPV")`**: A wrapper for `log_stream` that routes subprocess output into the non-blocking queue.

## 4. Implementation Steps

### Phase 1: Core Engine
- Rewrite `utils/logger.py` to implement the `QueueManager` and `SecurityFormatter`.
- Implement `ui_notify` logic that calls the `send_message` bridge automatically.

### Phase 2: Native Host Integration
- Replace the 60+ lines of logging setup in `native_host.py` with `logger.initialize()`.
- Update `task_wrapper` to set the correlation ID context for every incoming request.

### Phase 3: Subprocess Refactor
- Update `services.py` and `native_host.py` to use `logger.observe_stream` for `mpv` and `yt-dlp`.
- Add "Noise Filters" to the logger to drop useless lines (e.g., `[mpv_thumbnail_script]`) before they hit the queue.

### Phase 4: Diagnostic Export
- Implement a `get_debug_bundle` command that:
    1. Flushes the log queue to disk.
    2. Bundles `native_host.log`, `ipc_events.log`, and `session.json`.
    3. Returns a sanitized diagnostic report to the UI for user download.

## 5. Security & Privacy
- **Auto-Masking:** The system will identify patterns like `/home/user/` or `C:\Users\Name` and replace them with `<HOME>` or `<DATA_DIR>` globally.
- **Secret Scrubbing:** Ensure keys/tokens in URLs (like YouTube session tokens) are regex-scrubbed before writing to disk.
