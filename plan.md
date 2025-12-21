# Plan for Implementing Sequential URL Playback with Per-URL Settings

The goal is to modify the extension to allow playing URLs one by one, with the ability to apply different settings (e.g., a bypass script) to each URL. This is a significant architectural change to move from a "playlist" model to a "single URL at a time" model with managed queuing.

## All TODOs Completed:

1.  **Modify `storageManager.js` to support per-URL settings.**
2.  **Modify `mpv_session.py` to play a single URL with settings.**
3.  **Modify `native_host.py` to handle single URL playback and settings.**
4.  **Modify `background.js` for sequential playback and per-URL settings orchestration.**
5.  **Implement bypass script execution in `native_host.py`.**

All planned changes have been implemented and Python files have been successfully compiled.