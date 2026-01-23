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

def translate(message: Dict[str, Any]) -> BaseRequest:
    action = message.get('action')
    request_id = message.get('request_id')
    
    req_class = ACTION_MAP.get(action, BaseRequest)
    
    if req_class == PlaybackRequest:
        return PlaybackRequest(
            action=action,
            request_id=request_id,
            folder_id=message.get('folderId'),
            url_item=message.get('url_item'),
            url_items=message.get('url_items'),
            playlist=message.get('playlist'),
            playlist_start_id=message.get('playlist_start_id'),
            m3u_data=message.get('m3u_data'),
            geometry=message.get('geometry'),
            custom_width=message.get('custom_width'),
            custom_height=message.get('custom_height'),
            custom_mpv_flags=message.get('custom_mpv_flags'),
            automatic_mpv_flags=message.get('automatic_mpv_flags'),
            start_paused=message.get('start_paused', False),
            force_terminal=message.get('force_terminal', False),
            play_new_instance=message.get('play_new_instance', False),
            settings=SettingsOverrides.from_dict(message)
        )
    
    elif req_class == LiveUpdateRequest:
        return LiveUpdateRequest(
            action=action,
            request_id=request_id,
            folder_id=message.get('folderId'),
            item_id=message.get('item_id'),
            new_order=message.get('new_order')
        )
    
    elif req_class == DataSyncRequest:
        return DataSyncRequest(
            action=action,
            request_id=request_id,
            data=message.get('data'),
            is_incremental=message.get('is_incremental', False),
            filename=message.get('filename'),
            subfolder=message.get('subfolder'),
            custom_names=message.get('customNames'),
            preferences=message.get('preferences')
        )
        
    elif req_class == ServiceRequest:
        return ServiceRequest(
            action=action,
            request_id=request_id,
            force=message.get('force', False),
            delete_cache=message.get('delete_cache', False),
            is_cache_disabled=message.get('is_cache_disabled', False),
            days=message.get('days', 0),
            force_refresh=message.get('force_refresh', False)
        )
    
    return BaseRequest(action=action, request_id=request_id)
