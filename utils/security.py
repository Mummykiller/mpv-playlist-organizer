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

# --- Subprocess Environment Scrubbing ---
PYTHON_ENV_VARS_TO_SCRUB = {
    'PYTHONPATH',
    'PYTHONHOME',
    'PYTHONIOENCODING',
    'PYTHONDONTWRITEBYTECODE',
    'PYTHONUNBUFFERED',
}

POSIX_ALLOWED_ENV_VARS = {
    'HOME', 'LANG', 'LC_ALL', 'LOGNAME', 'PATH', 'PWD', 'SHELL', 'TERM', 'USER',
    'DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
    'XDG_CACHE_HOME', 'DBUS_SESSION_BUS_ADDRESS',
    'WAYLAND_DISPLAY', 'XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP',
    'MPV_HOME', 'PULSE_SERVER', 'PIPEWIRE_RUNTIME_DIR',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
    'SSL_CERT_FILE', 'SSL_CERT_DIR'
}

WINDOWS_SENSITIVE_ENV_PREFIXES = {
    'AWS_', 'GIT_', 'SSH_', 'SECRET', 'TOKEN', 'PASSWORD', 'API_KEY'
}

def get_scrubbed_env(base_env=None, keep_terminal=False) -> dict:
    """
    Scrubs environment variables for secure and isolated subprocess execution.
    - Strips Python runtime contamination variables (PYTHONPATH, PYTHONHOME, etc.).
    - On Windows, retains safe system variables while stripping sensitive credential keys.
    - On POSIX, restricts to a vetted allowlist unless keep_terminal is True.
    Returns a clean dictionary.
    """
    if base_env is None:
        source_env = os.environ.copy()
    else:
        source_env = dict(base_env)

    # 1. Strip Python contamination variables
    for var in PYTHON_ENV_VARS_TO_SCRUB:
        source_env.pop(var, None)

    if keep_terminal:
        return source_env

    # 2. Platform-specific security filtering
    if platform.system() == "Windows":
        # Windows: Retain full environment minus sensitive credentials
        clean_env = {}
        for key, val in source_env.items():
            key_upper = key.upper()
            if not any(s in key_upper for s in WINDOWS_SENSITIVE_ENV_PREFIXES):
                clean_env[key] = val
        return clean_env
    else:
        # Linux / macOS: Strict whitelist approach
        clean_env = {}
        for key, val in source_env.items():
            if key.upper() in POSIX_ALLOWED_ENV_VARS or key.startswith("LC_") or key.startswith("XDG_"):
                clean_env[key] = val
        return clean_env

# --- Protocol Allowlist ---
ALLOWED_PROTOCOLS = ('http://', 'https://', 'file://', 'udp://', 'rtmp://', 'rtsp://', 'mms://')
ALLOWED_WEB_PROTOCOLS = ('http://', 'https://')

# --- SSRF Blocked Hostnames ---
BLOCKED_HOSTNAMES = {
    'localhost',
    'localhost.localdomain',
    'ip6-localhost',
    'ip6-loopback',
    'metadata.google.internal',
    'metadata.internal',
    'instance-data',
}

def parse_obscured_ip(host: str):
    """
    Parses numeric, octal, hex, and dotted-integer IP obfuscation formats
    commonly used in SSRF evasions (e.g., 2130706433, 0177.0.0.1, 0x7f000001).
    Returns an ipaddress.IPv4Address object or None.
    """
    if not host or not isinstance(host, str):
        return None

    # 1. Direct Integer / Dword literal (e.g., 2130706433 for 127.0.0.1)
    if host.isdigit():
        try:
            val = int(host, 10)
            if 0 <= val <= 0xFFFFFFFF:
                return ipaddress.IPv4Address(val)
        except (ValueError, OverflowError) as e:
            logging.debug(f"Obscured IP: Failed to parse integer host '{host}': {e}")

    # 2. Hex Dword (e.g., 0x7f000001 or 0xa9fea9fe)
    if host.lower().startswith('0x') and not any(c in host for c in ':.'):
        try:
            val = int(host, 16)
            if 0 <= val <= 0xFFFFFFFF:
                return ipaddress.IPv4Address(val)
        except (ValueError, OverflowError) as e:
            logging.debug(f"Obscured IP: Failed to parse hex host '{host}': {e}")

    # 3. Classful Dotted variations (octal, hex, and decimal)
    parts = host.split('.')
    if len(parts) in (1, 2, 3, 4):
        try:
            nums = []
            for p in parts:
                p_lower = p.lower()
                if p_lower.startswith('0x'):
                    nums.append(int(p_lower, 16))
                elif p_lower.startswith('0') and len(p_lower) > 1 and p_lower.isdigit():
                    nums.append(int(p_lower, 8))
                elif p_lower.isdigit():
                    nums.append(int(p_lower, 10))
                else:
                    return None

            if len(nums) == 4 and all(0 <= n <= 255 for n in nums):
                return ipaddress.IPv4Address((nums[0] << 24) | (nums[1] << 16) | (nums[2] << 8) | nums[3])
            elif len(nums) == 3 and 0 <= nums[0] <= 255 and 0 <= nums[1] <= 255 and 0 <= nums[2] <= 0xFFFF:
                return ipaddress.IPv4Address((nums[0] << 24) | (nums[1] << 16) | nums[2])
            elif len(nums) == 2 and 0 <= nums[0] <= 255 and 0 <= nums[1] <= 0xFFFFFF:
                return ipaddress.IPv4Address((nums[0] << 24) | nums[1])
            elif len(nums) == 1 and 0 <= nums[0] <= 0xFFFFFFFF:
                return ipaddress.IPv4Address(nums[0])
        except (ValueError, OverflowError) as e:
            logging.debug(f"Obscured IP: Failed to parse classful dotted host '{host}': {e}")
            return None

    return None

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

def is_safe_url(url, web_only=False):
    """
    Validates a URL against SSRF attacks and unsafe protocols.
    - Rejects disallowed URI schemes (web_only strictly permits http/https).
    - Blocks private IP ranges (RFC 1918), loopback, link-local, CGNAT, 0.0.0.0/8,
      cloud metadata addresses (169.254.169.254, metadata.google.internal),
      and IPv4-mapped IPv6 evasions.
    - Strips userinfo credentials and inspects integer/octal/hex obfuscations.
    """
    if not url or not isinstance(url, str):
        return False
        
    if len(url) > SECURITY_LIMITS['MAX_URL_LENGTH']:
        logging.warning("Security: URL exceeds length limit.")
        return False

    try:
        url_lower = url.lower()
        allowed = ALLOWED_WEB_PROTOCOLS if web_only else ALLOWED_PROTOCOLS
        if not url_lower.startswith(allowed):
            logging.warning(f"Security: Rejected unsafe protocol: {url[:10]}...")
            return False

        parsed = urlparse(url)
        scheme = parsed.scheme.lower()
        hostname = parsed.hostname

        # For file:// URLs, hostname is usually empty for local paths (file:///path/to/file)
        if not hostname:
            if scheme == 'file':
                return not web_only
            return True

        clean_host = hostname.strip("[]").lower()
        if "%" in clean_host:
            clean_host = clean_host.split("%", 1)[0]

        # 1. Cloud Metadata & Loopback Hostname Denylist
        if (
            clean_host in BLOCKED_HOSTNAMES
            or clean_host.endswith('.localhost')
            or clean_host.endswith('.local')
        ):
            logging.warning(f"Security: SSRF Block for restricted hostname: {clean_host}")
            return False

        def _is_unsafe_ip(ip_obj):
            if ip_obj.version == 6 and ip_obj.ipv4_mapped:
                ip_obj = ip_obj.ipv4_mapped

            if (
                ip_obj.is_private
                or ip_obj.is_loopback
                or ip_obj.is_link_local
                or ip_obj.is_unspecified
                or ip_obj.is_reserved
                or (ip_obj.is_multicast and scheme != "udp")
            ):
                return True

            if ip_obj.version == 4:
                # 0.0.0.0/8 (current network / Linux local)
                if (int(ip_obj) & 0xFF000000) == 0:
                    return True
                # 100.64.0.0/10 (Carrier-Grade NAT RFC 6598)
                if (int(ip_obj) & 0xFFC00000) == 0x64400000:
                    return True

            return False

        # 2. Obscured IP Check (integer, hex dword, octal dotted)
        obscured_ip = parse_obscured_ip(clean_host)
        if obscured_ip is not None:
            if _is_unsafe_ip(obscured_ip):
                logging.warning(f"Security: Obscured IP SSRF Block for {clean_host} ({obscured_ip})")
                return False
            return True

        # 3. Direct IP Literal Check (IPv4 or IPv6)
        try:
            ip = ipaddress.ip_address(clean_host)
            if _is_unsafe_ip(ip):
                logging.warning(f"Security: Direct IP SSRF Block for {clean_host}")
                return False
            return True
        except ValueError as e:
            logging.debug(f"SSRF Check: Hostname '{clean_host}' is not a direct IP literal: {e}")

        # 4. Resolution Check (DNS lookup with offline/sandbox fallback)
        try:
            addr_info = socket.getaddrinfo(clean_host, None)
            if addr_info:
                for res in addr_info:
                    sockaddr = res[4]
                    if not sockaddr:
                        continue
                    ip_str = sockaddr[0]
                    if "%" in ip_str:
                        ip_str = ip_str.split("%", 1)[0]
                    ip = ipaddress.ip_address(ip_str)
                    if _is_unsafe_ip(ip):
                        logging.warning(f"Security: SSRF Block for resolved IP {clean_host} ({ip_str})")
                        return False
        except socket.gaierror as e:
            # When offline or inside network-isolated sandbox, gaierror is expected for legitimate domains
            logging.debug(f"SSRF Check: DNS resolution failed for '{clean_host}': {e}")

        return True
    except Exception as e:
        logging.error(f"Security: SSRF Check Error: {e}")
        return False

def is_safe_web_url(url):
    """Convenience helper enforcing web-only HTTP/HTTPS protocol with SSRF validation."""
    return is_safe_url(url, web_only=True)

def sanitize_string(s, is_filename=False, is_url=False):
    """Sanitizes strings for safe OSD or Filesystem usage."""
    if not isinstance(s, str):
        return s

    if not is_filename and not is_url:
        s_lower = s.lstrip().lower()
        if s_lower.startswith(('http://', 'https://', 'file://', 'rtmp://', 'rtsp://', 'mms://', 'udp://')):
            is_url = True

    # Enforce Length Limits
    if is_filename:
        max_len = SECURITY_LIMITS['MAX_FOLDER_NAME_LENGTH']
    elif is_url:
        max_len = SECURITY_LIMITS['MAX_URL_LENGTH']
    else:
        max_len = SECURITY_LIMITS['MAX_TITLE_LENGTH']

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

        if any(os.path.commonpath([resolved, prefix]) == prefix for prefix in allowed):
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
        (path, tag) for path, tag in [
            (data_dir, "<DATA_DIR>"),
            (script_dir, "<APP_DIR>"),
            (home_dir, "<HOME>")
        ] if path
    ]
    # Replace longest paths first to avoid partial masking
    for original, placeholder in sorted(replacements, key=lambda x: len(x[0]), reverse=True):
        if original: text = text.replace(original, placeholder)
    return text
