from dataclasses import dataclass, field
from typing import Optional, List, Dict, Any

@dataclass
class SettingsOverrides:
    disable_network_overrides: Optional[bool] = None
    enable_cache: Optional[bool] = None
    http_persistence: Optional[bool] = None
    demuxer_max_bytes: Optional[int] = None
    demuxer_max_back_bytes: Optional[int] = None
    cache_secs: Optional[int] = None
    demuxer_readahead_secs: Optional[int] = None
    stream_buffer_size: Optional[int] = None
    ytdlp_concurrent_fragments: Optional[int] = None
    enable_reconnect: Optional[bool] = None
    reconnect_delay: Optional[int] = None
    mpv_decoder: Optional[str] = None
    ytdl_quality: Optional[str] = None
    performance_profile: Optional[str] = None
    ultra_scalers: Optional[bool] = None
    ultra_video_sync: Optional[bool] = None
    ultra_interpolation: Optional[bool] = None
    ultra_deband: Optional[bool] = None
    ultra_fbo: Optional[bool] = None
    enable_precise_resume: Optional[bool] = None
    yt_mark_watched: Optional[bool] = None
    os_platform: Optional[str] = None
    ffmpeg_path: Optional[str] = None
    ytdlp_path: Optional[str] = None

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'SettingsOverrides':
        fields = {
            'disable_network_overrides', 'enable_cache', 'http_persistence',
            'demuxer_max_bytes', 'demuxer_max_back_bytes', 'cache_secs',
            'demuxer_readahead_secs', 'stream_buffer_size', 'ytdlp_concurrent_fragments',
            'enable_reconnect', 'reconnect_delay', 'mpv_decoder', 'ytdl_quality',
            'performance_profile', 'ultra_scalers', 'ultra_video_sync',
            'ultra_interpolation', 'ultra_deband', 'ultra_fbo',
            'enable_precise_resume', 'yt_mark_watched', 'os_platform',
            'ffmpeg_path', 'ytdlp_path'
        }
        return cls(**{k: data.get(k) for k in fields if k in data})

@dataclass
class BaseRequest:
    action: str
    request_id: Optional[str] = None

@dataclass
class PlaybackRequest(BaseRequest):
    folder_id: Optional[str] = None
    url_item: Optional[Dict[str, Any]] = None
    url_items: Optional[List[Dict[str, Any]]] = None
    playlist: Optional[List[Dict[str, Any]]] = None
    playlist_start_id: Optional[str] = None
    m3u_data: Optional[Dict[str, Any]] = None
    
    # Launch Options
    geometry: Optional[str] = None
    custom_width: Optional[int] = None
    custom_height: Optional[int] = None
    custom_mpv_flags: Optional[List[str]] = None
    automatic_mpv_flags: Optional[List[Dict[str, Any]]] = None
    start_paused: bool = False
    force_terminal: bool = False
    play_new_instance: bool = False
    
    # Settings
    settings: SettingsOverrides = field(default_factory=SettingsOverrides)

@dataclass
class LiveUpdateRequest(BaseRequest):
    folder_id: Optional[str] = None
    item_id: Optional[str] = None
    marked_as_watched: Optional[bool] = None
    watched: Optional[bool] = None
    played_ids: Optional[List[str]] = None
    watched_ids: Optional[List[str]] = None
    session_ids: Optional[List[str]] = None
    new_order: Optional[List[str]] = None

@dataclass
class DataSyncRequest(BaseRequest):
    data: Optional[Dict[str, Any]] = None
    is_incremental: bool = False
    filename: Optional[str] = None
    subfolder: Optional[str] = None
    custom_names: Optional[Dict[str, str]] = None
    preferences: Optional[Dict[str, Any]] = None

@dataclass
class ServiceRequest(BaseRequest):
    force: bool = False
    delete_cache: bool = False
    is_cache_disabled: bool = False
    days: int = 0
    force_refresh: bool = False
