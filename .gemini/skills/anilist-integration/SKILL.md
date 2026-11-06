---
name: anilist-integration
description: >-
  Governs the AniList release tracking service, airing schedule panel, GraphQL client,
  and rendering components. Load this skill whenever modifying `anilist_releases.py`,
  `utils/anilist_service.py`, `background/handlers/dependency_anilist.js`,
  `utils/AniListUI.js`, `utils/anilist_renderer.module.js`, or the `#anilist-panel-host` UI.
---

# AniList Release Tracking & Schedule Architecture

This skill defines the AniList airing schedule pipeline, caching strategy, GraphQL query client, and dual-surface rendering (in-page draggable panel and extension popup tab).

---

## 1. System Architecture

The AniList integration provides live tracking of anime airing schedules and episode releases:

```
┌────────────────────────────────┐       ┌────────────────────────────────┐
│ UI: In-Page Panel & Popup Tab  │ <---> │ Background Coordinator         │
│ (AniListUI.js / anilist_rend.) │       │ background/handlers/dep_ani.js │
└────────────────────────────────┘       └────────────────────────────────┘
                                                        │
                                                        ▼
┌────────────────────────────────┐       ┌────────────────────────────────┐
│ GraphQL Client Script          │ <---> │ Cache Manager                  │
│ anilist_releases.py            │       │ utils/anilist_service.py       │
└────────────────────────────────┘       └────────────────────────────────┘
```

---

## 2. Backend Service & Caching (`anilist_service.py`)

Backend management is handled by `AniListCache` in `utils/anilist_service.py`:

- **Cache TTL:** 30 minutes (`CACHE_DURATION_S = 1800`). Fresh queries within 30 minutes are served directly from cache without network latency.
- **Cache File:** Persisted on disk at `data/cache_anilist_releases.json`.
- **Force Refresh:** Triggered via `force_refresh=True` to bypass cache when the user explicitly clicks the refresh button.
- **Ping Check:** Invoking `anilist_releases.py --ping` verifies network connectivity and API reachability without downloading large schedule payloads.

---

## 3. GraphQL Query Script (`anilist_releases.py`)

- Queries AniList's public GraphQL endpoint (`https://graphql.anilist.co`).
- Retrieves airing schedules filtered by time range (defaults to current day ± selected days).
- Extracts metadata: media title (romaji and english), episode number, airing time, countdown timer, cover image URL, banner image, and external streaming links.

---

## 4. UI Surfaces & Shadow DOM Presentation

### A. In-Page Floating Panel (`#anilist-panel-host`)

- Encapsulated inside an open Shadow Root attached to `document.body` (`#anilist-panel-host`).
- Managed by `utils/AniListUI.js`.
- Features:
  - Dragging and positioning via `utils/Draggable.js`.
  - Resizing via `utils/Resizable.js`.
  - Day-of-week navigation tabs (Sunday through Saturday).
  - Countdown timers showing hours/minutes until release.
  - Image cover height adjustment via `anilistImageHeight` setting.
  - Double-click to copy title to clipboard (`enableDblclickCopy`).
  - Panel attachment modes: can be docked adjacent to the MPV controller or unlocked as a free-floating widget (`lockAnilistPanel`, `forcePanelAttached`).

### B. Extension Popup Tab (`utils/anilist_renderer.module.js`)

- Embedded in the main extension popup window (`popup.html`).
- Renders identical release cards using `AniListRenderer` without needing a floating overlay wrapper.

---

## 5. Settings & User Preferences

AniList behaviors are configured via global settings:
- `anilistPanelVisible`: Toggle state for in-page display.
- `anilistImageHeight`: Height of cover image thumbnails (default: `126px`).
- `lockAnilistPanel`: Locks panel coordinates to prevent accidental dragging.
- `forcePanelAttached`: Keeps the panel tethered to the main controller.
- `enableDblclickCopy`: Enables quick copying of anime titles on double click.
