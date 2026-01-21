# NativeLink: JS-Python Communication Refactor Plan

## 1. Problem Statement
The Python backend currently suffers from **"API Leakage"**. Business logic files (`mpv_session.py`, `native_host_handlers.py`) are directly interacting with raw JSON dictionaries from the Chrome Extension.

### Current "Spaghetti" Issues:
*   **Key Fragility:** If JavaScript changes `folderId` to `folder_id`, the Python side breaks in multiple files.
*   **Naming Collision:** Python logic is forced to use `camelCase` keys to match JS, violating PEP 8.
*   **Validation Gaps:** Handlers often check for `if not message.get('key')` repeatedly, leading to redundant code.
*   **Implicit Protocol:** The "handshake" logic (request_id, success flags) is hardcoded into every response.

---

## 2. Proposed Architecture: The "NativeLink" Layer
We will introduce a dedicated package (`utils/native_link/`) that acts as a strict "Sanitization & Translation" barrier.

### Component A: `translator.py` (The Marshaller)
*   **Input:** Raw JSON dict from `sys.stdin`.
*   **Action:** Maps JS-style keys (`folderId`) to Python-style attributes (`folder_id`).
*   **Validation:** Uses Type Hints or Dataclasses to ensure incoming data is complete before it reaches a handler.

### Component B: `models.py` (The DTOs)
*   Defines clean Python objects for every interaction:
    *   `PlaybackRequest`
    *   `PlaylistUpdate`
    *   `PreferenceSync`
*   Core logic will **only** receive these objects, never raw dicts.

### Component C: `responder.py` (The Envelope)
*   Standardizes the output format.
*   Automatically attaches `request_id` and formats the `log` object.
*   Core logic simply returns `Success(data)` or `Failure(error)`, and `NativeLink` handles the JSON packaging.

---

## 3. Implementation Phases

### Phase 1: Inbound Isolation
*   Modify `native_host.py` to pass the raw message to `NativeLink.translate(message)`.
*   Refactor `HandlerManager` methods to accept a `RequestModel` instead of a `message` dict.

### Phase 2: Outbound Standardization
*   Create a `NativeLink.wrap_response()` helper.
*   Remove manual `{"success": True, "request_id": ...}` construction from all handler methods.

### Phase 3: Total JS-Ignorance
*   Audit `mpv_session.py` and `services.py`. 
*   Ensure **zero** occurrences of JS-specific strings (like `folderId`) exist in these files.

---

## 4. Example: Before vs. After

### Before (Fragile)
```python
# utils/native_host_handlers.py
def handle_play(self, message):
    f_id = message.get('folderId')
    url = message.get('url_item').get('url')
    # ... logic ...
    return {"success": True, "request_id": message.get('request_id'), "result": "ok"}
```

### After (Robust)
```python
# utils/native_host_handlers.py
def handle_play(self, request: PlaybackRequest):
    # request.folder_id and request.url are already validated and snake_case
    # ... logic ...
    return NativeLink.success("ok") 
```

---

## 5. Impact Assessment
*   **Safety:** Malformed JS requests are caught at the "Border" (NativeLink) before they can cause `KeyError` crashes in deep logic.
*   **Cleanliness:** The main project directory will contain pure Python logic. All "Bridge" weirdness is contained in one folder.
*   **Maintenance:** Changing the communication protocol only requires editing `translator.py`.
