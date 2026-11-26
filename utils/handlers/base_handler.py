import logging
import re
import uuid
from .context import BackendContext
from .. import security

_STREAM_BUFFER_SIZE_RE = re.compile(r'^[0-9]+[KMGkmg]?$')

class BaseHandler:
    def __init__(self, ctx: BackendContext):
        self.ctx = ctx
        # Aliases for easier access while maintaining some compatibility
        self.mpv_session = ctx.mpv
        self.file_io = ctx.io
        self.services = ctx.services
        self.ipc_utils = ctx.ipc
        self.send_message = ctx.sender

        from ..item_processor import ItemProcessor
        self.item_processor = ItemProcessor(
            ctx.services, ctx.sender, ctx.io,
            metadata_cache=getattr(ctx, 'metadata_cache', None),
            task_manager=getattr(ctx, 'task_manager', None)
        )

        # Initialize session token without prematurely calling restore()
        existing_token = getattr(self.mpv_session, 'current_token', None)
        if isinstance(existing_token, str) and existing_token:
            self.server_token = existing_token
            logging.info("[PY] BaseHandler: Restored existing session token.")
        else:
            self.server_token = uuid.uuid4().hex
            logging.debug("[PY] BaseHandler: Generated new session token.")

    def _get_merged_settings(self, request_settings):
        """Merges global settings with request-specific overrides."""
        settings = self.file_io.get_settings()
        if request_settings:
            # Handle both dict and object with __dict__
            attrs = request_settings.__dict__ if hasattr(request_settings, '__dict__') else request_settings
            for key, value in attrs.items():
                if value is None:
                    continue
                if key in ('ffmpeg_path', 'ytdlp_path'):
                    if not isinstance(value, str) or not security.is_safe_executable_path(value, setting_key=key):
                        logging.warning(f"[PY][SEC] Dropped invalid settings override for {key}.")
                        continue
                elif key == 'stream_buffer_size':
                    buf_str = str(value).strip()
                    if not _STREAM_BUFFER_SIZE_RE.match(buf_str):
                        logging.warning(f"[PY][SEC] Dropped invalid settings override for stream_buffer_size: '{value}'.")
                        continue
                    value = buf_str
                elif key == 'ytdlp_concurrent_fragments':
                    if isinstance(value, bool):
                        logging.warning(f"[PY][SEC] Dropped boolean override for ytdlp_concurrent_fragments: '{value}'.")
                        continue
                    try:
                        value = int(value)
                    except (ValueError, TypeError):
                        logging.warning(f"[PY][SEC] Dropped invalid override for ytdlp_concurrent_fragments: '{value}'.")
                        continue
                settings[key] = value
        return settings
