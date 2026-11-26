#!/usr/bin/env python3
import sys
import os

# Prevent __pycache__ generation
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
sys.dont_write_bytecode = True

# --- Windows Console Hiding Logic ---
if sys.platform == "win32" and sys.executable.lower().endswith("python.exe") and "--cli" not in sys.argv:
    pythonw = os.path.join(os.path.dirname(sys.executable), "pythonw.exe")
    if os.path.isfile(pythonw):
        import subprocess
        # Re-launch with pythonw.exe to hide the console
        subprocess.Popen([pythonw, __file__] + sys.argv[1:])
        sys.exit(0)

# --- GUI Detection ---
GUI_AVAILABLE = True
try:
    import tkinter as tk
    from installer_src.installer_ui import HostManagerApp
except ImportError:
    GUI_AVAILABLE = False

from installer_cli import CommandLineApp

def main():
    # Priority 1: Force CLI if requested via argument or if TTY is detected without GUI
    force_cli = "--cli" in sys.argv or not GUI_AVAILABLE

    if force_cli:
        app = CommandLineApp()
        app.run()
    else:
        # Launch the Tkinter GUI; fall back to CLI if no display is available
        try:
            root = tk.Tk()
        except tk.TclError as e:
            print(f"GUI unavailable ({e}); falling back to CLI mode.", file=sys.stderr)
            app = CommandLineApp()
            app.run()
            return
        app = HostManagerApp(root)
        root.mainloop()

if __name__ == "__main__":
    main()
