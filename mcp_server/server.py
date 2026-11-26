import logging
import os
import sys
from typing import Any

sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"

logging.basicConfig(stream=sys.stderr, level=logging.WARNING, force=True)

try:
    from mcp.server.mcpserver import MCPServer  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    from mcp.server.fastmcp import FastMCP as MCPServer  # type: ignore[import-not-found,no-redef]

import bug_store
import tools_impl

mcp = MCPServer("mpv-playlist-organizer")


@mcp.tool(structured_output=False)
def verify_repo(mode: str = "full", target: str | None = None, sync_contract: bool = False) -> str:
    """Run build, lint, test, targeted test, fix (build+contract+ruff fix+verify), or full verification."""
    return tools_impl.compact_json(tools_impl.verify_repo(mode=mode, target=target, sync_contract=sync_contract))


@mcp.tool(structured_output=False)
def check_repo_drift() -> str:
    """Check transpiled JS, bridge contract, yt-tools-standalone, generated-file edits, and __pycache__."""
    return tools_impl.compact_json(tools_impl.check_repo_drift())


@mcp.tool(structured_output=False)
def inspect_runtime(
    target: str = "state",
    log: str = "native_host",
    lines: int = 50,
    grep: str | None = None,
    level: str | None = None,
    sections: list[str] | None = None,
    include_urls_for_folder: str | None = None,
    ipc_action: str = "list",
    socket_path: str | None = None,
    property_name: str | None = None,
) -> str:
    """Read-only runtime diagnostics: target='logs'|'state'|'registration'|'ipc'."""
    return tools_impl.compact_json(
        tools_impl.inspect_runtime(
            target=target,
            log=log,
            lines=lines,
            grep=grep,
            level=level,
            sections=sections,
            include_urls_for_folder=include_urls_for_folder,
            ipc_action=ipc_action,
            socket_path=socket_path,
            property_name=property_name,
        )
    )


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


@mcp.tool(structured_output=False)
def log_bug_pattern(
    slug: str,
    title: str,
    location: str,
    category: str = "general",
    severity: str = "medium",
    note: str = "",
    details: str = "",
    suggested_check: str = "",
) -> str:
    """Log or bump a repeatable bug pattern and its file:symbol occurrence in the local SQLite store."""
    return tools_impl.compact_json(
        bug_store.log_bug_pattern(
            slug=slug,
            title=title,
            location=location,
            category=category,
            severity=severity,
            note=note,
            details=details,
            suggested_check=suggested_check,
        )
    )


@mcp.tool(structured_output=False)
def query_bug_patterns(
    search: str | None = None,
    category: str | None = None,
    severity: str | None = None,
    status: str | None = None,
    min_hits: int | None = None,
    include_graduated: bool = False,
    limit: int = 30,
) -> str:
    """Query the compact bug-pattern index (omits full details; excludes graduated unless requested)."""
    return tools_impl.compact_json(
        bug_store.query_bug_patterns(
            search=search,
            category=category,
            severity=severity,
            status=status,
            min_hits=min_hits,
            include_graduated=include_graduated,
            limit=limit,
        )
    )


@mcp.tool(structured_output=False)
def get_bug_pattern(slug: str) -> str:
    """Fetch full details, suggested_check, test_ref, and all occurrences for one bug pattern."""
    return tools_impl.compact_json(bug_store.get_bug_pattern(slug=slug))


@mcp.tool(structured_output=False)
def graduate_bug_pattern(slug: str, test_ref: str, note: str = "") -> str:
    """Mark a bug pattern as graduated with its regression test or static check reference."""
    return tools_impl.compact_json(
        bug_store.graduate_bug_pattern(slug=slug, test_ref=test_ref, note=note)
    )


@mcp.tool(structured_output=False)
def remove_bug_pattern(slug: str, location: str | None = None, reason: str = "") -> str:
    """Remove a mistaken/false-positive bug pattern or a single occurrence from the SQLite store."""
    return tools_impl.compact_json(
        bug_store.remove_bug_pattern(slug=slug, location=location, reason=reason)
    )


if __name__ == "__main__":
    mcp.run(transport="stdio")
