# YouTube Tools — Feature Checklist

Mark any feature you want to add by putting an `x` inside `[]` (e.g. `[x]`).

## 1. Brave-Style Anti-Distraction & "Stop Pushing Content"
- [x] **Hide Home Feed Completely** — Turn the YouTube homepage into a clean search-only page (or redirect `/` directly to `/feed/subscriptions`).
- [x] **Hide "Up Next" / Related Sidebar** — Remove the recommended videos column next to the player on watch pages.
- [x] **Hide Comments Section** — Remove `#comments` below the video.
- [x] **Hide Live Chat** — Remove or auto-collapse the live chat panel on streams/premieres.
- [x] **Hide End-of-Video "More Videos" Wall** — Hide the end-screen recommendation grid when a video finishes.
- [x] **Hide Merch, Tickets, & Course Shelves** — Remove merch shelves, ticket/event promos, and "Courses" / "Podcasts" promos below videos.
- [x] **Hide "Breaking News", "Top News", & "Movies & TV" Shelves** — Remove editorial/promoted shelves on the home feed.
- [x] **Hide AI-Generated Video Summaries / "Ask" Button** — Hide YouTube's AI summary cards and AI chips below the player.
- [x] **Hide Info Cards (`i` button) & Channel Watermarks** — Remove `.ytp-cards-button` and `.iv-branding` overlays inside the player.
- [x] **Hide Search Filler Shelves** — Remove "People also watched", "For you", and "Previously watched" shelves in search results.
- [x] **Hide Extra Action Buttons** — Hide "Clips", "Thanks", "Download", and/or "Share" buttons below the video.
- [x] **Hide Explore / Trending / Shopping / Gaming in Sidebar** — Clean up the left navigation drawer.

## 2. Player & Viewing Comfort
- [x] **Disable Ambient Mode** — Turn off YouTube's glowing cinematics background behind the player.
- [x] **Disable Auto-Dubbing / Force Original Audio Track** — Prevent YouTube from auto-switching to AI-dubbed audio tracks.
- [x] **Codec Preference (Prefer VP9 / H.264 / AV1)** — Choose preferred video codec or disable AV1.
- [x] **Cinema / Dim-the-Lights Mode** — Darken everything outside the video player while watching.
- [x] **Screenshot Frame Button** — Add a camera button on the player bar to save a clean PNG of the current frame.
- [x] **Loop Video / A-B Section Loop** — Add a one-click loop toggle or A→B repeat markers on the player bar.
- [x] **Volume Boost (Amplifier)** — Gain boost (up to 200%–300%) for quiet videos + optional loudness normalization.
- [x] **Shift + Scroll Speed Control** — Hold `Shift` + mouse wheel over the player to adjust playback speed.
- [x] **Pause Other YouTube Tabs** — Automatically pause an active YouTube tab when another tab starts playing.
- [x] **Sticky / Floating Mini-Player on Scroll** — Keep the watch-page video floating in a corner when scrolling down to comments/description.
- [x] **Convert Shorts to Regular Watch Page** — Automatically redirect `/shorts/<id>` to `/watch?v=<id>` for full seekbar, speed, and quality controls.

## 3. Feed, Titles & Thumbnails
- [x] **Clean Clickbait Titles (De-ALL-CAPS)** — Normalize ALL-CAPS titles and strip excessive emojis/punctuation in feeds.
- [x] **Replace Thumbnails with Video Stills** — Swap custom clickbait thumbnails for actual video frames (`hq1`/`hq2`/`hq3`).
- [x] **Hide View Counts / Upload Dates / Subscriber Counts** — Reduce social-proof bias while browsing.
- [x] **Redirect Logo Click to Subscriptions** — Make clicking the YouTube logo go to `/feed/subscriptions` instead of Home.
- [x] **Compact Grid Density** — Force 4 or 5 videos per row on Home/Subscriptions.

## 4. Privacy & Quality of Life
- [x] **Strip Tracking Parameters (`?si=`, `&pp=`)** — Automatically clean YouTube URLs when copying or clicking Share.
- [x] **Prevent "Are you still watching?" Pause** — Auto-dismiss YouTube's idle confirmation popup during long sessions.
