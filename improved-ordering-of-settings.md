# MPV Playlist Organizer Settings

## 🎨 Appearance & Interface

### Main Controller
- **UI Mode on Startup**: How the controller appears when first opened (Full / Compact / Minimized)
- **Window Width**: Adjust extension window size (400px - 780px)
- **Show Minimized Button**: Display floating circular button when minimized

### Quick Actions
- **Auto-focus New Folder Input**: Automatically select the folder creation field
- **One-click "Add to Last Used"**: Quick-add option in right-click menu
- **Double-click to Copy Title**: Copy playlist names by double-clicking
- **Show Copy URL Button**: Display URL copy icon for playlist items

---

## ▶️ Playback & Player

### MPV Behavior
- **Video Quality**: Target resolution (4K / 1440p / 1080p / 720p / 480p)
- **Highlight Currently Playing**: Green border around active video
- **Hardware Decoder**: GPU acceleration (Auto / NVDEC / VAAPI / DXVA2 / etc.)

### Active Player Sync
- **Add to Running Player**: Send new items to active MPV instance
- **Remove from Running Player**: Sync deletions with active player
- **Auto-clear on Finish**: Wipe playlist when complete (No / Yes / Ask First)

### Advanced Player Options
- **Custom MPV Flags**: Manual command-line arguments
- **Auto-managed Flags**: Extension stability optimizations

---

## 🌐 External Services

### YouTube
- **Use Browser Cookies**: Access age-restricted/private videos
- **Mark Videos as Watched**: Add to YouTube watch history
- **Skip Title Analysis**: Faster adding (uses generic titles)

### AniList Anime Tracking
- **Enable Integration**: Show airing schedules and episode tracking
- **Panel Behavior**:
  - Lock Panel Position
  - Force Attach to Controller
  - Auto-attach on Open
- **Cover Image Size**: Adjust anime thumbnail height

### Website Video Detection
- **Auto-detect Videos**: Scan pages for streamable content
- **Filter Keywords**: Ignore titles containing these words

---

## ⚙️ Performance & Streaming

### Quality Presets
- **Performance Profile**: Low / Medium / High / Ultra

### Network Settings
- **Use Local Config**: Override with your `mpv.conf` settings
- **HTTP Persistence**: Keep connections alive (Auto / On / Off)
- **Enable Stream Cache**: Toggle demuxer caching

### Advanced Buffering
- **Cache Size**: Total memory for buffering
- **Back Buffer**: How much to keep behind playhead
- **Read-ahead Buffer**: How much to load ahead
- **Buffer Chunk Size**: Download segment size
- **Parallel Downloads**: Concurrent fragment threads
- **Auto-reconnect**: Resume interrupted streams

---

## ⌨️ Keyboard Shortcuts

- **Add to Playlist**: `Shift+A`
- **Play Playlist**: `Shift+P`
- **Show/Hide Controller**: `Shift+S`
- **Switch Playlist**: `Shift+Tab`
- **Open Popup**: `Alt+P`

---

## 🛡️ Confirmations & Safety

### Ask Before:
- Deleting a folder
- Clearing entire playlist
- Closing MPV player
- Playing while another instance is active
- Switching folders during playback

### Duplicate URLs
- Behavior when adding the same link twice (Ask / Always Allow / Never Allow)

---

## 🔧 System Status

### Dependencies Check
Real-time status for:
- Native Host Connection
- MPV Player
- yt-dlp (YouTube downloader)
- FFmpeg (media processor)
- Node.js

**Refresh Button**: Re-check all components
