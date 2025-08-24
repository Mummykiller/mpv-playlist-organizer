# MPV Playlist Organizer

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-1.0.0-blue)](https://github.com/Mummykiller/mpv-playlist-organizer/releases)
<!-- You can add more badges here, e.g. CI, downloads, etc. -->

A browser extension designed to capture video stream URLs (like M3U8) and YouTube links, organize them into persistent playlists, and play them directly in the [MPV media player](https://mpv.io/).

It features a draggable on-page UI, synchronization with a command-line interface, and robust controls for managing playback—all without leaving your browser.

![Screenshot of the UI](images/big.png)
<!-- Replace 'assets/screenshot.png' with the actual path to your screenshot -->

---

## Table of Contents

- [Why MPV Playlist Organizer?](#why-mpv-playlist-organizer)
- [Features](#features)
- [How It Works](#how-it-works)
- [Installation](#installation)
- [Usage Guide](#usage-guide)
- [Limitations](#limitations)
- [Contributing](#contributing)
- [Project Structure](#project-structure)
- [License](#license)

---

## Why MPV Playlist Organizer?

If you frequently watch content from various sources (live streams, video hosting sites, YouTube, etc.) and prefer the high-quality, resource-efficient playback of MPV, you’ve probably faced the tedious process of:

1. Finding a stream or video URL.
2. Copying it.
3. Opening a terminal.
4. Typing `mpv "..."`.
5. Repeating for every single video.

This extension streamlines your workflow. It acts as a bridge between your browser and your favorite media player, allowing you to build and play playlists on the fly—without ever leaving your browser.

---

## Features

- 🔍 **Automatic Stream Detection**: Finds M3U8 video streams and YouTube video pages automatically.
- 📂 **Multi-Playlist Management**: Organize links into multiple, named playlists (“folders”).
- 🚀 **Direct to MPV**: Send an entire playlist to MPV with a single click.
- 🔒 **Singleton Control**: Prevent multiple MPV instances from being launched by the extension.
- 🔌 **Remote Control**: Close the running MPV instance directly from the extension’s UI.
- 💾 **Saves Playback Position**: Leverages MPV’s `save-position-on-quit` feature, even when closed remotely.
- 🖐️ **Draggable & Customizable UI**: The on-page controller can be moved, pinned, minimized, or switched to compact mode. Its position and state are saved across sessions.
- 💻 **CLI Integration**: Includes a command-line interface to play your saved playlists directly from the terminal.
- 🔄 **Data Sync**: Playlist data is stored in a local `folders.json` file, keeping the extension and CLI in sync.

---

## How It Works

The extension consists of two main parts:

1. **The Browser Extension**:  
   This is the UI you see in your browser. It detects video URLs, manages your playlists in the browser’s local storage, and displays the on-page controller.
2. **The Native Host**:  
   This is a Python script running on your computer. Since browsers can’t start MPV directly for security reasons, the extension sends messages (like “play this playlist”) to the native host, which t[...]

This setup ensures a secure and powerful connection between your browser and your local system.

---

## Installation

Installation involves installing the browser extension and running a setup script to allow the browser to communicate with MPV.

### Prerequisites

- **MPV Player:**  
  You must have MPV installed. For easier command-line use, add its directory to your system’s PATH (not strictly required).

  <details>
    <summary>How to Add <code>mpv.exe</code> to Your PATH on Windows</summary>

    1. **Find your MPV folder:**  
       Locate where you extracted or installed `mpv.exe` (e.g., `C:\Tools\mpv\mpv.exe`).
    2. **Copy the folder path:**  
       Click the address bar in File Explorer, and copy the folder path (e.g., `C:\Tools\mpv`).
    3. **Open System Properties:**  
       - Press <kbd>Win</kbd> + <kbd>Pause/Break</kbd>, or  
       - Right-click “This PC” → Properties → Advanced system settings.
    4. **Edit Environment Variables:**  
       - Click “Environment Variables…”  
       - In the “System variables” section, scroll to Path and click “Edit…”  
       - Click “New” and paste the folder path you copied.
    5. **Apply and restart:**  
       - Click “OK” to save, then restart any command prompts or your PC for changes to take effect.

    You can now run `mpv` from any command prompt window.
  </details>

- **Python:**  
  Python 3.7+ is required to run the installation script.

---

### Step 1: Download the Project

Download the latest release from the **[Releases](https://github.com/Mummykiller/mpv-playlist-organizer/releases)** page and unzip it to a **permanent location** (e.g., your `Documents` or `home` folder).

> **⚠️ Do not run the installer from your `Downloads` folder.**  
> The installation creates absolute paths to the scripts. If you move or delete the folder later, the extension will stop working.

---

### Step 2: Run the Installer

The installer script configures your browser to communicate with the native host.

1. Open a terminal or command prompt in the folder where you unzipped the project.
2. Run the installer script:
    ```sh
    python3 install.py
    ```
    *(On Windows, you may need to use `python` or simply double-click `install.py`.)*

3. The script will prompt you for your **Extension ID** (next step).

---

### Step 3: Load the Extension & Get the ID

This extension is loaded as an “unpacked” extension.

1. Go to your browser’s extensions page (e.g., `chrome://extensions` or `about:addons`).
2. Enable **Developer Mode**.
3. Click **“Load unpacked”** (Chrome-based browsers) or **“Load Temporary Add-on...”** (Firefox, select `manifest.json`).
4. Select the folder where you unzipped the project.
5. The extension will now appear in your list. **Copy its ID.**

<details>
  <summary>Help finding the Extension ID</summary>

  - **Chrome / Edge / Brave / Chromium:**  
    The ID is a long string of letters on the extension’s card.
  - **Firefox:**  
    1. Go to `about:debugging`.  
    2. Click “This Firefox” on the left.  
    3. Find the extension and copy its **Internal UUID**.
</details>

---

### Step 4: Finish Installation

1. Return to your terminal where the installer script is waiting.
2. Paste the Extension ID you copied and press Enter.
3. The script will confirm creation of the necessary manifest files.

---

### Step 5: Restart Your Browser

**Completely close and restart your browser** for it to recognize the newly registered native messaging host.

---

## Usage Guide

### Browser Extension UI

Once installed, the controller UI will appear on web pages:

- **Status Banner:** Shows whether a stream has been detected. Click and drag to move the UI.
- **Add:** Adds the detected stream or current YouTube page URL to the selected playlist.
- **Play:** Sends the current playlist to MPV.
- **Clear:** Empties the current playlist.
- **Close MPV:** Gracefully closes the MPV instance launched by the extension.
- **Folder Dropdown:** Switch between different playlists (“folders”).
- **Popup Menu:** Use the extension’s browser toolbar icon to create/remove folders or access a mini-controller if the on-page UI is minimized.

### Command-Line Interface (CLI)

You can play your saved playlists directly from your terminal:

1. Navigate to the project directory in your terminal.
2. Use the `play` command followed by the folder name (case-sensitive).

**Example:**
```sh
# Play the playlist saved in the "YT" folder
python3 native_host.py play YT
```

---

## Limitations

- **M3U8 Stream Detection:**  
  The extension detects `.m3u8` stream URLs by listening for common network requests. However, many modern streaming sites use techniques to protect their videos, such as:
  - Obfuscated JavaScript (hiding the stream URL in complex code)
  - Blob URLs or WebSockets (serving video data in chunks without a direct URL)
  - Digital Rights Management (DRM)

On sites using these methods, the extension may be unable to find a playable URL. The status banner will continue to show “No stream detected.” This is a fundamental limitation; circumventing DRM or o[...]

---

## Contributing

This is a personal project, but contributions are welcome! If you have an idea for a new feature, found a bug, or want to improve the code:

1. **Open an Issue:**  
   Describe the bug or feature proposal.
2. **Discuss:**  
   We can refine the idea or bug report together.
3. **Fork and Submit a PR:**  
   Fork the repository, make your changes, and submit a pull request.

Please make sure your code is well-documented and tested. See the [Project Structure](#project-structure) section below for guidance.

---

## Project Structure

- `manifest.json` — Browser extension manifest.
- `install.py` — Installer script for native host setup.
- `native_host.py` — Python script implementing the native messaging host.
- `folders.json` — Stores playlist/folder data.
- `assets/` — Images, icons, and other assets.
- `src/` — Main extension source code (UI, logic, etc.).
- `README.md` — Project documentation (this file).

---

## License

This project is open-source and available under the [MIT License](https://opensource.org/licenses/MIT).
