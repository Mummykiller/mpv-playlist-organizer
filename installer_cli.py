import os
import sys
import platform
import json
import file_io
from installer_logic import (
    HOST_NAME, INSTALL_DIR, WindowsLogic, LinuxLogic, MacOSLogic, UnixLogic
)

class CommandLineApp:
    def __init__(self):
        self.logic = self._get_logic_strategy()

    def _get_logic_strategy(self):
        system = platform.system()
        def ask_dir_cli(title):
            print(f"\n[ACTION REQUIRED] {title}")
            return input("Path (Enter to skip): ").strip()
        
        if system == "Windows":
            return WindowsLogic(print, ask_dir_func=ask_dir_cli)
        elif system == "Linux":
            return LinuxLogic(print, ask_dir_func=ask_dir_cli)
        elif system == "Darwin":
            return MacOSLogic(print, ask_dir_func=ask_dir_cli)
        return UnixLogic(print, ask_dir_func=ask_dir_cli)

    def _print_header(self, text):
        print("\n" + "="*60)
        print(f"   {text}")
        print("="*60)

    def run(self):
        while True:
            self._print_header("MPV PLAYLIST ORGANIZER - TERMINAL MANAGER")
            print(" 1. Install Native Host")
            print(" 2. Uninstall Native Host")
            print(" 3. Run Diagnostics")
            print(" 4. Detect Extension ID")
            print(" 5. Install CLI Wrapper (mpv-cli)")
            print(" 6. Add to PATH (Windows only)")
            print(" 0. Exit")
            
            choice = input("\nSelect an option: ").strip()
            
            if choice == "1":
                self.perform_install()
            elif choice == "2":
                self.perform_uninstall()
            elif choice == "3":
                self.perform_diagnostics()
            elif choice == "4":
                self.perform_detection()
            elif choice == "5":
                self.perform_cli_install()
            elif choice == "6":
                self.perform_add_to_path()
            elif choice == "0":
                break
            else:
                print("Invalid choice. Please try again.")

    def perform_install(self):
        self._print_header("INSTALLATION")
        
        # 1. Get Extension ID
        current_id = ""
        manifest_filename = f"{HOST_NAME}-chrome.json" if platform.system() == "Windows" else f"{HOST_NAME}.json"
        manifest_path = os.path.join(file_io.DATA_DIR, manifest_filename)
        if os.path.exists(manifest_path):
            try:
                with open(manifest_path, 'r') as f:
                    data = json.load(f)
                    current_id = data.get("allowed_origins", [""])[0].replace("chrome-extension://", "").replace("/", "")
            except Exception:
                pass

        if current_id:
            print(f"Current Extension ID: {current_id}")
            ext_id = input("Enter new ID (or press Enter to keep current): ").strip() or current_id
        else:
            ext_id = input("Enter your Extension ID: ").strip()
            
        if not ext_id:
            print("Error: Extension ID is required.")
            return

        # 2. Settings
        use_bypass = input("Enable Advanced URL Analysis? (y/n) [n]: ").lower().startswith('y')
        
        selected_browser = "brave"
        use_youtube = False
        if use_bypass:
            selected_browser = input("Which browser do you use? (brave/chrome/edge/vivaldi/opera) [brave]: ").strip().lower() or "brave"
            use_youtube = input("Enable YouTube Account Integration? (y/n) [n]: ").lower().startswith('y')

        print("\nChecking Dependencies...")
        warnings = self.logic.check_dependencies()
        if warnings:
            for w in warnings:
                print(f"  [!]{w}")
        else:
            print("  [+] All core dependencies found.")

        print("\nStarting Installation...")
        try:
            self.logic.install(ext_id, use_bypass, selected_browser, use_youtube)
            print("\n✅ SUCCESS: Native host installed.")
            print("[IMPORTANT] Restart your browser for changes to take effect.")
        except Exception as e:
            print(f"\n❌ ERROR: {e}")

    def perform_uninstall(self):
        self._print_header("UNINSTALLATION")
        confirm = input("Are you sure you want to uninstall? (y/n): ").lower().startswith('y')
        if confirm:
            try:
                self.logic.uninstall()
                print("\n✅ SUCCESS: Native host uninstalled.")
            except Exception as e:
                print(f"\n❌ ERROR: {e}")

    def perform_diagnostics(self):
        self._print_header("DIAGNOSTICS")
        browser = input("Which browser to test for cookie access? [brave]: ").strip().lower() or "brave"
        print(f"Starting diagnostics for '{browser}'...\n")
        report, has_error = self.logic.run_diagnostics(browser)
        print(report)
        if has_error:
            print("\n❌ Diagnostics failed. See issues above.")
        else:
            print("\n✅ Diagnostics passed!")

    def perform_detection(self):
        self._print_header("EXTENSION ID DETECTION")
        browser = input("Which browser to scan? (brave/chrome/edge/vivaldi/opera) [brave]: ").strip().lower() or "brave"
        print(f"Scanning {browser} profiles...")
        ext_id = self.logic.find_extension_id(browser)
        if ext_id:
            print(f"\n✅ Found ID: {ext_id}")
        else:
            print("\n❌ Could not find ID. Make sure the extension is loaded in that browser.")

    def perform_cli_install(self):
        self._print_header("CLI WRAPPER INSTALL")
        try:
            self.logic.install_cli()
            print("\n✅ SUCCESS: mpv-cli installed.")
            if platform.system() != "Windows":
                print(f"\nManual Step: To use 'mpv-cli', add this to your PATH:")
                print(f'export PATH="$PATH:{INSTALL_DIR}"')
        except Exception as e:
            print(f"\n❌ ERROR: {e}")

    def perform_add_to_path(self):
        self._print_header("ADD TO PATH")
        if platform.system() != "Windows":
            print("This automated feature is Windows-only.")
            print(f"Linux/Mac users: export PATH=\"$PATH:{INSTALL_DIR}\"")
            return
            
        try:
            result = self.logic.add_to_path()
            if result == "Success":
                print("\n✅ SUCCESS: Directory added to user PATH.")
        except Exception as e:
            print(f"\n❌ ERROR: {e}")

if __name__ == "__main__":
    app = CommandLineApp()
    app.run()