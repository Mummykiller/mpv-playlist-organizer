import os
import re
import socket
import ipaddress
import logging
import platform
import sys
from urllib.parse import urlparse

# Prevent __pycache__ generation
sys.dont_write_bytecode = True
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'

# --- Security Limits ---
SECURITY_LIMITS = {
    'MAX_TITLE_LENGTH': 512,        # Increased from 255
    'MAX_URL_LENGTH': 4096,         # Increased from 2048
    'MAX_STRING_LENGTH': 1024 * 100, # 100KB for general payload strings (e.g. data export)
    'MAX_PLAYLIST_ITEMS': 10000,     # Increased from 5000
    'MAX_FOLDER_NAME_LENGTH': 128,  # Increased from 100
    'MAX_FOLDERS': 2000,
    'MAX_IPC_MESSAGE_SIZE': 5 * 1024 * 1024,  # 5MB
}

# --- Protocol Allowlist ---
ALLOWED_PROTOCOLS = ('http://', 'https://', 'file://', 'udp://', 'rtmp://', 'rtsp://', 'mms://')

# --- yt-dlp Safe Flags Allowlist ---
YTDLP_SAFE_FLAGS_ALLOWLIST = {
    'cookies', 'cookies-from-browser', 'user-agent', 'referer', 'add-header',
    'format', 'f', 'concurrent-fragments', 'N', 'limit-rate', 'r', 'retries', 'R',
    'fragment-retries', 'skip-unavailable-fragments', 'keep-fragments',
    'buffer-size', 'http-chunk-size', 'playlist-start', 'playlist-end',
    'playlist-items', 'match-filter', 'no-playlist', 'yes-playlist', 'age-limit',
    'min-filesize', 'max-filesize', 'date', 'datebefore', 'dateafter',
    'min-views', 'max-views', 'min-downloads', 'max-downloads', 'min-likes',
    'max-likes', 'min-dislikes', 'max-dislikes', 'match-title', 'reject-title',
    'id', 'I', 'proxy', 'socket-timeout', 'source-address', 'force-ipv4', '4',
    'force-ipv6', '6', 'geo-verification-proxy', 'geo-bypass',
    'geo-bypass-country', 'geo-bypass-ip-block', 'flat-playlist',
    'no-flat-playlist', 'live-from-start', 'wait-for-video', 'no-wait-for-video',
    'ignore-config', 'no-ignore-config', 'compat-options', 'alias', 'print',
    'no-warnings', 'dump-user-agent', 'version', 'update', 'verbose', 'v',
    'quiet', 'q', 'no-check-certificate', 'prefer-insecure', 'ffmpeg-location',
    'remote-components', 'js-runtimes'
}

# --- MPV Safe Flags Allowlist ---
SAFE_MPV_FLAGS_ALLOWLIST = {
    '--start', '--end', '--speed', '--loop', '--loop-playlist', '--loop-file', '--pause',
    '--save-position-on-quit', '--fullscreen', '--ontop', '--border', '--title',
    '--geometry', '--autofit', '--autofit-larger', '--autofit-smaller', '--keep-open',
    '--aspect', '--correct-pts', '--fps', '--deinterlace', '--hwdec', '--scale',
    '--cscale', '--dscale', '--dither-depth', '--deband', '--deband-iterations',
    '--deband-threshold', '--deband-range', '--fbo-format', '--profile', '--video-sync',
    '--interpolation', '--tscale', '--volume', '--mute', '--audio-device',
    '--audio-channels', '--sub-visibility', '--sub-pos', '--sub-scale', '--sub-font',
    '--sub-font-size', '--no-audio', '--no-video', '--force-window', '--cursor-autohide',
    '--terminal', '--input-terminal', '--no-config', '--load-scripts', '--ytdl',
    '--ytdl-format', '--ytdl-raw-options', '--user-agent', '--referrer', '--idle'
}

def is_safe_url(url):
    """
    Validates a URL against SSRF attacks and unsafe protocols.
    NOTE: This check is subject to TOCTOU (DNS Rebinding) if the caller resolves 
    the hostname again during the actual fetch. Secure implementations should 
    pin the resolved IP or use a fetcher that respects the validated IP.
    """
    if not url or not isinstance(url, str):
        return False
        
    if len(url) > SECURITY_LIMITS['MAX_URL_LENGTH']:
        logging.warning(f"Security: URL exceeds length limit.")
        return False

    try:
        # Protocol Check
        if not url.lower().startswith(ALLOWED_PROTOCOLS):
             logging.warning(f"Security: Rejected unsafe protocol: {url[:10]}...")
             return False

        parsed = urlparse(url)
        hostname = parsed.hostname
        if not hostname:
            return True # Local file or similar

        # 1. Direct IP Check
        try:
            ip = ipaddress.ip_address(hostname)
            if ip.is_private or ip.is_loopback or ip.is_link_local:
                logging.warning(f"Security: Direct IP SSRF Block for {hostname}")
                return False
        except ValueError:
            # Not a direct IP, continue to resolution
            pass

        # 2. Resolution Check
        try:
            ip_str = socket.gethostbyname(hostname)
        except socket.gaierror:
            return False

        ip = ipaddress.ip_address(ip_str)
        
        # Block Private/Local IPs
        if ip.is_private or ip.is_loopback or ip.is_link_local:
            logging.warning(f"Security: SSRF Block for {hostname} ({ip_str})")
            return False
            
        return True
    except Exception as e:
        logging.error(f"Security: SSRF Check Error: {e}")
        return False

def sanitize_string(s, is_filename=False):
    """Sanitizes strings for safe OSD or Filesystem usage."""
    if not isinstance(s, str):
        return s
    
    # Enforce Length Limits
    max_len = SECURITY_LIMITS['MAX_FOLDER_NAME_LENGTH'] if is_filename else SECURITY_LIMITS['MAX_TITLE_LENGTH']
    if len(s) > max_len:
        s = s[:max_len]

    if is_filename:
        # Strict filesystem blacklist
        restricted = ['/', '\\', ':', '*', '?', '"', '<', '>', '|', '$', ';', '&', '`', '\n', '\r', '\t']
        for char in restricted:
            s = s.replace(char, '')
    else:
        # Minimal OSD/JSON stripping - Allow # and & for URLs/Fragments
        restricted = ['"', '`', '$', '\n', '\r', '\t']
        for char in restricted:
            s = s.replace(char, '')
            
    return s.strip()

def sanitize_ytdlp_options(options_str):
    """Enforces a strict allowlist of yt-dlp flags."""
    if not options_str or not isinstance(options_str, str):
        return ""

    safe_options = []
    parts = re.split(r'(?<!\\),', options_str)
    
    for part in parts:
        part = part.strip()
        if not part or '=' not in part:
            continue
        
        key, value = part.split('=', 1)
        clean_key = key.strip().lower().lstrip('-')
        
        if clean_key in YTDLP_SAFE_FLAGS_ALLOWLIST:
            # Sanitize value to prevent shell injection or option breaking
            # We strip characters that could be used to chain commands or break out of strings
            clean_value = value.replace('"', '').replace("'", "").replace(';', '').replace('&', '').replace('|', '').replace('`', '').replace('\n', '').replace('\r', '')
            safe_options.append(f"{key.strip()}={clean_value}")
        else:
            logging.warning(f"Security: Removed unsafe yt-dlp flag '{clean_key}'")
        
    return ",".join(safe_options)

def validate_safe_path(path, data_dir, script_dir, temp_dir, allow_user_content=False):
    """Ensures paths for configuration reside in allowed app directories."""
    if not path: return None
    try:
        # Windows Named Pipes
        if platform.system() == "Windows" and path.startswith("\\\\.\\pipe\\"):
            return path
            
        resolved = os.path.realpath(os.path.abspath(path))
        
        # Standard Allowed Bases
        allowed = [os.path.realpath(d) for d in [data_dir, script_dir, temp_dir] if d]
        
        # Linux/Unix Runtime Sockets
        if platform.system() == "Linux":
            # 1. Shared Memory
            if os.path.exists("/dev/shm"):
                allowed.append(os.path.realpath("/dev/shm"))
            
            # 2. XDG Runtime (Standard for sockets)
            xdg_runtime = os.environ.get("XDG_RUNTIME_DIR")
            if xdg_runtime:
                allowed.append(os.path.realpath(xdg_runtime))
            
            # 3. Fallback IPC dir in home
            allowed.append(os.path.realpath(os.path.join(os.path.expanduser("~"), ".mpv_playlist_organizer_ipc")))

        if any(resolved.startswith(prefix) for prefix in allowed):
            return resolved
        
        if allow_user_content: return resolved
        logging.warning(f"Security: Path outside sandbox: {resolved}")
        return None
    except Exception as e:
        logging.error(f"Path validation error: {e}")
        return None


def validate_payload(data):
    """Validates the structure and size of incoming IPC messages."""
    if not isinstance(data, dict):
        return False, "Invalid payload type"

    action = data.get('action')
    if not action or not isinstance(action, str):
        return False, "Missing action"

    # Recursive size check
    def check_size(obj):
        if isinstance(obj, str):
            # Use MAX_STRING_LENGTH for general strings, but stay within total message limit
            if len(obj) > SECURITY_LIMITS['MAX_STRING_LENGTH']:
                return False
        if isinstance(obj, (list, dict)) and len(obj) > SECURITY_LIMITS['MAX_PLAYLIST_ITEMS']:
            return False
        if isinstance(obj, dict):
            return all(check_size(k) and check_size(v) for k, v in obj.items())
        if isinstance(obj, list):
            return all(check_size(i) for i in obj)
        return True

    if not check_size(data):
        return False, "Payload data exceeds security limits"
    
    return True, None

def mask_path(text, data_dir, script_dir, home_dir=None):
    """Masks system paths in logs/errors to prevent info leakage."""
    if not text or not isinstance(text, str):
        return text
    
    if home_dir is None:
        home_dir = os.path.expanduser("~")
    
    replacements = [
        (data_dir, "<DATA_DIR>"),
        (script_dir, "<APP_DIR>"),
        (home_dir, "<HOME>")
    ]
    # Replace longest paths first to avoid partial masking
    for original, placeholder in sorted(replacements, key=lambda x: len(x[0]), reverse=True):
        if original: text = text.replace(original, placeholder)
    return text
