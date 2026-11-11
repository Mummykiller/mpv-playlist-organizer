import re
from typing import Any, Dict, Optional

def _snake_to_camel(snake_str: str) -> str:
    """Converts snake_case to camelCase."""
    if snake_str in ("request_id", "url", "m3u8") or "://" in snake_str:
        return snake_str # Preserve for nativeConnection.js and URL cache keys
    if '_' not in snake_str:
        return snake_str
    components = snake_str.split('_')
    return components[0] + ''.join(x.title() for x in components[1:])

def _translate_keys(data: Any, parent_key: Optional[str] = None) -> Any:
    """Recursively translates snake_case keys to camelCase for JS."""
    if isinstance(data, dict):
        new_dict = {}
        preserve_immediate_keys = parent_key in ("folders", "headers", "http_headers", "httpHeaders")
        for k, v in data.items():
            if preserve_immediate_keys or not isinstance(k, str) or "://" in k:
                new_key = k
            else:
                new_key = _snake_to_camel(k)

            if parent_key == "folders" and new_key != "folders":
                child_parent_key = None
            elif isinstance(k, str) and "://" in k:
                child_parent_key = None
            else:
                child_parent_key = new_key if isinstance(new_key, str) else None

            new_dict[new_key] = _translate_keys(v, parent_key=child_parent_key)
        return new_dict
    elif isinstance(data, list):
        return [_translate_keys(i, parent_key=None) for i in data]
    return data

def success(result: Any = None, **kwargs) -> Dict[str, Any]:
    """Standard success response."""
    response = {"success": True}
    if result is not None:
        if isinstance(result, dict):
            response.update(result)
        else:
            response["result"] = result
    response.update(kwargs)
    return _translate_keys(response)

def failure(error: str, **kwargs) -> Dict[str, Any]:
    """Standard failure response."""
    response = {"success": False, "error": error}
    response.update(kwargs)
    return _translate_keys(response)
