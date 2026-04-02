# Site Compatibility System: Architecture & Concept

This document outlines the proposed architecture for a persistent, brand-based compatibility system designed to resolve network-level issues (such as FFmpeg reconnection loops) automatically for specific websites.

## 1. The Core Problem
Certain media sources (CDNs) used by websites are incompatible with aggressive reconnection headers (`demuxer-lavf-o` flags). When these flags are enabled, the player enters an infinite "Will reconnect" loop.
* **Challenge A:** CDNs often use rotating hostnames (e.g., `vault-11.cdn.com`, `vault-24.cdn.com`), making hostname-based blacklisting fragile.
* **Challenge B:** Manually toggling settings for every problematic video is a poor user experience.

## 2. The Solution: Brand-Based Predictive Mapping
Instead of reacting to specific stream URLs or hostnames, the system identifies the **Originating Website (Brand)** and applies a persistent configuration profile to all content from that source.

### Key Concept: The "Brand" Identity
The system extracts the primary brand from the `original_url` (the page where the user found the video).
* **Example:** `https://www.animeheaven.me/watch/ep1` -> Brand: `animeheaven`
* **Result:** Even if the site changes its TLD (`.me` to `.ru`) or rotates its CDN (`vault-11` to `vault-99`), the "Brand" remains the same.

## 3. Architecture Components

### A. Persistent Storage (`Site_Compatibility.json`)
A global JSON file that stores known site-specific overrides.
```json
{
  "animeheaven": {
    "enable_reconnect": false
  },
  "someothersite": {
    "enable_reconnect": false
  }
}
```

### B. Memory Cache (Backend)
At startup, the Python Native Host loads this file into an in-memory dictionary. This ensures that every "Pre-Launch" check has zero latency and doesn't require constant disk I/O.

### C. The Pre-Launch Injector
Whenever a video is prepared for playback (Enrichment Phase):
1. The system extracts the **Brand** from the `original_url`.
2. It queries the `Compatibility Cache`.
3. If a match is found, it **forces** the compatible settings (e.g., `enable_reconnect = false`) into the playback payload *before* the player even starts.

### D. Automated Discovery (Learning)
When the system detects a failure (like a reconnection loop) during active playback:
1. It applies an immediate "Hot Fix" to the current session.
2. It extracts the Brand from the current item.
3. It updates `Site_Compatibility.json` automatically.
4. **Outcome:** The system "learns" that the site is problematic and will never loop on that brand again.

## 4. Why This Works
1. **Zero Recurring Friction:** The user only experiences a loop once per brand. Every subsequent video from that brand—regardless of which folder it's in or when it's added—is fixed automatically.
2. **Resilience to Domain Changes:** By stripping TLDs and subdomains, the fix persists even if the website is moved or mirrored.
3. **Safety:** Fixes are scoped only to the problematic brand, ensuring that high-performance settings (like Auto-Reconnect) remain active for sites that support them (like YouTube).

## 5. Future Extensibility
The JSON structure allows for adding other compatibility flags as they are discovered:
* `http_persistent: false`
* `cache: false`
* `ytdl_format: "specific-format"`
