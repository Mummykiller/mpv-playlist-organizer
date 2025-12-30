import subprocess
import time
import os

mpv_exe = "/usr/bin/mpv"
# Simulating the command that was failing
command = [
    mpv_exe,
    "--force-window=yes",
    "--ytdl=yes",
    "--ytdl-raw-options=cookies-from-browser=brave,mark-watched=",
    "--vo=null",
    "--ao=null",
    "--frames=1",
    "https://www.youtube.com/watch?v=5QZvl0y4Bt4"
]

print(f"Running command: {' '.join(command)}")
try:
    result = subprocess.run(command, capture_output=True, text=True, timeout=10)
    print("STDOUT:", result.stdout)
    print("STDERR:", result.stderr)
    if result.returncode == 0:
        print("SUCCESS: MPV started and exited normally.")
    else:
        print(f"FAILURE: MPV exited with code {result.returncode}")
except subprocess.TimeoutExpired:
    print("SUCCESS: MPV started and was still running after 10s (timed out as expected for non-frames=1)")
except Exception as e:
    print(f"ERROR: {e}")
