from typing import Dict, Any, Type, Optional
from .models import (
    BaseRequest, PlaybackRequest, LiveUpdateRequest, 
    DataSyncRequest, ServiceRequest, SettingsOverrides
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
    'reorder_live': LiveUpdateRequest,
    'clear_live': LiveUpdateRequest,
    'is_mpv_running': LiveUpdateRequest,
    'get_playback_status': LiveUpdateRequest,
    'close_mpv': LiveUpdateRequest,
    
    # Data & Settings
    'export_data': DataSyncRequest,
    'export_playlists': DataSyncRequest,
    'export_all_playlists_separately': DataSyncRequest,
    'import_from_file': DataSyncRequest,
    'set_ui_preferences': DataSyncRequest,
    
    # Services
    'get_anilist_releases': ServiceRequest,
    'check_dependencies': ServiceRequest,
}

import re

# Keys that should NOT be converted (acronyms, special IDs, etc.)
WHITELIST = {'request_id', 'url', 'm3u8'}

def _camel_to_snake(camel_str: str) -> str:
    """Converts camelCase to snake_case."""
    if camel_str in WHITELIST:
        return camel_str
    # Handle acronyms and standard camelCase
    s1 = re.sub('(.)([A-Z][a-z]+)', r'\1_\2', camel_str)
    return re.sub('([a-z0-9])([A-Z])', r'\1_\2', s1).lower()

def _normalize_message(data: Any) -> Any:
    """Recursively normalizes camelCase keys to snake_case for Python logic."""
    if isinstance(data, dict):
        new_dict = {}
        for k, v in data.items():
            new_key = _camel_to_snake(k) if isinstance(k, str) else k
            new_dict[new_key] = _normalize_message(v)
        return new_dict
    elif isinstance(data, list):
        return [_normalize_message(i) for i in data]
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
            settings=SettingsOverrides.from_dict(norm_message)
        )
    
    elif req_class == LiveUpdateRequest:
        return LiveUpdateRequest(
            action=action,
            request_id=request_id,
            folder_id=norm_message.get('folder_id'),
            item_id=norm_message.get('item_id'),
            played_ids=norm_message.get('played_ids'),
            watched_ids=norm_message.get('watched_ids'),
            session_ids=norm_message.get('session_ids'),
            new_order=norm_message.get('new_order')
        )
    
    elif req_class == DataSyncRequest:
        return DataSyncRequest(
            action=action,
            request_id=request_id,
            data=norm_message.get('data'),
            is_incremental=norm_message.get('is_incremental', False),
            filename=norm_message.get('filename'),
            subfolder=norm_message.get('subfolder'),
            custom_names=norm_message.get('custom_names'),
            preferences=norm_message.get('preferences')
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
    
    return BaseRequest(action=action, request_id=request_id)
