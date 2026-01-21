from typing import Any, Dict, Optional

def success(result: Any = None, **kwargs) -> Dict[str, Any]:
    """Standard success response."""
    response = {"success": True}
    if result is not None:
        if isinstance(result, dict):
            response.update(result)
        else:
            response["result"] = result
    response.update(kwargs)
    return response

def failure(error: str, **kwargs) -> Dict[str, Any]:
    """Standard failure response."""
    response = {"success": False, "error": error}
    response.update(kwargs)
    return response
