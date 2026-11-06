import os
import shutil
import subprocess

def create_release():
    # 1. Setup paths
    # Assuming script is in <root>/testing_tools/
    root_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    release_dir = os.path.join(root_dir, "mpv-playlist-organizer-release")
    
    print(f"[*] Preparing release in: {release_dir}")
    
    # 2. Build JS first to ensure latest is included
    print("[*] Building legacy JS files...")
    try:
        subprocess.run(["python3", os.path.join(root_dir, "testing_tools", "generate_js.py")], check=True)
    except Exception as e:
        print(f"[!] Warning: JS build failed: {e}")

    # 3. Clean existing release folder
    if os.path.exists(release_dir):
        print("[*] Removing existing release folder...")
        shutil.rmtree(release_dir)
    
    # 4. Define custom ignore function
    def ignore_logic(src, names):
        import fnmatch
        ignored = []
        # Standard development patterns
        patterns = [
            ".git", "node_modules", "__pycache__", "*.pyc", ".pytest_cache",
            "mpv-playlist-organizer-release", ".gitignore", ".gemini*",
            "testing_tools", "mpv_playback_cache.json",
            "local_commits.txt", "run_native_host.sh"
        ]
        
        for name in names:
            # Check against standard patterns
            if any(fnmatch.fnmatch(name, p) for p in patterns):
                ignored.append(name)
                continue
            
            # MD rule: Ignore all .md files except for README.md
            if name.lower().endswith(".md") and name.upper() != "README.MD":
                ignored.append(name)
                
        return ignored

    # 5. Copy files
    print("[*] Copying files...")
    shutil.copytree(root_dir, release_dir, ignore=ignore_logic)
    
    print(f"\n[SUCCESS] Release created successfully at: {release_dir}")

if __name__ == "__main__":
    create_release()
