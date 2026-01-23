import os
import platform
import subprocess
import shlex
import re
import logging
import shutil
from datetime import datetime
import file_io
from . import security

# Prevent __pycache__ generation
import sys
sys.dont_write_bytecode = True
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'

ALLOWED_PROTOCOLS = security.ALLOWED_PROTOCOLS

class MpvCommandBuilder:
    def __init__(self, mpv_exe, use_ytdl_mpv=False, is_youtube_override=False, is_youtube=False, settings=None, cookies_browser=None, force_bypass=False):
        self.mpv_exe = mpv_exe
        self.settings = settings or {}
        self.cookies_browser = cookies_browser
        self.use_ytdl_mpv = use_ytdl_mpv
        self.is_youtube_override = is_youtube_override
        self.is_youtube = is_youtube
        self.force_bypass_hint = force_bypass
        
        self.url = None
        self.ipc_path = None
        self.scripts = []
        self.script_opts = []
        self.title = None
        self.geometry = None
        self.headers = None
        self.custom_flags = None
        self.automatic_flags = None
        self.playlist_start = None
        self.idle_val = None
        self.ytdl_raw_options = None
        self.disable_http_persistent_override = False
        self.input_terminal = None
        self.has_terminal_flag = False
        self.is_forced_terminal = False

    def with_ipc_path(self, ipc_path):
        self.ipc_path = file_io.validate_safe_path(ipc_path)
        return self

    def with_url(self, url):
        if url:
            if isinstance(url, list):
                self.url = [file_io.sanitize_string(u, is_filename=False) for u in url if file_io.sanitize_string(u, is_filename=False).lower().startswith(ALLOWED_PROTOCOLS)]
            else:
                sanitized = file_io.sanitize_string(url, is_filename=False)
                if sanitized.lower().startswith(ALLOWED_PROTOCOLS):
                    self.url = sanitized
        return self

    def with_completion_script(self, script_dir, flag_dir=None):
        if script_dir:
            p = os.path.join(script_dir, "mpv_scripts", "on_completion.lua")
            safe_p = file_io.validate_safe_path(p)
            if safe_p and os.path.exists(safe_p):
                self.scripts.append(safe_p)
                if flag_dir: 
                    safe_flag_dir = file_io.validate_safe_path(flag_dir)
                    if safe_flag_dir:
                         self.script_opts.append(f'on_completion-flag_dir={safe_flag_dir}')
        return self

    def with_adaptive_headers_script(self, script_dir):
        if script_dir:
            p = os.path.join(script_dir, "mpv_scripts", "adaptive_headers.lua")
            safe_p = file_io.validate_safe_path(p)
            if safe_p and os.path.exists(safe_p):
                self.scripts.append(safe_p)
        return self

    def with_python_interaction_script(self, script_dir):
        if script_dir:
            p = os.path.join(script_dir, "mpv_scripts", "python_loader.lua")
            safe_p = file_io.validate_safe_path(p)
            if safe_p and os.path.exists(safe_p):
                self.scripts.append(safe_p)
        return self

    def with_title(self, title):
        self.title = title
        return self

    def with_automatic_flags(self, flags):
        self.automatic_flags = flags
        return self

    def with_force_terminal(self, force):
        if force:
            self.has_terminal_flag = True
            self.is_forced_terminal = True
        return self

    def with_input_terminal(self, val):
        self.input_terminal = val
        return self

    def with_headers(self, headers):
        self.headers = headers
        return self

    def with_disable_http_persistent(self, val):
        self.disable_http_persistent_override = val
        return self

    def with_start_paused(self, paused):
        if paused:
            if not self.automatic_flags:
                self.automatic_flags = []
            self.automatic_flags.append({'flag': '--pause', 'enabled': True})
        return self

    def with_custom_flags(self, flags):
        self.custom_flags = flags
        return self

    def with_geometry(self, geometry, w, h):
        self.geometry = (geometry, w, h)
        return self

    def with_playlist_start(self, index):
        self.playlist_start = index
        return self

    def with_idle(self, idle):
        self.idle_val = idle
        return self

    def with_youtube_options(self, is_yt, raw_opts):
        self.ytdl_raw_options = raw_opts
        return self

    def build(self):
        args = [self.mpv_exe]
        if self.ipc_path: args.append(f'--input-ipc-server={self.ipc_path}')
        if self.idle_val: args.append(f'--idle={self.idle_val if isinstance(self.idle_val, str) else "yes"}')
        if self.input_terminal: args.append(f'--input-terminal={self.input_terminal}')
        for s in self.scripts: args.append(f'--script={s}')
        if self.script_opts: args.append(f"--script-opts={','.join(self.script_opts)}")
        if self.title: args.append(f'--title={security.sanitize_string(self.title)}')
        if self.playlist_start and self.playlist_start > 0: args.append(f'--playlist-start={self.playlist_start}')
        
        # Performance optimization: Fast seeking for immediate startup
        args.append("--hr-seek=no")

        if self.headers:
            if 'User-Agent' in self.headers: args.append(f'--user-agent={security.sanitize_string(str(self.headers["User-Agent"]))}')
            if 'Referer' in self.headers: args.append(f'--referrer={security.sanitize_string(str(self.headers["Referer"]))}')

        decoder = self.settings.get('mpv_decoder', 'auto')
        if decoder: args.append(f"--hwdec={decoder}")
        
        profile = self.settings.get('performance_profile', 'default')
        if profile == 'low': args.append("--profile=fast")
        elif profile == 'medium': args.extend(["--scale=spline36", "--cscale=spline36", "--vo=gpu"])
        elif profile == 'high': args.append("--profile=gpu-hq")
        elif profile == 'ultra':
            args.append("--profile=gpu-hq")
            if self.settings.get('ultra_scalers', True): args.extend(["--scale=ewa_lanczossharp", "--cscale=ewa_lanczossharp"])
            if self.settings.get('ultra_video_sync', True): args.append("--video-sync=display-resample")
            interp = self.settings.get('ultra_interpolation', 'oversample')
            if interp not in ('off', False):
                args.append("--interpolation=yes")
                args.append(f"--tscale={interp if isinstance(interp, str) else 'oversample'}")
            if self.settings.get('ultra_deband', True): args.extend(["--deband=yes", "--deband-iterations=4", "--deband-threshold=48", "--deband-range=24"])
            if self.settings.get('ultra_fbo', True): args.append("--fbo-format=rgba16f")

        if self.geometry:
            geom, w, h = self.geometry
            GEOM_PATTERN = re.compile(r'^[0-9x+%+-]+$')
            if w and h and GEOM_PATTERN.match(str(w)) and GEOM_PATTERN.match(str(h)): args.append(f'--geometry={w}x{h}')
            elif geom and GEOM_PATTERN.match(str(geom)): args.append(f'--geometry={geom}')

        q = str(self.settings.get('ytdl_quality', 'best'))
        ytdl_format = "bv*+ba/best"
        if q != 'best' and q in ['2160', '1440', '1080', '720', '480']:
            if int(q) > 1080: ytdl_format = f"bv*[height<=?{q}][vcodec~='^vp0?9|^av01']+ba/bv*[height<=?{q}]+ba/best"
            else: ytdl_format = f"bv*[height<=?{q}]+ba/best"
        args.append(f"--ytdl-format={ytdl_format}")
        
        if self.cookies_browser:
            browser_opt = f"cookies-from-browser={self.cookies_browser}"
            self.ytdl_raw_options = f"{self.ytdl_raw_options},{browser_opt}" if self.ytdl_raw_options else browser_opt
        
        if self.ytdl_raw_options: args.append(f"--ytdl-raw-options={self.ytdl_raw_options}")
        if self.use_ytdl_mpv or (self.is_youtube and not self.is_youtube_override): args.append('--ytdl=yes')

        if self.automatic_flags:
            for f_info in self.automatic_flags:
                if f_info.get('enabled'):
                    f = f_info.get('flag')
                    if f == '--terminal': self.has_terminal_flag = True
                    elif not f or f.startswith('--hwdec'): continue
                    elif f.split('=', 1)[0] in security.SAFE_MPV_FLAGS_ALLOWLIST: args.append(f)

        if self.custom_flags:
            try:
                parsed = []
                if isinstance(self.custom_flags, list):
                    for f in self.custom_flags:
                        if isinstance(f, dict) and f.get('enabled', True): parsed.extend(shlex.split(f.get('flag','')))
                        elif isinstance(f, str): parsed.extend(shlex.split(f))
                elif isinstance(self.custom_flags, str): parsed.extend(shlex.split(self.custom_flags))
                for a in parsed:
                    if a.startswith('--') and a.split('=', 1)[0] in security.SAFE_MPV_FLAGS_ALLOWLIST: args.append(a)
            except Exception: pass

        if self.has_terminal_flag: args = [a for a in args if a != '--terminal' and a != 'terminal']
        full_command = args + (['--'] + (self.url if isinstance(self.url, list) else [self.url]) if self.url else [])
        
        if self.settings.get('os_platform', platform.system()) != "Windows" and self.has_terminal_flag:
            term_cmd = []
            modern = ['konsole', 'gnome-terminal', 'xfce4-terminal', 'kitty', 'alacritty', 'tilix', 'foot', 'wezterm']
            if self.is_forced_terminal:
                inner = ' '.join(shlex.quote(a) for a in full_command)
                kp = shutil.which('konsole')
                if kp: term_cmd = [kp, '--hold', '-e'] + full_command
                else:
                    wrapped = f"{inner}; echo ''; echo '--- MPV Finished. Closing in 10s... ---'; sleep 10"
                    if shutil.which('xdg-terminal-exec'): term_cmd = ['xdg-terminal-exec', 'sh', '-c', wrapped]
                    else:
                        for t in modern:
                            tp = shutil.which(t)
                            if tp:
                                term_cmd = [tp, '--', 'sh', '-c', wrapped]
                                break
            else:
                if shutil.which('xdg-terminal-exec'): term_cmd = ['xdg-terminal-exec'] + full_command
                else:
                    for t in modern:
                        tp = shutil.which(t)
                        if tp:
                            term_cmd = [tp, '-e'] + full_command
                            break
            if term_cmd: full_command = term_cmd

        cmd_str = ' '.join(shlex.quote(a) for a in full_command)
        if self.settings.get('os_platform', platform.system()) == "Windows" and len(cmd_str) > 7500:
            logging.error(f"CRITICAL: Command line length ({len(cmd_str)}) exceeds limit.")
            raise RuntimeError(f"Command too long for Windows.")

        logging.info(f"Constructed MPV command: {cmd_str}")
        try:
            p = os.path.join(file_io.DATA_DIR, "last_mpv_command.txt")
            with open(p, 'w', encoding='utf-8') as f:
                f.write(f"Launch Timestamp: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n" + "="*60 + "\nSHELL-QUOTED COMMAND:\n" + " ".join(shlex.quote(a) for a in full_command))
        except Exception: pass
        return full_command, self.has_terminal_flag

def construct_mpv_command(mpv_exe, ipc_path=None, url=None, is_youtube=False, ytdl_raw_options=None, geometry=None, custom_width=None, custom_height=None, custom_mpv_flags=None, automatic_mpv_flags=None, headers=None, disable_http_persistent=False, start_paused=False, script_dir=None, load_on_completion_script=False, title=None, use_ytdl_mpv=False, is_youtube_override=False, idle=False, force_terminal=False, input_terminal=None, settings=None, flag_dir=None, playlist_start_index=None, cookies_browser=None, force_bypass=False):
    b = MpvCommandBuilder(mpv_exe, use_ytdl_mpv, is_youtube_override, is_youtube, settings, cookies_browser, force_bypass=force_bypass)
    b.with_ipc_path(ipc_path).with_url(url).with_title(title).with_headers(headers)
    b.with_geometry(geometry, custom_width, custom_height).with_playlist_start(playlist_start_index)
    b.with_automatic_flags(automatic_mpv_flags).with_custom_flags(custom_mpv_flags)
    b.with_force_terminal(force_terminal).with_input_terminal(input_terminal)
    b.with_disable_http_persistent(disable_http_persistent).with_start_paused(start_paused)
    b.with_idle(idle).with_youtube_options(is_youtube, ytdl_raw_options)
    if script_dir:
        b.with_adaptive_headers_script(script_dir).with_python_interaction_script(script_dir)
        if load_on_completion_script: b.with_completion_script(script_dir, flag_dir)
    return b.build()

def get_mpv_popen_kwargs(has_terminal_flag):
    kwargs = {'stdout': subprocess.PIPE if not has_terminal_flag else None, 'stderr': subprocess.STDOUT if not has_terminal_flag else None, 'universal_newlines': False}
    if platform.system() == "Windows":
        flags = subprocess.CREATE_NEW_PROCESS_GROUP
        if not has_terminal_flag: flags |= subprocess.CREATE_NO_WINDOW
        kwargs['creationflags'] = flags
    else: kwargs['start_new_session'] = True
    return kwargs
