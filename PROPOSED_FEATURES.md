# MPV Playlist Organizer - Proposed Features & Roadmap

This document outlines potential high-value features to further enhance the MPV Playlist Organizer experience. These are categorized by their impact on workflow, automation, and technical depth.

## 🕹️ 1. Direct Remote Control (IPC Expansion)
Currently, the controller manages the *list*, but active playback control happens in the MPV window.
*   **Direct Item Selection:** Click an item in the playlist UI to tell MPV to switch to that specific index immediately.
*   **Media Transport Controls:** Add Play/Pause, Next/Previous, and Mute buttons to the browser controller.
*   **Live Seek Bar:** A progress bar that polls MPV for the current time position and allows seeking from the browser.
*   **Volume Slider:** Control MPV's master volume directly from the tab.

## 🤖 2. Deep AniList Integration (Automation)
Move beyond just a "Release Feed" to a "Watching Manager."
*   **Auto-Update Progress:** Automatically increment your "Episodes Watched" count on AniList when MPV reaches 90% completion or exits with code 99.
*   **In-UI Rating:** A small 1-10 or star-rating widget that appears when a video finishes to submit your score to AniList.
*   **Status Sync:** Automatically move series from "Planning" to "Watching" when you play the first item in a folder.

## 📂 3. Playlist Power-User Tools
Enhancements for managing large (100+ item) folders.
*   **Instant Search/Filter:** A small text box at the top of the playlist to filter items by title in real-time.
*   **Bulk Actions:** A "Selection Mode" to move or delete multiple items simultaneously.
*   **Smart Sorting:** Buttons to sort by Date Added, Alphabetical, or "Natural Episode Sort" (detecting s01e01 etc.).
*   **Folder Metadata:** Assign custom icons or colors to specific folders for easier identification.

## ⚙️ 4. Advanced MPV Customization
*   **Per-Folder Profiles:** Define specific MPV flags or shaders for a specific folder (e.g., higher upscaling for "Anime," lower latency for "Live Streams").
*   **Subtitle/Audio Track Manager:** Dropdown menus in the browser UI to switch tracks without memorizing MPV keybinds.
*   **Screenshot Gallery:** A button to trigger a screenshot and a helper to open the screenshots folder immediately.

## 🎨 5. Visual Polish & UX
*   **Thumbnail Support:** Fetch and display small thumbnails for YouTube and supported oEmbed sites next to the title.
*   **"Up Next" Toasts:** A non-intrusive browser notification when MPV transitions to the next item in the playlist.
*   **Custom Themes:** Allow users to choose accent colors for the controller UI.

## ☁️ 6. Sync & Portability
*   **Cloud Settings Sync:** Use `chrome.storage.sync` to keep your preferences and keybinds consistent across different machines.
*   **Mobile Handoff:** Generate a QR code for the current stream URL to quickly open the video on a mobile device.
*   **Export to M3U8:** A button to download the current folder as a standard `.m3u8` file for use in other players.
