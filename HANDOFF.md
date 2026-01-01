The issue was caused by the `native_host` script deleting the MPV communication socket when it shut down (which happens when you restart the browser), even if the MPV player itself was still running. This prevented the extension from finding and reconnecting to the player when it started back up.

I have fixed this in `native_host.py`. Now, it checks if the MPV process is still running before cleaning up. If MPV is alive, the socket is preserved, allowing the extension to reconnect successfully after a restart.

**Note for Linux:**
You will need to restart the `native_host` for this change to take effect. Since the `native_host` is managed by the browser:
1.  **Restart your browser.**
2.  The fix will be active for subsequent restarts (i.e., if you restart the browser *again* after this, it should reconnect).