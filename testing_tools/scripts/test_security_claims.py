import os
import unittest
import sys

# Add project root to path
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from testing_tools.base_test import BaseTestCase
from utils import security, url_analyzer
import file_io
import mpv_session

class TestSecurityClaims(BaseTestCase):
    """
    Comprehensive security regression suite for MPV Playlist Organizer.
    Verifies security claims using safe, isolated environment checks.
    """

    def setUp(self):
        super().setUp()
        self.orig_data_dir = file_io.DATA_DIR
        file_io.initialize_paths(self.test_dir)

    def tearDown(self):
        file_io.initialize_paths(self.orig_data_dir)
        super().tearDown()

    def test_ssrf_protection(self):
        """Claim 2.2: Blocks private, loopback, link-local, and IPv6 SSRF targets."""
        # IPv4 Loopback
        self.assertFalse(security.is_safe_url("http://127.0.0.1/admin"))
        self.assertFalse(security.is_safe_url("http://127.0.0.2:8000/api"))
        self.assertFalse(security.is_safe_url("http://127.127.127.127/status"))
        self.assertFalse(security.is_safe_url("http://localhost:8080"))

        # Private Class A/B/C
        self.assertFalse(security.is_safe_url("http://192.168.1.1/config"))
        self.assertFalse(security.is_safe_url("http://10.0.0.5/meta-data"))
        self.assertFalse(security.is_safe_url("https://172.16.0.100/internal"))
        self.assertFalse(security.is_safe_url("http://172.31.255.255/secrets"))

        # Link-local / Cloud metadata endpoint
        self.assertFalse(security.is_safe_url("http://169.254.169.254/latest/meta-data"))

        # IPv6 Loopback, Link-Local, and Unique-Local
        self.assertFalse(security.is_safe_url("http://[::1]/debug"))
        self.assertFalse(security.is_safe_url("http://[::]/admin"))
        self.assertFalse(security.is_safe_url("http://[fe80::1]/private"))
        self.assertFalse(security.is_safe_url("http://[fc00::1]/internal"))
        self.assertFalse(security.is_safe_url("http://[fd12:3456:789a::1]/data"))
        self.assertFalse(security.is_safe_url("http://[::ffff:127.0.0.1]/status"))
        self.assertFalse(security.is_safe_url("http://[::ffff:169.254.169.254]/meta-data"))

        # Obfuscated Dword/Hex/Octal SSRF evasions
        self.assertFalse(security.is_safe_url("http://2130706433/")) # 127.0.0.1 as dword integer
        self.assertFalse(security.is_safe_url("http://0177.0.0.1/")) # 127.0.0.1 octal
        self.assertFalse(security.is_safe_url("http://017700000001/")) # 127.0.0.1 single octal
        self.assertFalse(security.is_safe_url("http://0x7f000001/")) # 127.0.0.1 hex
        self.assertFalse(security.is_safe_url("http://0x7f.0.0.1/")) # 127.0.0.1 mixed hex
        self.assertFalse(security.is_safe_url("http://2852039166/")) # 169.254.169.254 as dword
        self.assertFalse(security.is_safe_url("http://0xa9fea9fe/")) # 169.254.169.254 as hex
        self.assertFalse(security.is_safe_url("http://0.0.0.0/")) # Linux local bind
        self.assertFalse(security.is_safe_url("http://metadata.google.internal/computeMetadata/v1/"))
        self.assertFalse(security.is_safe_url("http://instance-data/latest/meta-data"))

        # Web Protocol Isolation (is_safe_web_url)
        self.assertTrue(security.is_safe_web_url("https://youtube.com/watch?v=dQw4w9WgXcQ"))
        self.assertTrue(security.is_safe_web_url("http://example.com/video.mp4"))
        self.assertFalse(security.is_safe_web_url("file:///tmp/test.mp4"))
        self.assertFalse(security.is_safe_web_url("rtmp://example.com/live"))
        self.assertFalse(security.is_safe_web_url("http://127.0.0.1:8080/stream"))
        self.assertFalse(security.is_safe_web_url("http://169.254.169.254"))

        # Public / Safe URLs
        self.assertTrue(security.is_safe_url("https://www.google.com"))
        self.assertTrue(security.is_safe_url("https://youtube.com/watch?v=dQw4w9WgXcQ"))
        self.assertTrue(security.is_safe_url("http://93.184.216.34/index.html")) # example.com IP

    def test_protocol_bypasses(self):
        """Verifies strict protocol allowlisting and rejection of unsafe/malformed schemes."""
        # Allowed protocols
        self.assertTrue(security.is_safe_url("https://example.com/stream.m3u8"))
        self.assertTrue(security.is_safe_url("http://example.com/video.mp4"))
        self.assertTrue(security.is_safe_url("udp://239.255.0.1:1234"))
        self.assertTrue(security.is_safe_url("rtmp://example.com/live/stream"))
        self.assertTrue(security.is_safe_url("rtsp://example.com/media.mp4"))
        self.assertTrue(security.is_safe_url("mms://example.com/broadcast"))

        # Case-insensitivity for allowed schemes
        self.assertTrue(security.is_safe_url("HTTPS://example.com/video.mp4"))
        self.assertTrue(security.is_safe_url("Http://example.com/stream"))
        self.assertTrue(security.is_safe_url("FILE:///tmp/test.mp4"))

        # Disallowed / dangerous protocols
        dangerous_protocols = [
            "javascript:alert(1)",
            "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
            "ftp://example.com/pub/file.mp4",
            "gopher://evil.com/1",
            "ssh://root@example.com",
            "ws://evil.com/socket",
            "wss://evil.com/socket",
            "dict://dict.org",
            "ldap://example.com/o=test",
            "chrome-extension://invalid/path",
            "moz-extension://invalid/path",
            "vbscript:msgbox(1)",
        ]
        for url in dangerous_protocols:
            self.assertFalse(security.is_safe_url(url), f"Should reject dangerous protocol: {url}")

        # Malformed scheme representations (missing slashes or obfuscation)
        self.assertFalse(security.is_safe_url("http:example.com"))
        self.assertFalse(security.is_safe_url("file:video.mp4"))
        self.assertFalse(security.is_safe_url("javascript://example.com"))
        self.assertFalse(security.is_safe_url("jav\tascript:alert(1)"))

        # Invalid types and edge cases
        self.assertFalse(security.is_safe_url(None))
        self.assertFalse(security.is_safe_url(""))
        self.assertFalse(security.is_safe_url("   "))
        self.assertFalse(security.is_safe_url(12345))
        self.assertFalse(security.is_safe_url(["https://example.com"]))
        self.assertFalse(security.is_safe_url({"url": "https://example.com"}))

        # Length limit enforcement (MAX_URL_LENGTH = 4096)
        max_len = security.SECURITY_LIMITS['MAX_URL_LENGTH']
        oversized_url = "https://example.com/" + ("a" * max_len)
        self.assertFalse(security.is_safe_url(oversized_url), "Should reject URLs exceeding MAX_URL_LENGTH")

    def test_file_scheme_handling(self):
        """Verifies file:// scheme behavior: allows local paths, blocks SSRF hostnames."""
        # Standard local file path (parsed.hostname is None or empty)
        self.assertTrue(security.is_safe_url("file:///home/user/Videos/movie.mkv"))
        self.assertTrue(security.is_safe_url("file:///C:/Users/User/Videos/movie.mkv"))

        # file:// URLs specifying hostnames targeting internal SSRF
        self.assertFalse(security.is_safe_url("file://localhost/etc/passwd"))
        self.assertFalse(security.is_safe_url("file://127.0.0.1/etc/shadow"))
        self.assertFalse(security.is_safe_url("file://169.254.169.254/latest/meta-data"))

    def test_string_sanitation_restricted_chars(self):
        """Claim 3.1: Strips restricted characters ($, `, ", etc.) from OSD/Metadata."""
        malicious = 'Test $(echo safe) `cat /dev/null` "quoted" \n \r \t'
        sanitized = security.sanitize_string(malicious, is_filename=False)

        self.assertNotIn('$', sanitized)
        self.assertNotIn('`', sanitized)
        self.assertNotIn('"', sanitized)
        self.assertNotIn('\n', sanitized)
        self.assertNotIn('\r', sanitized)
        self.assertNotIn('\t', sanitized)

        self.assertIn('Test', sanitized)
        self.assertIn('echo safe', sanitized)
        self.assertIn('cat /dev/null', sanitized)

        # URL fragments and parameters (#, &) should be preserved in OSD/title mode
        url_with_fragment = "https://example.com/watch?v=123&t=45#details"
        sanitized_url = security.sanitize_string(url_with_fragment, is_filename=False)
        self.assertIn('&', sanitized_url)
        self.assertIn('#', sanitized_url)

        # Title length truncation enforcement (MAX_TITLE_LENGTH = 512)
        max_title = security.SECURITY_LIMITS['MAX_TITLE_LENGTH']
        long_title = "A" * (max_title + 100)
        sanitized_long = security.sanitize_string(long_title, is_filename=False)
        self.assertEqual(len(sanitized_long), max_title)

        # Non-string passthrough
        self.assertIsNone(security.sanitize_string(None))
        self.assertEqual(security.sanitize_string(42), 42)

    def test_filename_sanitation_edge_cases(self):
        """Verifies strict filesystem sanitization for folder names and exports."""
        # Directory traversal and filesystem restricted characters
        dangerous_filename = '../../etc/passwd:stream*name?"quoted"<tag>|pipe$var;cmd&bg`sub`\n\r\t'
        sanitized = security.sanitize_string(dangerous_filename, is_filename=True)

        for restricted_char in ['/', '\\', ':', '*', '?', '"', '<', '>', '|', '$', ';', '&', '`', '\n', '\r', '\t']:
            self.assertNotIn(restricted_char, sanitized, f"Character '{restricted_char}' must be stripped from filename")

        self.assertIn('passwdstreamnamequotedtagpipevarcmdbgsub', sanitized)

        # Folder name length truncation (MAX_FOLDER_NAME_LENGTH = 128)
        max_folder = security.SECURITY_LIMITS['MAX_FOLDER_NAME_LENGTH']
        long_folder = "Folder_" + ("X" * (max_folder + 50))
        sanitized_folder = security.sanitize_string(long_folder, is_filename=True)
        self.assertEqual(len(sanitized_folder), max_folder)

    def test_ytdlp_options_allowlist_and_sanitization(self):
        """Verifies allowlist enforcement and injection stripping for yt-dlp options."""
        # Safe options should be preserved
        valid_opts = "format=bestvideo+bestaudio,limit-rate=1M,user-agent=MyCustomUA,concurrent-fragments=4"
        sanitized = security.sanitize_ytdlp_options(valid_opts)
        self.assertIn("format=bestvideo+bestaudio", sanitized)
        self.assertIn("limit-rate=1M", sanitized)
        self.assertIn("user-agent=MyCustomUA", sanitized)
        self.assertIn("concurrent-fragments=4", sanitized)

        # Dangerous flags outside the allowlist must be stripped
        dangerous_opts = "format=best,exec=rm -rf /,external-downloader=curl,output=/etc/shadow,write-info-json=/tmp/exploit"
        sanitized_danger = security.sanitize_ytdlp_options(dangerous_opts)
        self.assertEqual(sanitized_danger, "format=best")
        self.assertNotIn("exec", sanitized_danger)
        self.assertNotIn("external-downloader", sanitized_danger)
        self.assertNotIn("output", sanitized_danger)

        # PY-H5: Dangerous flags (proxy, ffmpeg-location, js-runtimes, remote-components, alias, update, print, no-check-certificate, compat-options) stripped by default
        untrusted_payload_opts = "format=best,proxy=http://evil.com,ffmpeg-location=/bin/sh,js-runtimes=node:/bin/sh,remote-components=all,alias=evil,update=true,print=traffic,no-check-certificate=,compat-options=all"
        sanitized_untrusted = security.sanitize_ytdlp_options(untrusted_payload_opts, allow_settings_flags=False)
        self.assertEqual(sanitized_untrusted, "format=best")
        for flag in ["proxy", "ffmpeg-location", "js-runtimes", "remote-components", "alias", "update", "print", "no-check-certificate", "compat-options"]:
            self.assertNotIn(flag, sanitized_untrusted)

        # extractor-args is preserved with semicolons and escaped commas
        extractor_opts = r"extractor-args=generic:impersonate;youtube:player_client=android\,ios,format=best"
        sanitized_extractor = security.sanitize_ytdlp_options(extractor_opts, allow_settings_flags=False)
        self.assertIn(r"extractor-args=generic:impersonate;youtube:player_client=android\,ios", sanitized_extractor)
        self.assertIn("format=best", sanitized_extractor)

        merged_extractor = file_io.merge_ytdlp_options(extractor_opts, "ignore-config=", allow_settings_flags=False)
        self.assertIn(r"extractor-args=generic:impersonate;youtube:player_client=android\,ios", merged_extractor)

        # Settings-only flags preserved when allow_settings_flags=True
        settings_opts = "remote-components=ejs:github,js-runtimes=node,ffmpeg-location=/usr/bin/ffmpeg,compat-options=2023"
        sanitized_settings = security.sanitize_ytdlp_options(settings_opts, allow_settings_flags=True)
        self.assertIn("remote-components=ejs:github", sanitized_settings)
        self.assertIn("js-runtimes=node", sanitized_settings)
        self.assertIn("ffmpeg-location=/usr/bin/ffmpeg", sanitized_settings)
        self.assertIn("compat-options=2023", sanitized_settings)

        # Injection attempts inside allowed flag values must be neutralized
        injected_opts = 'user-agent=Mozilla; rm -rf / | evil & `calc`,limit-rate=500K\n\r"quoted"'
        sanitized_injected = security.sanitize_ytdlp_options(injected_opts)
        self.assertNotIn(';', sanitized_injected)
        self.assertNotIn('|', sanitized_injected)
        self.assertNotIn('&', sanitized_injected)
        self.assertNotIn('`', sanitized_injected)
        self.assertNotIn('\n', sanitized_injected)
        self.assertNotIn('\r', sanitized_injected)
        self.assertNotIn('"', sanitized_injected)

        # Invalid formats and non-string inputs
        self.assertEqual(security.sanitize_ytdlp_options(""), "")
        self.assertEqual(security.sanitize_ytdlp_options(None), "")
        self.assertEqual(security.sanitize_ytdlp_options("no-equals-sign,just-flags"), "")

    def test_m3u_injection_hardening(self):
        """Claim 3.2: Item titles in M3U files are sanitized against shell metacharacters."""
        malicious_items = [
            {
                "id": "item-1",
                "url": "https://example.com/video1",
                "title": 'Title $(date) `true` "quoted"'
            }
        ]

        dependencies = {
            'get_all_folders_from_file': lambda: {},
            'get_mpv_executable': lambda: "mpv",
            'log_stream': lambda: None,
            'send_message': self.mock_send,
            'SCRIPT_DIR': PROJECT_ROOT,
            'TEMP_PLAYLISTS_DIR': os.path.join(self.test_dir, "temp_playlists"),
            'metadata_cache': None,
            'task_manager': None
        }

        session = mpv_session.MpvSessionManager(os.path.join(self.test_dir, "session.json"), dependencies)
        m3u_content = session._generate_m3u_content(malicious_items)

        self.assertIn("#EXTM3U", m3u_content)
        self.assertNotIn('$', m3u_content)
        self.assertNotIn('`', m3u_content)
        self.assertNotIn('"', m3u_content)
        self.assertIn("Title (date) true quoted", m3u_content)

    def test_path_validation_sandbox(self):
        """Claim 4.1: Restricts file operations to sandboxed directories."""
        data_dir = os.path.join(self.test_dir, "data")
        script_dir = os.path.join(self.test_dir, "app")
        temp_dir = os.path.join(self.test_dir, "temp")

        os.makedirs(data_dir, exist_ok=True)
        os.makedirs(script_dir, exist_ok=True)
        os.makedirs(temp_dir, exist_ok=True)

        # Valid files within sandbox
        safe_file = os.path.join(data_dir, "config.json")
        self.assertIsNotNone(security.validate_safe_path(safe_file, data_dir, script_dir, temp_dir))

        # Subdirectories within sandbox
        sub_file = os.path.join(temp_dir, "playlists", "session_1.m3u")
        self.assertIsNotNone(security.validate_safe_path(sub_file, data_dir, script_dir, temp_dir))

        # Dangerous paths (Directory Traversal)
        self.assertIsNone(security.validate_safe_path(os.path.join(data_dir, "../../secret.txt"), data_dir, script_dir, temp_dir))
        self.assertIsNone(security.validate_safe_path("/etc/passwd", data_dir, script_dir, temp_dir))

        # allow_user_content toggle
        user_file = os.path.join(self.test_dir, "user_media", "clip.mp4")
        self.assertIsNone(security.validate_safe_path(user_file, data_dir, script_dir, temp_dir, allow_user_content=False))
        self.assertIsNotNone(security.validate_safe_path(user_file, data_dir, script_dir, temp_dir, allow_user_content=True))

        # Null and empty inputs
        self.assertIsNone(security.validate_safe_path(None, data_dir, script_dir, temp_dir))
        self.assertIsNone(security.validate_safe_path("", data_dir, script_dir, temp_dir))

    def test_ipc_payload_validation(self):
        """Verifies structure and size validation of incoming IPC payloads."""
        # Non-dict payload
        valid, err = security.validate_payload(["not", "a", "dict"])
        self.assertFalse(valid)
        self.assertIn("Invalid payload type", err)

        # Missing action
        valid, err = security.validate_payload({"folder_id": "test"})
        self.assertFalse(valid)
        self.assertIn("Missing action", err)

        # Valid payload
        valid, err = security.validate_payload({"action": "ping", "request_id": "123"})
        self.assertTrue(valid)
        self.assertIsNone(err)

        # String length exceeding limit (MAX_STRING_LENGTH = 100KB)
        oversized_str = "x" * (security.SECURITY_LIMITS['MAX_STRING_LENGTH'] + 10)
        valid, err = security.validate_payload({"action": "log_event", "message": oversized_str})
        self.assertFalse(valid)
        self.assertIn("exceeds security limits", err)

        # Item count exceeding limit (MAX_PLAYLIST_ITEMS = 10000)
        oversized_list = [{"id": f"item_{i}"} for i in range(security.SECURITY_LIMITS['MAX_PLAYLIST_ITEMS'] + 5)]
        valid, err = security.validate_payload({"action": "play_batch", "playlist": oversized_list})
        self.assertFalse(valid)
        self.assertIn("exceeds security limits", err)

        # Recursion depth exceeding limit (max_depth = 32)
        deep_obj = "leaf"
        for _ in range(40):
            deep_obj = {"nested": deep_obj}
        valid, err = security.validate_payload({"action": "export_data", "data": deep_obj})
        self.assertFalse(valid)
        self.assertIn("exceeds security limits", err)

    def test_atomic_write_integrity(self):
        """Claim 4.2: Atomic writes use temp files and provide .bak fallback."""
        test_file = os.path.join(self.test_dir, "atomic_test.json")
        v1 = {"v": 1}
        v2 = {"v": 2}
        v3 = {"v": 3}

        file_io._atomic_json_dump(v1, test_file)
        file_io._atomic_json_dump(v2, test_file)
        self.assertTrue(os.path.exists(test_file + ".bak"))

        file_io._atomic_json_dump(v3, test_file)
        bak_data = file_io._safe_json_load(test_file + ".bak")
        self.assertEqual(bak_data["v"], 2)

        # Simulate Corruption of Primary (V3)
        with open(test_file, 'w') as f:
            f.write("{ corrupt json")

        # Recovery should load Backup (V2)
        recovered = file_io._safe_json_load(test_file)
        self.assertEqual(recovered["v"], 2)

    def test_log_path_masking(self):
        """Claim 6.1: Masks sensitive system paths in logs with priority ordering."""
        home_dir = "/home/safe_user"
        data_dir = "/home/safe_user/.config/mpv_app"
        script_dir = "/home/safe_user/repo/mpv-playlist-organizer"

        sensitive_text = f"Opening {data_dir}/config.json via {script_dir}/native_host.py for user at {home_dir}/Videos"
        masked = security.mask_path(sensitive_text, data_dir, script_dir, home_dir)

        self.assertNotIn(data_dir, masked)
        self.assertNotIn(script_dir, masked)
        self.assertNotIn(home_dir, masked)

        self.assertIn("<DATA_DIR>/config.json", masked)
        self.assertIn("<APP_DIR>/native_host.py", masked)
        self.assertIn("<HOME>/Videos", masked)

        # Empty / non-string handling
        self.assertIsNone(security.mask_path(None, data_dir, script_dir))
        self.assertEqual(security.mask_path(123, data_dir, script_dir), 123)

    def test_url_normalization_tracking_strip(self):
        """Verifies tracking parameter and fragment stripping for reliable playlist item matching."""
        raw_url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&index=3&si=tracking123&feature=share#t=42"
        normalized = url_analyzer.normalize_url(raw_url)

        self.assertIn("v=dQw4w9WgXcQ", normalized)
        self.assertNotIn("t=42s", normalized)
        self.assertNotIn("index=3", normalized)
        self.assertNotIn("si=tracking123", normalized)
        self.assertNotIn("feature=share", normalized)
        self.assertNotIn("#t=42", normalized)

        # Non-string / empty passthrough
        self.assertIsNone(url_analyzer.normalize_url(None))
        self.assertEqual(url_analyzer.normalize_url(""), "")

    def test_executable_path_validation(self):
        """Claim 3.3: Validates executable binary paths against approved allowlists and forbids shell injection."""
        # Valid binaries in system PATH
        self.assertTrue(security.is_safe_executable_path("mpv", "mpv_path"))
        self.assertTrue(security.is_safe_executable_path("node", "node_path"))
        self.assertTrue(security.is_safe_executable_path("ffmpeg", "ffmpeg_path"))

        # Injection characters
        self.assertNotIn('(', security.FORBIDDEN_PATH_CHARS)
        self.assertNotIn(')', security.FORBIDDEN_PATH_CHARS)
        self.assertFalse(security.is_safe_executable_path("mpv; rm -rf /", "mpv_path"))
        self.assertFalse(security.is_safe_executable_path("mpv$(whoami)", "mpv_path"))
        self.assertFalse(security.is_safe_executable_path("mpv`id`", "mpv_path"))
        self.assertFalse(security.is_safe_executable_path("mpv | evil", "mpv_path"))
        self.assertFalse(security.is_safe_executable_path("mpv & evil", "mpv_path"))
        self.assertFalse(security.is_safe_executable_path("mpv\ncalc", "mpv_path"))

        # Base binary name mismatch for setting
        self.assertFalse(security.is_safe_executable_path("/bin/sh", "mpv_path"))
        self.assertFalse(security.is_safe_executable_path("/usr/bin/python3", "mpv_path"))
        self.assertFalse(security.is_safe_executable_path("curl", "ytdlp_path"))

        # Nonexistent path
        self.assertFalse(security.is_safe_executable_path("/nonexistent/bin/mpv", "mpv_path"))

        # Null or empty
        self.assertFalse(security.is_safe_executable_path(None, "mpv_path"))
        self.assertFalse(security.is_safe_executable_path("", "mpv_path"))

    def test_settings_allowlist_enforcement(self):
        """Claim 3.4: Enforces strict key and path validation in set_settings."""
        original_data_dir = file_io.DATA_DIR
        file_io.initialize_paths(self.test_dir)
        try:
            # Unapproved key injection must be rejected
            res = file_io.set_settings({"malicious_injected_key": "evil_payload", "ytdl_quality": "1080"})
            self.assertTrue(res.get("success"))

            saved_settings = file_io.get_settings()
            self.assertNotIn("malicious_injected_key", saved_settings)
            self.assertEqual(saved_settings.get("ytdl_quality"), "1080")

            # Unsafe binary path injection must be rejected
            res = file_io.set_settings({"mpv_path": "/bin/sh; rm -rf /"})
            self.assertTrue(res.get("success"))
            saved_settings = file_io.get_settings()
            self.assertNotEqual(saved_settings.get("mpv_path"), "/bin/sh; rm -rf /")
        finally:
            file_io.initialize_paths(original_data_dir)

    def test_shell_free_terminal_execution(self):
        """Claim 5.3: Terminal execution uses direct process argv without sh -c or shell wrapping."""
        import services
        cmd, has_terminal = services.construct_mpv_command(
            mpv_exe="mpv",
            url=["https://example.com/test.mp4"],
            force_terminal=True,
            settings={"os_platform": "Linux"}
        )
        self.assertTrue(has_terminal)
        self.assertIsInstance(cmd, list)

        # Ensure no shell invocation tokens appear in command list
        self.assertNotIn("sh", cmd)
        self.assertNotIn("-c", cmd)
        self.assertNotIn("bash", cmd)

    def test_script_opts_smuggling_and_command_url_ssrf_blocked(self):
        """Verifies custom --script-opts smuggling is blocked and MpvCommandBuilder enforces SSRF checks."""
        import services
        cmd, _ = services.construct_mpv_command(
            mpv_exe="mpv",
            url=[
                "https://example.com/safe.mp4",
                "http://169.254.169.254/latest/meta-data",
                "file://localhost/etc/passwd",
                "http://127.0.0.1:43210/playlist.m3u?token=deadbeefcafe1234",
            ],
            custom_mpv_flags="--fullscreen --script-opts=ytdl_hook-ytdl_path=/bin/sh",
            cookies_browser="chrome,ffmpeg-location=/bin/sh",
            cookies_file="/etc/passwd",
            ytdl_raw_options="format=best,exec=rm -rf /",
        )
        cmd_str = " ".join(cmd)
        self.assertIn("https://example.com/safe.mp4", cmd)
        self.assertIn("http://127.0.0.1:43210/playlist.m3u?token=deadbeefcafe1234", cmd)
        self.assertNotIn("169.254.169.254", cmd_str)
        self.assertNotIn("file://localhost", cmd_str)
        self.assertNotIn("ytdl_hook-ytdl_path", cmd_str)
        self.assertNotIn("ffmpeg-location=/bin/sh", cmd_str)
        self.assertNotIn("/etc/passwd", cmd_str)
        self.assertNotIn("exec=", cmd_str)

    def test_cookies_browser_and_cookie_file_smuggling_blocked(self):
        """Verifies construct_lua_options blocks flag smuggling via cookies_browser and outside-sandbox cookies_file."""
        import services
        malicious_item = {
            "id": "itm-1",
            "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "title": "Test",
            "cookies_browser": "chrome,ffmpeg-location=/bin/sh,proxy=http://127.0.0.1:8080",
            "cookies_file": "/etc/shadow",
        }
        lua_opts, _ = services.construct_lua_options(malicious_item, {}, PROJECT_ROOT)
        self.assertIsNone(lua_opts.get("cookies_browser"))
        self.assertIsNone(lua_opts.get("cookies_file"))
        self.assertNotIn("ffmpeg-location=/bin/sh", lua_opts.get("ytdl_raw_options", ""))
        self.assertNotIn("proxy=", lua_opts.get("ytdl_raw_options", ""))

    def test_m3u_parser_ssrf_and_ytdl_options_sanitization(self):
        """Verifies parse_m3u rejects unsafe protocols, SSRF IPs, path traversal, and sanitizes EXT-X-YTDL-OPTIONS."""
        from utils.m3u_parser import parse_m3u
        m3u_text = "\n".join([
            "#EXTM3U",
            "#EXTINF:-1,Safe Item",
            "#EXT-X-YTDL-OPTIONS:format=best|exec=rm -rf /|proxy=http://evil.com",
            "https://example.com/video.mp4",
            "#EXTINF:-1,SSRF Item",
            "http://169.254.169.254/latest/meta-data",
            "#EXTINF:-1,JS Scheme",
            "javascript://alert(1)",
            "#EXTINF:-1,Traversal Path",
            "../../../etc/passwd",
        ])
        items = parse_m3u(m3u_text)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["url"], "https://example.com/video.mp4")
        self.assertEqual(items[0]["ytdl_raw_options"], "format=best")

    def test_handshake_permissions_and_token_masking(self):
        """Verifies handshake files use 0600 permissions, token redaction in mask_path, and prototype pollution guards."""
        import platform
        import services
        from utils import fallback_sync
        from utils.native_link import translator, responder

        flag_dir = os.path.join(self.test_dir, "flags")
        os.makedirs(flag_dir, exist_ok=True)
        h_path, _ = services.create_handshake_file(
            flag_dir, "Default", PROJECT_ROOT,
            {"id": "1", "url": "https://example.com/v.mp4", "title": "V"},
            {}
        )
        if platform.system() != "Windows":
            mode = os.stat(h_path).st_mode & 0o777
            self.assertEqual(mode, 0o600)

        masked_token = security.mask_path("Timeout at http://127.0.0.1:9999/playlist.m3u?token=secret123456&foo=1")
        self.assertNotIn("secret123456", masked_token)
        self.assertIn("token=[REDACTED]", masked_token)

        ok, msg = fallback_sync.mark_video_as_watched("http://127.0.0.1:8080/video", "chrome")
        self.assertFalse(ok)
        ok2, msg2 = fallback_sync.mark_video_as_watched("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "chrome;rm -rf /")
        self.assertFalse(ok2)

        polluted = {"action": "ping", "__proto__": {"polluted": True}, "constructor": "keep", "prototype": "keep"}
        norm = translator._normalize_message(polluted)
        self.assertNotIn("__proto__", norm)
        self.assertEqual(norm.get("constructor"), "keep")
        trans = responder._translate_keys(polluted)
        self.assertNotIn("__proto__", trans)
        self.assertEqual(trans.get("prototype"), "keep")

        # Trailing-dot FQDN SSRF bypass
        self.assertFalse(security.is_safe_url("http://127.0.0.1./"))
        self.assertFalse(security.is_safe_url("http://metadata.google.internal./x"))

        # yt-dlp cookie browser specs: valid forms pass, injection fails
        for ok_spec in ("chrome", "firefox:default-release", "chrome+gnomekeyring", "chrome:Profile 1", "firefox::Work"):
            self.assertTrue(security.is_safe_cookie_browser(ok_spec), ok_spec)
        for bad_spec in ("chrome,proxy=http://x", "chrome;rm", "evil", "chrome:a,b", ""):
            self.assertFalse(security.is_safe_cookie_browser(bad_spec), bad_spec)

        # Preserved data keys survive a second translation pass
        res = responder.success(data={"my_anime_list": 1}, preserve_data_keys=True)
        self.assertIn("my_anime_list", responder._translate_keys(res)["data"])

    def test_mpv_command_builder_strips_settings_only_ytdl_flags_and_sanitizes_ua(self):
        """Regression: MpvCommandBuilder.build strips settings-only ytdl_raw_options and sanitizes UA."""
        import services
        cmd, _ = services.construct_mpv_command(
            mpv_exe="mpv",
            url="https://example.com/video.mp4",
            ytdl_raw_options="format=best,proxy=http://evil.invalid:8080,ffmpeg-location=/bin/sh,js-runtimes=node:/bin/sh",
            headers={"User-Agent": 'Mozilla/5.0, $(whoami) `id` "bad"\nInjected'},
        )
        raw_arg = next((a for a in cmd if a.startswith("--ytdl-raw-options=")), "")
        self.assertIn("format=best", raw_arg)
        self.assertNotIn("proxy=", raw_arg)
        self.assertNotIn("ffmpeg-location=", raw_arg)
        self.assertNotIn("/bin/sh", raw_arg)
        self.assertIn("js-runtimes=node", raw_arg)
        self.assertIn("user-agent=Mozilla/5.0", raw_arg)
        self.assertNotIn("$", raw_arg)
        self.assertNotIn("`", raw_arg)
        self.assertNotIn('"', raw_arg)
        self.assertNotIn("\n", raw_arg)

    def test_settings_overrides_validation_and_essential_ytdlp_flags(self):
        """Regression: _get_merged_settings & get_essential_ytdlp_flags validate paths, buffer size, and fragment count."""
        from unittest.mock import MagicMock
        import services
        from utils.handlers.base_handler import BaseHandler
        from utils.native_link.models import SettingsOverrides

        ctx = MagicMock()
        ctx.io = file_io
        ctx.mpv.current_token = "tok"
        handler = BaseHandler(ctx)

        overrides = SettingsOverrides(
            ffmpeg_path="/bin/sh",
            ytdlp_path="/usr/bin/curl",
            stream_buffer_size="10M,exec=rm -rf /",
            ytdlp_concurrent_fragments="not-an-int",
        )
        merged = handler._get_merged_settings(overrides)
        self.assertNotEqual(merged.get("ffmpeg_path"), "/bin/sh")
        self.assertNotEqual(merged.get("ytdlp_path"), "/usr/bin/curl")
        self.assertEqual(merged.get("stream_buffer_size"), "10M")
        self.assertEqual(merged.get("ytdlp_concurrent_fragments"), 4)

        valid_overrides = SettingsOverrides(
            stream_buffer_size="32M",
            ytdlp_concurrent_fragments="6",
        )
        merged_valid = handler._get_merged_settings(valid_overrides)
        self.assertEqual(merged_valid.get("stream_buffer_size"), "32M")
        self.assertEqual(merged_valid.get("ytdlp_concurrent_fragments"), 6)

        flags = services.get_essential_ytdlp_flags(settings={
            "stream_buffer_size": "10M,proxy=http://evil",
            "ytdlp_concurrent_fragments": "invalid",
        })
        self.assertNotIn("buffer-size=", flags)
        self.assertIn("concurrent-fragments=4", flags)

    def test_cookie_browser_traversal_rejected_and_get_cookies_file_sanitizes_filename(self):
        """Regression: is_safe_cookie_browser rejects '..' and get_cookies_file sanitizes temp filename."""
        from unittest.mock import patch

        self.assertFalse(security.is_safe_cookie_browser("chrome:../../etc/passwd"))
        self.assertFalse(security.is_safe_cookie_browser("firefox:Profile..1"))
        self.assertTrue(security.is_safe_cookie_browser("chrome:Profile 1"))

        captured_cmd = {}

        def fake_run(cmd, **_kwargs):
            captured_cmd["cmd"] = cmd
            out_idx = cmd.index("--cookies") + 1
            with open(cmd[out_idx], "w", encoding="utf-8") as f:
                f.write("# Netscape HTTP Cookie File\n")

        with patch("subprocess.run", side_effect=fake_run):
            path = url_analyzer.get_cookies_file("chrome:Profile 1", "https://example.com/v", force_refresh=True)
            try:
                self.assertIsNotNone(path)
                v_dir = os.path.realpath(url_analyzer.VolatileCookieManager.get_volatile_dir())
                self.assertEqual(os.path.dirname(os.path.realpath(path)), v_dir)
                base = os.path.basename(path)
                self.assertNotIn(":", base)
                self.assertNotIn(" ", base)
                self.assertTrue(base.startswith("mpv_cookies_chrome_Profile_1_"))
            finally:
                url_analyzer.VolatileCookieManager.cleanup_volatile_dir()

    def test_fetch_remote_m3u_size_cap_and_binary_content_type(self):
        """Regression: _fetch_remote_m3u aborts on binary Content-Type and payloads exceeding 2 MiB."""
        from unittest.mock import MagicMock, patch
        from utils.item_processor import ItemProcessor

        proc = ItemProcessor(MagicMock(), MagicMock(), file_io)

        class FakeResp:
            def __init__(self, body, content_type):
                self._body = body
                self.headers = {"Content-Type": content_type}

            def read(self, n=-1):
                return self._body if n < 0 else self._body[:n]

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        # 1. Binary Content-Type bails early
        with patch("urllib.request.OpenerDirector.open", return_value=FakeResp(b"binary-video-data", "video/mp4")):
            self.assertIsNone(proc._fetch_remote_m3u("https://example.com/video.mp4", None))

        # 2. Oversized M3U (> 2 MiB) aborted
        oversized = b"#EXTM3U\n" + (b"A" * (proc.MAX_M3U_BYTES + 100))
        with patch("urllib.request.OpenerDirector.open", return_value=FakeResp(oversized, "application/vnd.apple.mpegurl")):
            self.assertIsNone(proc._fetch_remote_m3u("https://example.com/big.m3u8", None))

        # 3. Normal small M3U succeeds
        small = b"#EXTM3U\nhttps://example.com/stream.m3u8\n"
        with patch("urllib.request.OpenerDirector.open", return_value=FakeResp(small, "application/vnd.apple.mpegurl; charset=utf-8")):
            self.assertEqual(proc._fetch_remote_m3u("https://example.com/list.m3u8", None), small.decode("utf-8"))

        # 4. Non-web URL (file://) blocked before opening; opener excludes FileHandler/FTPHandler
        self.assertIsNone(proc._fetch_remote_m3u("file:///etc/passwd", None))
        import urllib.request
        captured_handlers = []
        orig_add = urllib.request.OpenerDirector.add_handler
        def spy_add(self_opener, handler):
            captured_handlers.append(type(handler).__name__)
            return orig_add(self_opener, handler)
        with patch("urllib.request.OpenerDirector.add_handler", spy_add), \
             patch("urllib.request.OpenerDirector.open", return_value=FakeResp(small, "text/plain")):
            proc._fetch_remote_m3u("https://example.com/list.m3u8", None)
        self.assertNotIn("FileHandler", captured_handlers)
        self.assertNotIn("FTPHandler", captured_handlers)
        self.assertIn("HTTPHandler", captured_handlers)
        self.assertIn("HTTPSHandler", captured_handlers)

    def test_ytdlp_cookie_option_injection_and_http_header_crlf_sanitization(self):
        """Regression: sanitize_ytdlp_options validates cookies/cookies-from-browser; sanitize_http_headers strips CRLF."""
        import services
        from utils.m3u_parser import parse_m3u
        from utils import session_ipc_ops
        from unittest.mock import MagicMock

        # 1. Cookie file/browser injection in sanitize_ytdlp_options
        safe_cookie = os.path.join(file_io.TEMP_DIR, "mpv_cookies_test.txt")
        self.assertEqual(
            security.sanitize_ytdlp_options("cookies=/etc/passwd,cookies-from-browser=evil;id,format=best"),
            "format=best",
        )
        ok_opts = security.sanitize_ytdlp_options(f"cookies={safe_cookie},cookies-from-browser=chrome:Profile 1")
        self.assertIn(f"cookies={safe_cookie}", ok_opts)
        self.assertIn("cookies-from-browser=chrome:Profile 1", ok_opts)

        # 2. sanitize_http_headers helper
        dirty = {
            "User-Agent": "Agent\r\nX-Injected: 1\x00",
            "Referer": "https://example.com/\r\nEvil: yes",
            "Referer\n": "https://evil.example.com/",
            "Bad Header": "val",
            "Bad:Name": "val",
            "NonString": 123,
        }
        cleaned = security.sanitize_http_headers(dirty)
        self.assertEqual(cleaned, {
            "User-Agent": "AgentX-Injected: 1",
            "Referer": "https://example.com/Evil: yes",
        })

        # 3. Applied in construct_lua_options, parse_m3u, and hot_swap_item
        lua_opts, _ = services.construct_lua_options(
            {"id": "1", "url": "https://example.com/v.mp4", "headers": dirty}, {}, PROJECT_ROOT
        )
        self.assertNotIn("Bad Header", lua_opts["headers"])
        self.assertNotIn("\r", lua_opts["headers"]["User-Agent"])
        self.assertNotIn("\n", lua_opts["headers"]["Referer"])

        m3u_items = parse_m3u("#EXTM3U\n#EXT-X-HEADERS:Bad Key=1|X-Good=ok\r\nhttps://example.com/a.mp4\n")
        self.assertEqual(m3u_items[0]["headers"], {"X-Good": "ok"})

        mock_session = MagicMock()
        mock_session.SCRIPT_DIR = PROJECT_ROOT
        mock_session.ipc_manager.is_connected.return_value = True
        mock_session.ipc_manager.get_property.side_effect = [[{"filename": "https://example.com/a.mp4"}], 1]
        session_ipc_ops.hot_swap_item(
            mock_session,
            {"id": "1", "url": "https://example.com/a.mp4", "headers": {"User-Agent": "UA\r\nBad", "Referer": "https://a.com/\nX"}},
            "Folder",
            {},
            [],
        )
        ua_calls = [c[0][0]["command"][2] for c in mock_session.ipc_manager.send.call_args_list if c[0][0].get("command", [])[:2] == ["set_property", "user-agent"]]
        self.assertEqual(ua_calls, ["UABad"])

    def test_log_event_level_allowlist(self):
        """Regression: handle_log_event uses explicit allowlist instead of arbitrary getattr(logging, ...)."""
        from unittest.mock import MagicMock, patch
        from utils.handlers.data_handler import DataHandler
        from utils import native_link
        import logging

        handler = DataHandler(MagicMock())
        req = native_link.LogRequest(action="log_event", level="getLogger", message="hi", context="BG")
        with patch("logging.log") as mock_log:
            res = handler.handle_log_event(req)
        self.assertTrue(res.get("success"))
        self.assertEqual(mock_log.call_args[0][0], logging.INFO)

    def test_emergency_log_path_honors_xdg_without_import_makedirs(self):
        """Regression: _get_emergency_log_path honors XDG_DATA_HOME on Unix and does not call os.makedirs."""
        from unittest.mock import patch
        import native_host

        custom_xdg = os.path.join(self.test_dir, "xdg_never_created")
        with patch.object(sys, "platform", "linux"), \
             patch.dict(os.environ, {"XDG_DATA_HOME": custom_xdg}, clear=False):
            p = native_host._get_emergency_log_path()

        self.assertEqual(p, os.path.join(custom_xdg, "MPVPlaylistOrganizer", "native_host_crash.log"))
        self.assertFalse(os.path.exists(custom_xdg))

if __name__ == '__main__':
    unittest.main()
