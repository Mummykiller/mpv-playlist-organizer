from typing import Any, Dict, Optional

import re
from typing import Any, Dict, Optional

def _snake_to_camel(snake_str: str) -> str:
    """Converts snake_case to camelCase."""
    if snake_str == "request_id":
        return "request_id" # Preserve for nativeConnection.js
    components = snake_str.split('_')
    return components[0] + ''.join(x.title() for x in components[1:])

def _translate_keys(data: Any) -> Any:
    """Recursively translates snake_case keys to camelCase for JS."""
    if isinstance(data, dict):
        new_dict = {}
        for k, v in data.items():
            new_key = _snake_to_camel(k) if isinstance(k, str) else k
            new_dict[new_key] = _translate_keys(v)
        return new_dict
    elif isinstance(data, list):
        return [_translate_keys(i) for i in data]
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
