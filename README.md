# MPV Playlist Organizer

A browser extension to capture video streams (like M3U8/HLS), organize them into multiple playlists, and play them in the [MPV media player](https://mpv.io/) with a single click.



## Key Features

*   **Multi-Playlist Management**: Organize links into multiple, named playlists (called "folders").
*   **In-Page Controller UI**: A rich user interface injected directly into your web pages.
    *   **Draggable & Pinnable**: Move the UI anywhere on the screen and pin it in place.
    *   **Full & Compact Modes**: Switch between a detailed view with the playlist and a minimal view with essential controls.
    *   **Minimizable**: Hide the UI and bring it back via the extension popup or context menu.
*   **Automatic Stream Detection**: Automatically detects M3U8/HLS video streams as you browse.
*   **YouTube Support**: Directly add the current YouTube video page to a playlist.
*   **Resume Playback**: Remembers the last played video in each playlist and resumes from there.
*   **Context Menu Integration**: Right-click on links, videos, or pages to quickly add them to a folder.
*   **Command-Line Interface (CLI)**: Play your saved playlists directly from your terminal.
*   **Cross-Platform**: Works on Windows, macOS, and Linux.

---

## How It Works

This extension consists of two main parts:

1.  **The Browser Extension**: This is the user-facing part. It manages the UI, detects streams, and stores your playlists within the browser.
2.  **The Native Host**: A small Python script that runs on your computer. It acts as a bridge between the browser and your system. When you click "Play", the extension sends the playlist to this script, which then launches or controls MPV.

This separation is required because browser extensions, for security reasons, cannot directly run local applications like MPV.

---

## Installation

Installation is a multi-step process that involves setting up both the native host and the browser extension. Please follow these steps carefully.

### Prerequisites

1.  **MPV Media Player**: You must have MPV installed.
    *   **Windows**: Download from [mpv.io](https://mpv.io/installation/).
    *   **macOS/Linux**: Install via your package manager (e.g., `brew install mpv`, `sudo apt-get install mpv`). Ensure the `mpv` command is available in your system's PATH.

2.  **Python 3**: You must have Python 3 installed.
    *   **Windows**: Download from python.org. **Make sure to check "Add Python to PATH"** during installation.
    *   **macOS/Linux**: Usually pre-installed. You can check by running `python3 --version` in a terminal.

### Step 1: Download and Place the Project

1.  Download the project files (e.g., by clicking `Code -> Download ZIP` on GitHub).
2.  Unzip the archive.
3.  Move the resulting folder (`mpv-playlist-organizer-release`) to a **permanent location** on your computer. For example:
    *   Windows: `C:\Users\YourUser\Documents\Scripts\`
    *   macOS/Linux: `~/Documents/` or `~/.local/share/`

> **IMPORTANT**: Do not run the installer from your `Downloads` folder. The installation creates file paths that will break if you move the folder later. If you move it, you must run the installer again.

### Step 2: Load the Extension and Get its ID

1.  Open your Chromium-based browser (Chrome, Edge, Brave, etc.).
2.  Navigate to the extensions page: `chrome://extensions`
3.  Enable **Developer mode** using the toggle in the top-right corner.
4.  Click the **Load unpacked** button.
5.  Select the `mpv-playlist-organizer-release` folder that you placed in the permanent location.
6.  The extension will appear in your list. Find its **ID** (a long string of letters) and **copy it**.

### Step 3: Run the Native Host Installer

1.  Open a terminal or command prompt **inside the `mpv-playlist-organizer-release` folder**.
    *   **Windows**: In File Explorer, navigate into the folder, click the address bar, type `cmd`, and press Enter.
    *   **macOS/Linux**: Navigate to the folder using the `cd` command (e.g., `cd ~/Documents/mpv-playlist-organizer-release`).
2.  Run the installer script:
    ```sh
    python3 install.py
    ```
    (On Windows, you may just need to use `python install.py`)
3.  The script will prompt you to enter the **extension ID**. Paste the ID you copied in the previous step and press Enter.
4.  **Windows Users**: The script will try to find `mpv.exe`. If it can't, it will ask you to provide the full path to it (e.g., `C:\path\to\mpv.exe`).
5.  The script will confirm that it has registered the native host for your browsers.

### Step 4: Restart Your Browser

**This is a critical step!** You must **completely close and restart** your browser for it to recognize the new native host connection.

---

## Usage

### The Controller UI

Once installed, the controller UI will appear on pages where it detects a video stream.

*   **Status Banner**: Shows whether a stream has been detected. You can click and drag this banner to move the UI.
*   **Folder Select**: Choose which playlist you want to interact with.
*   **Add Button**: Adds the detected stream URL (or the current YouTube page URL) to the selected playlist.
*   **Play Button**: Sends the selected playlist to MPV. It will resume from the last played item.
*   **Clear Button**: Empties the selected playlist.
*   **UI Controls (Top Right)**:
    *   **Pin**: Locks the UI's position.
    *   **Full/Compact**: Toggles between the full view (with playlist) and a minimal view.
*   **Minimize Button (Top Left)**: Hides the UI.

### The Popup

Click the extension's icon in your browser's toolbar to open the popup.

*   **Create Folder**: Create a new, empty playlist.
*   **Remove Folder**: Select and delete an existing playlist.
*   **Show Controller**: If you've minimized the controller on the current page, this button will make it reappear.

### Context Menu

Right-click on any link, video, audio element, or the page itself. In the context menu, you will see an "Add to MPV Folder" option, allowing you to add the URL directly to any of your playlists.

### Command-Line (CLI) Usage

You can play a playlist directly from your terminal without opening the browser.

1.  Navigate to the project directory in your terminal.
2.  Run the command:
    ```sh
    # Replace <folder_name> with the name of your playlist (e.g., YT)
    python3 native_host.py play <folder_name>
    ```

This will launch MPV and play the specified list, respecting the last played position.

---

## Troubleshooting

*   **Error: "Could not connect to native host"**
    *   Did you **restart your browser** completely after running `install.py`? This is the most common cause.
    *   Did you copy the correct **Extension ID** into the installer?
    *   Did you move the project folder after installation? If so, you must run `install.py` again from the new location.
    *   Check for errors in the `native_host.log` file located in the project directory.

*   **The Controller UI doesn't appear on a page.**
    *   The UI only appears when a stream is detected or on a YouTube video page.
    *   The extension may not have permission to run on the current site. Check your extension settings.
    *   The UI will not appear on special browser pages (e.g., `chrome://...`) or the Chrome Web Store.

*   **The "Play" button does nothing, but there's no error.**
    *   Is MPV installed correctly?
    *   **On Windows**: Did you provide the correct path to `mpv.exe` during installation? You can edit the path in the `config.json` file and restart your browser.
    *   **On Linux/macOS**: Is the `mpv` command accessible from your terminal's PATH?

---

## Project Structure

*   `manifest.json`: Defines the extension's properties, permissions, and components.
*   `background.js`: The service worker; the brain of the extension. It manages state, handles all communication with the native host, and manages context menus.
*   `content.js` / `content.css`: The script and stylesheet for the in-page controller UI.
*   `popup.js` / `popup.html`: The code for the browser action popup window.
*   `native_host.py`: The Python script that receives messages from the extension and interacts with MPV.
*   `install.py`: The cross-platform installation script for the native host.
*   `folders.json`: (Generated) A file where your playlists are stored on disk, enabling CLI access.
*   `config.json`: (Generated on Windows) Stores the path to your `mpv.exe`.
*   `native_host.log`: (Generated) A log file for debugging the native host script.

---

## License

This project is open-source and available under the MIT License.

MIT License

Copyright (c) 2023

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.