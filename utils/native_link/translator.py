from typing import Dict, Any, Type
from .models import (
    BaseRequest, PlaybackRequest, LiveUpdateRequest, 
    DataSyncRequest, ServiceRequest, SettingsOverrides
)

def translate(message: Dict[str, Any]) -> BaseRequest:
    action = message.get('action')
    request_id = message.get('request_id')
    
    if action in ['play', 'play_batch', 'play_m3u', 'append', 'play_new_instance']:
        return PlaybackRequest(
            action=action,
            request_id=request_id,
            folder_id=message.get('folderId'),
            url_item=message.get('url_item'),
            url_items=message.get('url_items'),
            playlist=message.get('playlist'),
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
    
    elif action in ['remove_item_live', 'reorder_live', 'clear_live', 'is_mpv_running', 'get_playback_status', 'close_mpv']:
        return LiveUpdateRequest(
            action=action,
            request_id=request_id,
            folder_id=message.get('folderId'),
            item_id=message.get('item_id'),
            new_order=message.get('new_order')
        )
    
    elif action in ['export_data', 'export_playlists', 'export_all_playlists_separately', 'import_from_file', 'set_ui_preferences']:
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
        
    elif action in ['get_anilist_releases', 'check_dependencies']:
        return ServiceRequest(
            action=action,
            request_id=request_id,
            force=message.get('force', False),
            delete_cache=message.get('delete_cache', False),
            is_cache_disabled=message.get('is_cache_disabled', False),
            days=message.get('days', 0),
            force_refresh=message.get('force_refresh', False)
        )
    
    # Fallback for simple actions or unknown ones
    return BaseRequest(action=action, request_id=request_id)
