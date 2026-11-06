import subprocess
import sys
import os
import logging

os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
sys.dont_write_bytecode = True


def run_step(script_path, description, extra_args=None):
    """Runs a verification step, printing output directly so errors appear immediately."""
    cmd = [sys.executable, script_path] + (extra_args or [])
    try:
        subprocess.run(cmd, check=True)
        return True
    except subprocess.CalledProcessError as e:
        print(f"❌ {description} failed (exit code {e.returncode}).")
        return False
    except Exception as e:
        print(f"❌ Could not run {description}: {e}")
        return False


def main():
    project_root = os.path.dirname(os.path.abspath(__file__))
    os.chdir(project_root)

    extra_args = sys.argv[1:]
    verbose = "--verbose" in extra_args or "-v" in extra_args
    if verbose:
        print("🔍 Verifying build & test suite...")

    # 0. Ensure Pycache Watchdog is active in background
    try:
        sys.path.insert(0, os.path.join(project_root, "testing_tools"))
        import pycache_watchdog
        pycache_watchdog.ensure_running(silent=not verbose)
    except (ImportError, OSError) as e:
        logging.debug(f"[VERIFY] Pycache watchdog ensure_running: {e}")

    # 1. Generate JS (Transpile ES modules to legacy globals)
    if not run_step(os.path.join("testing_tools", "generate_js.py"), "JS Build", extra_args):
        sys.exit(1)

    # 2. Run Full Test Suite
    if not run_step(os.path.join("testing_tools", "run_suite.py"), "Test Suite", extra_args):
        sys.exit(1)


if __name__ == "__main__":
    main()
