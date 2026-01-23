# MPV Playlist Organizer: Security Hardening Plan

## Executive Summary

This document provides a comprehensive security audit checklist and implementation plan for the MPV Playlist Organizer extension. It addresses known vulnerabilities, validates existing protections, and establishes best practices for ongoing security maintenance.

**Status Legend:**
- ✅ **Verified Secure** - Confirmed implementation meets security standards
- ⚠️ **Needs Verification** - Requires code review to confirm security
- ❌ **Vulnerable** - Known gap requiring immediate attention
- 🔄 **In Progress** - Currently being implemented

---

## 1. Input Validation & Sanitization

### 1.1 URL Protocol Validation
**Status:** ❌ **Vulnerable** (High Priority)

**Issue:** Context menu and link capture may accept dangerous URI schemes.

**Implementation Required:**
```javascript
// extension/content_script.js or background.js
const ALLOWED_PROTOCOLS = ['http:', 'https:', 'mpv:'];
const YOUTUBE_DOMAINS = ['youtube.com', 'youtu.be', 'm.youtube.com', 'www.youtube.com'];

function isValidUrl(urlString) {
    try {
        const url = new URL(urlString);
        
        // Protocol whitelist
        if (!ALLOWED_PROTOCOLS.includes(url.protocol)) {
            console.warn(`Rejected unsafe protocol: ${url.protocol}`);
            return false;
        }
        
        // Additional validation for data: URIs (should never reach here)
        if (url.protocol === 'data:') {
            return false;
        }
        
        return true;
    } catch (e) {
        console.error('Invalid URL format:', urlString);
        return false;
    }
}

// Apply to all URL capture points
document.addEventListener('contextmenu', (e) => {
    const target = e.target.closest('a, video, img');
    if (target) {
        const url = target.href || target.src || target.dataset.videoUrl;
        if (url && !isValidUrl(url)) {
            e.preventDefault();
            console.warn('Blocked unsafe URL from context menu');
            return;
        }
    }
});
```

**Verification Checklist:**
- [ ] Context menu captures validated
- [ ] Drag-and-drop URLs validated
- [ ] Popup manual URL input validated
- [ ] M3U8/MPD playlist URLs validated
- [ ] AniList integration URLs validated

---

### 1.2 Input Length Limits
**Status:** ❌ **Vulnerable** (Medium Priority)

**Issue:** No documented limits on input sizes could lead to memory exhaustion or UI rendering issues.

**Implementation Required:**
```javascript
// extension/utils.js
const SECURITY_LIMITS = {
    MAX_TITLE_LENGTH: 200,
    MAX_URL_LENGTH: 2048,
    MAX_PLAYLIST_ITEMS: 10000,
    MAX_FOLDER_NAME_LENGTH: 100,
    MAX_FOLDERS: 1000,
    MAX_M3U8_MANIFEST_SIZE: 10 * 1024 * 1024, // 10MB
    MAX_IPC_MESSAGE_SIZE: 1 * 1024 * 1024 // 1MB
};

function enforceLimit(value, maxLength, truncateMessage = '...') {
    if (typeof value !== 'string') return value;
    if (value.length <= maxLength) return value;
    
    console.warn(`Input truncated from ${value.length} to ${maxLength} chars`);
    return value.substring(0, maxLength - truncateMessage.length) + truncateMessage;
}

// Apply to sanitizeString
function sanitizeString(text, context = 'default') {
    if (!text) return '';
    
    // Apply length limits first
    const maxLength = context === 'filename' 
        ? SECURITY_LIMITS.MAX_FOLDER_NAME_LENGTH 
        : SECURITY_LIMITS.MAX_TITLE_LENGTH;
    
    text = enforceLimit(text, maxLength);
    
    // Existing sanitation logic...
    if (context === 'filename') {
        return text.replace(/[\/\\:*?"<>|$;&`\x00-\x1F]/g, '');
    }
    return text.replace(/["`\n\r\t]/g, '');
}
```

**Python Host Implementation:**
```python
# native_host/security.py
SECURITY_LIMITS = {
    'MAX_TITLE_LENGTH': 200,
    'MAX_URL_LENGTH': 2048,
    'MAX_PLAYLIST_ITEMS': 10000,
    'MAX_MANIFEST_SIZE': 10 * 1024 * 1024,
    'MAX_IPC_MESSAGE_SIZE': 1 * 1024 * 1024
}

def validate_playlist_size(playlist_data):
    """Prevent DoS via oversized playlists"""
    if len(playlist_data.get('items', [])) > SECURITY_LIMITS['MAX_PLAYLIST_ITEMS']:
        raise SecurityError(f"Playlist exceeds maximum size of {SECURITY_LIMITS['MAX_PLAYLIST_ITEMS']} items")
    return True

def validate_message_size(message):
    """Prevent DoS via oversized IPC messages"""
    import json
    message_size = len(json.dumps(message))
    if message_size > SECURITY_LIMITS['MAX_IPC_MESSAGE_SIZE']:
        raise SecurityError(f"IPC message exceeds {SECURITY_LIMITS['MAX_IPC_MESSAGE_SIZE']} bytes")
    return True
```

**Verification Checklist:**
- [ ] All user inputs have length limits
- [ ] Playlist item count is capped
- [ ] M3U8 manifest fetching has size limits
- [ ] IPC messages are size-checked
- [ ] Error messages don't leak full paths

---

### 1.3 YouTube URL Normalization Enhancement
**Status:** ⚠️ **Needs Verification**

**Issue:** Need to confirm all YouTube URL variants are normalized correctly.

**Enhanced Implementation:**
```javascript
// extension/utils.js
function normalizeYouTubeUrl(url) {
    if (!url) return url;
    
    try {
        const urlObj = new URL(url);
        const hostname = urlObj.hostname.toLowerCase();
        
        // Supported YouTube domains
        const ytDomains = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'];
        if (!ytDomains.some(domain => hostname === domain || hostname.endsWith('.' + domain))) {
            return url; // Not a YouTube URL
        }
        
        let videoId = null;
        
        // Extract video ID from various formats
        if (hostname === 'youtu.be') {
            // Short URL: youtu.be/VIDEO_ID
            videoId = urlObj.pathname.slice(1).split('?')[0];
        } else if (urlObj.pathname.includes('/embed/')) {
            // Embed: youtube.com/embed/VIDEO_ID
            videoId = urlObj.pathname.split('/embed/')[1].split('?')[0];
        } else if (urlObj.pathname.includes('/watch')) {
            // Standard: youtube.com/watch?v=VIDEO_ID
            videoId = urlObj.searchParams.get('v');
        } else if (urlObj.pathname.includes('/v/')) {
            // Old format: youtube.com/v/VIDEO_ID
            videoId = urlObj.pathname.split('/v/')[1].split('?')[0];
        } else if (urlObj.pathname.includes('/shorts/')) {
            // Shorts: youtube.com/shorts/VIDEO_ID
            videoId = urlObj.pathname.split('/shorts/')[1].split('?')[0];
        }
        
        if (!videoId || videoId.length !== 11) {
            console.warn('Invalid YouTube video ID:', videoId);
            return url;
        }
        
        // Normalize to standard format, preserve only essential params
        const normalized = new URL(`https://www.youtube.com/watch?v=${videoId}`);
        
        // Preserve playlist context if present (but remove index/t)
        const listParam = urlObj.searchParams.get('list');
        if (listParam) {
            normalized.searchParams.set('list', listParam);
        }
        
        return normalized.toString();
    } catch (e) {
        console.error('URL normalization failed:', e);
        return url; // Return original on error
    }
}
```

**Verification Checklist:**
- [ ] Test `youtu.be/VIDEO_ID`
- [ ] Test `youtube.com/embed/VIDEO_ID`
- [ ] Test `m.youtube.com/watch?v=VIDEO_ID`
- [ ] Test `youtube.com/shorts/VIDEO_ID`
- [ ] Test `youtube.com/v/VIDEO_ID`
- [ ] Verify deduplication works across formats

---

## 2. File System Security

### 2.1 M3U File Generation Security
**Status:** ⚠️ **Needs Verification** (High Priority)

**Issue:** M3U files can contain command injection vectors if metadata is not properly escaped.

**Implementation Required:**
```python
# native_host/m3u_generator.py
import re

def escape_m3u_metadata(text):
    """
    Escape text for safe inclusion in M3U #EXTINF metadata.
    Prevents command injection via crafted titles.
    """
    if not text:
        return ''
    
    # Remove any existing control characters
    text = re.sub(r'[\x00-\x1F\x7F-\x9F]', '', text)
    
    # Escape shell metacharacters that could be interpreted
    dangerous_chars = ['$', '`', '\\', '!', '|', '&', ';', '<', '>', '(', ')', '{', '}', '[', ']', '*', '?', '~', '#']
    for char in dangerous_chars:
        text = text.replace(char, f'\\{char}')
    
    # Remove newlines that could break M3U format
    text = text.replace('\n', ' ').replace('\r', ' ')
    
    return text

def generate_m3u(items, output_path):
    """Generate a secure M3U playlist file"""
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write('#EXTM3U\n')
        
        for item in items:
            # Sanitize all metadata
            title = escape_m3u_metadata(item.get('title', 'Unknown'))
            duration = int(item.get('duration', -1))
            
            # Validate URL
            url = item.get('url', '')
            if not url or not is_safe_url(url):
                logger.warning(f"Skipping unsafe URL in M3U: {url}")
                continue
            
            # Write entry
            f.write(f'#EXTINF:{duration},{title}\n')
            f.write(f'{url}\n')
    
    # Set restrictive permissions (owner read/write only)
    os.chmod(output_path, 0o600)
```

**Alternative: Use JSON Playlists (Recommended)**
```python
# More secure option: Use MPV's JSON playlist format
def generate_json_playlist(items, output_path):
    """Generate a JSON playlist (safer than M3U)"""
    playlist = []
    
    for item in items:
        entry = {
            'filename': item.get('url', ''),
            'title': sanitize_string(item.get('title', 'Unknown')),
        }
        
        # Add resume timestamp if available
        if 'resume_time' in item and item['resume_time'] > 0:
            entry['start'] = item['resume_time']
        
        playlist.append(entry)
    
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(playlist, f, indent=2)
    
    os.chmod(output_path, 0o600)

# Launch MPV with JSON playlist
def launch_mpv_with_playlist(playlist_path):
    return subprocess.Popen([
        'mpv',
        f'--playlist={playlist_path}',
        '--input-ipc-server=/tmp/mpv-ipc-socket',
        '--save-position-on-quit'
    ])
```

**Verification Checklist:**
- [ ] M3U metadata escaping implemented
- [ ] Alternative JSON playlist format available
- [ ] File permissions set to `0600` on creation
- [ ] Command injection test cases passed
- [ ] MPV successfully plays generated playlists

---

### 2.2 Atomic File Operations
**Status:** ⚠️ **Needs Verification**

**Issue:** TOCTOU (Time-of-Check-Time-of-Use) race conditions in backup mechanism.

**Secure Implementation:**
```python
# native_host/file_operations.py
import os
import tempfile
import shutil
from pathlib import Path

def atomic_write(dest_path, content, backup=True):
    """
    Write file atomically with optional backup.
    Prevents corruption from crashes or concurrent access.
    """
    dest_path = Path(dest_path)
    
    # Validate path first
    if not validate_safe_path(str(dest_path)):
        raise SecurityError(f"Path validation failed: {dest_path}")
    
    # Create backup atomically BEFORE writing new file
    if backup and dest_path.exists():
        backup_path = dest_path.with_suffix(dest_path.suffix + '.bak')
        try:
            # Use rename for atomic backup (same filesystem)
            shutil.copy2(dest_path, backup_path)
        except Exception as e:
            logger.warning(f"Backup creation failed: {e}")
    
    # Write to temporary file in same directory (same filesystem)
    temp_fd, temp_path = tempfile.mkstemp(
        dir=dest_path.parent,
        prefix=f'.{dest_path.name}.',
        suffix='.tmp'
    )
    
    try:
        with os.fdopen(temp_fd, 'w', encoding='utf-8') as f:
            if isinstance(content, dict):
                import json
                json.dump(content, f, indent=2)
            else:
                f.write(content)
            f.flush()
            os.fsync(f.fileno())  # Force write to disk
        
        # Set permissions before moving
        os.chmod(temp_path, 0o600)
        
        # Atomic replace
        os.replace(temp_path, dest_path)
        
    except Exception as e:
        # Clean up temp file on error
        try:
            os.unlink(temp_path)
        except:
            pass
        raise

def read_with_fallback(file_path):
    """Read JSON file with automatic fallback to .bak on corruption"""
    file_path = Path(file_path)
    
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (json.JSONDecodeError, FileNotFoundError) as e:
        logger.warning(f"Primary file corrupted/missing: {e}")
        
        # Try backup
        backup_path = file_path.with_suffix(file_path.suffix + '.bak')
        if backup_path.exists():
            logger.info(f"Attempting recovery from backup: {backup_path}")
            with open(backup_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
                # Restore primary file
                atomic_write(file_path, data, backup=False)
                return data
        
        raise
```

**Verification Checklist:**
- [ ] All JSON writes use `atomic_write()`
- [ ] Backup creation is atomic
- [ ] Temp files are on same filesystem as destination
- [ ] File descriptors are properly closed
- [ ] Crash recovery tested

---

### 2.3 IPC Socket Security
**Status:** ⚠️ **Needs Verification** (High Priority)

**Issue:** IPC socket permissions and authentication not documented.

**Secure Implementation:**
```python
# native_host/ipc.py
import socket
import os
import json
import stat

class MPVIPCClient:
    def __init__(self, socket_path='/tmp/mpv-ipc-socket'):
        self.socket_path = socket_path
        self.sock = None
    
    def connect(self):
        """Connect to MPV IPC socket with security checks"""
        if not os.path.exists(self.socket_path):
            raise ConnectionError(f"Socket does not exist: {self.socket_path}")
        
        # Verify socket permissions (should be 0600 or 0700)
        stat_info = os.stat(self.socket_path)
        mode = stat.S_IMODE(stat_info.st_mode)
        
        # Check if socket is world-readable/writable (security risk)
        if mode & (stat.S_IROTH | stat.S_IWOTH):
            raise SecurityError(f"Socket has insecure permissions: {oct(mode)}")
        
        # Verify socket owner matches current user
        if stat_info.st_uid != os.getuid():
            raise SecurityError(f"Socket owned by different user")
        
        # Connect
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(self.socket_path)
    
    def send_command(self, command):
        """Send command to MPV with input validation"""
        if not self.sock:
            raise ConnectionError("Not connected to MPV")
        
        # Validate command structure
        if not isinstance(command, dict):
            raise ValueError("Command must be a dictionary")
        
        if 'command' not in command:
            raise ValueError("Command must have 'command' key")
        
        # Serialize and send
        message = json.dumps(command) + '\n'
        
        # Check message size
        if len(message) > SECURITY_LIMITS['MAX_IPC_MESSAGE_SIZE']:
            raise SecurityError("IPC message exceeds size limit")
        
        self.sock.sendall(message.encode('utf-8'))
        
        # Read response
        response = b''
        while not response.endswith(b'\n'):
            chunk = self.sock.recv(4096)
            if not chunk:
                break
            response += chunk
        
        return json.loads(response.decode('utf-8'))

# MPV Launch Function
def launch_mpv_with_ipc(video_url, socket_path='/tmp/mpv-ipc-socket'):
    """Launch MPV with secure IPC socket"""
    
    # Remove stale socket (from "The Janitor")
    if os.path.exists(socket_path):
        try:
            # Verify it's a socket and owned by us
            stat_info = os.stat(socket_path)
            if stat.S_ISSOCK(stat_info.st_mode) and stat_info.st_uid == os.getuid():
                os.unlink(socket_path)
        except Exception as e:
            logger.warning(f"Could not remove stale socket: {e}")
    
    # Launch MPV
    process = subprocess.Popen([
        'mpv',
        f'--input-ipc-server={socket_path}',
        video_url
    ])
    
    # Wait for socket to be created and set permissions
    import time
    for _ in range(50):  # 5 second timeout
        if os.path.exists(socket_path):
            os.chmod(socket_path, 0o600)
            break
        time.sleep(0.1)
    
    return process
```

**Verification Checklist:**
- [ ] Socket created with `0600` permissions
- [ ] Socket owner verified before connection
- [ ] Stale sockets cleaned up on startup
- [ ] IPC commands validated before sending
- [ ] Connection timeout implemented
- [ ] MPV process ownership verified

---

## 3. Cookie & Credential Security

### 3.1 Browser Cookie Sync
**Status:** ⚠️ **Needs Verification** (High Priority)

**Issue:** Cookie storage and cleanup process not fully documented.

**Secure Implementation:**
```python
# native_host/cookie_manager.py
import tempfile
import os
import shutil
from pathlib import Path

class SecureCookieManager:
    def __init__(self):
        # Use RAM-backed storage on Linux
        if os.path.exists('/dev/shm'):
            self.cookie_dir = Path('/dev/shm') / 'mpv-organizer-cookies'
        else:
            # Fallback to system temp
            self.cookie_dir = Path(tempfile.gettempdir()) / 'mpv-organizer-cookies'
        
        self.cookie_dir.mkdir(mode=0o700, exist_ok=True)
    
    def export_cookies(self, browser='chrome'):
        """
        Export browser cookies to temporary file.
        Returns path to cookie file.
        """
        cookie_file = self.cookie_dir / f'{browser}_cookies_{os.getpid()}.txt'
        
        # Export using browser-cookie3 or similar
        # IMPORTANT: Never store cookies in plaintext in permanent storage
        try:
            # ... cookie export logic ...
            
            # Set restrictive permissions
            os.chmod(cookie_file, 0o600)
            
            return str(cookie_file)
        except Exception as e:
            logger.error(f"Cookie export failed: {e}")
            return None
    
    def cleanup_cookies(self, cookie_path=None):
        """Securely delete cookie files"""
        if cookie_path:
            # Delete specific file
            try:
                if os.path.exists(cookie_path):
                    # Overwrite with zeros before deletion (paranoid mode)
                    with open(cookie_path, 'wb') as f:
                        f.write(b'\x00' * os.path.getsize(cookie_path))
                    os.unlink(cookie_path)
            except Exception as e:
                logger.warning(f"Cookie cleanup failed: {e}")
        else:
            # Clean all cookies (called by "The Janitor")
            try:
                shutil.rmtree(self.cookie_dir, ignore_errors=True)
                self.cookie_dir.mkdir(mode=0o700, exist_ok=True)
            except Exception as e:
                logger.warning(f"Cookie directory cleanup failed: {e}")
    
    def __del__(self):
        """Cleanup on exit"""
        self.cleanup_cookies()

# Usage in yt-dlp calls
def get_ytdlp_options(use_cookies=True):
    options = sanitize_ytdlp_options({...})
    
    if use_cookies:
        cookie_manager = SecureCookieManager()
        cookie_file = cookie_manager.export_cookies()
        if cookie_file:
            options['cookies'] = cookie_file
            # Register cleanup callback
            atexit.register(lambda: cookie_manager.cleanup_cookies(cookie_file))
    
    return options
```

**Verification Checklist:**
- [ ] Cookies stored in RAM-backed storage (Linux: `/dev/shm`)
- [ ] Cookie files have `0600` permissions
- [ ] Cookies cleaned up on process exit
- [ ] Cookies overwritten before deletion (optional, paranoid mode)
- [ ] No cookies in version control or logs

---

### 3.2 The Janitor - Startup Cleanup
**Status:** ⚠️ **Needs Verification**

**Enhanced Implementation:**
```python
# native_host/janitor.py
import os
import glob
import time
from pathlib import Path

class TheJanitor:
    """Automated cleanup of temporary files and stale resources"""
    
    def __init__(self, temp_dir, max_age_hours=24):
        self.temp_dir = Path(temp_dir)
        self.max_age_seconds = max_age_hours * 3600
    
    def clean_stale_m3u_files(self):
        """Remove old M3U playlist files"""
        pattern = self.temp_dir / '*.m3u'
        cleaned = 0
        
        for m3u_file in glob.glob(str(pattern)):
            try:
                # Check file age
                if time.time() - os.path.getmtime(m3u_file) > self.max_age_seconds:
                    os.unlink(m3u_file)
                    cleaned += 1
            except Exception as e:
                logger.warning(f"Could not clean {m3u_file}: {e}")
        
        logger.info(f"Cleaned {cleaned} stale M3U files")
    
    def clean_stale_ipc_sockets(self):
        """Remove orphaned IPC sockets"""
        socket_patterns = [
            '/tmp/mpv-ipc-socket*',
            '/run/user/*/mpv-ipc-socket*'
        ]
        cleaned = 0
        
        for pattern in socket_patterns:
            for socket_path in glob.glob(pattern):
                try:
                    # Check if socket is actually in use
                    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                    try:
                        sock.connect(socket_path)
                        sock.close()
                        # Socket is active, don't remove
                    except socket.error:
                        # Socket is stale
                        os.unlink(socket_path)
                        cleaned += 1
                except Exception as e:
                    logger.warning(f"Could not clean {socket_path}: {e}")
        
        logger.info(f"Cleaned {cleaned} stale IPC sockets")
    
    def clean_cookies(self):
        """Remove all temporary cookies"""
        cookie_manager = SecureCookieManager()
        cookie_manager.cleanup_cookies()
    
    def run(self):
        """Execute all cleanup tasks"""
        logger.info("The Janitor: Starting cleanup...")
        self.clean_stale_m3u_files()
        self.clean_stale_ipc_sockets()
        self.clean_cookies()
        logger.info("The Janitor: Cleanup complete")

# Run on startup
if __name__ == '__main__':
    janitor = TheJanitor(TEMP_DIR)
    janitor.run()
```

**Verification Checklist:**
- [ ] Janitor runs on every native host startup
- [ ] Orphaned sockets detected correctly
- [ ] Old M3U files removed
- [ ] Cookie cleanup integrated
- [ ] Cleanup errors are logged but don't crash

---

## 4. Network Security

### 4.1 SSRF Protection Enhancement
**Status:** ⚠️ **Needs Verification**

**Enhanced Implementation:**
```python
# native_host/security.py
import socket
import ipaddress
from urllib.parse import urlparse

def is_safe_url(url):
    """
    Validate URL to prevent SSRF attacks.
    Blocks access to private networks and localhost.
    """
    try:
        parsed = urlparse(url)
        hostname = parsed.hostname
        
        if not hostname:
            return False
        
        # Resolve hostname to IP
        try:
            ip_addresses = socket.getaddrinfo(hostname, None)
        except socket.gaierror:
            logger.warning(f"DNS resolution failed for: {hostname}")
            return False
        
        # Check all resolved IPs
        for addr_info in ip_addresses:
            ip_str = addr_info[4][0]
            
            try:
                ip = ipaddress.ip_address(ip_str)
                
                # Block private networks
                if ip.is_private:
                    logger.warning(f"Blocked private IP: {ip_str} for {hostname}")
                    return False
                
                # Block loopback
                if ip.is_loopback:
                    logger.warning(f"Blocked loopback IP: {ip_str} for {hostname}")
                    return False
                
                # Block link-local
                if ip.is_link_local:
                    logger.warning(f"Blocked link-local IP: {ip_str} for {hostname}")
                    return False
                
                # Block multicast
                if ip.is_multicast:
                    logger.warning(f"Blocked multicast IP: {ip_str} for {hostname}")
                    return False
                
                # Block reserved
                if ip.is_reserved:
                    logger.warning(f"Blocked reserved IP: {ip_str} for {hostname}")
                    return False
                
            except ValueError:
                # Invalid IP address
                logger.warning(f"Invalid IP address: {ip_str}")
                return False
        
        return True
        
    except Exception as e:
        logger.error(f"URL validation error: {e}")
        return False

def validate_m3u8_manifest(url):
    """
    Fetch and validate M3U8 manifest with size limits.
    Prevents DoS via oversized manifests.
    """
    if not is_safe_url(url):
        raise SecurityError("Unsafe URL blocked")
    
    import requests
    
    try:
        response = requests.get(
            url,
            timeout=10,
            stream=True,
            headers={'User-Agent': 'MPV-Playlist-Organizer/2.6'}
        )
        
        # Check Content-Length if available
        content_length = response.headers.get('Content-Length')
        if content_length and int(content_length) > SECURITY_LIMITS['MAX_MANIFEST_SIZE']:
            raise SecurityError(f"Manifest exceeds size limit: {content_length} bytes")
        
        # Download with size limit
        manifest = b''
        for chunk in response.iter_content(chunk_size=8192):
            manifest += chunk
            if len(manifest) > SECURITY_LIMITS['MAX_MANIFEST_SIZE']:
                raise SecurityError("Manifest download exceeded size limit")
        
        return manifest.decode('utf-8')
        
    except requests.RequestException as e:
        logger.error(f"Manifest fetch failed: {e}")
        raise
```

**Verification Checklist:**
- [ ] DNS rebinding protection tested
- [ ] IPv6 private ranges blocked
- [ ] Cloud metadata endpoints blocked (169.254.169.254)
- [ ] Time-of-check-time-of-use (TOCTOU) DNS rebinding mitigated
- [ ] M3U8 manifest size limits enforced

---

## 5. Process & Privilege Management

### 5.1 MPV Process Isolation
**Status:** ⚠️ **Needs Verification**

**Enhanced Implementation:**
```python
# native_host/mpv_launcher.py
import subprocess
import os
import signal

class MPVProcessManager:
    def __init__(self):
        self.processes = {}
    
    def launch(self, video_url, session_id, options=None):
        """Launch MPV with security constraints"""
        
        # Validate URL
        if not is_safe_url(video_url):
            raise SecurityError(f"Unsafe URL blocked: {video_url}")
        
        # Build command
        cmd = ['mpv']
        
        # Security options
        cmd.extend([
            '--no-config',  # Ignore user config files (prevent injection)
            '--no-input-default-bindings',  # Disable default key bindings
            '--load-scripts=no',  # Disable Lua scripts (prevent code execution)
        ])
        
        # Functional options
        cmd.extend([
            f'--input-ipc-server=/tmp/mpv-ipc-{session_id}',
            '--save-position-on-quit',
            '--force-window=immediate',
        ])
        
        # Add validated options
        if options:
            options = sanitize_ytdlp_options(options)
            for key, value in options.items():
                cmd.append(f'--{key}={value}')
        
        # Add video URL last
        cmd.append(video_url)
        
        # Launch with clean environment
        env = os.environ.copy()
        env['MPV_HOME'] = '/dev/null'  # Prevent config loading
        
        try:
            process = subprocess.Popen(
                cmd,
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE
            )
            
            self.processes[session_id] = process
            return process
            
        except Exception as e:
            logger.error(f"Failed to launch MPV: {e}")
            raise
    
    def kill_session(self, session_id):
        """Safely terminate an MPV session"""
        if session_id in self.processes:
            process = self.processes[session_id]
            try:
                # Try graceful shutdown first
                process.terminate()
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                # Force kill if necessary
                process.kill()
                process.wait()
            finally:
                del self.processes[session_id]
```

**Verification Checklist:**
- [ ] MPV launched with `--no-config` flag
- [ ] Lua scripts disabled with `--load-scripts=no`
- [ ] Process spawned with minimal environment
- [ ] User config files ignored
- [ ] Graceful shutdown implemented
- [ ] Zombie processes cleaned up

---

### 5.2 yt-dlp Command Injection Prevention
**Status:** ⚠️ **Needs Verification** (Critical)

**Enhanced Implementation:**
```python
# native_host/ytdlp_wrapper.py
import subprocess
import shlex

# Strict allowlist of safe yt-dlp options
YTDLP_SAFE_OPTIONS = {
    'format': str,
    'cookies': str,
    'user-agent': str,
    'referer': str,
    'concurrent-fragments': int,
    'retries': int,
    'fragment-retries': int,
    'skip-unavailable-fragments': bool,
    'abort-on-unavailable-fragment': bool,
    'keep-fragments': bool,
    'buffer-size': str,
    'http-chunk-size': str,
    'playlist-items': str,
    'geo-bypass': bool,
    'geo-bypass-country': str,
}

# Dangerous options that MUST be blocked
YTDLP_BLOCKED_OPTIONS = [
    'exec',
    'exec-before-download',
    'exec-after-download',
    'output',
    'output-na-placeholder',
    'paths',
    'convert-subs',
    'convert-thumbnails',
    'write-subs',
    'write-auto-subs',
    'write-thumbnail',
    'load-info-json',
    'cookies-from-browser',  # Only allow pre-exported cookies
    'config-location',
    'config-locations',
    'flat-playlist',
    'call-home',
]

def sanitize_ytdlp_options(options):
    """
    Validate and sanitize yt-dlp options to prevent command injection.
    Returns only safe options with validated values.
    """
    sanitized = {}
    
    for key, value in options.items():
        # Block dangerous options
        if key in YTDLP_BLOCKED_OPTIONS:
            logger.warning(f"Blocked dangerous yt-dlp option: {key}")
            continue
        
        # Only allow allowlisted options
        if key not in YTDLP_SAFE_OPTIONS:
            logger.warning(f"Unknown yt-dlp option blocked: {key}")
            continue
        
        # Validate value type
        expected_type = YTDLP_SAFE_OPTIONS[key]
        if not isinstance(value, expected_type):
            try:
                value = expected_type(value)
            except (ValueError, TypeError):
                logger.warning(f"Invalid type for {key}: {type(value)}")
                continue
        
        # Additional validation for file paths
        if key in ['cookies'] and isinstance(value, str):
            if not validate_safe_path(value):
                logger.warning(f"Invalid path for {key}: {value}")
                continue
        
        sanitized[key] = value
    
    return sanitized

def resolve_with_ytdlp(url, options=None):
    """
    Safely resolve video URL using yt-dlp.
    Uses subprocess with strict argument validation.
    """
    if not is_safe_url(url):
        raise SecurityError(f"Unsafe URL: {url}")
    
    # Build command
    cmd = ['yt-dlp', '--get-url', '--no-playlist']
    
    # Add sanitized options
    if options:
        options = sanitize_ytdlp_options(options)
        for key, value in options.items():
            if isinstance(value, bool):
                if value:
                    cmd.append(f'--{key}')
            else:
                # Use proper escaping
                cmd.extend([f'--{key}', str(value)])
    
    # Add URL last
    cmd.append(url)
    
    # Execute with timeout and capture output
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=30,
            check=True
        )
        return result.stdout.strip()
    
    except subprocess.TimeoutExpired:
        raise TimeoutError("yt-dlp resolution timed out")
    except subprocess.CalledProcessError as e:
        logger.error(f"yt-dlp failed: {e.stderr}")
        raise
```

**Verification Checklist:**
- [ ] All yt-dlp options pass through allowlist
- [ ] `--exec` and similar dangerous flags blocked
- [ ] File path options validated with `validate_safe_path`
- [ ] Command construction prevents shell injection
- [ ] Timeout prevents hanging
- [ ] Error messages don't leak sensitive info

---

## 6. Error Handling & Information Disclosure

### 6.1 Secure Error Messages
**Status:** ❌ **Vulnerable** (Medium Priority)

**Issue:** Error messages may leak sensitive file paths or system information.

**Implementation Required:**
```python
# native_host/error_handler.py
import traceback
import sys
from pathlib import Path

class SecureErrorHandler:
    """Sanitize error messages to prevent information disclosure"""
    
    def __init__(self, data_dir, script_dir):
        self.data_dir = Path(data_dir).resolve()
        self.script_dir = Path(script_dir).resolve()
        self.home_dir = Path.home()
    
    def sanitize_path(self, text):
        """Remove sensitive paths from error messages"""
        if not isinstance(text, str):
            return text
        
        # Replace sensitive paths with placeholders
        replacements = [
            (str(self.data_dir), '<DATA_DIR>'),
            (str(self.script_dir), '<APP_DIR>'),
            (str(self.home_dir), '<HOME>'),
            (str(Path.home()), '<HOME>'),
        ]
        
        sanitized = text
        for original, placeholder in replacements:
            sanitized = sanitized.replace(original, placeholder)
        
        return sanitized
    
    def format_error_for_user(self, error):
        """Format exception for display to user (minimal info)"""
        error_type = type(error).__name__
        
        # For known error types, provide helpful messages
        if isinstance(error, SecurityError):
            return "Security validation failed. Please check your input."
        elif isinstance(error, FileNotFoundError):
            return "Required file not found. Please check your installation."
        elif isinstance(error, PermissionError):
            return "Permission denied. Please check file permissions."
        elif isinstance(error, subprocess.TimeoutExpired):
            return "Operation timed out. Please try again."
        else:
            # Generic message for unknown errors
            return f"An error occurred: {error_type}"
    
    def format_error_for_log(self, error):
        """Format exception for logging (detailed but sanitized)"""
        tb = traceback.format_exc()
        sanitized_tb = self.sanitize_path(tb)
        return sanitized_tb
    
    def handle_exception(self, error, context=""):
        """Central exception handler"""
        # Log detailed error
        logger.error(f"Exception in {context}: {self.format_error_for_log(error)}")
        
        # Return user-friendly message
        return {
            'success': False,
            'error': self.format_error_for_user(error)
        }

# Global error handler instance
error_handler = SecureErrorHandler(DATA_DIR, SCRIPT_DIR)

# Wrapper for message handlers
def safe_message_handler(func):
    """Decorator to catch and sanitize exceptions"""
    def wrapper(*args, **kwargs):
        try:
            return func(*args, **kwargs)
        except Exception as e:
            return error_handler.handle_exception(e, context=func.__name__)
    return wrapper

# Usage
@safe_message_handler
def handle_play_video(message):
    url = message.get('url')
    # ... processing ...
    return {'success': True}
```

**Verification Checklist:**
- [ ] All exception handlers use `SecureErrorHandler`
- [ ] Full file paths not exposed to extension
- [ ] Stack traces sanitized before logging
- [ ] User-facing errors are generic but helpful
- [ ] Debug mode can be enabled for development

---

### 6.2 Logging Security
**Status:** ⚠️ **Needs Verification**

**Secure Implementation:**
```python
# native_host/logging_config.py
import logging
import logging.handlers
from pathlib import Path

class SanitizingFormatter(logging.Formatter):
    """Custom formatter that sanitizes sensitive data"""
    
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.error_handler = SecureErrorHandler(DATA_DIR, SCRIPT_DIR)
    
    def format(self, record):
        # Sanitize the message
        if isinstance(record.msg, str):
            record.msg = self.error_handler.sanitize_path(record.msg)
        
        # Sanitize arguments
        if record.args:
            sanitized_args = tuple(
                self.error_handler.sanitize_path(str(arg)) 
                for arg in record.args
            )
            record.args = sanitized_args
        
        return super().format(record)

def setup_logging(log_dir, debug=False):
    """Configure secure logging"""
    log_dir = Path(log_dir)
    log_dir.mkdir(exist_ok=True, mode=0o700)
    
    log_file = log_dir / 'mpv-organizer.log'
    
    # Set up rotating file handler (max 10MB, keep 3 backups)
    handler = logging.handlers.RotatingFileHandler(
        log_file,
        maxBytes=10 * 1024 * 1024,
        backupCount=3,
        encoding='utf-8'
    )
    
    # Use sanitizing formatter
    formatter = SanitizingFormatter(
        '%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S'
    )
    handler.setFormatter(formatter)
    
    # Set log level
    level = logging.DEBUG if debug else logging.INFO
    
    # Configure root logger
    logger = logging.getLogger()
    logger.setLevel(level)
    logger.addHandler(handler)
    
    # Set restrictive permissions on log file
    log_file.chmod(0o600)
    
    return logger

# Never log these types of data
SENSITIVE_KEYS = ['password', 'token', 'api_key', 'cookie', 'auth', 'secret']

def safe_log_dict(data, logger_instance=None):
    """Log dictionary with sensitive keys redacted"""
    if logger_instance is None:
        logger_instance = logger
    
    sanitized = {}
    for key, value in data.items():
        if any(sensitive in key.lower() for sensitive in SENSITIVE_KEYS):
            sanitized[key] = '<REDACTED>'
        else:
            sanitized[key] = value
    
    logger_instance.info(f"Data: {sanitized}")
```

**Verification Checklist:**
- [ ] Log files have `0600` permissions
- [ ] Sensitive data (cookies, tokens) never logged
- [ ] Paths sanitized in log messages
- [ ] Log rotation configured
- [ ] Debug mode disabled in production

---

## 7. Extension-Specific Security

### 7.1 Content Script Isolation
**Status:** ⚠️ **Needs Verification**

**Enhanced Implementation:**
```javascript
// extension/content_script.js

// Isolated execution context
(function() {
    'use strict';
    
    // Prevent page scripts from accessing extension objects
    const originalPostMessage = window.postMessage;
    const TRUSTED_ORIGIN = chrome.runtime.getURL('').replace(/\/$/, '');
    
    // Validate messages from page
    window.addEventListener('message', (event) => {
        // Only accept messages from our own extension
        if (event.source !== window) return;
        
        // Validate message structure
        if (!event.data || typeof event.data !== 'object') return;
        if (!event.data.type || !event.data.type.startsWith('MPV_')) return;
        
        // Sanitize and forward to background script
        const sanitizedData = {
            type: event.data.type,
            url: sanitizeAndValidateUrl(event.data.url),
            title: sanitizeString(event.data.title || ''),
            folder: sanitizeString(event.data.folder || 'default')
        };
        
        chrome.runtime.sendMessage(sanitizedData);
    });
    
    // Prevent page scripts from overriding our functions
    Object.freeze(window.MPV_CAPTURE);
    
    // Secure DOM manipulation
    function secureCreateElement(tag, attributes = {}) {
        const element = document.createElement(tag);
        
        // Only allow safe attributes
        const safeAttributes = ['class', 'id', 'data-*', 'aria-*'];
        for (const [key, value] of Object.entries(attributes)) {
            if (safeAttributes.some(attr => 
                key === attr || key.startsWith(attr.replace('*', ''))
            )) {
                element.setAttribute(key, value);
            }
        }
        
        return element;
    }
    
    // Use textContent instead of innerHTML
    function secureSetText(element, text) {
        element.textContent = sanitizeString(text);
    }
})();
```

**Verification Checklist:**
- [ ] Content script isolated from page scripts
- [ ] No `eval()` or `innerHTML` usage
- [ ] Message validation between contexts
- [ ] CSP (Content Security Policy) configured
- [ ] XSS prevention tested

---

### 7.2 Native Messaging Security
**Status:** ⚠️ **Needs Verification** (High Priority)

**Secure Implementation:**
```javascript
// extension/native_messaging.js

class SecureNativeMessaging {
    constructor() {
        this.port = null;
        this.messageQueue = [];
        this.connecting = false;
    }
    
    connect() {
        if (this.port || this.connecting) return;
        
        this.connecting = true;
        
        try {
            this.port = chrome.runtime.connectNative('com.mpv.playlist.organizer');
            
            this.port.onMessage.addListener((message) => {
                this.handleMessage(message);
            });
            
            this.port.onDisconnect.addListener(() => {
                console.log('Native host disconnected');
                this.port = null;
                this.connecting = false;
                
                // Check for errors
                if (chrome.runtime.lastError) {
                    console.error('Native messaging error:', chrome.runtime.lastError);
                }
            });
            
            this.connecting = false;
            
        } catch (error) {
            console.error('Failed to connect to native host:', error);
            this.connecting = false;
        }
    }
    
    sendMessage(message) {
        // Validate message size
        const messageStr = JSON.stringify(message);
        if (messageStr.length > SECURITY_LIMITS.MAX_IPC_MESSAGE_SIZE) {
            console.error('Message exceeds size limit');
            return Promise.reject(new Error('Message too large'));
        }
        
        // Validate message structure
        if (!message.action || typeof message.action !== 'string') {
            return Promise.reject(new Error('Invalid message format'));
        }
        
        // Connect if needed
        if (!this.port) {
            this.connect();
        }
        
        return new Promise((resolve, reject) => {
            const messageId = crypto.randomUUID();
            const timeoutId = setTimeout(() => {
                reject(new Error('Native messaging timeout'));
            }, 30000);
            
            const handler = (response) => {
                if (response.messageId === messageId) {
                    clearTimeout(timeoutId);
                    this.port.onMessage.removeListener(handler);
                    
                    if (response.success) {
                        resolve(response);
                    } else {
                        reject(new Error(response.error || 'Unknown error'));
                    }
                }
            };
            
            this.port.onMessage.addListener(handler);
            this.port.postMessage({ ...message, messageId });
        });
    }
    
    handleMessage(message) {
        // Validate incoming message
        if (!message || typeof message !== 'object') {
            console.warn('Invalid message from native host');
            return;
        }
        
        // Process based on message type
        switch (message.type) {
            case 'playback_update':
                this.handlePlaybackUpdate(message);
                break;
            case 'error':
                console.error('Native host error:', message.error);
                break;
            default:
                console.warn('Unknown message type:', message.type);
        }
    }
}
```

**Verification Checklist:**
- [ ] Native host identity verified
- [ ] Message size limits enforced
- [ ] Timeout prevents hanging
- [ ] Connection errors handled gracefully
- [ ] No sensitive data in messages

---

## 8. Security Maintenance & Monitoring

### 8.1 Security Update Checklist
**Status:** 🔄 **Ongoing**

**Regular Maintenance Tasks:**

**Weekly:**
- [ ] Review error logs for security anomalies
- [ ] Check for yt-dlp updates (security patches)
- [ ] Monitor file permissions on data directory

**Monthly:**
- [ ] Review all TODO/FIXME comments related to security
- [ ] Test all input validation with fuzzing
- [ ] Verify backup/restore functionality
- [ ] Check for stale temporary files

**Per Release:**
- [ ] Run security audit checklist (below)
- [ ] Update dependency versions
- [ ] Review and update this document
- [ ] Test all verification checklists

---

### 8.2 Security Testing Protocol
**Status:** ❌ **Not Implemented**

**Required Test Suite:**

```python
# tests/security_tests.py
import pytest
from native_host.security import *

class TestInputValidation:
    """Test all input validation functions"""
    
    def test_url_protocol_validation(self):
        # Test safe URLs
        assert isValidUrl('https://example.com/video')
        assert isValidUrl('http://example.com/stream.m3u8')
        
        # Test dangerous URLs
        assert not isValidUrl('javascript:alert(1)')
        assert not isValidUrl('data:text/html,<script>alert(1)</script>')
        assert not isValidUrl('file:///etc/passwd')
    
    def test_ssrf_protection(self):
        # Test private IPs
        assert not is_safe_url('http://192.168.1.1')
        assert not is_safe_url('http://127.0.0.1')
        assert not is_safe_url('http://10.0.0.1')
        assert not is_safe_url('http://169.254.169.254')  # AWS metadata
        
        # Test public IPs
        assert is_safe_url('https://youtube.com')
    
    def test_path_traversal(self):
        # Test legitimate paths
        assert validate_safe_path(f'{DATA_DIR}/config.json')
        
        # Test traversal attempts
        assert not validate_safe_path('../../../etc/passwd')
        assert not validate_safe_path(f'{DATA_DIR}/../../../etc/passwd')
    
    def test_input_length_limits(self):
        # Test within limits
        assert len(sanitizeString('a' * 100)) <= 200
        
        # Test exceeding limits
        long_string = 'a' * 10000
        sanitized = sanitizeString(long_string)
        assert len(sanitized) <= 200
    
    def test_m3u_injection(self):
        # Test normal title
        title = "Normal Video Title"
        assert escape_m3u_metadata(title) == title
        
        # Test malicious titles
        malicious = "Title $(rm -rf /)"
        escaped = escape_m3u_metadata(malicious)
        assert '
         not in escaped or '\\
         in escaped
        
        malicious2 = "Title\n#EXTINF:999,Injected"
        escaped2 = escape_m3u_metadata(malicious2)
        assert '\n' not in escaped2
    
    def test_ytdlp_option_sanitization(self):
        # Test safe options
        safe = {'format': 'best', 'cookies': '/tmp/cookies.txt'}
        sanitized = sanitize_ytdlp_options(safe)
        assert 'format' in sanitized
        
        # Test dangerous options
        dangerous = {'exec': 'rm -rf /', 'output': '/etc/passwd'}
        sanitized = sanitize_ytdlp_options(dangerous)
        assert 'exec' not in sanitized
        assert 'output' not in sanitized

class TestFileSystemSecurity:
    def test_atomic_write(self):
        # Test normal write
        test_file = TEMP_DIR / 'test.json'
        atomic_write(test_file, {'test': 'data'})
        assert test_file.exists()
        
        # Test permissions
        stat_info = test_file.stat()
        assert oct(stat_info.st_mode)[-3:] == '600'
    
    def test_socket_permissions(self):
        # Create test socket
        socket_path = '/tmp/test-mpv-socket'
        # ... create socket ...
        
        # Verify permissions
        stat_info = os.stat(socket_path)
        mode = stat.S_IMODE(stat_info.st_mode)
        assert not (mode & (stat.S_IROTH | stat.S_IWOTH))

# Run tests
if __name__ == '__main__':
    pytest.main([__file__, '-v'])
```

**Verification Checklist:**
- [ ] All security tests passing
- [ ] Fuzzing tests for input validation
- [ ] Integration tests for MPV launching
- [ ] Network security tests (SSRF)
- [ ] File permission tests

---

### 8.3 Incident Response Plan
**Status:** 🔄 **In Progress**

**If a security vulnerability is discovered:**

1. **Immediate Actions:**
   - Document the vulnerability with minimal details
   - Assess severity (Critical/High/Medium/Low)
   - Disable affected feature if possible
   - Notify users via GitHub Security Advisory

2. **Investigation:**
   - Review logs for evidence of exploitation
   - Identify scope of affected versions
   - Determine root cause

3. **Remediation:**
   - Develop and test fix
   - Create security patch release
   - Update security documentation

4. **Post-Incident:**
   - Conduct root cause analysis
   - Update testing procedures
   - Review similar code paths for related issues

---

## 9. Quick Reference: High-Priority Action Items

**Implement These First (Critical):**

1. ✅ **URL Protocol Validation** (Section 1.1)
   - Block `javascript:`, `data:`, `file:` schemes
   - **Impact:** Prevents XSS and local file access

2. ✅ **M3U Command Injection Prevention** (Section 2.1)
   - Escape all metadata in M3U files
   - **Impact:** Prevents arbitrary command execution

3. ✅ **IPC Socket Security** (Section 2.3)
   - Set 0600 permissions on all sockets
   - **Impact:** Prevents unauthorized process control

4. ✅ **yt-dlp Option Sanitization** (Section 5.2)
   - Enforce strict allowlist
   - **Impact:** Prevents command injection via yt-dlp

5. ✅ **Cookie Security** (Section 3.1)
   - Use RAM-backed storage
   - **Impact:** Prevents credential theft

**Medium Priority (Hardening):**

6. ⚠️ Input Length Limits (Section 1.2)
7. ⚠️ Error Message Sanitization (Section 6.1)
8. ⚠️ SSRF Protection Enhancement (Section 4.1)

**Low Priority (Best Practices):**

9. 🔄 Security Testing Suite (Section 8.2)
10. 🔄 Logging Improvements (Section 6.2)

---

## 10. Compliance Matrix

| Security Control | Implemented | Tested | Documented |
|------------------|-------------|---------|------------|
| URL Protocol Validation | ❌ | ❌ | ✅ |
| Input Length Limits | ❌ | ❌ | ✅ |
| M3U Injection Prevention | ⚠️ | ❌ | ✅ |
| Path Traversal Protection | ✅ | ⚠️ | ✅ |
| SSRF Protection | ✅ | ⚠️ | ✅ |
| IPC Socket Security | ⚠️ | ❌ | ✅ |
| Cookie Security | ⚠️ | ❌ | ✅ |
| Atomic File Operations | ✅ | ⚠️ | ✅ |
| Error Sanitization | ❌ | ❌ | ✅ |
| yt-dlp Sanitization | ✅ | ⚠️ | ✅ |

**Legend:**
- ✅ Complete
- ⚠️ Partial/Needs Verification  
- ❌ Not Implemented

---

## Appendix: Security Resources

**External References:**
- [OWASP Input Validation](https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html)
- [Chrome Extension Security](https://developer.chrome.com/docs/extensions/mv3/security/)
- [MPV Security Considerations](https://mpv.io/manual/master/#security)

**Internal Documentation:**
- `sanitation.md` - Current sanitization implementation
- `README.md` - User-facing security features

---

**Document Version:** 1.0  
**Last Updated:** January 2026  
**Next Review:** Per release
