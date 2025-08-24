# MPV Playlist Organizer

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A browser extension designed to capture video stream URLs (like M3U8) and YouTube links, organize them into persistent playlists, and play them directly in the [MPV media player](https://mpv.io/).

It features a draggable on-page UI, synchronization with a command-line interface, and robust controls for managing playback without leaving the browser.

!Screenshot of the UI

---

## Table of Contents

- Why MPV Playlist Organizer?
- Features
- How It Works
- Installation
- Usage Guide
- Limitations
- Contributing
- License

---

## Why MPV Playlist Organizer?

If you frequently watch content from various sources (like live streams, video hosting sites, or YouTube) and prefer the high-quality, resource-efficient playback of MPV, you've likely faced the tedious process of:

1.  Finding a stream or video URL.
2.  Copying it.
3.  Opening a terminal.
4.  Typing `mpv "..."`.
5.  Repeating for every single video.

This extension streamlines that entire workflow. It acts as a bridge between your browser and your favorite media player, allowing you to build and play playlists on the fly without ever leaving your web page.

## Features

-   🔍 **Automatic Stream Detection**: Finds M3U8 video streams and YouTube video pages automatically.
-   📂 **Multi-Playlist Management**: Organize links into multiple, named playlists (called "folders").
-   🚀 **Direct to MPV**: Sends an entire playlist to MPV with a single click.
-   🔒 **Singleton Control**: Prevents multiple MPV instances from being launched by the extension.
-   🔌 **Remote Control**: Close the running MPV instance directly from the extension's UI.
-   💾 **Saves Playback Position**: Leverages MPV's `save-position-on-quit` feature, even when closed remotely.
-   🖐️ **Draggable & Customizable UI**: The on-page controller can be moved, pinned, minimized, or switched to a compact mode. Its position and state are saved across sessions.
-   💻 **CLI Integration**: Includes a command-line interface to play your saved playlists directly from the terminal.
-   🔄 **Data Sync**: Playlist data is stored in a local `folders.json` file, keeping the extension and CLI perfectly in sync.

## How It Works

The extension consists of two main parts:

1.  **The Browser Extension**: This is the UI you see in your browser. It detects video URLs, manages your playlists in the browser's local storage, and displays the on-page controller.
2.  **The Native Host**: This is a Python script that runs on your computer. The browser can't start MPV directly for security reasons. The extension sends messages (like "play this playlist") to the Native Host, which is responsible for launching and controlling the MPV process. This communication happens via Native Messaging.

This setup ensures a secure and powerful connection between your browser and your local system.

---

## Installation

Installation is a multi-step process that involves installing the extension in your browser and running a setup script to allow the browser to communicate with MPV.

### Prerequisites

-   **MPV Player**: You must have MPV installed on your system and accessible from your command line (i.e., in your system's PATH).
- **Python**: Python 3.7+ is required to run the installation script.

How to Add mpv.exe to Your PATH on Windows
Find your MPV folder:
Locate where you extracted or installed mpv.exe (for example: C:\Tools\mpv\mpv.exe).

Copy the folder path:
Click the address bar in File Explorer where mpv.exe is located, and copy the folder path (e.g., C:\Tools\mpv).

Open System Properties:

Press <kbd>Win</kbd> + <kbd>Pause/Break</kbd>, or
Right-click "This PC" → Properties → Advanced system settings.
Edit Environment Variables:

Click "Environment Variables…"
In the "System variables" section, scroll to Path and click "Edit…"
Click "New" and paste the folder path you copied.
Apply and restart:
Click "OK" to save, then restart any command prompts or your PC for changes to take effect.

You can now run mpv from any command prompt window.

### Step 1: Download the Project

Download the latest release from the **Releases** page and unzip it to a **permanent location** on your computer (e.g., your `Documents` or `home` folder).

> [!WARNING]
> **Do not run the installer from your `Downloads` folder.**
> The installation creates absolute paths to the scripts inside this folder. If you move or delete the folder later, the extension will stop working.

### Step 2: Run the Installer

The installer script configures your browser to communicate with the native host script.

1.  Open a terminal or command prompt in the folder where you unzipped the project.
2.  Run the installer script:
    ```sh
    python3 install.py
    ```
    *(On Windows, you may need to use `python` or can simply double-click the `install.py` file).*

3.  The script will prompt you for your **Extension ID**. You will get this in the next step.

### Step 3: Load the Extension & Get the ID

This extension is loaded as an "unpacked" extension.

1.  Go to your browser's extensions page (e.g., `chrome://extensions` or `about:addons`).
2.  Enable **Developer Mode**.
3.  Click **"Load unpacked"** (on Chrome-based browsers) or **"Load Temporary Add-on..."** (on Firefox, selecting the `manifest.json` file).
4.  Select the folder where you unzipped the project.
5.  The extension will now appear in your list. **Copy its ID**.

<details>
<summary>Click here for help finding the Extension ID</summary>

-   **Chrome / Edge / Brave / Chromium**:
    The ID is a long string of letters on the extension's card.
    

-   **Firefox**:
    1.  Go to `about:debugging`.
    2.  Click "This Firefox" on the left.
    3.  Find the extension and copy its **Internal UUID**.
    

</details>

### Step 4: Finish the Installation

1.  Go back to your terminal where the installer script is waiting.
2.  Paste the Extension ID you copied and press Enter.
3.  The script will confirm that it has created the necessary manifest files.

### Step 5: Restart Your Browser

This is a crucial final step. **Completely close and restart your browser** for it to recognize the newly registered native messaging host.

---

## Usage Guide

### Browser Extension UI

Once installed, the controller UI will appear on web pages.

-   **Status Banner**: Shows whether a stream has been detected. Click and drag the banner to move the UI.
-   **Add**: Adds the detected stream URL or the current YouTube page URL to the selected playlist.
-   **Play**: Sends the current playlist to MPV.
-   **Clear**: Empties the current playlist.
-   **Close MPV**: Gracefully closes the MPV instance that was launched by the extension.
-   **Folder Dropdown**: Switch between your different playlists ("folders").
-   **Popup Menu**: Use the extension's icon in the browser toolbar to create and remove folders, or to access a mini-controller if the on-page UI is minimized.

### Command-Line Interface (CLI)

You can also play your saved playlists directly from your terminal.

1.  Navigate to the project directory in your terminal.
2.  Use the `play` command followed by the folder name (which is case-sensitive).




**Example:**
```sh
# To play the playlist saved in the "YT" folder
python3 native_host.py play YT
```

## Limitations  
M3U8 Stream Detection: The extension detects .m3u8 stream URLs by listening for common network request patterns. However, many modern streaming sites use sophisticated techniques to protect their video content, such as:

Obfuscated JavaScript: Hiding the stream URL in complex, hard-to-read code.
Blob URLs or WebSockets: Serving video data in chunks that don't have a simple, direct URL.
Digital Rights Management (DRM): Encrypting the video stream, which this extension cannot bypass.
On websites that use these methods, the extension may fail to find a playable URL, and the status banner will continue to show "No stream detected". This is a fundamental limitation, as circumventing these protections is often not possible or feasible for a browser extension.

## Contributing 

This is a personal project, but contributions are welcome! If you have an idea for a new feature, find a bug, or want to improve the code: + +1. Open an Issue: Describe the bug or feature proposal. +2. Fork the Repository: Create your own copy to work on. +3. Submit a Pull Request: Once your changes are ready, submit a PR for review. +



## License

This project is open-source and available under the MIT License.
