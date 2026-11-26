"""
MPV Playlist Organizer - Backend Services
Collection of utilities for URL processing, dependency management, and MPV command building.

NOTE ON LATE IMPORTS (E402):
Imports are intentionally deferred to minimize initial startup time for the Native Host.
"""
import logging
import os
import platform
import re
import shutil
import subprocess
import sys
import uuid
import json

# Prevent __pycache__ generation
sys.dont_write_bytecode = True
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'

from utils import url_analyzer, security
from utils import dependency_manager, anilist_service, mpv_command_builder
import file_io

def sanitize_url(url):
    """Sanitizes a URL by removing potentially dangerous characters."""
    return file_io.sanitize_string(url, is_filename=False)

def create_handshake_file(flag_dir, folder_id, script_dir, item, settings,
                          playlist_start_index=0, is_unmanaged=False,
                          is_youtube=False, use_ytdl_mpv=False,
                          headers=None, cookies_browser=None):
    """
    Creates an atomic metadata handshake JSON file for mpv/lua initialization.
    Returns (handshake_path, handshake_flag).
    """
    os.makedirs(flag_dir, exist_ok=True)
    handshake_data = {
        "folder_id": folder_id,
        "project_root": script_dir,
        "flag_dir": flag_dir,
        "python_executable": sys.executable,
        "playlist_start_index": playlist_start_index,
        "is_youtube": is_youtube,
        "use_ytdl_mpv": use_ytdl_mpv,
        "title": item.get('title'),
        "id": item.get('id'),
        "original_url": sanitize_url(item.get('original_url') or item.get('url', '')),
        "headers": headers or item.get('headers'),
        "cookies_browser": cookies_browser or item.get('cookies_browser'),
        "lua_options": construct_lua_options(item, settings, script_dir)[0],
        "is_unmanaged": is_unmanaged
    }

    prefix = "handshake_unmanaged_" if is_unmanaged else "handshake_"
    handshake_path = os.path.join(flag_dir, f"{prefix}{uuid.uuid4().hex}.json")
    if platform.system() == "Windows":
        handshake_path = handshake_path.replace("\\", "/")

    fd = os.open(handshake_path, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        json.dump(handshake_data, f)

    handshake_flag = f"--script-opts=mpv_organizer-handshake={handshake_path}"
    return handshake_path, handshake_flag

def get_gpu_vendor():
    system = platform.system()
    try:
        if system == "Windows":
            cmd = ["wmic", "path", "win32_VideoController", "get", "name"]
            output = subprocess.check_output(cmd, stderr=subprocess.STDOUT, text=True, timeout=5).lower()
        elif system == "Darwin":
            return "apple"
        else:
            if shutil.which("lspci"):
                output = subprocess.check_output(["lspci"], stderr=subprocess.STDOUT, text=True, timeout=5).lower()
            else:
                return "unknown"
        if "nvidia" in output:
            return "nvidia"
        elif "intel" in output:
            return "intel"
        elif "amd" in output or "radeon" in output:
            return "amd"
    except (subprocess.SubprocessError, OSError, FileNotFoundError) as e:
        logging.debug(f"[PY][Services] GPU detection failed: {e}")
    return "unknown"

def get_mark_watched(item, settings):
    """Normalizes the mark_watched preference for an item."""
    val = item.get('mark_watched')
    if val is None:
        val = settings.get('yt_mark_watched', True)
    if isinstance(val, str):
        return val.lower() in ("true", "yes", "1")
    return bool(val)

def force_sanitize_headers(url, headers):
    """
    LAST STAND OVERRIDE: Detects AnimePahe/Kwik CDN URLs and forces the correct
    headers regardless of what metadata was stored in the item or sent by the browser.
    """
    if not url:
        return headers

    # Standardize detection
    url_low = str(url).lower()
    is_pahe_cdn = (".owocdn.top" in url_low) or (".uwucdn.top" in url_low) or ("kwik.cx" in url_low)

    if is_pahe_cdn:
        if not headers:
            headers = {}
        # Force the only working referer for these CDNs
        headers["Referer"] = "https://kwik.cx/"
        headers["Origin"] = "https://kwik.cx"
        logging.debug(f"[PY][Services] Forced Kwik headers for: {url}")

    return headers

def construct_lua_options(item, settings, script_dir, index=None):
    """
    Centralized helper to construct the options dictionary passed to adaptive_headers.lua.
    Ensures all metadata and networking overrides are consistent.
    """
    essential_flags = get_essential_ytdlp_flags(settings)
    raw_opts = item.get('ytdl_raw_options')

    # Strip dangerous settings-only flags from untrusted item payload BEFORE merging
    if raw_opts:
        raw_opts = security.sanitize_ytdlp_options(raw_opts, allow_settings_flags=False)

    # Support Direct Browser Access (validated against approved cookie browser allowlist)
    raw_cookies_browser = item.get('cookies_browser')
    safe_cookies_browser = raw_cookies_browser.strip() if security.is_safe_cookie_browser(raw_cookies_browser) else None
    if safe_cookies_browser:
        browser_opt = f"cookies-from-browser={safe_cookies_browser}"
        raw_opts = f"{raw_opts},{browser_opt}" if raw_opts else browser_opt

    raw_cookies_file = item.get('cookies_file')
    safe_cookies_file = raw_cookies_file if security.is_safe_cookie_file(raw_cookies_file) else None

    final_opts = file_io.merge_ytdlp_options(raw_opts, essential_flags, allow_settings_flags=True)

    item_url = sanitize_url(item.get('original_url') or item.get('url'))

    # Defensive extraction of resume time
    raw_resume = item.get('resume_time') if item.get('resume_time') is not None else item.get('resumeTime')
    try:
        resume_time = int(float(raw_resume)) if raw_resume is not None else 0
    except (ValueError, TypeError) as e:
        logging.debug(f"[PY][Services] Could not parse resume_time '{raw_resume}': {e}")
        resume_time = 0

    logging.info(f"[PY][Services] construct_lua_options: item='{item.get('title')}', resume_time={resume_time}")

    # FORCE SANITIZE: Override stale headers from browser storage and strip CRLF/invalid header names
    sanitized_headers = force_sanitize_headers(item_url, item.get('headers'))
    if sanitized_headers is not None:
        sanitized_headers = security.sanitize_http_headers(sanitized_headers) or None

    lua_options = {
        "id": item.get('id'),
        "title": item.get('title'),
        "headers": sanitized_headers,
        "ytdl_raw_options": final_opts,
        "use_ytdl_mpv": item.get('use_ytdl_mpv', False) or item.get('is_youtube', False),
        "ytdl_format": item.get('ytdl_format'),
        "ffmpeg_path": settings.get('ffmpeg_path'),
        "original_url": item_url,
        "cookies_file": safe_cookies_file,
        "enable_cache": settings.get('enable_cache', True),
        "cookies_browser": safe_cookies_browser,
        "disable_http_persistent": item.get('disable_http_persistent', False),
        "disable_network_overrides": settings.get('disable_network_overrides', False),
        "http_persistence": settings.get('http_persistence', 'auto'),
        "enable_reconnect": settings.get('enable_reconnect', True),
        "reconnect_delay": settings.get('reconnect_delay', 4),
        "demuxer_max_bytes": settings.get('demuxer_max_bytes', '1G'),
        "demuxer_max_back_bytes": settings.get('demuxer_max_back_bytes', '500M'),
        "cache_secs": settings.get('cache_secs', 500),
        "demuxer_readahead_secs": settings.get('demuxer_readahead_secs', 500),
        "stream_buffer_size": settings.get('stream_buffer_size', '10M'),
        "analyzeduration": settings.get('analyzeduration', 0),
        "probesize": settings.get('probesize', 32),
        "resume_time": resume_time,
        "project_root": script_dir,
        "folder_id": item.get("folder_id") or settings.get("folder_id"),
        "mark_watched": get_mark_watched(item, settings),
        "marked_as_watched": item.get('marked_as_watched') if item.get('marked_as_watched') is not None else item.get('markedAsWatched', False),
        "watched": item.get('watched') if item.get('watched') is not None else item.get('watched', False),
        "targeted_defaults": settings.get('targeted_defaults', 'none')
    }

    # If precise resume is disabled globally, don't pass it to Lua
    if not settings.get('enable_precise_resume', True):
        lua_options["resume_time"] = None

    return lua_options, item_url

# --- Dependency Checking & Updating ---

def update_ytdlp(send_message_func):
    """Downloads the latest yt-dlp binary and replaces the existing one."""
    return dependency_manager.update_ytdlp(send_message_func)

def check_mpv_and_ytdlp_status(get_mpv_executable_func, send_message_func, force_refresh=False):
    """Checks for the presence and version of mpv, yt-dlp, and ffmpeg executables."""
    return dependency_manager.check_mpv_and_ytdlp_status(get_mpv_executable_func, send_message_func, force_refresh)

def get_essential_ytdlp_flags(settings=None, bypass=False):
    """Returns the baseline yt-dlp flags required for reliable streaming and security."""
    config = settings if settings else file_io.get_settings()

    # Base security and functionality flags
    flags_list = ["remote-components=ejs:github"]

    # Handle JS Runtimes (Critical for YouTube)
    node_path = config.get("node_path")
    if node_path and os.path.exists(node_path) and security.is_safe_executable_path(node_path, "node_path"):
        flags_list.append(f"js-runtimes=node:{node_path}")
    else:
        flags_list.append("js-runtimes=node")

    if config.get('yt_ignore_config', True):
        flags_list.insert(0, "ignore-config=")

    # Performance Injectors - SKIP IF BYPASS ACTIVE
    if not bypass:
        raw_concurrent = config.get('ytdlp_concurrent_fragments', 4)
        try:
            concurrent = int(raw_concurrent) if not isinstance(raw_concurrent, bool) else 4
        except (ValueError, TypeError):
            concurrent = 4
        if concurrent > 1:
            flags_list.append(f"concurrent-fragments={concurrent}")

        buf_size = config.get('stream_buffer_size', '10M')
        if buf_size:
            buf_str = str(buf_size).strip()
            if re.match(r'^[0-9]+[KMGkmg]?$', buf_str):
                flags_list.append(f"buffer-size={buf_str}")
            else:
                logging.warning(f"[PY][Services] Ignored invalid stream_buffer_size '{buf_size}'.")

    ffmpeg_path = config.get("ffmpeg_path")
    if ffmpeg_path and os.path.exists(ffmpeg_path) and security.is_safe_executable_path(ffmpeg_path, "ffmpeg_path"):
        flags_list.append(f"ffmpeg-location={ffmpeg_path}")

    return ",".join(flags_list)

# --- MPV Command Construction ---

def construct_mpv_command(*args, **kwargs):
    return mpv_command_builder.construct_mpv_command(*args, **kwargs)

def get_mpv_popen_kwargs(has_terminal_flag):
    return mpv_command_builder.get_mpv_popen_kwargs(has_terminal_flag)

# --- URL Bypass & Analysis ---

def apply_bypass_script(url_item, send_message_func, settings=None, session=None, quiet=False):
    """Applies URL analysis logic if enabled in settings."""
    if session and getattr(session, 'launch_cancelled', False):
        raise RuntimeError("Launch cancelled by user.")

    if not isinstance(url_item, dict):
        url_item = {'url': url_item if url_item else "", 'settings': {}}

    original_url = sanitize_url(url_item['url'])
    if settings is None:
        settings = file_io.get_settings()

    enable_url_analysis = settings.get("enable_url_analysis", False)
    browser_for_analysis = settings.get("browser_for_url_analysis", "chrome")
    enable_youtube_analysis = settings.get("enable_youtube_analysis", False)
    user_agent_string = settings.get("user_agent_string", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
    ytdl_quality = settings.get("ytdl_quality", "best")

    is_youtube = "youtube.com/" in original_url or "youtu.be/" in original_url
    default_return_tuple = (original_url, None, None, False, is_youtube, None, False, None, False, None, None)

    if original_url and "://" in original_url and not security.is_safe_url(original_url):
        logging.warning(f"Security: Blocked unsafe URL in apply_bypass_script: {original_url}")
        return ("", None, None, False, False, None, False, None, False, None, None)

    if not enable_url_analysis:
        return default_return_tuple

    youtube_enabled_for_script = "true" if enable_youtube_analysis else "false"
    item_settings = url_item.get('settings', {})
    yt_use_cookies = item_settings.get('yt_use_cookies', True)
    yt_mark_watched = item_settings.get('yt_mark_watched', True)
    yt_ignore_config = item_settings.get('yt_ignore_config', True)
    other_sites_use_cookies = item_settings.get('other_sites_use_cookies', True)

    try:
        logging.info(f"Executing URL analysis for URL: {original_url}")
        if not quiet:
            send_message_func({"action": "log_from_native_host", "log": {"text": f"Running URL analysis for: {original_url}", "type": "info"}})

        result = url_analyzer.run_bypass_logic(
            original_url,
            browser_for_analysis,
            youtube_enabled_for_script,
            user_agent_string,
            yt_use_cookies=yt_use_cookies,
            yt_mark_watched=yt_mark_watched,
            yt_ignore_config=yt_ignore_config,
            other_sites_use_cookies=other_sites_use_cookies,
            ytdl_quality=ytdl_quality,
            check_cancelled=lambda: session and getattr(session, 'launch_cancelled', False)
        )

        if not result.get("success", False):
            error_message = result.get("error", "Unknown error from URL analyzer.")
            logging.error(f"URL analysis indicated failure: {error_message}")
            send_message_func({"action": "log_from_native_host", "log": {"text": f"URL analysis failed: {error_message}. Playing original URL.", "type": "error"}})
            return default_return_tuple

        processed_url = result.get("url", original_url)
        headers_for_mpv = result.get("headers")
        ytdl_raw_options_for_mpv = result.get("ytdl_raw_options")
        use_ytdl_mpv_flag = result.get("use_ytdl_mpv", False)
        is_youtube_flag_from_script = result.get("is_youtube", False) if use_ytdl_mpv_flag else False
        entries = result.get("entries")
        disable_http_persistent = result.get("disable_http_persistent", False)
        cookies_file = result.get("cookies_file")
        cookies_browser = result.get("cookies_browser")
        mark_watched = result.get("mark_watched", False)
        ytdl_format_result = result.get("ytdl_format")

        return (processed_url, headers_for_mpv, ytdl_raw_options_for_mpv, use_ytdl_mpv_flag, is_youtube_flag_from_script, entries, disable_http_persistent, cookies_file, mark_watched, ytdl_format_result, cookies_browser)

    except Exception as e:
        logging.error(f"Error during URL analysis: {e}")
        send_message_func({"action": "log_from_native_host", "log": {"text": f"URL analysis failed with exception: {e}. Playing original URL.", "type": "error"}})
        return (original_url, None, None, False, is_youtube, None, False, None, False, None, None)

# --- AniList Service ---

def get_anilist_releases_with_cache(*args, **kwargs):
    return anilist_service.get_anilist_releases_with_cache(*args, **kwargs)
