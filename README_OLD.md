# 🎬 MPV Playlist Organizer

<div align="center">

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-2.6.0-blue)](https://github.com/Mummykiller/mpv-playlist-organizer/releases)
[![MPV](https://img.shields.io/badge/MPV-Player-purple)](https://mpv.io/)

**A powerful browser extension for capturing video streams and managing playlists with MPV**

[Quick Start](#-quick-start) • [Features](#-core-features) • [Installation](#-installation) • [Usage](#-usage-guide) • [CLI](#-command-line-interface)

</div>

---

## 📋 Overview

MPV Playlist Organizer is a browser extension that captures video stream URLs (M3U8, MPD) and YouTube links, organizes them into persistent playlists, and plays them directly in the [MPV media player](https://mpv.io/). Experience seamless video management with a draggable on-page UI, command-line interface synchronization, and robust playback controls—all without leaving your browser.

> **Development Note:** This extension was developed through human-AI collaboration, combining AI assistance with human direction and oversight.

### 📸 Screenshots

<div align="center">

| On-Page Controller | Popup Interface |
|:------------------:|:---------------:|
| ![On-Page Controller](images/big.png) | ![Popup Playlist](images/popup_controller.png) |

| AniList Integration | Settings Panel |
|:-------------------:|:--------------:|
| ![AniList Releases](images/anilist.png) | ![Settings View](images/Settings.png) |

</div>

---

## 🚀 Quick Start

Get up and running in 5 simple steps:

1. **📥 Download** — Get the latest release and unzip to a **permanent location**
2. **🔧 Install** — Run `installer.py` and follow the GUI prompts
3. **🧩 Load Extension** — Add the unpacked extension in your browser (`chrome://extensions`)
4. **🔗 Connect** — Copy the extension ID, paste it into the installer, and click "Install"
5. **♻️ Restart** — Completely restart your browser

📚 [Detailed installation instructions](#-installation)

---

## ✨ Core Features

### 🎯 Playback & Queue Management
- **Sequential Playback Queue** — Stack multiple videos to play consecutively in the same MPV instance
- **Session Restoration** — Reconnect to your MPV instance even after closing your browser
- **Per-Item Settings** — Apply individual settings to each video in your queue
- **Native M3U Support** — Generates M3U playlists including video names for robust metadata handling and playback stability

### 🎨 User Interface
- **Draggable On-Page Controller** — Floating UI that can be minimized to a small button
- **Popup Playlist Manager** — Quick access to playlists from the toolbar icon
- **Context Menu Integration** — Right-click any link or video to add it instantly
- **SPA Compatibility** — Works seamlessly on modern Single-Page Applications like YouTube

### 📂 Organization & Management
- **Multiple Playlists** — Create and manage unlimited playlist folders
- **Smart Title Scraping** — Automatically generates clean titles (e.g., `s01e05 - Show Name`)
- **Import/Export** — Backup playlists as JSON files
- **Drag & Drop Reordering** — Organize your queue with ease

### 🔧 Advanced Features
- **AniList Integration** — View today's airing anime in a draggable side-panel
- **Advanced Site Support** — Dynamic bypass scripts for sites requiring special headers
- **Customizable Keybindings** — Set global shortcuts for common actions
- **Terminal Mode** — Launch MPV with a visible console for debugging
- **Manageable Flags** — Enable/disable default MPV flags through settings

### 💻 Command-Line Interface
- **Terminal Support** — Full CLI for managing and playing playlists
- **Cross-Platform** — Works on Windows, Linux, and macOS
- **Session Management** — CLI sessions sync with browser extension

---

## 📦 Installation

### Prerequisites

Before installing, ensure you have:

| Requirement | Description |
|-------------|-------------|
| **Browser** | Chromium-based (Chrome, Edge, Brave) — *Firefox not supported* |
| **MPV Player** | [Download here](https://mpv.io/installation/) |
| **yt-dlp** | [Install guide](https://github.com/yt-dlp/yt-dlp) — Required for YouTube |
| **Python** | Python 3.7+ for installer and native host |

### Step-by-Step Guide

#### 1️⃣ Download the Project

Download the latest release from the **[Releases](https://github.com/Mummykiller/mpv-playlist-organizer/releases)** page and unzip it to a **permanent location** (e.g., `Documents` or home folder).

> ⚠️ **Important:** Do not install from your `Downloads` folder. The installer creates absolute paths—moving the folder later will break the extension.

#### 2️⃣ Run the Installer

Launch the installer GUI:

```bash
# macOS/Linux
python3 installer.py

# Windows
python installer.py
```

Or simply double-click `installer.py`.

The installer window allows you to:
- Enter your Extension ID
- Select your browser for bypass scripts
- Run diagnostics to verify setup

#### 3️⃣ Load the Extension

1. Navigate to `chrome://extensions` (or your browser's equivalent)
2. Enable **Developer Mode**
3. Click **"Load unpacked"**
4. Select the unzipped project folder
5. **Copy the Extension ID** that appears
6. Paste the ID into the installer and click **Install**

#### 4️⃣ Restart Your Browser

**Completely close and restart your browser** to register the native messaging host.

---

## 📖 Usage Guide

### Three Ways to Interact

| Interface | Description |
|-----------|-------------|
| **🖥️ On-Page Controller** | Main UI on web pages for adding URLs, playing, and clearing playlists. Minimizable to a small button. |
| **📱 Popup Menu** | Click the toolbar icon to view/manage playlists, create folders, adjust settings, and see anime releases. |
| **🖱️ Context Menu** | Right-click links, videos, or pages to quickly add them to your playlist. |

### Basic Workflow

1. **Browse** to a video streaming site
2. **Detect** — The extension automatically captures M3U8/MPD URLs
3. **Add** — Click the floating button or use the context menu
4. **Play** — Hit the play button to launch MPV
5. **Manage** — Organize into folders, reorder, or export playlists

---

## 💻 Command-Line Interface

### Setup

1. Open `installer.py`
2. Click **"Install CLI Wrapper"**
3. Click **"Add Folder to User PATH"** (Windows) or follow the manual instructions (Linux/macOS)

### Usage

Play a playlist named "My Watchlist":

```bash
mpv-cli "My Watchlist"
```

The CLI will:
- ✅ Locate the specified playlist
- ✅ Launch MPV with proper configuration
- ✅ Create a session controllable by the browser extension

### CLI Features

- 🔄 Sync with browser extension sessions
- 📝 Support for all playlist management operations
- 🎯 Direct playback without opening the browser

---

## ⚙️ How It Works

The extension uses a **two-component architecture**:

```mermaid
Browser Extension (UI) ↔️ Native Host (Python) ↔️ MPV Player
```

1. **Browser Extension** — Captures URLs and provides the user interface
2. **Native Host** — Python script that bridges browser and MPV
3. **MPV Player** — Handles actual video playback

This architecture enables powerful features like live playlist syncing, session persistence, and cross-platform support.

---

## ⚠️ Known Limitations

| Limitation | Details |
|------------|---------|
| **Absolute Paths** | Cannot move project folder after installation without reinstalling |
| **Browser Support** | Chromium-based browsers only (Firefox not supported) |
| **Single Instance** | Only one MPV instance can be managed at a time |
| **URL Detection** | Primarily captures M3U8/MPD streams and YouTube URLs |

---

## 🔧 Troubleshooting

<details>
<summary><strong>🔍 Dependency Verification</strong></summary>

**Issue:** Unsure if dependencies are configured correctly

**Solution:** Open `installer.py` and click **Run Diagnostics**. This checks for:
- ✅ MPV installation
- ✅ yt-dlp availability
- ✅ ffmpeg presence
- ✅ Browser cookie access

</details>

<details>
<summary><strong>🔌 Native Host Connection</strong></summary>

**Issue:** Log shows "Native host disconnected"

**Solution:**
1. **Completely restart your browser** after running the installer
2. Verify you haven't moved the project folder after installation
3. Check that the extension ID in `config.json` matches your browser

</details>

<details>
<summary><strong>🎬 MPV Launch Issues</strong></summary>

**Issue:** MPV doesn't launch when clicking Play

**Solution:**
- The installer should prompt for `mpv.exe` location if not found
- Manually set the path in `data/config.json`
- On Linux/macOS, ensure `mpv` is in your system `PATH`
- Run diagnostics to verify MPV detection

</details>

<details>
<summary><strong>📺 AniList Integration Problems</strong></summary>

**Issue:** AniList feature shows SSL errors

**Solution:**
- Common on corporate networks
- Place a certificate authority file named `ca.pem` in the `data` directory
- Contact your network administrator for the appropriate certificate

</details>

---

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

---

## 📄 License

This project is licensed under the **MIT License** — see the [LICENSE](https://opensource.org/licenses/MIT) file for details.

---

<div align="center">

**Made with ❤️ for the MPV community**

[⭐ Star on GitHub](https://github.com/Mummykiller/mpv-playlist-organizer) • [🐛 Report Bug](https://github.com/Mummykiller/mpv-playlist-organizer/issues) • [💡 Request Feature](https://github.com/Mummykiller/mpv-playlist-organizer/issues)

</div>
