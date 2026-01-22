"""
MPV Playlist Organizer - Backend Services
Collection of utilities for URL processing, dependency management, and MPV command building.

NOTE ON LATE IMPORTS (E402): 
Imports are intentionally deferred to minimize initial startup time for the Native Host.
"""
import json
import logging
import os
import platform
import shutil
import subprocess
import sys
from datetime import datetime

# Prevent __pycache__ generation
sys.dont_write_bytecode = True
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'

import time
import shlex
import re
from utils import url_analyzer
from utils import dependency_manager, anilist_service, mpv_command_builder
import file_io

# A set of mpv flags that are considered safe to be passed from the extension.
ALLOWED_PROTOCOLS = ('http://', 'https://', 'file://', 'udp://', 'rtmp://', 'rtsp://', 'mms://')

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
    '--terminal', '--input-terminal',
}

def sanitize_url(url):
    """Sanitizes a URL by removing potentially dangerous characters."""
    return file_io.sanitize_string(url, is_filename=False)

def get_gpu_vendor():
    system = platform.system()
    try:
        if system == "Windows":
            cmd = ["wmic", "path", "win32_VideoController", "get", "name"]
            output = subprocess.check_output(cmd, stderr=subprocess.STDOUT, text=True).lower()
        elif system == "Darwin":
            return "apple"
        else:
            if shutil.which("lspci"):
                output = subprocess.check_output(["lspci"], stderr=subprocess.STDOUT, text=True).lower()
            else:
                return "unknown"
        if "nvidia" in output:
            return "nvidia"
        elif "intel" in output:
            return "intel"
        elif "amd" in output or "radeon" in output:
            return "amd"
    except Exception:
        pass
    return "unknown"

def get_mark_watched(item, settings):
    """Normalizes the mark_watched preference for an item."""
    val = item.get('mark_watched')
    if val is None:
        val = settings.get('yt_mark_watched', True)
    if isinstance(val, str):
        return val.lower() in ("true", "yes", "1")
    return bool(val)

def construct_lua_options(item, settings, script_dir, index=None):
    """
    Centralized helper to construct the options dictionary passed to adaptive_headers.lua.
    Ensures all metadata and networking overrides are consistent.
    """
    essential_flags = get_essential_ytdlp_flags(settings)
    raw_opts = item.get('ytdl_raw_options')
    
    # Support Direct Browser Access
    if item.get('cookies_browser'):
         browser_opt = f"cookies-from-browser={item['cookies_browser']}"
         raw_opts = f"{raw_opts},{browser_opt}" if raw_opts else browser_opt

    final_opts = file_io.merge_ytdlp_options(raw_opts, essential_flags)
    
    item_url = sanitize_url(item.get('original_url') or item.get('url'))
    
    lua_options = {
        "id": item.get('id'), 
        "title": item.get('title'),
        "headers": item.get('headers'),
        "ytdl_raw_options": final_opts,
        "use_ytdl_mpv": item.get('use_ytdl_mpv', False) or item.get('is_youtube', False),
        "ytdl_format": item.get('ytdl_format'),
        "ffmpeg_path": settings.get('ffmpeg_path'),
        "original_url": item_url,
        "cookies_file": item.get('cookies_file'),
        "cookies_browser": item.get('cookies_browser'),
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
        "resume_time": item.get('resume_time'),
        "project_root": script_dir,
        "mark_watched": get_mark_watched(item, settings),
        "marked_as_watched": item.get('marked_as_watched', False),
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
    config = settings if settings else file_io._safe_json_load(file_io.CONFIG_FILE)
    
    # Base security and functionality flags
    flags_list = ["remote-components=ejs:github"]
    
    # Handle JS Runtimes (Critical for YouTube)
    node_path = config.get("node_path")
    if node_path and os.path.exists(node_path):
        flags_list.append(f"js-runtimes=node:{node_path}")
    else:
        flags_list.append("js-runtimes=node")
    
    if config.get('yt_ignore_config', True):
        flags_list.insert(0, "ignore-config=")
    
    # Performance Injectors - SKIP IF BYPASS ACTIVE
    if not bypass:
        concurrent = config.get('ytdlp_concurrent_fragments', 4)
        if concurrent > 1:
            flags_list.append(f"concurrent-fragments={concurrent}")
        
        buf_size = config.get('stream_buffer_size', '10M')
        if buf_size:
            flags_list.append(f"buffer-size={buf_size}")

    ffmpeg_path = config.get("ffmpeg_path")
    if ffmpeg_path and os.path.exists(ffmpeg_path):
        flags_list.append(f"ffmpeg-location={ffmpeg_path}")
    
    return ",".join(flags_list)

# --- MPV Command Construction ---

def construct_mpv_command(*args, **kwargs):
    return mpv_command_builder.construct_mpv_command(*args, **kwargs)

def get_mpv_popen_kwargs(has_terminal_flag):
    return mpv_command_builder.get_mpv_popen_kwargs(has_terminal_flag)

# --- URL Bypass & Analysis ---

def apply_bypass_script(url_item, send_message_func, settings=None, session=None):
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