/**
 * Shared defaults, quality presets, and UI schema for Shinku YouTube Tools.
 * Safe to load in both ISOLATED content scripts and extension popup pages.
 */
(function (root) {
  "use strict";

  const SHINKU_YT_DEFAULTS = {
    "frame-removal-settings": {
      "frame-removal": true,
      "live-removal": true,
      "shorts-removal": true,
      "streamed-removal": true,
      "upcoming-removal": true,
      "playables-removal": true,
      "mixes-removal": true,
      "members-removal": false,
      "posts-removal": false,
      "watched-removal": false,
      "search-filler-removal": false,
      "news-movies-removal": false,
      "blocked-keywords": ""
    },
    "distraction-settings": {
      "distraction-master": true,
      "hide-home-feed": false,
      "redirect-home-to-subs": false,
      "hide-related-sidebar": false,
      "hide-comments": false,
      "hide-live-chat": false,
      "hide-endscreen-wall": false,
      "hide-merch-tickets": false,
      "hide-ai-summaries": false,
      "hide-info-cards-watermarks": false,
      "hide-action-buttons": false,
      "hide-sidebar-explore": false
    },
    "video-player-settings": {
      "Video-settings": true,
      "button": true,
      "force-seek-to-saved": true,
      "pause": true,
      "progress-bar": true,
      "on-player-status": true,
      "quality-selection": "hd1080",
      "playback-speed": "off",
      "codec-preference": "off",
      "auto-theater": false,
      "disable-native-autoplay": false,
      "disable-ambient-mode": false,
      "disable-auto-dubbing": false,
      "cinema-mode": false,
      "sticky-mini-player": false,
      "pause-other-tabs": false,
      "prevent-idle-pause": false,
      "convert-shorts-to-watch": false,
      "hide-endscreens": false,
      "screenshot-btn": false,
      "loop-btn": false,
      "volume-boost-enable": false,
      "volume-boost-level": 150,
      "scroll-volume": true,
      "shift-scroll-speed": false,
      "seek-override": "2",
      "seek-override-enable": true,
      "shift-seek-override": "20",
      "shift-seek-override-enable": true
    },
    "thumbnail-title-settings": {
      "thumbnail-master": true,
      "hover-preview-guard": true,
      "hover-preview-delay": 3,
      "clean-clickbait-titles": false,
      "still-frame-thumbnails": false,
      "hide-social-counts": false,
      "compact-grid-density": false,
      "strip-tracking-params": false
    },
    "playlist-manager": {
      "playlist-manager": true,
      "auto-update-library": true,
      "auto-next": false,
      "thumbnail-bookmark-btn": true,
      "yt-dominant-on-youtube": false
    }
  };

  const SHINKU_YT_QUALITIES = [
    { value: "hd2160", label: "4K (2160p)" },
    { value: "hd1440", label: "2K (1440p)" },
    { value: "hd1080", label: "1080p" },
    { value: "hd720", label: "720p" },
    { value: "large", label: "480p" },
    { value: "medium", label: "360p" },
    { value: "small", label: "240p" },
    { value: "tiny", label: "144p" },
    { value: "off", label: "Off" }
  ];

  const SHINKU_YT_SPEEDS = [
    { value: "off", label: "Off" },
    { value: "0.5", label: "0.5x" },
    { value: "0.75", label: "0.75x" },
    { value: "1", label: "1x (Normal)" },
    { value: "1.25", label: "1.25x" },
    { value: "1.5", label: "1.5x" },
    { value: "1.75", label: "1.75x" },
    { value: "2", label: "2x" },
    { value: "2.5", label: "2.5x" },
    { value: "3", label: "3x" }
  ];

  const SHINKU_YT_CODECS = [
    { value: "off", label: "Auto (Default)" },
    { value: "vp9", label: "Prefer VP9 (Block AV1)" },
    { value: "h264", label: "Prefer H.264 (Block AV1 & VP9)" },
    { value: "av1", label: "Prefer AV1" }
  ];

  const SHINKU_YT_UI_SCHEMA = [
    {
      id: "frame-removal-settings",
      title: "Feed & Card Filtering",
      masterKey: "frame-removal",
      controls: [
        { key: "shorts-removal", label: "Hide Shorts", type: "toggle" },
        { key: "live-removal", label: "Hide Live Streams", type: "toggle" },
        { key: "streamed-removal", label: "Hide Streamed Videos", type: "toggle" },
        { key: "upcoming-removal", label: "Hide Upcoming Premieres", type: "toggle" },
        { key: "playables-removal", label: "Hide Playables", type: "toggle" },
        { key: "mixes-removal", label: "Hide Mixes & Radio Playlists", type: "toggle" },
        { key: "members-removal", label: "Hide Members-Only Videos", type: "toggle" },
        { key: "posts-removal", label: "Hide Community Posts & Polls", type: "toggle" },
        { key: "watched-removal", label: "Hide Already-Watched (90%+)", type: "toggle" },
        {
          key: "search-filler-removal",
          label: 'Hide Search Filler Shelves ("People also watched" / "For you")',
          type: "toggle"
        },
        { key: "news-movies-removal", label: "Hide Breaking News & Movies/TV Shelves", type: "toggle" },
        {
          key: "blocked-keywords",
          label: "Blocked Channels / Keywords",
          description: "Comma-separated words or channel names to hide",
          type: "text",
          placeholder: "e.g. clickbait, spoiler"
        }
      ]
    },
    {
      id: "distraction-settings",
      title: "Page Layout & Anti-Distraction",
      masterKey: "distraction-master",
      controls: [
        { key: "hide-home-feed", label: "Hide Home Feed Completely", type: "toggle" },
        { key: "redirect-home-to-subs", label: "Redirect Home / Logo Click to Subscriptions", type: "toggle" },
        { key: "hide-related-sidebar", label: 'Hide "Up Next" / Related Sidebar', type: "toggle" },
        { key: "hide-comments", label: "Hide Comments Section", type: "toggle" },
        { key: "hide-live-chat", label: "Hide Live Chat Panel", type: "toggle" },
        { key: "hide-endscreen-wall", label: 'Hide End-of-Video "More Videos" Wall', type: "toggle" },
        { key: "hide-merch-tickets", label: "Hide Merch, Tickets, & Course Shelves", type: "toggle" },
        { key: "hide-ai-summaries", label: 'Hide AI Summaries & "Ask" Button', type: "toggle" },
        { key: "hide-info-cards-watermarks", label: "Hide Info Cards (i) & Channel Watermarks", type: "toggle" },
        {
          key: "hide-action-buttons",
          label: "Hide Extra Action Buttons (Clips / Thanks / Download / Share)",
          type: "toggle"
        },
        {
          key: "hide-sidebar-explore",
          label: "Hide Explore / Trending / Shopping / Gaming in Sidebar",
          type: "toggle"
        }
      ]
    },
    {
      id: "video-player-settings",
      title: "Video Player & Playback",
      masterKey: "Video-settings",
      controls: [
        {
          key: "quality-selection",
          label: "Preferred Quality",
          type: "select",
          optionsKey: "SHINKU_YT_QUALITIES"
        },
        {
          key: "playback-speed",
          label: "Default Playback Speed",
          type: "select",
          options: SHINKU_YT_SPEEDS
        },
        {
          key: "codec-preference",
          label: "Codec Preference",
          type: "select",
          options: SHINKU_YT_CODECS
        },
        { key: "pause", label: "Auto-Pause on Open", type: "toggle" },
        { key: "force-seek-to-saved", label: "Fast Resume from Saved Time", type: "toggle" },
        { key: "auto-theater", label: "Auto-Theater Mode", type: "toggle" },
        { key: "disable-native-autoplay", label: "Keep YouTube Autoplay Off", type: "toggle" },
        { key: "disable-ambient-mode", label: "Disable Ambient Mode", type: "toggle" },
        { key: "disable-auto-dubbing", label: "Disable Auto-Dubbing / Force Original Audio", type: "toggle" },
        { key: "cinema-mode", label: "Cinema / Dim-the-Lights Mode", type: "toggle" },
        { key: "sticky-mini-player", label: "Sticky Floating Mini-Player on Scroll", type: "toggle" },
        { key: "pause-other-tabs", label: "Pause Other YouTube Tabs When Playing", type: "toggle" },
        { key: "prevent-idle-pause", label: 'Prevent "Are You Still Watching?" Pause', type: "toggle" },
        { key: "convert-shorts-to-watch", label: "Convert Shorts (/shorts/) to Regular Watch Page", type: "toggle" },
        { key: "hide-endscreens", label: "Hide End-Screen Cards", type: "toggle" },
        { key: "progress-bar", label: "Static Progress Bar", type: "toggle" },
        { key: "on-player-status", label: "On-Player Timestamp Badge", type: "toggle" },
        { key: "button", label: "Player Bookmark (+) Button", type: "toggle" },
        { key: "screenshot-btn", label: "Screenshot Frame Button", type: "toggle" },
        { key: "loop-btn", label: "Loop Video Toggle Button", type: "toggle" },
        { key: "volume-boost-enable", label: "Volume Boost (Amplifier)", type: "toggle" },
        {
          key: "volume-boost-level",
          label: "Volume Boost % (100-300)",
          type: "number",
          min: 100,
          max: 300,
          step: 25
        },
        { key: "scroll-volume", label: "Mouse Wheel Volume Control", type: "toggle" },
        { key: "shift-scroll-speed", label: "Shift + Scroll Wheel Speed Control", type: "toggle" },
        { key: "seek-override-enable", label: "Custom Arrow Key Seek", type: "toggle" },
        {
          key: "seek-override",
          label: "Arrow Seek Seconds",
          type: "number",
          min: 1,
          max: 300,
          step: 1
        },
        { key: "shift-seek-override-enable", label: "Custom Shift+Arrow Seek", type: "toggle" },
        {
          key: "shift-seek-override",
          label: "Shift+Arrow Seek Seconds",
          type: "number",
          min: 1,
          max: 600,
          step: 1
        }
      ]
    },
    {
      id: "thumbnail-title-settings",
      title: "Thumbnails, Titles & Links",
      masterKey: "thumbnail-master",
      controls: [
        { key: "hover-preview-guard", label: "Block Thumbnail Hover Auto-Play", type: "toggle" },
        {
          key: "hover-preview-delay",
          label: "Hover Delay Before Preview (sec)",
          type: "number",
          min: 0,
          max: 30,
          step: 0.5
        },
        { key: "clean-clickbait-titles", label: "Clean Clickbait Titles (De-ALL-CAPS)", type: "toggle" },
        { key: "still-frame-thumbnails", label: "Replace Thumbnails with Video Stills", type: "toggle" },
        { key: "hide-social-counts", label: "Hide View Counts, Upload Dates & Subscriber Counts", type: "toggle" },
        { key: "compact-grid-density", label: "Compact Grid Density (4-5 per Row)", type: "toggle" },
        { key: "strip-tracking-params", label: "Strip Tracking Parameters (?si=, &pp=)", type: "toggle" }
      ]
    },
    {
      id: "playlist-manager",
      title: "Watch Later / Library",
      masterKey: "playlist-manager",
      controls: [
        { key: "auto-update-library", label: "Auto-Update Saved Progress", type: "toggle" },
        { key: "auto-next", label: "Auto-Next in Library", type: "toggle" },
        { key: "thumbnail-bookmark-btn", label: "Quick-Save (+) on Thumbnails", type: "toggle" },
        {
          key: "yt-dominant-on-youtube",
          label: "Dominate YouTube Tabs (Icon & Default Tab)",
          description: "Switch toolbar icon to YouTube Tools and open its tab automatically on YouTube",
          type: "toggle",
          mainExtensionOnly: true
        }
      ]
    }
  ];

  root.SHINKU_YT_DEFAULTS = SHINKU_YT_DEFAULTS;
  root.SHINKU_YT_QUALITIES = SHINKU_YT_QUALITIES;
  root.SHINKU_YT_SPEEDS = SHINKU_YT_SPEEDS;
  root.SHINKU_YT_CODECS = SHINKU_YT_CODECS;
  root.SHINKU_YT_UI_SCHEMA = SHINKU_YT_UI_SCHEMA;
})(globalThis);
