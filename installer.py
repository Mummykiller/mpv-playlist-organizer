#!/usr/bin/env python3
import sys
import os
import platform

# Prevent __pycache__ generation
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
sys.dont_write_bytecode = True

# --- Windows Console Hiding Logic ---
if sys.platform == "win32" and sys.executable.endswith("python.exe"):
    import subprocess
    # Re-launch with pythonw.exe to hide the console
    subprocess.Popen([sys.executable.replace("python.exe", "pythonw.exe"), __file__] + sys.argv[1:])
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
        # Launch the Tkinter GUI
        root = tk.Tk()
        app = HostManagerApp(root)
        root.mainloop()

if __name__ == "__main__":
    main()