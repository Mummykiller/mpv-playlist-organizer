from .base_handler import BaseHandler
from .. import native_link

from .base_handler import BaseHandler
from .registry import command
from .. import native_link

class SettingsHandler(BaseHandler):
    def __init__(self, ctx):
        super().__init__(ctx)

    @command('get_anilist_releases')
    def handle_get_anilist_releases(self, request: native_link.ServiceRequest):
        res = self.services.get_anilist_releases_with_cache(
            request.force, request.delete_cache, request.is_cache_disabled, 
            request.days, self.ctx.anilist_cache_file, self.ctx.script_dir, self.send_message
        )
        if res.get('success'):
            return native_link.success(output=res.get('output'))
        return native_link.failure(res.get('error', 'Unknown AniList error'))

    @command('run_ytdlp_update')
    def handle_run_ytdlp_update(self, request: native_link.BaseRequest):
        return self.services.update_ytdlp(self.send_message)

    @command('check_dependencies')
    def handle_check_dependencies(self, request: native_link.ServiceRequest):
        return self.services.check_mpv_and_ytdlp_status(
            self.file_io.get_mpv_executable, self.send_message, 
            force_refresh=request.force_refresh
        )

    @command('get_ui_preferences')
    def handle_get_ui_preferences(self, request: native_link.BaseRequest):
        return native_link.success({"preferences": self.file_io.get_settings()})

    @command('set_ui_preferences')
    def handle_set_ui_preferences(self, request: native_link.DataSyncRequest):
        if request.preferences is None:
            return native_link.failure("No preferences provided.")
        return self.file_io.set_settings(request.preferences)

    @command('get_default_automatic_flags')
    def handle_get_default_automatic_flags(self, request: native_link.BaseRequest):
        return native_link.success({"flags": [
            {"flag": "--pause", "description": "Start MPV paused.", "enabled": False},
            {"flag": "--terminal", "description": "Show a terminal window.", "enabled": False},
            {"flag": "--save-position-on-quit", "description": "Remember playback position on exit.", "enabled": True},
            {"flag": "--loop-playlist=inf", "description": "Loop the entire playlist indefinitely.", "enabled": False},
            {"flag": "--ontop", "description": "Keep the player window on top of other windows.", "enabled": False},
            {"flag": "--force-window=immediate", "description": "Open the window immediately when starting.", "enabled": False}
        ]})
        return native_link.success({"flags": [
            {"flag": "--pause", "description": "Start MPV paused.", "enabled": False},
            {"flag": "--terminal", "description": "Show a terminal window.", "enabled": False},
            {"flag": "--save-position-on-quit", "description": "Remember playback position on exit.", "enabled": True},
            {"flag": "--loop-playlist=inf", "description": "Loop the entire playlist indefinitely.", "enabled": False},
            {"flag": "--ontop", "description": "Keep the player window on top of other windows.", "enabled": False},
            {"flag": "--force-window=immediate", "description": "Open the window immediately when starting.", "enabled": False}
        ]})
