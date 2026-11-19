from typing import Dict, Any, Type, Optional
from .models import (
    BaseRequest, PlaybackRequest, LiveUpdateRequest,
    DataSyncRequest, ServiceRequest, SettingsOverrides, LogRequest,
    LogBrowserErrorRequest
)

# Action to Dataclass mapping
ACTION_MAP: Dict[str, Type[BaseRequest]] = {
    # Playback
    'play': PlaybackRequest,
    'play_batch': PlaybackRequest,
    'play_m3u': PlaybackRequest,
    'append': PlaybackRequest,
    'play_new_instance': PlaybackRequest,

    # Live Updates / Status
    'remove_item_live': LiveUpdateRequest,
    'remove_items_live': LiveUpdateRequest,
    'reorder_live': LiveUpdateRequest,
    'clear_live': LiveUpdateRequest,
    'update_item_marked_as_watched': LiveUpdateRequest,
    'is_mpv_running': LiveUpdateRequest,
    'get_playback_status': LiveUpdateRequest,
    'close_mpv': LiveUpdateRequest,

    # Data & Settings
    'export_data': DataSyncRequest,
    'export_playlists': DataSyncRequest,
    'export_all_playlists_separately': DataSyncRequest,
    'import_from_file': DataSyncRequest,
    'set_ui_preferences': DataSyncRequest,
    'get_unified_diagnostics': DataSyncRequest,
    'get_smart_reorder': DataSyncRequest,
    'get_metadata_cache': DataSyncRequest,
    'cancel_task': DataSyncRequest,

    # Services
    'get_anilist_releases': ServiceRequest,
    'check_dependencies': ServiceRequest,

    # Logging
    'log_event': LogRequest,
    'log_browser_error': LogBrowserErrorRequest,
}

import re

# Keys that should NOT be converted (acronyms, special IDs, etc.)
WHITELIST = {'request_id', 'url', 'm3u8'}

def _camel_to_snake(camel_str: str) -> str:
    """Converts camelCase to snake_case."""
    if camel_str in WHITELIST:
        return camel_str
    # Handle acronyms and standard camelCase (only between alphanumeric characters)
    s1 = re.sub(r'([a-zA-Z0-9])([A-Z][a-z]+)', r'\1_\2', camel_str)
    return re.sub(r'([a-z0-9])([A-Z])', r'\1_\2', s1).lower()

SUBTREE_PRESERVE_KEYS = {
    "youtube_tools",
    "youtubeTools",
    "shinku_library",
    "shinkuLibrary",
    "shinku_extension_settings",
    "shinkuExtensionSettings",
}


FORBIDDEN_KEYS = {"__proto__", "constructor", "prototype"}


def _normalize_message(data: Any, parent_key: Optional[str] = None, preserve_subtree: bool = False) -> Any:
    """Recursively normalizes camelCase keys to snake_case for Python logic."""
    if isinstance(data, dict):
        new_dict = {}
        preserve_immediate_keys = preserve_subtree or parent_key in (
            "data", "folders", "domains", "headers", "http_headers", "httpHeaders", "custom_names", "customNames"
        )
        for k, v in data.items():
            if isinstance(k, str) and k in FORBIDDEN_KEYS:
                continue
            if preserve_immediate_keys or not isinstance(k, str):
                new_key = k
            else:
                new_key = _camel_to_snake(k)
            if isinstance(new_key, str) and new_key in FORBIDDEN_KEYS:
                continue

            next_preserve_subtree = preserve_subtree or (k in SUBTREE_PRESERVE_KEYS) or (new_key in SUBTREE_PRESERVE_KEYS)
            # Determine child parent_key so nested item dicts inside folder maps are still normalized
            if parent_key in ("data", "folders", "domains") and new_key not in ("folders", "domains"):
                child_parent_key = None
            elif parent_key in ("headers", "http_headers", "httpHeaders"):
                child_parent_key = None
            else:
                child_parent_key = new_key if isinstance(new_key, str) else None

            new_dict[new_key] = _normalize_message(v, parent_key=child_parent_key, preserve_subtree=next_preserve_subtree)
        return new_dict
    elif isinstance(data, list):
        return [_normalize_message(i, parent_key=None, preserve_subtree=preserve_subtree) for i in data]
    return data

def translate(message: Dict[str, Any]) -> BaseRequest:
    # 1. Pre-normalize all keys to snake_case
    norm_message = _normalize_message(message)

    action = norm_message.get('action')
    request_id = norm_message.get('request_id')

    req_class = ACTION_MAP.get(action, BaseRequest)

    if req_class == PlaybackRequest:
        return PlaybackRequest(
            action=action,
            request_id=request_id,
            folder_id=norm_message.get('folder_id'),
            url_item=norm_message.get('url_item'),
            url_items=norm_message.get('url_items'),
            playlist=norm_message.get('playlist'),
            playlist_start_id=norm_message.get('playlist_start_id'),
            m3u_data=norm_message.get('m3u_data'),
            geometry=norm_message.get('geometry'),
            custom_width=norm_message.get('custom_width'),
            custom_height=norm_message.get('custom_height'),
            custom_mpv_flags=norm_message.get('custom_mpv_flags'),
            automatic_mpv_flags=norm_message.get('automatic_mpv_flags'),
            start_paused=norm_message.get('start_paused', False),
            force_terminal=norm_message.get('force_terminal', False),
            play_new_instance=norm_message.get('play_new_instance', False),
            is_unmanaged=norm_message.get('is_unmanaged', False),
            settings=SettingsOverrides.from_dict(norm_message)
        )

    elif req_class == LiveUpdateRequest:
        return LiveUpdateRequest(
            action=action,
            request_id=request_id,
            folder_id=norm_message.get('folder_id'),
            item_id=norm_message.get('item_id'),
            item_ids=norm_message.get('item_ids'),
            marked_as_watched=norm_message.get('marked_as_watched'),
            watched=norm_message.get('watched'),
            played_ids=norm_message.get('played_ids'),
            watched_ids=norm_message.get('watched_ids'),
            session_ids=norm_message.get('session_ids'),
            new_order=norm_message.get('new_order')
        )

    elif req_class == DataSyncRequest:
        return DataSyncRequest(
            action=action,
            request_id=request_id,
            folder_id=norm_message.get('folder_id'),
            data=norm_message.get('data'),
            is_incremental=norm_message.get('is_incremental', False),
            filename=norm_message.get('filename'),
            subfolder=norm_message.get('subfolder'),
            custom_names=norm_message.get('custom_names'),
            preferences=norm_message.get('preferences'),
            shard=norm_message.get('shard'),
            task_id=norm_message.get('task_id')
        )

    elif req_class == ServiceRequest:
        return ServiceRequest(
            action=action,
            request_id=request_id,
            force=norm_message.get('force', False),
            delete_cache=norm_message.get('delete_cache', False),
            is_cache_disabled=norm_message.get('is_cache_disabled', False),
            days=norm_message.get('days', 0),
            force_refresh=norm_message.get('force_refresh', False)
        )

    elif req_class == LogRequest:
        return LogRequest(
            action=action,
            request_id=request_id,
            level=norm_message.get('level', 'INFO'),
            message=norm_message.get('message', ''),
            context=norm_message.get('context', 'JS'),
            stack=norm_message.get('stack', '')
        )

    elif req_class == LogBrowserErrorRequest:
        return LogBrowserErrorRequest(
            action=action,
            request_id=request_id,
            message=norm_message.get('message', norm_message.get('error', '')),
            context=norm_message.get('context', 'Browser'),
            stack=norm_message.get('stack', '')
        )

    return BaseRequest(action=action, request_id=request_id)
