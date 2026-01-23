import functools
import logging
from typing import Dict, Callable, Any, Type, Optional
from ..native_link.models import BaseRequest

class HandlerRegistry:
    """
    Registry for backend command handlers.
    Used to decouple implementation from registration in native_host.py.
    """
    _handlers: Dict[str, Callable] = {}

    @classmethod
    def command(cls, name: str):
        """Decorator to register a method as a command handler."""
        def decorator(func: Callable):
            cls._handlers[name] = func
            @functools.wraps(func)
            def wrapper(*args, **kwargs):
                return func(*args, **kwargs)
            return wrapper
        return decorator

    @classmethod
    def get_handler(cls, name: str) -> Optional[Callable]:
        return cls._handlers.get(name)

    @classmethod
    def get_all_handlers(cls) -> Dict[str, Callable]:
        return cls._handlers.copy()

    @classmethod
    def bind_instance(cls, instance: Any):
        """
        Binds all registered commands found on the instance to the instance itself.
        This allows instance methods to be correctly dispatched.
        """
        for name, func in list(cls._handlers.items()):
            if hasattr(instance, func.__name__):
                # Bind the method to the instance
                bound_method = getattr(instance, func.__name__)
                cls._handlers[name] = bound_method

def command(name: str):
    """Alias for HandlerRegistry.command for easier usage."""
    return HandlerRegistry.command(name)
