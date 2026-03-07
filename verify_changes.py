import subprocess
import sys
import os

def run_command(script_path, description):
    """Runs a python script and returns success status."""
    print(f"\n[RUNNING] {description} ({script_path})...")
    try:
        # Use sys.executable to ensure we use the same python environment
        subprocess.run([sys.executable, script_path], check=True)
        print(f"[SUCCESS] {description} completed.")
        return True
    except subprocess.CalledProcessError as e:
        print(f"[FAILURE] {description} failed with exit code {e.returncode}.")
        return False
    except Exception as e:
        print(f"[ERROR] Could not run {description}: {e}")
        return False

def main():
    # Ensure we are in the project root
    project_root = os.path.dirname(os.path.abspath(__file__))
    os.chdir(project_root)

    print("="*60)
    print("MPV Playlist Organizer - End of Edit Verification")
    print("="*60)

    # 1. Generate JS (Transpile ES modules to legacy globals)
    js_gen_path = os.path.join("testing_tools", "generate_js.py")
    if not run_command(js_gen_path, "JS Build/Generation"):
        print("\n❌ Verification aborted due to build failure.")
        sys.exit(1)

    # 2. Run Full Test Suite
    suite_path = os.path.join("testing_tools", "run_suite.py")
    if not run_command(suite_path, "Automated Test Suite"):
        print("\n❌ Verification failed: Tests did not pass.")
        sys.exit(1)

    print("\n" + "="*60)
    print("✨ ALL TASKS COMPLETED SUCCESSFULLY! ✨")
    print("Your changes are built and verified.")
    print("="*60)

if __name__ == "__main__":
    main()
