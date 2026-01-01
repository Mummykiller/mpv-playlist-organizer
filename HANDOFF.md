# MPV Playlist Organizer - Session Handoff (Jan 1, 2026 - Turn 1)

## 📂 Recent Structural Changes
- **Searchable UI**: Settings now support `data-section-name` and `data-setting-name` attributes for live filtering.
- **Improved Settings Model**: Custom MPV flags are now stored as objects `{flag: string, enabled: boolean}` to allow toggling without deletion.

## 🛠 Features & Reworks Implemented

### 1. Advanced Networking Controls (✅ COMPLETED)
- **Master Override**: Added "Disable all overrides" toggle. When enabled, the extension stops passing custom buffer/cache/persistence flags, letting MPV use its native defaults.
- **HTTP Persistence**: Added a dedicated setting (Auto, Always On, Always Off). 
    - *Auto*: Uses site-specific stability logic (e.g., disabled for YouTube/Animepahe).
    - *Manual*: Forces connection reuse on or off globally.
- **Full Stack Sync**: Updated `services.py`, `mpv_session.py`, `adaptive_headers.lua`, and the Popup UI to respect these new toggles.

### 2. UI Precision & Alignment (✅ COMPLETED)
- **The 85% Rule**: All settings checkboxes and the new section reload icons are now perfectly aligned at **85% width from the left**.
- **Reload Icons**: Replaced the bulky "Force Reload Settings" button with subtle sync icons in every section header. 
- **Visual Feedback**: 
    - Reload icons spin and turn green during synchronization.
    - Keybind recorder pulses red while listening for input.
    - Search results are highlighted with a subtle blue background.

### 3. Settings Search & Navigation (✅ ADDED)
- **Search-to-Top**: Added a search bar at the top of the settings. Typing a keyword (e.g., "buffer") instantly pulls matching sections and individual settings to the top of the list.
- **Auto-Expansion**: Matching sections automatically expand during search.

### 4. Keybinding Overhaul (✅ ADDED)
- **Keybind Recorder**: Users no longer type combinations manually. A "Record" button now listens for the next keypress combo (e.g., `Ctrl+Shift+X`) and saves it in the correct format.
- **New Shortcut**: Added "Play Selected Playlist" keybind (default: `Shift+P`) to trigger playback from anywhere on the page.

### 5. MPV Flag Management (✅ OPTIMIZED)
- **Distinct Colors**: Custom flags are now **Blue**, and Automatic flags are **Green**.
- **Interactions**: 
    - Single-click: Toggle (Enable/Disable).
    - Double-click: Remove (Custom flags only).
- **Suggestions**: Added a datalist of common safe MPV flags to the input box.

### 6. Visual Button Differentiation (✅ ADDED)
- **Semantic Coloring**: 
    - **Export**: Blue (`--accent-export`).
    - **Import**: Teal (`--accent-import`).
    - **Open Folder**: Neutral Gray (`--accent-folder`).
- **Prominent Controls**: The "Show/Hide On-Page Controller" buttons now feature vibrant linear gradients and enhanced hover shadows to stand out as primary actions.

## 📂 Key Files Modified
... (omitted for brevity) ...

## 💡 Technical Implementation Notes (For the next agent)

### 1. The Search-to-Top Logic
- **Mechanism**: The search feature in `settings.js` does not hide elements. Instead, it calculates a "relevance score" for each section based on `data-section-name` and `data-setting-name` attributes. 
- **Reordering**: Sections are detached and re-appended to the `settings-sections-wrapper` using `appendChild` in order of their score. 
- **UX**: Matching sections are automatically set to `open=true` and given a `box-shadow` highlight.

### 2. UI Alignment (The "85% Rule")
- **Layout**: Checkboxes and reload buttons are vertically aligned using `position: absolute; left: 85%; transform: translateX(-50%);`.
- **Constraint**: The parent `.control-group` or `summary` must be `position: relative`. 
- **Safety**: Labels have a `max-width: 75%` and `text-overflow: ellipsis` to prevent collision with the absolute-positioned controls on small screens.

### 3. Keybind Recorder
- **Format**: Combinations are stored as standardized strings (e.g., `Ctrl+Shift+A`). 
- **Listening**: Uses a capture-phase `keydown` listener. It prevents default browser actions (like `Ctrl+S` saving the page) while the recorder is active.
- **Forbidden Keys**: Modifiers alone (`Shift`, `Alt`, etc.) do not trigger a save; it waits for a non-modifier key.

### 4. Custom MPV Flag Objects
- **Storage Change**: `custom_mpv_flags` was previously a string. It is now an **Array of Objects**: `[{ "flag": "--x", "enabled": true }, ...]`. 
- **Backend Compatibility**: `services.py` has been updated with a fallback to handle both the new list format and legacy strings seamlessly.

### 5. HTTP Persistence Logic
- **Precedence**: Site-specific overrides in `url_analyzer.py` (which set `disable_http_persistent: true`) are now **lowest priority**.
- **User Choice**: If the user selects "Always On" or "Always Off", that choice overrides the site recommendation.
- **Master Kill-switch**: If "Disable all overrides" is checked, **all** custom networking logic (including persistence) is skipped entirely.