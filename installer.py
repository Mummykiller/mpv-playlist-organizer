#!/usr/bin/env python3
import sys
import os

os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
sys.dont_write_bytecode = True

import re
# --- Windows Console Hiding Logic ---
# This block checks if the script is running on Windows with the standard 'python.exe'
# interpreter. If so, it re-launchs itself using 'pythonw.exe' (the windowless version)
# and exits. This prevents a console window from appearing behind the GUI.
if sys.platform == "win32" and sys.executable.endswith("python.exe"):
    import subprocess
    # Re-launch with pythonw.exe and pass along any command-line arguments.
    subprocess.Popen([sys.executable.replace("python.exe", "pythonw.exe"), __file__] + sys.argv[1:])
    sys.exit(0)

import json
import subprocess
import shutil
import platform
import threading
import queue
import services
import file_io
import installer_logic
from installer_logic import (
    HOST_NAME, HOST_DESCRIPTION, SCRIPT_NAME, INSTALL_DIR, DATA_DIR, CONFIG_FILE,
    WindowsLogic, LinuxLogic, MacOSLogic, UnixLogic
)
from installer_cli import CommandLineApp

# --- GUI Imports with Fallback ---
GUI_AVAILABLE = True
try:
    import tkinter as tk
    from tkinter import ttk, scrolledtext, messagebox, filedialog
except ImportError:
    GUI_AVAILABLE = False

# --- Platform-specific imports ---
if platform.system() == "Windows":
    import winreg

# --- Centralized Font Configuration ---
MODERN_FONT = ("Segoe UI", "Roboto", "Ubuntu", "Helvetica Neue", "Arial")
MONO_FONT = ("Consolas", "Monaco", "DejaVu Sans Mono", "monospace")

# --- Tooltip Class for detailed explanations ---
class Tooltip:
    """
    Creates a tooltip for a given widget.
    """
    def __init__(self, widget, text):
        self.widget = widget
        self.text = text
        self.tooltip_window = None
        self.widget.bind("<Enter>", self.show_tooltip)
        self.widget.bind("<Leave>", self.hide_tooltip)

    def show_tooltip(self, event=None):
        # Don't show tooltip if the widget is disabled
        if str(self.widget['state']) == 'disabled':
            return

        x, y, _, _ = self.widget.bbox("insert")
        x += self.widget.winfo_rootx() + 25
        y += self.widget.winfo_rooty() + 25

        self.tooltip_window = tw = tk.Toplevel(self.widget)
        tw.wm_overrideredirect(True)
        tw.wm_geometry(f"+{x}+{y}")

        label = tk.Label(tw, text=self.text, justify=tk.LEFT,
                         background="#ffffe0", relief=tk.SOLID, borderwidth=1,
                         font=("Segoe UI", 9, "normal"))
        label.pack(ipadx=4, ipady=2)

    def hide_tooltip(self, event=None):
        if self.tooltip_window:
            self.tooltip_window.destroy()
        self.tooltip_window = None

# --- GUI Application Class ---
class HostManagerApp:
    def __init__(self, root):
        self.root = root
        self.root.title("MPV Playlist Organizer - Host Manager")
        self.log_queue = queue.Queue()

        self._setup_ui()

        self.root.resizable(False, False)

        # --- Center the window on the screen ---
        window_width = 640
        window_height = 600
        # Get screen dimensions
        screen_width = self.root.winfo_screenwidth()
        screen_height = self.root.winfo_screenheight()
        # Calculate position x, y
        center_x = int(screen_width / 2 - window_width / 2)
        center_y = int(screen_height / 2 - window_height / 2)
        self.root.geometry(f'{window_width}x{window_height}+{center_x}+{center_y}')

        # --- Initialize Logic ---
        self.logic = self._get_logic_strategy()

        # --- Start Log Poller ---
        self.root.after(100, self._process_log_queue)

        # --- Initial Dependency Check ---
        self.root.after(200, self._check_dependencies_async)

    def _get_logic_strategy(self):
        system = platform.system()
        ask_file_func = self._ask_file_path_sync
        ask_dir_func = self._ask_directory_sync
        if system == "Windows":
            return WindowsLogic(self.log, ask_file_func, ask_dir_func)
        elif system == "Linux":
            return LinuxLogic(self.log, ask_file_func, ask_dir_func)
        elif system == "Darwin":
            return MacOSLogic(self.log, ask_file_func, ask_dir_func)
        else:
            self.log(f"Unsupported platform: {system}")
            return UnixLogic(self.log, ask_file_func, ask_dir_func) # Fallback

    def _ask_file_path_sync(self, title, filetypes):
        q = queue.Queue()
        def _ask():
            path = filedialog.askopenfilename(title=title, filetypes=filetypes, parent=self.root)
            q.put(path)
        self.root.after(0, _ask)
        return q.get()

    def _ask_directory_sync(self, title):
        q = queue.Queue()
        def _ask():
            path = filedialog.askdirectory(title=title, parent=self.root)
            q.put(path)
        self.root.after(0, _ask)
        return q.get()

    def _setup_ui(self):
        # --- Styles ---
        bg_color = "#f8f9fa"
        self.root.configure(bg=bg_color)

        style = ttk.Style()
        style.theme_use('clam')

        # Increased base font size and weight
        style.configure(".", background=bg_color, font=("Segoe UI", 11, "normal"))
        style.configure("TFrame", background=bg_color)
        style.configure("TLabel", background=bg_color)
        style.configure("TCheckbutton", background=bg_color)

        style.configure("TButton", padding=8, relief="flat", background="#5865f2", foreground="white", borderwidth=0, font=("Segoe UI", 11, "bold"))
        style.map("TButton", background=[('active', '#4f5bda'), ('disabled', '#cccccc')])

        style.configure("Uninstall.TButton", background="#ed4245", font=("Segoe UI", 11, "bold"))
        style.map("Uninstall.TButton", background=[('active', '#da3739')])

        style.configure("Header.TLabel", font=("Segoe UI", 18, "bold"), foreground="#2c2f33")

        # --- Main Frame ---
        main_frame = ttk.Frame(self.root, padding="25")
        main_frame.pack(fill=tk.BOTH, expand=True)

        # --- Header ---
        ttk.Label(main_frame, text="MPV Playlist Organizer", style="Header.TLabel").pack(pady=(0, 20))

        # --- Settings Frame (using Grid layout for alignment) ---
        settings_frame = ttk.Frame(main_frame)
        settings_frame.pack(fill=tk.X, pady=(0, 10))
        settings_frame.columnconfigure(1, weight=1) # Make the input column expandable

        # --- Row 0: Extension ID ---
        ttk.Label(settings_frame, text="Extension ID:", font=("Segoe UI", 11, "bold")).grid(row=0, column=0, sticky=tk.W, pady=4)

        id_input_frame = ttk.Frame(settings_frame)
        id_input_frame.grid(row=0, column=1, sticky="ew", padx=(10, 0))
        id_input_frame.columnconfigure(0, weight=1)

        self.extension_id_var = tk.StringVar()
        self.extension_id_entry = ttk.Entry(id_input_frame, textvariable=self.extension_id_var, font=("Segoe UI", 11))
        self.extension_id_entry.grid(row=0, column=0, sticky="ew")

        self.detect_id_btn = ttk.Button(id_input_frame, text="Detect", command=self.run_detect_id, width=7)
        self.detect_id_btn.grid(row=0, column=1, sticky=tk.E, padx=(5, 0))
        Tooltip(self.detect_id_btn, "Automatically find the Extension ID for the selected browser")

        # --- Row 1: Enable URL Analysis Option ---
        bypass_label = ttk.Label(settings_frame, text="Advanced URL Analysis:", font=("Segoe UI", 11, "bold"))
        bypass_label.grid(row=1, column=0, sticky=tk.W, pady=4)

        self.create_bypass_var = tk.BooleanVar(value=False) # Default to False, will be loaded from config
        self.bypass_checkbutton = ttk.Checkbutton(
            settings_frame,
            variable=self.create_bypass_var
        )
        self.bypass_checkbutton.grid(row=1, column=1, sticky=tk.W, padx=(10, 0))

        tooltip_text = (
            "🔓 ENABLE ADVANCED URL ANALYSIS\n\n"
            "What this does:\n"
            "- Uses yt-dlp to resolve difficult stream URLs (e.g. AnimePahe).\n"
            "- Automatically applies site-specific security headers.\n"
            "- READS browser profiles to find cookies for the selected browser.\n\n"
            "Privacy Note: This strictly accesses local browser data to authorize \n"
            "video playback. No data is sent to external servers except the streaming site."
        )
        Tooltip(bypass_label, tooltip_text)
        Tooltip(self.bypass_checkbutton, tooltip_text)

        # --- Row 2: Enable YouTube Analysis Option ---
        yt_bypass_label = ttk.Label(settings_frame, text="YouTube Account Integration:", font=("Segoe UI", 11, "bold"))
        yt_bypass_label.grid(row=2, column=0, sticky=tk.W, pady=4)

        self.enable_youtube_bypass_var = tk.BooleanVar(value=False) # Default to False, will be loaded from config
        self.yt_bypass_checkbutton = ttk.Checkbutton(
            settings_frame,
            variable=self.enable_youtube_bypass_var
        )
        self.yt_bypass_checkbutton.grid(row=2, column=1, sticky=tk.W, padx=(10, 0))

        yt_tooltip_text = (
            "📺 ENABLE YOUTUBE INTEGRATION\n\n"
            "What this does:\n"
            "- Synchronizes with your YouTube account via browser cookies.\n"
            "- Supports Private Videos, Subscriptions, and Watch Later.\n"
            "- Enables 'Mark as Watched' synchronization with your history.\n"
            "- Allows the extension to expand YouTube Playlists automatically.\n\n"
            "Requires 'Advanced URL Analysis' to be enabled above."
        )
        Tooltip(yt_bypass_label, yt_tooltip_text)
        Tooltip(self.yt_bypass_checkbutton, yt_tooltip_text)

        # --- Row 3: Browser for URL Analysis ---
        browser_label = ttk.Label(settings_frame, text="Browser for Analysis:", font=("Segoe UI", 11, "bold"))
        browser_label.grid(row=3, column=0, sticky=tk.W, pady=4)

        browser_input_frame = ttk.Frame(settings_frame)
        browser_input_frame.grid(row=3, column=1, sticky="ew", padx=(10, 0))
        browser_input_frame.columnconfigure(0, weight=1)

        self.browser_var = tk.StringVar()
        self.browser_combobox = ttk.Combobox(browser_input_frame, textvariable=self.browser_var, state="readonly", font=("Segoe UI", 11))
        self.browser_combobox['values'] = ('brave', 'chrome', 'edge', 'vivaldi', 'opera')
        self.browser_combobox.grid(row=0, column=0, sticky="ew")

        self.diagnostics_btn = ttk.Button(browser_input_frame, text="Run Diagnostics", command=self.run_diagnostics)
        self.diagnostics_btn.grid(row=0, column=1, sticky=tk.E, padx=(5, 0))

        # --- Connect Toggle Function ---
        def toggle_url_analysis_widgets():
            state = tk.NORMAL if self.create_bypass_var.get() else tk.DISABLED
            self.browser_combobox.config(state="readonly" if self.create_bypass_var.get() else "disabled")
            self.diagnostics_btn.config(state=state)
            self.yt_bypass_checkbutton.config(state=state)
            # Also toggle the labels' appearance to indicate they're disabled
            browser_label.config(state=state)
            yt_bypass_label.config(state=state)

        self.bypass_checkbutton.config(command=toggle_url_analysis_widgets)

        # --- Attempt to load previous Extension ID and URL Analysis settings ---
        if platform.system() == "Windows":
            manifest_filename = f"{HOST_NAME}-chrome.json"
        else: # Linux/macOS
            manifest_filename = f"{HOST_NAME}.json"

        manifest_file_path = os.path.join(file_io.DATA_DIR, manifest_filename)
        if os.path.exists(manifest_file_path):
            try:
                with open(manifest_file_path, 'r', encoding='utf-8') as f:
                    manifest_data = json.load(f)
                allowed_origins = manifest_data.get("allowed_origins")
                if allowed_origins and len(allowed_origins) > 0:
                    # Extract ID from "chrome-extension://{id}/"
                    ext_id = allowed_origins[0].replace("chrome-extension://", "").replace("/", "")
                    self.extension_id_var.set(ext_id)
            except (IOError, json.JSONDecodeError, AttributeError, IndexError) as e:
                self.log(f"WARNING: Could not read previous Extension ID from manifest file: {e}")

        # Load URL analysis settings from config.json
        current_config = file_io.get_settings()
        self.create_bypass_var.set(current_config.get("enable_url_analysis", False))
        self.enable_youtube_bypass_var.set(current_config.get("enable_youtube_analysis", False))
        self.browser_var.set(current_config.get("browser_for_url_analysis", "brave"))

        # Call toggle function once to set initial state of widgets based on loaded config
        toggle_url_analysis_widgets()

        # --- Buttons ---
        button_frame = ttk.Frame(main_frame)
        button_frame.pack(fill=tk.X, pady=10)
        self.install_button = ttk.Button(button_frame, text="Install", command=self.run_install)
        self.install_button.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=(0, 5))
        self.uninstall_button = ttk.Button(button_frame, text="Uninstall", style="Uninstall.TButton", command=self.run_uninstall)
        self.uninstall_button.pack(side=tk.RIGHT, fill=tk.X, expand=True, padx=(5, 0))

        # --- CLI Wrapper Button ---
        cli_button_frame = ttk.Frame(main_frame)
        cli_button_frame.pack(fill=tk.X, pady=5)
        self.cli_button = ttk.Button(cli_button_frame, text="Install CLI Wrapper (mpv-cli)", command=self.run_install_cli)
        self.cli_button.pack(fill=tk.X, expand=True)

        # --- Add to PATH Button ---
        path_button_frame = ttk.Frame(main_frame)
        path_button_frame.pack(fill=tk.X, pady=(0, 5))
        self.path_button = ttk.Button(path_button_frame, text="Add Folder to User PATH", command=self.run_add_to_path)
        self.path_button.pack(fill=tk.X, expand=True)
        # --- Log Area ---
        ttk.Label(main_frame, text="Log Output:", font=(MODERN_FONT, 11, "bold")).pack(anchor=tk.W, pady=(10, 5))
        self.log_area = scrolledtext.ScrolledText(main_frame, wrap=tk.WORD, height=14, font=(MONO_FONT, 10), relief="flat", borderwidth=1)
        self.log_area.pack(fill=tk.BOTH, expand=True)
        self.log_area.configure(state='disabled')

    def _process_log_queue(self):
        try:
            while True:
                msg = self.log_queue.get_nowait()
                self.log_area.configure(state='normal')
                self.log_area.insert(tk.END, msg + "\n")
                self.log_area.configure(state='disabled')
                self.log_area.see(tk.END)
        except queue.Empty:
            pass
        self.root.after(100, self._process_log_queue)

    def log(self, message):
        self.log_queue.put(message)

    def run_install(self):
        extension_id = self.extension_id_var.get().strip()
        if not extension_id:
            messagebox.showerror("Error", "Extension ID cannot be empty.")
            return

        # Basic validation for Chrome extension ID format (32 characters, a-p)
        if not re.match(r"^[a-p]{32}$", extension_id):
            if not messagebox.askyesno("Warning", "The Extension ID doesn't look like a standard Chrome extension ID (32 characters, a-p).\n\nAre you sure you want to proceed?"):
                return

        self.install_button.config(state=tk.DISABLED)
        self.uninstall_button.config(state=tk.DISABLED)
        self.cli_button.config(state=tk.DISABLED)
        self.browser_combobox.config(state=tk.DISABLED)

        # Run in a separate thread to keep the GUI responsive
        threading.Thread(target=self._install_thread, args=(extension_id,)).start()

    def run_uninstall(self):
        if not messagebox.askyesno("Confirm Uninstall", "Are you sure you want to uninstall the native host?"):
            return

        self.install_button.config(state=tk.DISABLED)
        self.uninstall_button.config(state=tk.DISABLED)
        self.cli_button.config(state=tk.DISABLED)
        self.browser_combobox.config(state=tk.DISABLED)

        threading.Thread(target=self._uninstall_thread).start()

    def run_install_cli(self):
        """Disables buttons and starts the CLI wrapper installation in a new thread."""
        self.install_button.config(state=tk.DISABLED)
        self.uninstall_button.config(state=tk.DISABLED)
        self.cli_button.config(state=tk.DISABLED)
        self.path_button.config(state=tk.DISABLED)
        self.browser_combobox.config(state=tk.DISABLED)

        # Run in a separate thread to keep the GUI responsive
        threading.Thread(target=self._install_cli_thread).start()

    def run_add_to_path(self):
        """Disables buttons and starts the 'add to PATH' logic in a new thread."""
        self.install_button.config(state=tk.DISABLED)
        self.uninstall_button.config(state=tk.DISABLED)
        self.cli_button.config(state=tk.DISABLED)
        self.path_button.config(state=tk.DISABLED)
        self.browser_combobox.config(state=tk.DISABLED)

        threading.Thread(target=self._add_to_path_thread).start()

    def _check_dependencies_async(self):
        threading.Thread(target=self._check_dependencies_thread, daemon=True).start()

    def _check_dependencies_thread(self):
        status = services.check_mpv_and_ytdlp_status(file_io.get_mpv_executable, lambda msg: None)
        
        # Proactive alert if MPV is missing
        if not status['mpv']['found']:
            self.root.after(0, self._prompt_for_mpv)

        warnings = self.logic.check_dependencies()
        for w in warnings:
            self.log(f"WARNING: {w.splitlines()[0]}")
            self.root.after(0, lambda msg=w: messagebox.showwarning("Dependency Missing", msg))

    def _prompt_for_mpv(self):
        """Displays a professional custom dialog when MPV is missing with a copyable link."""
        top = tk.Toplevel(self.root)
        top.title("MPV Not Found")
        top.geometry("650x420")
        top.resizable(False, False)
        top.transient(self.root)
        top.grab_set()

        padding = 30
        frame = ttk.Frame(top, padding=padding)
        frame.pack(fill=tk.BOTH, expand=True)

        ttk.Label(frame, text="⚠️ MPV Media Player Missing", font=(MODERN_FONT, 14, "bold"), foreground="#ed4245").pack(anchor=tk.W, pady=(0, 10))
        
        msg = (
            "The extension requires the MPV player to function. We couldn't find it "
            "in your system's PATH or configuration."
        )
        tk.Label(frame, text=msg, wraplength=590, justify=tk.LEFT, font=(MODERN_FONT, 11)).pack(anchor=tk.W, pady=(0, 20))

        # --- Link Section ---
        ttk.Label(frame, text="To install MPV, visit the official page:", font=(MODERN_FONT, 11, "bold")).pack(anchor=tk.W, pady=(0, 5))
        
        link_url = "https://mpv.io/installation/"
        
        link_frame = ttk.Frame(frame)
        link_frame.pack(fill=tk.X, pady=(0, 15))
        
        link_text = tk.Text(link_frame, height=1, font=(MONO_FONT, 11), bg="#2c2f33", fg="#ffffff", 
                           padx=10, pady=10, relief="flat")
        link_text.insert(tk.END, link_url)
        link_text.config(state=tk.DISABLED)
        link_text.pack(side=tk.LEFT, fill=tk.X, expand=True)

        def copy_link():
            self.root.clipboard_clear()
            self.root.clipboard_append(link_url)
            copy_link_btn.config(text="✅ COPIED")
            self.root.after(2000, lambda: copy_link_btn.config(text="Copy Link"))

        copy_link_btn = ttk.Button(link_frame, text="Copy Link", command=copy_link)
        copy_link_btn.pack(side=tk.RIGHT, padx=(10, 0))

        # --- Manual Selection Section ---
        ttk.Label(frame, text="Or if it's already installed elsewhere:", font=(MODERN_FONT, 11, "bold")).pack(anchor=tk.W, pady=(0, 5))
        
        def browse_path():
            ext = "*.exe" if platform.system() == "Windows" else "*"
            path = filedialog.askopenfilename(
                title="Select mpv executable", 
                filetypes=[("Executable", ext), ("All Files", "*.*")]
            )
            if path:
                file_io.set_settings({"mpv_path": path})
                self.log(f"Custom MPV path saved: {path}")
                top.destroy()
                self._check_dependencies_async()

        browse_btn = ttk.Button(frame, text="📂 Select mpv executable manually...", command=browse_path)
        browse_btn.pack(fill=tk.X, pady=(0, 20))

        ttk.Button(frame, text="Ignore for now", command=top.destroy).pack(side=tk.BOTTOM, anchor=tk.E)

    def run_diagnostics(self):
        """Runs a suite of diagnostic tests including dependency checks and cookie access."""
        browser = self.browser_var.get()

        self.install_button.config(state=tk.DISABLED) # Disable install while testing
        self.log(f"Starting diagnostics for '{browser}'...")

        def _test():
            report_text, has_critical_error = self.logic.run_diagnostics(browser)
            self.log("Diagnostics Results:\n" + report_text)

            title = "Diagnostics Failed" if has_critical_error else "Diagnostics Passed"

            self.root.after(0, lambda: messagebox.showinfo(title, report_text) if not has_critical_error else messagebox.showerror(title, report_text))
            self.root.after(0, lambda: self.install_button.config(state=tk.NORMAL))

        threading.Thread(target=_test, daemon=True).start()

    def run_detect_id(self):
        """Attempts to automatically detect the Extension ID for the selected browser."""
        browser = self.browser_var.get()
        self.log(f"Attempting to detect Extension ID for {browser}...")

        self.detect_id_btn.config(state=tk.DISABLED)

        def _detect():
            ext_id = self.logic.find_extension_id(browser)
            if ext_id:
                self.root.after(0, lambda: self.extension_id_var.set(ext_id))
                self.log(f"Auto-detection successful: {ext_id}")
            else:
                self.root.after(0, lambda: messagebox.showwarning("Not Found",
                    f"Could not find the extension ID in {browser}'s profiles.\n\n"
                    "Make sure you have loaded the unpacked extension in the browser first!"))

            self.root.after(0, lambda: self.detect_id_btn.config(state=tk.NORMAL))

        threading.Thread(target=_detect, daemon=True).start()

    def _show_linux_path_instructions(self):
        """Displays a custom dialog with copyable PATH instructions for Linux/macOS users."""
        top = tk.Toplevel(self.root)
        top.title("Manual PATH Configuration")
        top.geometry("700x550")
        top.resizable(False, False)
        top.transient(self.root)
        top.grab_set()

        padding = 30
        frame = ttk.Frame(top, padding=padding)
        frame.pack(fill=tk.BOTH, expand=True)

        ttk.Label(frame, text="🚀 Almost there!", font=(MODERN_FONT, 16, "bold"), foreground="#5865f2").pack(anchor=tk.W, pady=(0, 5))
        ttk.Label(frame, text="To use 'mpv-cli' from any terminal, follow these steps:", font=(MODERN_FONT, 11, "bold")).pack(anchor=tk.W, pady=(0, 20))

        # --- Step 1 ---
        step1_frame = ttk.Frame(frame)
        step1_frame.pack(fill=tk.X, pady=(0, 10))
        ttk.Label(step1_frame, text="1. Copy this command:", font=(MODERN_FONT, 11, "bold")).pack(anchor=tk.W)

        path_command = f'export PATH="$PATH:{INSTALL_DIR}"'

        # Code-block style box
        cmd_text = tk.Text(frame, height=2, font=(MONO_FONT, 12), bg="#2c2f33", fg="#ffffff",
                          padx=15, pady=15, relief="flat", insertbackground="white")
        cmd_text.insert(tk.END, path_command)
        cmd_text.config(state=tk.DISABLED)
        cmd_text.pack(fill=tk.X, pady=(5, 10))

        def copy_path():
            self.root.clipboard_clear()
            self.root.clipboard_append(path_command)
            copy_btn.config(text="✅ COPIED TO CLIPBOARD")
            self.root.after(2000, lambda: copy_btn.config(text="Copy Command"))

        copy_btn = ttk.Button(frame, text="Copy Command", command=copy_path)
        copy_btn.pack(pady=(0, 25))

        # --- Step 2 ---
        ttk.Label(frame, text="2. Paste it at the bottom of your config file:", font=(MODERN_FONT, 11, "bold")).pack(anchor=tk.W)

        config_info = (
            "• If you use Zsh (macOS Default):  ~/.zshrc\n"
            "• If you use Bash (Linux Default): ~/.bashrc"
        )
        tk.Label(frame, text=config_info, justify=tk.LEFT, font=(MODERN_FONT, 11), padx=10).pack(anchor=tk.W, pady=(5, 20))

        # --- Step 3 ---
        ttk.Label(frame, text="3. Reload your profile or restart terminal:", font=(MODERN_FONT, 11, "bold")).pack(anchor=tk.W)
        ttk.Label(frame, text="Run:  source ~/.bashrc  (or ~/.zshrc)", font=(MONO_FONT, 11), foreground="#555").pack(anchor=tk.W, padx=10, pady=(2, 20))

        ttk.Button(frame, text="Done", command=top.destroy).pack(side=tk.BOTTOM, pady=(10, 0))

    def _install_thread(self, extension_id):
        self.log("--- Starting Installation ---")
        try:
            # Get URL analysis settings. Renamed 'create_bypass' to 'enable_url_analysis' for clarity.
            enable_url_analysis = self.create_bypass_var.get()
            selected_browser = self.browser_var.get()
            enable_youtube_analysis = self.enable_youtube_bypass_var.get()

            self.logic.install(extension_id, enable_url_analysis, selected_browser, enable_youtube_analysis)

            self.log("\n--- Installation Finished! ---")
            self.log("[IMPORTANT] You must now RESTART your browser completely for the changes to take effect.")
        except Exception as e:
            self.log(f"An unexpected error occurred: {e}")
        finally:
            self.install_button.config(state=tk.NORMAL)
            self.uninstall_button.config(state=tk.NORMAL)
            self.cli_button.config(state=tk.NORMAL)
            self.path_button.config(state=tk.NORMAL)
            self.browser_combobox.config(state="readonly")

    def _uninstall_thread(self):
        self.log("--- Starting Uninstallation ---")
        try:
            self.logic.uninstall()

            self.log("\n--- Uninstallation Finished! ---")
            self.log("You can now remove the extension from your browser and delete this folder.")
        except Exception as e:
            self.log(f"An unexpected error occurred: {e}")
        finally:
            self.install_button.config(state=tk.NORMAL)
            self.uninstall_button.config(state=tk.NORMAL)
            self.cli_button.config(state=tk.NORMAL)
            self.path_button.config(state=tk.NORMAL)
            self.browser_combobox.config(state="readonly")

    def _install_cli_thread(self):
        """The actual logic for creating the CLI wrapper, run in a new thread."""
        self.log("--- Installing CLI Wrapper ---")
        try:
            self.logic.install_cli()

            self.log("\n--- CLI Wrapper Installation Finished! ---")
            self.log("Ensure this directory is in your system's PATH to use the command from anywhere.")
        except Exception as e:
            self.log(f"An unexpected error occurred during CLI wrapper installation: {e}")
        finally:
            self.install_button.config(state=tk.NORMAL)
            self.uninstall_button.config(state=tk.NORMAL)
            self.cli_button.config(state=tk.NORMAL)
            self.path_button.config(state=tk.NORMAL)
            self.browser_combobox.config(state="readonly")

    def _add_to_path_thread(self):
        """The actual logic for adding the install directory to the user's PATH."""
        self.log("--- Adding to User PATH ---")
        try:
            result = self.logic.add_to_path()
            if result == "Success":
                self.log("Successfully added directory to user PATH.")
                self.root.after(0, lambda: messagebox.showinfo("Success", "Directory added to user PATH. Please restart any open terminals."))
            elif result == "Manual":
                self.root.after(0, self._show_linux_path_instructions)
            else:
                self.log(result)

        except Exception as e:
            self.log(f"An unexpected error occurred while modifying PATH: {e}")
        finally:
            self.install_button.config(state=tk.NORMAL)
            self.uninstall_button.config(state=tk.NORMAL)
            self.cli_button.config(state=tk.NORMAL)
            self.path_button.config(state=tk.NORMAL)
            self.browser_combobox.config(state="readonly")

def main():
    if GUI_AVAILABLE:
        root = tk.Tk()
        app = HostManagerApp(root)
        root.mainloop()
    else:
        app = CommandLineApp()
        app.run()

if __name__ == "__main__":
    main()
