# MPV Playlist Organizer: Unified Non-Blocking Logging Plan

## 1. Objectives
*   **Performance:** Move all disk I/O for logging to a background thread to prevent blocking main execution threads.
*   **Reliability:** Centralize logging configuration to ensure consistent behavior across all modules.
*   **Visibility:** Provide easy-to-use decorators for automated function tracing, error catching, and performance monitoring.
*   **Maintainability:** Replace manual `logging.basicConfig` and `RotatingFileHandler` setups with a single call to a centralized manager.

## 2. Architecture: The `QueueManager` System
The system will utilize the `logging.handlers.QueueHandler` and `QueueListener` pattern.

### Components
1.  **Shared Queue:** A single `multiprocessing.Queue` or `queue.Queue` that all loggers push to.
2.  **QueueListener Thread:** A dedicated background thread that polls the queue and writes to the actual log files.
3.  **Scoped Loggers:**
    *   `MAIN`: General logic (`native_host.log`).
    *   `IPC`: High-frequency noise (`ipc_events.log`).
    *   `TRACE`: Automated decorator output.

## 3. The Unified API (`utils/logger.py`)
The new `utils/logger.py` will expose the following interface:

### Initialization
```python
import logger
# Called once in native_host.py main entry point
logger.initialize(data_dir, level=logging.DEBUG)
```

### Direct Logging
Standard `logging.info()` etc. will continue to work, but will automatically be routed through the queue. We will also provide a convenient `get_logger(tag)` helper.

### Decorator Suite
*   **`@logger.trace`**: Logs function entry, exit, arguments, and total execution time.
*   **`@logger.catch`**: Wraps a function in a try-except block, logs the full traceback on error, and optionally re-raises.
*   **`@logger.slow_warning(threshold=1.0)`**: Logs a warning only if the function takes longer than the specified threshold.

## 4. Implementation Strategy

### Step 1: Update `utils/logger.py`
Rewrite the current `StandardLogger` class into a singleton-style `LoggingManager` that handles the `QueueListener` lifecycle.

### Step 2: Clean up `native_host.py`
Remove the boilerplate configuration logic.
*   **Delete:** ~50 lines of `RotatingFileHandler` setup.
*   **Add:** `logger.initialize(DATA_DIR)`.

### Step 3: Migration of Core Modules
*   **`mpv_session.py`**: Add `@logger.trace` to critical methods like `start()` and `clear()`.
*   **`playlist_tracker.py`**: Route high-frequency IPC logs through the optimized `IPC` queue stream.
*   **`file_io.py`**: Wrap expensive I/O operations in `@logger.slow_warning`.

### Step 4: Standalone Script Support
Update `utils/cli_base.py` to use the new unified logger so that `installer.py` and other CLI tools benefit from the same non-blocking architecture.

## 5. Benefits for Debugging
When a user reports a "hang" or "unreachable host":
1.  We can look at the `TRACE` logs to see exactly which function was entered but never exited.
2.  The `@slow_warning` logs will immediately point to specific yt-dlp calls or file locks that are taking too long.
3.  Crash logs in the background threads will be more reliable as they are captured by `@logger.catch`.
