# MPV Playlist Organizer Settings Map

### **General Interface**
*   **Default UI Mode**: Choose how the on-page controller first appears (Full, Compact, or Minimized).
*   **Auto-focus Input**: Automatically focus the "Create new folder" box when opening the popup.
*   **Show Minimized Button**: Toggle the floating circular button shown when minimized.
*   **One-click Add**: Adds a top-level "Add to Last Used" option to the right-click menu.
*   **Double-click to Copy**: Copy playlist titles by double-clicking them.
*   **Show Copy URL Button**: Show a small icon to copy item URLs in the playlist.
*   **Popup Width**: Slider to adjust the extension window size (400px to 780px).

### **MPV Player**
*   **Preferred Quality**: Set target resolution for YouTube/Streams (4K down to 480p).
*   **Highlight active item**: Green border around the video currently playing in MPV.
*   **Add to Active Player**: Send new items directly to a running MPV instance.
*   **Remove from Active Player**: Sync item deletions with the running MPV instance.
*   **Clear on Completion**: Automatically wipe the playlist when finished (No, Yes, or Confirm).
*   **Advanced Flags** *(Sub-section)*:
    *   **Custom MPV Flags**: Manually add specific command-line arguments.
    *   **Automatic Internal Flags**: Toggle stability flags managed by the extension.

### **Integrations**
*   **YouTube Settings** *(Sub-section)*:
    *   **Use Cookies**: Use browser cookies for age-restricted or private videos.
    *   **Mark as Watched**: Automatically add played videos to your YouTube history.
    *   **Skip YouTube Analysis**: Faster adds by bypassing title/metadata scraping.
*   **AniList Integration** *(Sub-section)*:
    *   **Enable Integration**: Show airing schedules and tracking info.
    *   **Lock Panel**: Prevent the AniList panel from being moved.
    *   **Force Attached**: Snaps panel to the controller and hides it when minimized.
    *   **Attach on Open**: Automatically attach the panel when the controller is opened.
    *   **Cover Image Height**: Adjust the size of anime cover thumbnails.
*   **Content Scraper** *(Sub-section)*:
    *   **Auto-Scrape Links**: Toggle automatic detection of videos on non-YouTube pages.
    *   **Filter Words**: List of words to ignore when scanning for stream titles.

### **Keybindings**
*   **Add to Playlist**: (Default: `Shift+A`)
*   **Play Playlist**: (Default: `Shift+P`)
*   **Toggle Controller**: (Default: `Shift+S`)
*   **Switch Playlist**: (Default: `Shift+Tab`)
*   **Open Popup**: (Default: `Alt+P`)

### **Networking & Performance**
*   **Networking** *(Sub-section)*:
    *   **Disable Overrides**: Force MPV to use your local `mpv.conf` network settings.
    *   **Persistent Connections**: Control HTTP persistence (Auto, On, Off).
    *   **Enable Cache**: Toggle the demuxer cache.
*   **Performance Profiles** *(Sub-section)*:
    *   **Profile**: Presets for Low, Medium, High, or Ultra quality.
    *   **Hardware Decoder**: Select specific GPU decoding (Auto, NVDEC, VAAPI, etc.).
*   **Buffering (Advanced)** *(Sub-section)*:
    *   **Cache Size, Back Buffer, Readahead, Buffer Size**: Granular control over streaming memory.
    *   **Concurrent Fragments**: Number of parallel threads for `yt-dlp` downloads.
    *   **Enable Reconnect**: Automatically try to resume interrupted streams.

### **Safety & Confirmations**
*   **Confirm Delete Folder**: Ask before deleting a folder.
*   **Confirm Clear Playlist**: Ask before wiping a playlist.
*   **Confirm Close MPV**: Ask before terminating the player.
*   **Confirm 'Play New'**: Ask before launching a second instance.
*   **Confirm Folder Switch**: Ask when playing a folder if one is already active.
*   **Duplicate URLs**: Define behavior for repeating links (Ask, Always, Never).

### **Diagnostics & Dependencies**
*   **Status**: Real-time check for Native Host, MPV, yt-dlp, FFmpeg, and Node.js.
*   **Refresh**: Button to force-recheck system requirements.
