# Project Improvement Plan

## Current Status
- A local Git repository has been successfully initialized for the project.
- Initial project files have been committed to version control.
- Git user.name is set to "Shinku" locally.

## Areas for Improvement

### 1. Git Configuration
- **Objective:** Ensure consistent Git identity across all projects and prepare for remote repositories.
- **Action Items:**
    - [ ] Globally configure `user.name` and `user.email` for future projects. (Currently, it's only set locally for this project, or might default to global if already set).
    - [ ] Consider setting up a remote repository (e.g., GitHub, GitLab) for collaboration and backup, if applicable.

### 2. Modularity and Architecture
- **Objective:** Improve the project's overall structure, reduce complexity, enhance reusability, and enforce separation of concerns.
- **Action Items:**
    - [ ] **Refactor `background.js` (Service Worker):**
        - Break down the monolithic `background.js` into smaller, specialized modules (e.g., `storageService.js`, `nativeMessagingService.js`, `contextMenuManager.js`, `streamScannerBackground.js`, `playlistManagerBackground.js`).
        - Encapsulate `requestPromises` and `requestIdCounter` into a dedicated native messaging module.
        - Create a `config.js` or `constants.js` for centralizing magic numbers and intervals.
    - [ ] **Refactor `content.js` (Content Script):**
        - Break down the large `MpvController` class into more focused classes/modules (e.g., `UIManager`, `PlaylistUI`, `AniListUI`, `LogUI`, `Scraper`, `PreferenceManagerClient`).
        - Extract generic utility functions (e.g., `debounce`, `sendMessageAsync`, draggable/resizable logic) into a `utils.js` module.
        - Centralize modal creation and management logic into a dedicated `ModalService` or component factory.
    - [ ] **Refactor `native_host.py` (Native Host):**
        - Break down `native_host.py` into smaller Python modules (e.g., `mpvManager.py`, `fileManager.py`, `anilistService.py`, `ytdlpUpdater.py`, `nativeMessenger.py`, `cliHandler.py`).
        - Encapsulate global variables within a configuration object or pass them explicitly.
    - [ ] **Centralize Shared Styles:** Create a single, shared CSS file or use a CSS-in-JS approach for common variables and base styling used by both `content.css` and `popup.css` to reduce redundancy.
    - [ ] **View Management in `popup.js`:** Implement a more explicit view-switching mechanism (e.g., a simple router or state manager) rather than relying solely on `display: none` for the different popup views.

### 3. Code Quality and Maintainability
- **Objective:** Enhance code reliability, readability, and ease of maintenance.
- **Action Items:**
    - [ ] **Implement Unit Tests:** Develop unit tests for critical functions and modules across the entire project (e.g., `StorageManager` in `background.js`, `MpvSessionManager` in `native_host.py`, `scrapePageDetails` in `content.js`, AniList caching logic).
    - [ ] **Code Linting and Formatting:** Introduce linters (ESLint for JavaScript, Black/Flake8 for Python) and formatters (Prettier for JavaScript) to enforce consistent coding style and catch common errors.
    - [ ] **Error Handling & User Feedback:**
        - Provide more prominent UI notifications for critical issues like native host disconnections (beyond just logging).
        - Refine silent error catching (`.catch(() => {})`) in JavaScript to ensure no legitimate issues are inadvertently hidden.
        - Enhance `native_host.py`'s error feedback for `mpv_path` configuration and `yt-dlp` updates.
        - Implement more structured error objects/enums instead of magic strings for communication between modules (e.g., `addUrlToFolder` return values).
    - [ ] **Remove Redundancy:** Eliminate duplicated code blocks, especially in CSS files and event listener setups (e.g., drag-and-drop logic).
    - [ ] **Comprehensive Documentation:**
        - **Inline Documentation:** Add comprehensive JSDoc (for JavaScript) and Python docstrings to all functions, classes, and complex logic, explaining *what* they do, *why*, and their parameters/return values.
        - **README Enhancement:** Expand `README.md` with detailed setup instructions, usage guides, troubleshooting, and a developer-focused section.

### 4. Build and Deployment Automation
- **Objective:** Streamline the process of building, testing, and deploying the extension.
- **Action Items:**
    - [ ] **CI/CD Pipeline:** Set up a Continuous Integration/Continuous Deployment (CI/CD) pipeline (e.g., using GitHub Actions, GitLab CI) to automate testing, linting, and potentially packaging/deployment of the extension.

### 5. Performance Optimization
- **Objective:** Improve the responsiveness and efficiency of the browser extension and native host.
- **Action Items:**
    - [ ] **Profile Performance:** Use browser developer tools and Python profiling tools to identify and address bottlenecks in `background.js`, `content.js`, and `native_host.py`.
    - [ ] **Optimize Data Handling:** Review data serialization/deserialization and storage mechanisms for efficiency.
    - [ ] **Playlist Rendering:** For large playlists, consider implementing a diffing algorithm or virtualized list for `renderPlaylist` in `content.js` and `popup.js` to improve UI responsiveness.
    - [ ] **DOM Queries:** Cache frequently accessed DOM elements in `content.js` and `popup.js` to reduce repeated queries.
    - [ ] **`MutationObserver` Tuning:** Fine-tune `MutationObserver` parameters and `setInterval` polling frequency in `content.js` to reduce resource consumption on complex SPA pages.

### 6. Security Enhancements
- **Objective:** Ensure the extension operates with the minimal necessary permissions and robust safeguards.
- **Action Items:**
    - [ ] **Review `manifest.json` Permissions:** Investigate if `<all_urls>` permission can be narrowed down for `webRequest` or other features without breaking core functionality.
    - [ ] **Firefox `allowed_origins`:** For `moz-extension://*`, consider dynamically adding the specific Firefox extension ID if possible, for stricter security.

### 7. Cross-Platform Consistency & Robustness
- **Objective:** Improve the installer and native host's behavior across different operating systems.
- **Action Items:**
    - [ ] **`Installer.py` Error Handling:** Add explicit `messagebox.showerror` for critical failures (e.g., `mpv.exe` not found and user cancels).
    - [ ] **`native_host.py` IPC on Windows:** Investigate options for bidirectional IPC on Windows (e.g., using `pywin32`) to improve robustness of `is_process_alive` and other IPC-reliant features.
    - [ ] **`config.json` for Unix-like Systems:** Consider creating `config.json` (for `mpv_path`) on Linux/macOS as well, potentially allowing manual configuration, to align with Windows behavior and provide more explicit control.
    - [ ] **`yt-dlp` Update (Linux):** Provide clearer fallback instructions for manual updates if graphical sudo tools are unavailable or fail.

### 8. User Experience & UI Refinements
- **Objective:** Improve the usability, clarity, and visual feedback of the extension.
- **Action Items:**
    - [ ] **AniList UI Feedback:** Implement more explicit loading indicators and error messages within the AniList panel (both on-page and popup).
    - [ ] **"Add" Button State Clarity:** Enhance visual distinctions for "stream present", "URL in playlist", and "duplicate detected" states for the "Add" button across all UI contexts.
    - [ ] **Placeholder Images:** Implement fallback placeholder images for `anilist_renderer.js` when `cover_image` URLs are broken.
    - [ ] **UI Notifications:** Consider implementing a temporary, non-intrusive UI notification system (e.g., toast messages) for general status updates or less critical errors, complementing the log.
