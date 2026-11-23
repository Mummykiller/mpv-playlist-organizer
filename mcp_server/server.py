import logging
import os
import sys
from typing import Any

sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"

logging.basicConfig(stream=sys.stderr, level=logging.WARNING, force=True)

try:
    from mcp.server.mcpserver import MCPServer
except ImportError:  # pragma: no cover
    from mcp.server.fastmcp import FastMCP as MCPServer  # type: ignore[no-redef]

import tools_impl

mcp = MCPServer("mpv-playlist-organizer")


@mcp.tool(structured_output=False)
def verify_repo(mode: str = "full", target: str | None = None, sync_contract: bool = False) -> str:
    """Run build, lint, test, targeted test, or full repo verification."""
    return tools_impl.compact_json(tools_impl.verify_repo(mode=mode, target=target, sync_contract=sync_contract))


@mcp.tool(structured_output=False)
def check_repo_drift() -> str:
    """Check transpiled JS, bridge contract, yt-tools-standalone, generated-file edits, and __pycache__."""
    return tools_impl.compact_json(tools_impl.check_repo_drift())


@mcp.tool(structured_output=False)
def tail_logs(log: str = "native_host", lines: int = 50, grep: str | None = None, level: str | None = None) -> str:
    """Tail and filter MPVPlaylistOrganizer runtime logs with path/token masking."""
    return tools_impl.compact_json(tools_impl.tail_logs(log=log, lines=lines, grep=grep, level=level))


@mcp.tool(structured_output=False)
def inspect_runtime_state(
    sections: list[str] | None = None,
    include_urls_for_folder: str | None = None,
) -> str:
    """Read-only snapshot of DATA_DIR session, config, folder counts, flags, and playlists."""
    return tools_impl.compact_json(
        tools_impl.inspect_runtime_state(sections=sections, include_urls_for_folder=include_urls_for_folder)
    )


@mcp.tool(structured_output=False)
def check_native_host_registration() -> str:
    """Read-only check of native host wrapper, manifest JSON, and Linux browser symlinks."""
    return tools_impl.compact_json(tools_impl.check_native_host_registration())


@mcp.tool(structured_output=False)
def probe_mpv_ipc(
    action: str = "list",
    socket_path: str | None = None,
    property_name: str | None = None,
) -> str:
    """Read-only mpv Unix IPC socket discovery and property inspection."""
    return tools_impl.compact_json(
        tools_impl.probe_mpv_ipc(action=action, socket_path=socket_path, property_name=property_name)
    )


@mcp.tool(structured_output=False)
def validate_bridge_payload(
    payload: dict[str, Any] | str | None = None,
    direction: str = "js_to_py",
    action_schema: str | None = None,
) -> str:
    """Validate/translate JS<->Python bridge payloads or inspect an action schema."""
    return tools_impl.compact_json(
        tools_impl.validate_bridge_payload(payload=payload, direction=direction, action_schema=action_schema)
    )


@mcp.tool(structured_output=False)
def trace_action(action_name: str) -> str:
    """Static cross-layer tracer returning file:line matches for an action across JS, Python, and Lua."""
    return tools_impl.compact_json(tools_impl.trace_action(action_name=action_name))


@mcp.tool(structured_output=False)
def simulate_native_message(
    payload: dict[str, Any] | list[dict[str, Any]] | str,
    seed_state: dict[str, Any] | None = None,
    timeout: float = 5.0,
) -> str:
    """Sandboxed native_host.py test against temp DATA_DIR using 4-byte length-prefixed JSON framing."""
    return tools_impl.compact_json(
        tools_impl.simulate_native_message(payload=payload, seed_state=seed_state, timeout=timeout)
    )


@mcp.tool(structured_output=False)
def test_mpv_pipeline(
    mode: str = "dry_run",
    urls: list[Any] | None = None,
    options: dict[str, Any] | None = None,
) -> str:
    """Dry-run mpv argv/M3U builder or run short-lived headless mpv with Lua scripts and temp IPC."""
    return tools_impl.compact_json(
        tools_impl.test_mpv_pipeline(mode=mode, urls=urls, options=options)
    )


if __name__ == "__main__":
    mcp.run(transport="stdio")
