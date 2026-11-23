import glob
import json
import os
import re
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"

ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
EXPECTED_TOOLS = {
    "verify_repo",
    "check_repo_drift",
    "tail_logs",
    "inspect_runtime_state",
    "check_native_host_registration",
    "probe_mpv_ipc",
    "validate_bridge_payload",
    "trace_action",
    "simulate_native_message",
    "test_mpv_pipeline",
}


def _send(proc: subprocess.Popen[str], msg: dict) -> None:
    assert proc.stdin is not None
    proc.stdin.write(json.dumps(msg) + "\n")
    proc.stdin.flush()


def _recv_id(proc: subprocess.Popen[str], req_id: int) -> dict:
    assert proc.stdout is not None
    while True:
        line = proc.stdout.readline()
        if not line:
            stderr_txt = proc.stderr.read() if proc.stderr else ""
            raise RuntimeError(f"EOF waiting for id={req_id}. stderr={stderr_txt}")
        stripped = line.strip()
        if not stripped:
            continue
        # Strictly verify zero non-JSON stdout corruption
        obj = json.loads(stripped)
        if obj.get("id") == req_id:
            return obj


def _call_tool(proc: subprocess.Popen[str], req_id: int, name: str, arguments: dict) -> dict:
    _send(
        proc,
        {
            "jsonrpc": "2.0",
            "id": req_id,
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        },
    )
    resp = _recv_id(proc, req_id)
    if "error" in resp:
        raise AssertionError(f"Tool {name} RPC error: {resp['error']}")
    result = resp["result"]
    if result.get("isError"):
        raise AssertionError(f"Tool {name} returned isError=true: {result}")
    content = result.get("content", [])
    if not content or content[0].get("type") != "text":
        raise AssertionError(f"Tool {name} missing text content: {result}")
    text = content[0]["text"]
    if ANSI_RE.search(text):
        raise AssertionError(f"Tool {name} leaked ANSI escape codes")
    return json.loads(text)


def main() -> None:
    mcp_dir = os.path.dirname(os.path.abspath(__file__))
    env = os.environ.copy()
    env["PYTHONDONTWRITEBYTECODE"] = "1"

    proc = subprocess.Popen(
        ["uv", "run", "--frozen", "--quiet", "--directory", mcp_dir, "python", "server.py"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    )

    try:
        # 1. Initialize
        _send(
            proc,
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "smoke-test", "version": "0.1"},
                },
            },
        )
        init_resp = _recv_id(proc, 1)
        assert "result" in init_resp, f"init failed: {init_resp}"

        _send(proc, {"jsonrpc": "2.0", "method": "notifications/initialized"})

        # 2. tools/list
        _send(proc, {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
        list_resp = _recv_id(proc, 2)
        tools = list_resp["result"]["tools"]
        names = {t["name"] for t in tools}
        assert len(tools) <= 10, f"Tool budget exceeded: {len(tools)} > 10"
        assert names == EXPECTED_TOOLS, f"Tool set mismatch: {names} vs {EXPECTED_TOOLS}"
        schema_bytes = len(json.dumps(tools, separators=(",", ":")))

        # 3. Call all read-only & sandboxed tools
        drift = _call_tool(proc, 3, "check_repo_drift", {})
        assert "ok" in drift and "js_drift" in drift, drift
        assert "yt_tools_standalone_drift" in drift and "present" in drift["yt_tools_standalone_drift"], drift

        logs = _call_tool(proc, 4, "tail_logs", {"log": "native_host", "lines": 10})
        assert logs["ok"] is True and logs["log"] == "native_host", logs

        state = _call_tool(proc, 5, "inspect_runtime_state", {})
        assert state["ok"] is True and "counts" in state, state

        reg = _call_tool(proc, 6, "check_native_host_registration", {})
        assert "ok" in reg and "browsers" in reg, reg

        ipc = _call_tool(proc, 7, "probe_mpv_ipc", {"action": "list"})
        assert ipc["ok"] is True and ipc["action"] == "list", ipc

        val_payload = _call_tool(
            proc,
            8,
            "validate_bridge_payload",
            {"payload": {"action": "play", "request_id": "req-1", "folderId": "Anime"}},
        )
        assert val_payload["ok"] is True and val_payload["request_id_preserved"] is True, val_payload

        val_schema = _call_tool(proc, 9, "validate_bridge_payload", {"action_schema": "play"})
        assert val_schema["ok"] is True and val_schema["model"] == "PlaybackRequest", val_schema

        trace_diag = _call_tool(proc, 10, "trace_action", {"action_name": "get_unified_diagnostics"})
        assert trace_diag["ok"] is True and trace_diag["model"] == "DataSyncRequest", trace_diag
        for layer_name in ("popup", "background", "models", "handlers"):
            assert trace_diag["layers"][layer_name], f"Expected trace matches in {layer_name}: {trace_diag}"

        trace_play = _call_tool(proc, 100, "trace_action", {"action_name": "play"})
        assert trace_play["ok"] is True and trace_play["model"] == "PlaybackRequest", trace_play
        for layer_name in ("background", "models", "handlers"):
            assert trace_play["layers"][layer_name], f"Expected trace matches in {layer_name}: {trace_play}"

        trace_lua = _call_tool(proc, 11, "trace_action", {"action_name": "set_url_options"})
        assert trace_lua["ok"] is True and trace_lua["layers"]["mpv_scripts"], trace_lua

        tmp_root = tempfile.gettempdir()
        sim_before = set(glob.glob(os.path.join(tmp_root, "mpv_nh_sim_*")))
        sim = _call_tool(
            proc,
            12,
            "simulate_native_message",
            {
                "payload": {"action": "ping", "request_id": "smoke-ping-1"},
                "seed_state": {"config": {"ytdl_quality": "1080"}},
                "timeout": 5,
            },
        )
        sim_after = set(glob.glob(os.path.join(tmp_root, "mpv_nh_sim_*")))
        assert sim["ok"] is True and sim["exit_code"] == 0 and sim["timed_out"] is False, sim
        assert any(
            f.get("request_id") == "smoke-ping-1" and f.get("status") == "online"
            for f in sim.get("frames", [])
        ), sim
        assert sim_after <= sim_before, f"Leaked sim temp dirs: {sim_after - sim_before}"

        # Assert dry_run does not create/modify real DATA_DIR/last_mpv_command.txt
        real_base = os.getenv("XDG_DATA_HOME") or os.path.expanduser("~/.local/share")
        real_last_cmd = os.path.join(real_base, "MPVPlaylistOrganizer", "last_mpv_command.txt")
        had_last_cmd = os.path.exists(real_last_cmd)
        last_cmd_stat = os.stat(real_last_cmd).st_mtime_ns if had_last_cmd else None
        last_cmd_bytes = open(real_last_cmd, "rb").read() if had_last_cmd else None
        dry_before = set(glob.glob(os.path.join(tmp_root, "mpv_dryrun_*")))

        dry = _call_tool(
            proc,
            13,
            "test_mpv_pipeline",
            {
                "mode": "dry_run",
                "urls": [
                    "https://example.com/a.mp4",
                    {"id": "vid2", "title": "Video 2", "url": "https://example.com/b.mp4"},
                ],
                "options": {"start_paused": True, "geometry": "1280x720"},
            },
        )
        dry_after = set(glob.glob(os.path.join(tmp_root, "mpv_dryrun_*")))
        assert dry["ok"] is True and "--pause" in dry["argv"] and "--geometry=1280x720" in dry["argv"], dry
        assert "#EXTM3U" in dry["m3u_content"] and "mpv_organizer_id=vid2" in dry["m3u_content"], dry
        assert dry_after <= dry_before, f"Leaked dry_run temp dirs: {dry_after - dry_before}"
        if had_last_cmd:
            assert os.stat(real_last_cmd).st_mtime_ns == last_cmd_stat, "Real last_mpv_command.txt mtime changed!"
            assert open(real_last_cmd, "rb").read() == last_cmd_bytes, "Real last_mpv_command.txt content changed!"
        else:
            assert not os.path.exists(real_last_cmd), "Real last_mpv_command.txt was created by dry_run!"

        hl_before = set(glob.glob(os.path.join(tmp_root, "mpv_headless_*")))
        headless = _call_tool(proc, 14, "test_mpv_pipeline", {"mode": "headless"})
        hl_after = set(glob.glob(os.path.join(tmp_root, "mpv_headless_*")))
        assert headless["ok"] is True and headless["ipc_connected"] is True, headless
        assert headless["pid_verified"] is True and headless["lua_errors"] == [], headless
        assert len(headless["scripts_loaded"]) == 3, headless
        hl_pid = headless["properties"].get("pid")
        assert isinstance(hl_pid, int) and hl_pid > 0, headless
        hl_dead = False
        try:
            os.kill(hl_pid, 0)
        except ProcessLookupError:
            hl_dead = True
        assert hl_dead, f"Headless mpv PID {hl_pid} still alive!"
        assert hl_after <= hl_before, f"Leaked headless temp dirs: {hl_after - hl_before}"

        lint = _call_tool(proc, 15, "verify_repo", {"mode": "lint"})
        assert lint["ok"] is True, lint

        if proc.stdin:
            proc.stdin.close()
        rc = proc.wait(timeout=5)
        stderr_out = proc.stderr.read() if proc.stderr else ""
        assert rc == 0, f"Server exited with {rc}: {stderr_out}"
        assert "Traceback" not in stderr_out, f"Traceback in stderr: {stderr_out}"

        print(
            json.dumps(
                {
                    "smoke_ok": True,
                    "tools_count": len(tools),
                    "tools_schema_bytes": schema_bytes,
                    "drift_ok": drift["ok"],
                    "lint_ok": lint["ok"],
                }
            )
        )
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=5)


if __name__ == "__main__":
    main()
