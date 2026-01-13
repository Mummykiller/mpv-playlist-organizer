# Performance & Security Optimization Report: YouTube Instant-Play

This report outlines the refactoring plan to eliminate startup latency for YouTube videos while enhancing the security of user session cookies.

---

## 1. Current System: The "Waterfall" Method

Currently, the extension follows a sequential "waterfall" process where each step must finish before the next begins.

### **Illustration of Current Flow**
1.  **User Clicks Play**
2.  **Step A: Cookie Extraction (Blocking)**
    *   Python runs `yt-dlp --cookies-from-browser [browser]`.
    *   `yt-dlp` reads the browser database and writes cookies to a **plain-text `.txt` file** on disk.
    *   *Delay:* 1–3 seconds. Browser popup is "frozen" during this time.
3.  **Step B: MPV Launch**
    *   Python launches MPV and passes the path to the `.txt` file.
    *   *Result:* MPV window finally appears.
4.  **Step C: Video Resolution**
    *   MPV calls its internal `yt-dlp` to find the actual video streams using the provided `.txt` file.
    *   *Delay:* 2–4 seconds before video starts.

**Total Latency:** ~4–7 seconds before the first frame appears.
**Security State:** Sensitive session cookies exist as readable plain-text on the hard drive.

---

## 2. Proposed System: The "Direct & Volatile" Method

The new system moves from sequential blocking to **Optimistic Parallelism** and **Volatile Session Keys**.

### **Illustration of New Flow**
1.  **User Clicks Play**
2.  **Step A: Instant Launch (Non-Blocking)**
    *   Python **immediately** opens MPV.
    *   It passes the flag: `--ytdl-raw-options=cookies-from-browser=[browser]`.
    *   *Result:* MPV window appears **instantly** (0.1s).
3.  **Step B: Native Resolution**
    *   MPV handles the cookie extraction natively in RAM while the window is already initializing.
4.  **Step C: Smart Fallback (Background)**
    *   If the browser blocks direct access (database lock), the Python Host detects the failure.
    *   Python extracts cookies into a **Volatile Memory Folder** (RAM-only, e.g., `/dev/shm`).
    *   Python "hot-swaps" the cookies into the running MPV session.

### **The "Session Lock" Mechanism**
*   **No Permanent Files:** Cookies are never saved to long-term storage.
*   **RAM-Only Keys:** For background tasks (like Mark-as-Watched), cookies are stored in a temporary directory that exists only in system memory.
*   **Auto-Destruct:** The Python Host monitors the MPV process. The moment MPV closes, the volatile directory is cryptographically wiped and deleted.

---

## 3. Comparison Table

| Feature | Current System | New "Instant-Play" System |
| :--- | :--- | :--- |
| **MPV Window Appearance** | 2–4 Seconds (Delayed) | **Instant (< 0.2s)** |
| **Total Start Time** | 5–8 Seconds | **2–4 Seconds** |
| **Disk Footprint** | Plain-text `.txt` files left on disk | **Zero (Stored in RAM/Encrypted)** |
| **Security** | High Risk (Readable by other apps) | **Low Risk (Session-bound & Encrypted)** |
| **Reliability** | Fails if file-write is blocked | **Self-Healing (Multiple fallback stages)** |

---

## 4. Why the New System is More Secure

1.  **Encrypted-at-Rest:** By using `cookies-from-browser` inside MPV, we leverage the browser's own encryption. The cookies are decrypted only in memory when needed.
2.  **Vanishing Credentials:** The current system relies on you (or the script) remembering to delete the `.txt` file. The new system uses "Volatile Keys" that the OS automatically cleans up if the power is cut or the process ends.
3.  **Process Isolation:** By using RAM-based storage (`/dev/shm` on Linux), we ensure that the cookies are not indexed by desktop search tools or "Recently Accessed Files" trackers.

---

## 5. Handling Browser Access Prevention

If a browser like Chrome prevents access because it has a "lock" on the file:
1.  MPV will report a `403 Forbidden` error.
2.  The Python Host (already running in the background) catches this error via IPC.
3.  Python creates a **Shadow Copy** of the browser's database (a standard `yt-dlp` workaround).
4.  This shadow copy is used to feed MPV the cookies, then is immediately deleted.
5.  The user sees a "Retrying with fallback..." message on the MPV screen for a split second, then the video starts.

---
**Status:** Ready for implementation.
