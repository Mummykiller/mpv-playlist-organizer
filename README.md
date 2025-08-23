# MPV Playlist Organizer

A browser extension designed to capture video stream URLs (like M3U8) and YouTube links, organize them into persistent playlists, and play them directly in the [MPV media player](https://mpv.io/).

It features a draggable on-page UI, synchronization with a command-line interface, and robust controls for managing playback without leaving the browser.

![Screenshot of the UI] <img width="362" height="423" alt="image" src="https://github.com/user-attachments/assets/e13211c2-dd8a-49a4-ad49-c66c599734a6" /> <!-- Placeholder for a screenshot -->

## Features

- **Stream Detection**: Automatically detects M3U8 video streams and YouTube video pages.
- **Multi-Playlist Management**: Organize links into multiple, named playlists (called "folders").
- **Direct to MPV**: Sends the entire playlist to MPV with a single click.
- **Singleton Control**: Prevents multiple MPV instances from being launched by the extension.
- **Remote Close**: Close the running MPV instance directly from the extension's UI.
- **Saves Playback Position**: Leverages MPV's `save-position-on-quit` feature, even when closed remotely.
- **Draggable & Customizable UI**: The on-page controller can be moved, pinned, minimized, or switched to a compact mode. Its position and state are saved.
- **CLI Integration**: Includes a command-line interface to play your saved playlists directly from the terminal.
- **Data Sync**: Playlist data is stored in a local `folders.json` file, keeping the extension and CLI perfectly in sync.

## Limitations

- **M3U8 Stream Detection**: The extension's ability to detect M3U8 streams relies on standard web request patterns. Some websites, such as `https://hianime.to/`, use advanced methods like Blob URLs or DRM to serve video, which can prevent the extension from detecting the stream URL. In these cases, the controller UI will not indicate that a stream has been found.

---

## Installation

Installation is a multi-step process that involves installing the extension in your browser and running a setup script to allow the browser to communicate with MPV.

### Prerequisites

- **MPV Player**: You must have MPV installed on your system.
- **Python**: Python 3.6+ is required to run the installation script.

### Step 1: Download the Project

Download the latest release of this project from the Releases page and unzip it to a **permanent location** on your computer (e.g., your `Documents` or `home` folder).

> **Warning**
> Do not run the installer from your `Downloads` folder. The installation creates absolute paths to the scripts inside this folder. If you move or delete the folder later, the extension will stop working.

### Step 2: Install the Native Host

The native host is a script that acts as the bridge between your browser and MPV.

1.  Open a terminal or command prompt in the folder where you unzipped the project.
2.  Run the installer script:
    ```sh
    python3 install.py
    ```
    *(On Windows, you may just need to use `python` or double-click the `install.py` file).*

3.  The script will guide you through the process. It will ask for your **Extension ID**.

#### How to find your Extension ID:

-   **Chrome / Edge / Brave / Chromium**:
    1.  Go to your extensions page (e.g., `chrome://extensions`).
    2.  Enable **Developer mode**.
    3.  The ID will be visible on the extension's card after you load it in the next step. You will need to load it first, copy the ID, and then re-run the installer.

-   **Firefox**:
    1.  Go to `about:debugging`.
    2.  Click "This Firefox" on the left.
    3.  Find the extension and copy its **Internal UUID**.

The script will automatically detect your operating system and create the necessary manifest files in the correct browser configuration directories.

### Step 3: Load the Extension in Your Browser

This extension is loaded as an "unpacked" extension.

-   **Chrome / Edge / Brave / Chromium**:
    1.  Go to your extensions page (`chrome://extensions`).
    2.  Enable **Developer mode**.
    3.  Click **"Load unpacked"**.
    4.  Select the folder where you unzipped the project.

-   **Firefox**:
    1.  Go to `about:debugging`.
    2.  Click "This Firefox".
    3.  Click **"Load Temporary Add-on..."**.
    4.  Select the `manifest.json` file from the project folder.

### Step 4: Restart Your Browser

This is a crucial final step. **Completely close and restart your browser** for it to recognize the newly registered native messaging host.

---

## How to Use

### The Controller UI

Once installed, the controller UI will appear on web pages.

- **Status Banner**: Shows whether a stream has been detected. Click and drag the banner to move the UI.
- **Add**: Adds the detected stream URL or the current YouTube page URL to the selected playlist.
- **Play**: Sends the current playlist to MPV.
- **Clear**: Empties the current playlist.
- **Close MPV**: Gracefully closes the MPV instance that was launched by the extension.
- **Folder Dropdown**: Switch between your different playlists.
- **Popup Menu**: Use the extension's icon in the toolbar to create and remove folders.

### Command-Line Interface (CLI)

You can also play your saved playlists directly from your terminal.

1.  Navigate to the project directory in your terminal.
2.  Use the `play` command followed by the folder ID (which is case-sensitive).

**Example:**
```sh
# To play the playlist saved in the "YT" folder
python3 native_host.py play YT
```

## License

This project is open-source and available under the MIT License.
