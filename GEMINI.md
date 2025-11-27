# GEMINI.md: Project mpv_playlist_organizer

## Project Overview

This project is a browser extension named "MPV Playlist Organizer" designed to capture video stream URLs (like M3U8 and YouTube links) from web pages, organize them into playlists, and play them in the MPV media player.

It features a two-part architecture:
1.  **Browser Extension (Frontend):** The user-facing component built with JavaScript, HTML, and CSS. It provides an on-page UI to manage playlists, detects stream URLs, and communicates with the native host.
2.  **Native Host (Backend):** A Python script that acts as a bridge between the browser and the local system. It is responsible for launching and controlling the MPV process, managing playlist files on disk, and handling other filesystem operations like importing/exporting.

The extension is designed to be loaded as an "unpacked" extension and requires a one-time setup using a Python-based installer.

### Key Technologies

*   **Browser Extension:** JavaScript (ES6+), HTML5, CSS3
*   **Native Host & Installer:** Python 3 (using only the standard library, with Tkinter for the installer GUI)
*   **MPV Integration:** A Lua script (`on_completion.lua`) is used to detect when a playlist finishes playing in MPV.
*   **Data Format:** JSON is used for configuration (`config.json`), playlists (`folders.json`), session management (`session.json`), and native messaging payloads.

### Core Components

*   `manifest.json`: Defines the browser extension's permissions, scripts, and capabilities.
*   `background.js`: The service worker acting as the extension's central controller. It manages state, handles all business logic, and orchestrates communication between the UI and the native host.
*   `content.js`: A content script injected into web pages to provide the on-page draggable UI for playlist management.
*   `popup.html` / `popup.js`: The UI and logic for the extension's toolbar popup, used for folder management and settings.
*   `native_host.py`: The backend Python script. It listens for commands from the browser via native messaging and also provides a command-line interface (CLI) for playing playlists.
*   `Installer.py`: A cross-platform GUI installer built with Python and Tkinter that sets up the native messaging host connection for various browsers.
*   `data/`: A directory created after installation to store all user data, including playlists (`folders.json`), logs, and configuration.

## Building and Running

This is an "unpacked" browser extension and does not have a traditional build step. The process involves running a Python installer and loading the project directory into the browser.

### Prerequisites

*   **Python 3.7+:** Required to run the installer.
*   **MPV Media Player:** Must be installed and ideally available in the system's PATH.
*   **yt-dlp:** Required by MPV for playing YouTube links. Must be installed and in the system's PATH.

### Installation & Running Steps

1.  **Download:** Download the project files to a permanent location.
2.  **Run Installer:** Execute the Python installer script:
    ```sh
    python Installer.py
    ```
    *   The installer now attempts to remember the last used Extension ID, pre-filling the input field for convenience.
    *   On Windows, if `mpv.exe` is not found, the installer will prompt you to select its path. An error will be shown if not selected.
    *   On Linux/macOS, the installer will prompt you to select the `mpv` executable path if it's not found in your system's PATH, and this path will be saved in `config.json` for future use.
3.  **Load Extension:**
    *   Open your browser's extension management page (e.g., `chrome://extensions`).
    *   Enable "Developer mode".
    *   Click "Load unpacked" and select the project directory.
4.  **Configure Native Host:**
    *   Copy the Extension ID from the browser.
    *   Paste the ID into the installer GUI and click "Install".
5.  **Restart Browser:** A full browser restart is required to complete the setup.

After these steps, the extension will be active.

### Command-Line Interface (CLI)

The native host script also provides a CLI for interacting with playlists from the terminal.

*   **List all folders:**
    ```sh
    python native_host.py list
    ```
*   **Play a folder:**
    ```sh
    python native_host.py play "My Playlist"
    ```

## Development Conventions

*   **State Management:** All application state (playlists, settings, UI preferences) is centralized into a single object in `chrome.storage.local`, managed by the `StorageManager` class in `background.js`.
*   **Communication:**
    *   Communication between the browser extension and the native host is done via standard I/O using the `chrome.runtime.connectNative` API. Messages are JSON objects.
    *   The `background.js` script acts as a message broker between UI components (content script, popup) and the native host.
*   **Data Persistence:**
    *   Browser-side state is stored using `chrome.storage.local`.
    *   Filesystem-side playlists (`data/folders.json`) are kept in sync via the native host. The `background.js` script debounces write operations to this file for efficiency.
*   **Modularity:** The code is organized by function. `background.js` handles logic, `content.js` handles the on-page UI, `popup.js` handles the popup UI, and `native_host.py` handles system interaction.
*   **Error Handling:** The native host logs errors and operational messages to `data/native_host.log`. The background script logs errors to the browser's service worker console and broadcasts important status messages to the UI. The `native_host.py` now provides clearer fallback instructions for `yt-dlp` updates on Linux when graphical `sudo` tools are unavailable.

## Gemini CLI Interaction

For instructions on how to gracefully exit a Gemini CLI session, including saving your work and generating a session summary, please refer to the `closechat.md` file.

To review the summary of your previous session, please refer to the `closedchat.md` file.
