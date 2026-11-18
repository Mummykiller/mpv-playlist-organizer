import fnmatch
import os
import shutil
import subprocess
import sys

sys.dont_write_bytecode = True

IGNORE_PATTERNS = (
    ".git",
    "node_modules",
    "__pycache__",
    "*.pyc",
    ".pytest_cache",
    "mpv-playlist-organizer-release",
    "mpv-playlist-organizer-release.zip",
    "yt-tools-legacy",
    "yt-tools-standalone",
    "yt-tools-standalone.zip",
    "export_standalone.py",
    "port_to_main.py",
    ".gitignore",
    ".gemini*",
    "testing_tools",
    "biome.json",
    "pyproject.toml",
    "verify_changes.py",
    "mpv_playback_cache.json",
    "local_commits.txt",
    "run_native_host.sh",
    "run_native_host.bat",
    "mpv-cli",
    "mpv-cli.bat",
    "play_with_bypass.sh",
    "*.log",
    "*.log.*",
    "*.tmp",
    "*.bak",
    ".DS_Store",
    "Thumbs.db",
    "data",
    "flags",
)


def create_release():
    """Build transpiled JS modules and package a clean release directory."""
    # Assuming script is in <root>/testing_tools/
    root_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    release_dir = os.path.join(root_dir, "mpv-playlist-organizer-release")

    print(f"[*] Preparing release in: {release_dir}")

    # 1. Build JS first to ensure latest transpiled files are included
    print("[*] Building legacy JS files...")
    env = os.environ.copy()
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    try:
        subprocess.run(
            [sys.executable, os.path.join(root_dir, "testing_tools", "generate_js.py")],
            check=True,
            cwd=root_dir,
            env=env,
        )
    except subprocess.CalledProcessError as e:
        print(f"[!] Error: JS build failed with exit code {e.returncode}")
        sys.exit(e.returncode)
    except OSError as e:
        print(f"[!] Error: Failed to run JS build: {e}")
        sys.exit(1)

    # 2. Clean existing release folder
    if os.path.exists(release_dir):
        print("[*] Removing existing release folder...")
        shutil.rmtree(release_dir)

    # 3. Define custom ignore function
    def ignore_logic(_src, names):
        ignored = []
        for name in names:
            if any(fnmatch.fnmatch(name, p) for p in IGNORE_PATTERNS):
                ignored.append(name)
                continue

            # Ignore all .md files except README.md
            if name.lower().endswith(".md") and name.upper() != "README.MD":
                ignored.append(name)

        return ignored

    # 4. Copy files
    print("[*] Copying files...")
    shutil.copytree(root_dir, release_dir, ignore=ignore_logic)

    print(f"\n[SUCCESS] Release created successfully at: {release_dir}")


if __name__ == "__main__":
    create_release()
