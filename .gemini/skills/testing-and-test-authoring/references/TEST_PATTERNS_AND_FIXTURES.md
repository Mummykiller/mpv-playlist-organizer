# Test Harness Fixtures, JSDOM Simulation & Risk-Area Patterns

This reference provides copy-pasteable test patterns for Python (`BaseTestCase`), JavaScript (`JSDOM` / Node), static AST/regex gates, and risk-area regression tests.

---

## 1. Python Test Harness (`testing_tools/base_test.py:BaseTestCase`)

All Python unit and integration tests in `testing_tools/scripts/test_*.py` inherit from `BaseTestCase`:

```python
import os
import sys

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from testing_tools.base_test import BaseTestCase


class MyFeatureTest(BaseTestCase):
    def test_my_feature(self):
        temp_file = os.path.join(self.test_dir, "test.json")
        ...
```

### Provided `BaseTestCase` Fixtures
1. **`self.test_dir`:** Isolated per-test directory created via `tempfile.mkdtemp()` and removed in `tearDown()`.
2. **`self.mock_send(msg)` & `self.sent_messages`:** Captures outgoing native-host messages in memory.
3. **Isolated Logger Lifecycle:** Initializes `utils.logger` in `self.test_dir` (`self.main_log`, `self.ipc_log`, `self.browser_error_log`) and calls `logger.shutdown()` in `tearDown()`.
4. **`self.wait_for_async(seconds=0.1)`:** Allows background daemon threads (`QueueListener`) to flush disk writes.

---

## 2. JavaScript Node & JSDOM Simulation (`testing_tools/scripts/test_*.js`)

Frontend tests run under Node.js and use `jsdom` + mocked `global.chrome` APIs when testing DOM or extension components:

```javascript
const { JSDOM } = require("jsdom");
const dom = new JSDOM('<!DOCTYPE html><html><body><div id="playlist-container"></div></body></html>', {
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
});
global.window = dom.window;
global.document = dom.window.document;
```

- Mock `global.chrome` (`chrome.runtime.sendMessage`, `chrome.storage.local.get/set`, `chrome.tabs.sendMessage/query`, `chrome.scripting`).
- Load generated `utils/*.js` outputs when testing classic content-script global namespace (`window.MPV_INTERNAL`, `window.MPV_SECURITY`) parity, or import `utils/*.module.js` / `background/*.js` when testing ES modules.

---

## 3. Static AST & Catch-Block Gate Examples (`testing_tools/run_suite.py`)

```python
# FORBIDDEN by Python AST Gate (bare except or silent pass):
try:
    do_something()
except Exception:
    pass

# PERMITTED (logs or re-raises):
try:
    do_something()
except Exception as e:
    logging.debug(f"Operation skipped: {e}")
```

```javascript
// FORBIDDEN by JS Regex Gate (empty or comment-only catch):
try { doSomething(); } catch (e) { /* ignored */ }

// PERMITTED (logs, handles, or returns fallback):
try { doSomething(); } catch (e) { console.debug("Skipped:", e); }
```

---

## 4. Risk-Area Regression Test Matrix

| Risk Area | Required Regression Test Style |
| :--- | :--- |
| **Native host framing** | Subprocess/unit test sending oversized (>900 KB reply), truncated, and malformed frames (`test_native_host_boot.py`) |
| **`FileLock` / atomic writes** | Multi-process/thread contention, stale vs. live holder cases, corrupt primary fallback to `.bak` (`test_storage_locking.py`, `test_robustness.py`) |
| **MPV IPC concurrency** | Mock MPV Unix socket / named pipe testing full backlog, slow reply, dead peer, and PID reuse (`test_playback_ipc_concurrency.py`) |
| **Local HTTP server** | Missing token → `403`, wrong `Host` header → `400`, path traversal → `404`, slow client isolation (`test_server_and_installer.py`) |
| **Security allowlists** | Item-supplied dangerous flags (`proxy=`, `exec=`, `ffmpeg-location=`), SSRF IPs, and path traversal rejected (`test_security_claims.py`) |
| **Service worker & UI resilience** | Mocked `chrome.*` testing worker restart state rehydration, ping-first injection, and teardown (`test_resilience_fixes.js`, `test_ui_sync.js`) |
| **YouTube Tools sub-extension** | Dynamic script registration, `MAIN`/`ISOLATED` bridge validation, legacy setting migration, standalone export parity (`test_yt_tools.js`, `test_yt_tools_standalone.js`) |
