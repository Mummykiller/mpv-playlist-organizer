import logging
import os
import uuid
from .. import native_link
from .context import BackendContext

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

        # Restore session token
        restored_data = self.mpv_session.restore()
        if restored_data and restored_data.get("token"):
            self.server_token = restored_data["token"]
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
                if value is not None:
                    settings[key] = value
        return settings
