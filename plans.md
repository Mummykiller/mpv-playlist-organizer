# Project Improvement Plan

## Current Status
The project is a functional browser extension with a native host component for managing and playing media in MPV. It includes features like playlist management, on-page UI controls, AniList integration, and a Python-based installer. The current codebase is largely monolithic, presenting opportunities for significant architectural improvements.

## High-Level Objectives
1.  **Improve Modularity & Separation of Concerns:** Deconstruct monolithic files into smaller, single-responsibility modules to enhance readability, testability, and maintainability.
2.  **Enhance Code Quality & Consistency:** Introduce automated tooling and standardized practices to ensure the codebase is robust, predictable, and easy to navigate.
3.  **Strengthen Robustness & User Experience:** Improve error handling, cross-platform consistency, and UI feedback to create a more reliable and intuitive user experience.
4.  **Establish a Test & Deployment Strategy:** Implement a testing framework and CI/CD pipeline to automate quality checks and streamline the release process.

---

### Phase 1: Foundational Refactoring & Code Quality
This phase focuses on breaking down the largest files and establishing a baseline for code quality.

- **Action Items:**
    - **1. Deconstruct `background.js` (Service Worker):**
        - **Goal:** Isolate core functionalities into distinct modules.
        - **Modules:**
            - [x] `storageManager.js`: Encapsulate the existing `StorageManager` class and all data migration logic.
            - [x] `nativeConnection.js`: Manage the persistent connection to the native host, including `requestPromises`, `requestIdCounter`, and connection state.
            - [x] `contextMenu.js`: Handle creation and updates for all context menus.
            - [x] `playlistManager.js`: Contain logic for adding, removing, clearing, and reordering playlist items.
            - [x] `messageRouter.js`: The main entry point for `onMessage`, responsible for delegating actions to other services.
        - **Benefit:** Simplifies the main service worker file, making it easier to trace logic and add new features.

    - **2. Deconstruct `native_host.py`:**
        - **Goal:** Separate concerns within the Python host.
        - **Modules:**
            - [x] `mpv_session.py`: Isolate the `MpvSessionManager` class and all MPV process/IPC logic.
            - [x] `file_io.py`: Handle all interactions with the filesystem (`folders.json`, `config.json`, exports).
            - [x] `services.py`: Contain business logic for AniList caching, yt-dlp updates, and dependency checks.
            - [x] `cli.py`: House the `argparse` setup and all CLI command handlers.
            - [x] `native_host.py` (main): Becomes the lightweight entry point, handling the native messaging loop and delegating to other modules.
        - **Benefit:** Improves testability of individual components (e.g., testing `MpvSessionManager` without the messaging layer).

    - **3. Refactor `content.js` (`MpvController`):**
        - **Goal:** Break down the massive `MpvController` class.
        - **Modules/Classes:**
            - `UIManager.js`: Manage the lifecycle of the controller, stub, and AniList panel hosts (creation, injection, teardown).
            - `Draggable.js` / `Resizable.js`: Abstract the drag/resize logic into reusable utility classes that can be applied to any element.
            - `PlaylistUI.js`: Handle rendering and event binding specifically for the playlist view.
            - `AniListUI.js`: Manage the AniList panel's state, rendering, and event binding.
            - `PageScraper.js`: Centralize all page scraping logic, including the YouTube-specific rules.
        - **Benefit:** Makes the UI logic more component-oriented and easier to debug.

    - **4. Introduce Code Quality Tooling:**
        - **Goal:** Enforce a consistent and high-quality coding standard.
        - **Actions:**
            - [ ] **JavaScript:** Integrate **ESLint** (for error checking) and **Prettier** (for formatting). Configure them to run on commit or as part of a CI pipeline.
            - [ ] **Python:** Integrate **Black** (for formatting) and **Flake8** or **Ruff** (for linting).
        - **Benefit:** Automates code style, reduces trivial review comments, and catches common bugs early.

---

### Phase 2: Testing, CI/CD, and Documentation
With a more modular structure, this phase focuses on building a safety net and improving developer onboarding.

 - **Action Items:**
    - **1. Implement Unit & Integration Testing:**
        - **Goal:** Verify the correctness of core logic.
        - **JavaScript:** Use a framework like **Jest** or **Vitest**.
            - **Targets:** `storageManager.js` migrations, `PageScraper.js` logic for various URLs, utility functions.
        - **Python:** Use the built-in **`unittest`** or **`pytest`**.
            - **Targets:** `MpvSessionManager` state transitions, AniList caching logic, file I/O helpers.
        - **Benefit:** Catches regressions and validates complex logic in isolation.

    - **2. Set Up CI/CD Pipeline:**
        - **Goal:** Automate quality checks and build processes.
        - **Actions:**
            - [ ] Use **GitHub Actions** or a similar service.
            - [ ] Create a workflow that runs on every push/pull request to:
                - Install dependencies (JS & Python).
                - Run linters and formatters.
                - Execute all unit tests.
            - [ ] Add a separate workflow for creating a packaged `.zip` file for release.
        - **Benefit:** Ensures that no broken code is merged and simplifies the release process.

    - **3. Enhance Documentation:**
        - **Goal:** Make the project easy to understand, use, and contribute to.
        - **Actions:**
            - [ ] **Code Docs:** Add comprehensive JSDoc/Python docstrings to all public functions and classes, explaining their purpose, parameters, and return values.
            - [ ] **`README.md`:** Overhaul the README with:
                - Clear, step-by-step installation instructions for all OSes.
                - Detailed usage guide for all features.
                - A "Developer Guide" section explaining the project structure, build process, and how to contribute.
                - A comprehensive troubleshooting section for common issues (e.g., native host connection errors).

---

### Phase 3: Performance, UX, and Security Hardening
This phase focuses on refining the user-facing aspects of the extension and addressing potential performance and security issues.

- **Action Items:**
    - **1. Performance Optimization:**
        - **Goal:** Ensure the extension is fast and resource-efficient.
        - **Actions:**
            - [ ] **Playlist Rendering:** For `content.js` and `popup.js`, investigate virtual scrolling or list diffing for very large playlists to prevent UI lag.
            - [ ] **DOM Interaction:** Cache frequently accessed DOM elements in UI modules to reduce redundant queries.
            - [ ] **Observer Tuning:** Fine-tune `MutationObserver` in `content.js` to observe more specific targets/attributes, reducing its impact on SPA performance.

    - **2. User Experience (UX) Refinements:**
        - **Goal:** Make the UI more intuitive and informative.
        - **Actions:**
            - [ ] **Unified UI Components:** Create shared, reusable UI components (e.g., for modals, buttons) to ensure consistency between the popup and the on-page controller.
            - [ ] **Toast Notifications:** Implement a non-intrusive "toast" notification system for success messages (e.g., "URL Added") and non-critical errors, reducing reliance on the log panel.
            - [ ] **Installer GUI:** Improve `Installer.py` to automatically detect the extension ID (if installed) and provide more explicit feedback on success/failure.

    - **3. Security & Robustness:**
        - **Goal:** Harden the extension against potential issues.
        - **Actions:**
            - [ ] **Permissions Review:** Re-evaluate the `host_permissions` in `manifest.json`. Determine if `<all_urls>` is strictly necessary or if it can be narrowed to more specific patterns.
            - **Windows IPC:** Investigate using a library like `pywin32` in `native_host.py` to enable bidirectional IPC on Windows. This would make `is_process_alive` more reliable and allow for features like getting the current playback time.
            - **Error Handling:** Replace generic `try...catch (e)` blocks with more specific error handling that provides actionable feedback to the user.
