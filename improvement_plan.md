# MPV Playlist Organizer: Improvement Plan

This document outlines the strategic improvements identified to enhance the reliability, data integrity, and user experience of the extension, drawing inspiration from advanced architectural patterns while maintaining the project's lightweight design.

## 📈 Strategic Improvements

### 1. Robust Error Tracking & Granular Logging
- **Improvement:** Implement a **Diagnostic Collector** in both Python and JavaScript to accumulate specific issues during complex operations (migration, parsing) instead of generic failures.
- **Benefit:** Actionable feedback for corrupted data.

### 2. Structural Data Validation (Schema Layer)
- **Improvement:** Introduce a **Validation Guard** before any storage write. Verify UUID formats, URL protocols, and required fields.
- **Benefit:** Prevents storage poisoning and "broken state" crashes.

### 3. UI Input Constraints & Safety
- **Improvement:** Implement **Boundary Enforcement** on all UI inputs (64 chars for folders, 255 for titles). Add real-time character counts.
- **Benefit:** Protects database from bloated entries.

### 4. Proactive yt-dlp Security (Whitelisting)
- **Improvement:** Move from a **Blacklist** (blocking known bad flags) to a **Whitelist** (allowing only known safe flags).
- **Benefit:** Proactively protects against Remote Code Execution (RCE) via future yt-dlp updates.

### 5. Protocol & Scheme Safety
- **Improvement:** Enforce strict **URL Scheme Validation**. Only allow `http`, `https`, and `file` schemes.
- **Benefit:** Prevents "Protocol Smuggling" and malicious script execution via `javascript:` or `data:` URLs.

### 6. HTTP Header & Command-Line Hardening
- **Improvement:** 
    - Implement **Strict Header Formatting** (no commas/CRLF in values).
    - Enforce a **Command-Line Length Guard** (~7000 chars) to prevent launch failures on Windows.
- **Benefit:** Prevents header injection and ensures OS compatibility.

### 7. Sensitive Data Protection (Secure Permissions)
- **Improvement:** Explicitly set **Secure File Permissions** (`0o600`) for temporary cookie files.
- **Benefit:** Prevents other users on shared systems from accessing session cookies.

### 8. Frontend Hardening
- **Improvement:** 
    - Implement **Prototype Pollution Protection** in the storage layer.
    - Add a strict **Content Security Policy (CSP)** to `manifest.json`.
- **Benefit:** Enhances extension resilience against XSS and logic-manipulation attacks.

---

## 🛠️ Implementation Strategy

| Phase | Task | Primary Files |
| :--- | :--- | :--- |
| **Phase 1** | Boundary Enforcement (Point 3) | `popup.js`, `UIManager.js` |
| **Phase 2** | Security Hardening (Points 4, 5, 7) | `file_io.py`, `services.py`, `url_analyzer.py` |
| **Phase 3** | Validation & CSP (Points 2, 6, 8) | `storageManager.js`, `manifest.json`, `services.py` |
| **Phase 4** | Diagnostic Collector (Point 1) | `native_host.py`, `background.js` |

## 🚫 Out of Scope
- **psutil/3rd-party dependencies:** All logic must remain native Python to ensure ease of installation.
- **Content-Type Validation:** Discarded due to the 1-2s performance penalty per request.
- **Cloud AI / Cloud Persistence:** Project remains strictly local for privacy.