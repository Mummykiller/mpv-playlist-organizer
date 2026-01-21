import tkinter as tk
from tkinter import ttk, scrolledtext, messagebox, filedialog
import threading
import queue
import re
import platform
import os
import json
import file_io
import services
from .installer_logic import (
    HOST_NAME, INSTALL_DIR, WindowsLogic, LinuxLogic, MacOSLogic, UnixLogic
)

MODERN_FONT = ("Segoe UI", "Roboto", "Ubuntu", "Helvetica Neue", "Arial")
MONO_FONT = ("Consolas", "Monaco", "DejaVu Sans Mono", "monospace")

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

class HostManagerApp:
    def __init__(self, root):
        self.root = root
        self.root.title("MPV Playlist Organizer - Host Manager")
        self.log_queue = queue.Queue()

        self._setup_ui()

        self.root.resizable(False, False)

        window_width = 640
        window_height = 600
        screen_width = self.root.winfo_screenwidth()
        screen_height = self.root.winfo_screenheight()
        center_x = int(screen_width / 2 - window_width / 2)
        center_y = int(screen_height / 2 - window_height / 2)
        self.root.geometry(f'{window_width}x{window_height}+{center_x}+{center_y}')

        self.logic = self._get_logic_strategy()
        self.root.after(100, self._process_log_queue)
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
            return UnixLogic(self.log, ask_file_func, ask_dir_func)

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
        bg_color = "#f8f9fa"
        self.root.configure(bg=bg_color)
        style = ttk.Style()
        style.theme_use('clam')
        style.configure(".", background=bg_color, font=("Segoe UI", 11, "normal"))
        style.configure("TFrame", background=bg_color)
        style.configure("TLabel", background=bg_color)
        style.configure("TCheckbutton", background=bg_color)
        style.configure("TButton", padding=8, relief="flat", background="#5865f2", foreground="white", borderwidth=0, font=("Segoe UI", 11, "bold"))
        style.map("TButton", background=[('active', '#4f5bda'), ('disabled', '#cccccc')])
        style.configure("Uninstall.TButton", background="#ed4245", font=("Segoe UI", 11, "bold"))
        style.map("Uninstall.TButton", background=[('active', '#da3739')])
        style.configure("Header.TLabel", font=("Segoe UI", 18, "bold"), foreground="#2c2f33")

        main_frame = ttk.Frame(self.root, padding="25")
        main_frame.pack(fill=tk.BOTH, expand=True)
        ttk.Label(main_frame, text="MPV Playlist Organizer", style="Header.TLabel").pack(pady=(0, 20))

        settings_frame = ttk.Frame(main_frame)
        settings_frame.pack(fill=tk.X, pady=(0, 10))
        settings_frame.columnconfigure(1, weight=1)

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

        bypass_label = ttk.Label(settings_frame, text="Advanced URL Analysis:", font=("Segoe UI", 11, "bold"))
        bypass_label.grid(row=1, column=0, sticky=tk.W, pady=4)
        self.create_bypass_var = tk.BooleanVar(value=False)
        self.bypass_checkbutton = ttk.Checkbutton(settings_frame, variable=self.create_bypass_var)
        self.bypass_checkbutton.grid(row=1, column=1, sticky=tk.W, padx=(10, 0))

        yt_bypass_label = ttk.Label(settings_frame, text="YouTube Account Integration:", font=("Segoe UI", 11, "bold"))
        yt_bypass_label.grid(row=2, column=0, sticky=tk.W, pady=4)
        self.enable_youtube_bypass_var = tk.BooleanVar(value=False)
        self.yt_bypass_checkbutton = ttk.Checkbutton(settings_frame, variable=self.enable_youtube_bypass_var)
        self.yt_bypass_checkbutton.grid(row=2, column=1, sticky=tk.W, padx=(10, 0))

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

        def toggle_url_analysis_widgets():
            state = tk.NORMAL if self.create_bypass_var.get() else tk.DISABLED
            self.browser_combobox.config(state="readonly" if self.create_bypass_var.get() else "disabled")
            self.diagnostics_btn.config(state=state)
            self.yt_bypass_checkbutton.config(state=state)
            browser_label.config(state=state)
            yt_bypass_label.config(state=state)

        self.bypass_checkbutton.config(command=toggle_url_analysis_widgets)

        manifest_filename = f"{HOST_NAME}-chrome.json" if platform.system() == "Windows" else f"{HOST_NAME}.json"
        manifest_file_path = os.path.join(file_io.DATA_DIR, manifest_filename)
        if os.path.exists(manifest_file_path):
            try:
                with open(manifest_file_path, 'r', encoding='utf-8') as f:
                    manifest_data = json.load(f)
                allowed_origins = manifest_data.get("allowed_origins")
                if allowed_origins:
                    ext_id = allowed_origins[0].replace("chrome-extension://", "").replace("/", "")
                    self.extension_id_var.set(ext_id)
            except Exception:
                pass

        current_config = file_io.get_settings()
        self.create_bypass_var.set(current_config.get("enable_url_analysis", False))
        self.enable_youtube_bypass_var.set(current_config.get("enable_youtube_analysis", False))
        self.browser_var.set(current_config.get("browser_for_url_analysis", "brave"))
        toggle_url_analysis_widgets()

        button_frame = ttk.Frame(main_frame)
        button_frame.pack(fill=tk.X, pady=10)
        self.install_button = ttk.Button(button_frame, text="Install", command=self.run_install)
        self.install_button.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=(0, 5))
        self.uninstall_button = ttk.Button(button_frame, text="Uninstall", style="Uninstall.TButton", command=self.run_uninstall)
        self.uninstall_button.pack(side=tk.RIGHT, fill=tk.X, expand=True, padx=(5, 0))

        cli_button_frame = ttk.Frame(main_frame)
        cli_button_frame.pack(fill=tk.X, pady=5)
        self.cli_button = ttk.Button(cli_button_frame, text="Install CLI Wrapper (mpv-cli)", command=self.run_install_cli)
        self.cli_button.pack(fill=tk.X, expand=True)

        path_button_frame = ttk.Frame(main_frame)
        path_button_frame.pack(fill=tk.X, pady=(0, 5))
        self.path_button = ttk.Button(path_button_frame, text="Add Folder to User PATH", command=self.run_add_to_path)
        self.path_button.pack(fill=tk.X, expand=True)

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
        if not re.match(r"^[a-p]{32}$", extension_id):
            if not messagebox.askyesno("Warning", "Invalid ID format. Proceed anyway?"):
                return
        self.install_button.config(state=tk.DISABLED)
        threading.Thread(target=self._install_thread, args=(extension_id,)).start()

    def run_uninstall(self):
        if not messagebox.askyesno("Confirm Uninstall", "Are you sure?"):
            return
        threading.Thread(target=self._uninstall_thread).start()

    def run_install_cli(self):
        threading.Thread(target=self._install_cli_thread).start()

    def run_add_to_path(self):
        threading.Thread(target=self._add_to_path_thread).start()

    def _check_dependencies_async(self):
        threading.Thread(target=self._check_dependencies_thread, daemon=True).start()

    def _check_dependencies_thread(self):
        status = services.check_mpv_and_ytdlp_status(file_io.get_mpv_executable, lambda msg: None)
        if not status['mpv']['found']:
            self.root.after(0, self._prompt_for_mpv)
        warnings = self.logic.check_dependencies()
        for w in warnings:
            self.log(f"WARNING: {w.splitlines()[0]}")

    def _prompt_for_mpv(self):
        top = tk.Toplevel(self.root)
        top.title("MPV Not Found")
        top.geometry("650x420")
        frame = ttk.Frame(top, padding=30)
        frame.pack(fill=tk.BOTH, expand=True)
        ttk.Label(frame, text="⚠️ MPV Media Player Missing", font=(MODERN_FONT, 14, "bold"), foreground="#ed4245").pack(anchor=tk.W, pady=(0, 10))
        
        def browse_path():
            path = filedialog.askopenfilename(title="Select mpv")
            if path:
                file_io.set_settings({"mpv_path": path})
                top.destroy()
                self._check_dependencies_async()

        ttk.Button(frame, text="📂 Select mpv executable manually...", command=browse_path).pack(fill=tk.X, pady=(0, 20))
        ttk.Button(frame, text="Ignore", command=top.destroy).pack(side=tk.BOTTOM, anchor=tk.E)

    def run_diagnostics(self):
        browser = self.browser_var.get()
        def _test():
            report, has_err = self.logic.run_diagnostics(browser)
            title = "Diagnostics Failed" if has_err else "Diagnostics Passed"
            self.root.after(0, lambda: messagebox.showinfo(title, report) if not has_err else messagebox.showerror(title, report))
        threading.Thread(target=_test, daemon=True).start()

    def run_detect_id(self):
        browser = self.browser_var.get()
        def _detect():
            ext_id = self.logic.find_extension_id(browser)
            if ext_id:
                self.root.after(0, lambda: self.extension_id_var.set(ext_id))
            else:
                self.root.after(0, lambda: messagebox.showwarning("Not Found", "Could not find extension ID."))
        threading.Thread(target=_detect, daemon=True).start()

    def _install_thread(self, extension_id):
        try:
            self.logic.install(extension_id, self.create_bypass_var.get(), self.browser_var.get(), self.enable_youtube_bypass_var.get())
            self.log("Installation Finished!")
        except Exception as e:
            self.log(f"Error: {e}")
        finally:
            self.root.after(0, lambda: self.install_button.config(state=tk.NORMAL))

    def _uninstall_thread(self):
        try:
            self.logic.uninstall()
            self.log("Uninstallation Finished!")
        except Exception as e:
            self.log(f"Error: {e}")

    def _install_cli_thread(self):
        try:
            self.logic.install_cli()
            self.log("CLI Wrapper Installed!")
        except Exception as e:
            self.log(f"Error: {e}")

    def _add_to_path_thread(self):
        try:
            result = self.logic.add_to_path()
            if result == "Success":
                self.log("Added to PATH!")
            else:
                self.log(result)
        except Exception as e:
            self.log(f"Error: {e}")
