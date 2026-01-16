# MPV Playlist Organizer - Product Roadmap

This document outlines high-value features grouped by their impact on the user experience and technical architecture.

## 🎮 1. Unified Remote Control & System Integration
Enhance the browser controller to feel like a native remote for the MPV process.
*   **Full Media Transport (IPC):** Add a seek bar (with time polling), volume slider, and Play/Pause/Mute controls directly to the browser UI.
*   **Discord Rich Presence:** Show the current video title, episode, and time remaining on your Discord profile via the native host.
*   **Global Media Keys:** Support for hardware Play/Pause/Next keys on your keyboard, even when the browser is minimized.
*   **Direct Item Selection:** Click any item in the browser playlist to force MPV to jump to that specific index immediately.

## 🧠 2. Intelligent Content Lifecycle (Automation)
Automate the "busy work" of managing watch history, metadata, and files.
*   **Deep AniList Automation:** 
    *   **Auto-Update Progress:** Increment your "Episodes Watched" count when MPV reaches 90% completion.
    *   **Rating & Status Sync:** Set a star rating in-UI after finishing a show and automatically move series from "Planning" to "Watching."
*   **AI Metadata Cleaning:** Use intelligent pattern matching (or local LLM) to rename messy website titles (e.g., "Watch Episode 5 HD...") into clean "Show Name - Episode 05" formats.

## 🚀 3. The "Bridge" Features (Unique Architecture Capabilities)
Features that are ONLY possible by bridging the Browser context with the Local Player.
*   **Infinite Autoplay (DOM-Aware):** When a video ends, the Extension scans the *live* browser page (YouTube "Up Next", Twitch "Raids") to intelligently queue the next video based on your visual context, bypassing generic API algorithms.
*   **The "Study Bridge" (Video-to-Notes):** Press a hotkey in MPV to instantly capture a screenshot + timestamp and inject it directly into your active browser-based notes app (Notion, Google Docs) via the Extension.
*   **Contextual Companion (Second Screen):** As MPV starts "Episode 5", the Extension automatically navigates a browser tab to the specific Reddit Discussion Thread or Wiki page for that episode.
*   **Drag-to-Archive (Web-to-Local):** Drag a streaming video item in the popup to a "Local Folder" zone to auto-download it and seamlessly hot-swap the playlist entry from the URL to the new local file.

## 📂 4. Power-User Organization & Productivity
Features designed for managing massive playlists and specific viewing conditions.
*   **Playlist Search & Filter:** A real-time search box at the top of the playlist to find specific episodes or channels instantly.
*   **Bulk Management:** A selection mode to move, delete, or export multiple items at once.
*   **Smart Sorting:** Advanced sort modes: Date Added, Alphabetical, and "Natural Episode Sort" (correctly ordering S1E2 before S1E10).
*   **Per-Folder Profiles:** Assign unique MPV flags or shaders to specific folders (e.g., "Ultra" profile for the "Anime" folder, but "Low Latency" for "Live Streams").

## ✨ 5. Modern UI & Visual Polish
Bringing the visual experience up to modern media player standards.
*   **Dynamic Thumbnails:** Fetch and display video thumbnails for YouTube and supported sites next to the titles.
*   **"Up Next" Feedback:** Non-intrusive browser toasts or animations when MPV transitions to the next item.
*   **Custom Theming:** A theme engine allowing users to choose accent colors, font sizes, and transparency levels for the on-page UI.
*   **Integrated Screenshot Gallery:** View and manage MPV screenshots directly within the browser dashboard.

## 🌐 6. Ecosystem, Sync & Portability
Ensuring your playlists and settings are available wherever you go.
*   **Cloud Settings Sync:** Use `chrome.storage.sync` to keep keybinds and preferences consistent across different browsers and machines.
*   **Network Casting:** Send your current browser playlist to a remote MPV instance on another device (Home Theater PC, Steam Deck, or Pi) over the local network.
*   **Mobile Handoff:** Generate a QR code for the current stream to quickly open the video on your phone or tablet.
*   **Standardized Exports:** One-click "Export to M3U8" to save your curated playlists for use in VLC or other standalone players.

## 📊 7. Analytics & Dashboard
*   **Watch History Heatmap:** A GitHub-style contribution graph showing which days you watched the most content.
*   **Format Distribution:** A pie chart showing your source breakdown (e.g., "60% YouTube, 30% Anime, 10% Twitch").
*   **Total Watch Time:** Aggregate statistics from the tracker's history.
