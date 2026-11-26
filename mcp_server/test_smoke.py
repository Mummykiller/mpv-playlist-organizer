import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"

ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
EXPECTED_TOOLS = {
    "verify_repo",
    "check_repo_drift",
    "inspect_runtime",
    "simulate_native_message",
    "test_mpv_pipeline",
    "log_bug_pattern",
    "query_bug_patterns",
    "get_bug_pattern",
    "graduate_bug_pattern",
    "remove_bug_pattern",
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
    bug_tmp_dir = tempfile.mkdtemp(prefix="mpv_mcp_bugdb_")
    bug_db_path = os.path.join(bug_tmp_dir, "smoke_bugs.db")
    real_bug_db = os.path.join(mcp_dir, "bug_patterns.db")
    had_real_bug_db = os.path.exists(real_bug_db)
    real_bug_db_mtime = os.stat(real_bug_db).st_mtime_ns if had_real_bug_db else None

    env = os.environ.copy()
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["MPV_MCP_BUG_DB_PATH"] = bug_db_path

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

        # 2. tools/list — enforce expected tool schema
        _send(proc, {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
        list_resp = _recv_id(proc, 2)
        tools = list_resp["result"]["tools"]
        names = {t["name"] for t in tools}
        assert len(tools) == len(EXPECTED_TOOLS), f"Tool budget mismatch: {len(tools)} != {len(EXPECTED_TOOLS)} ({names})"
        assert names == EXPECTED_TOOLS, f"Tool set mismatch: {names} vs {EXPECTED_TOOLS}"
        # Regression check: every tool must expose non-empty properties, typed array items, and no bare additionalProperties
        def _assert_clean_schema(tool_name: str, node: object, path: str = "") -> None:
            if not isinstance(node, dict):
                return
            if path == "":
                assert node.get("type") == "object", f"{tool_name}: root type must be object: {node}"
                props = node.get("properties")
                assert isinstance(props, dict) and len(props) > 0, f"{tool_name}: empty properties breaks MCP clients"
            if node.get("type") == "array":
                items = node.get("items")
                assert isinstance(items, dict) and "type" in items, f"{tool_name}{path}: array items missing type: {node}"
            if node.get("additionalProperties") is True:
                raise AssertionError(f"{tool_name}{path}: bare additionalProperties:true is incompatible with strict MCP clients")
            for k, v in node.items():
                if isinstance(v, dict):
                    _assert_clean_schema(tool_name, v, f"{path}.{k}")
                elif isinstance(v, list):
                    for idx, elem in enumerate(v):
                        _assert_clean_schema(tool_name, elem, f"{path}.{k}[{idx}]")

        for tool_def in tools:
            _assert_clean_schema(tool_def["name"], tool_def.get("inputSchema"))
        schema_bytes = len(json.dumps(tools, separators=(",", ":")))

        # 3. Call all read-only & sandboxed tools
        drift = _call_tool(proc, 3, "check_repo_drift", {})
        assert "ok" in drift and "js_drift" in drift, drift
        assert "yt_tools_standalone_drift" in drift and "present" in drift["yt_tools_standalone_drift"], drift

        logs = _call_tool(proc, 4, "inspect_runtime", {"target": "logs", "log": "native_host", "lines": 10})
        assert logs["ok"] is True and logs["target"] == "logs" and logs["log"] == "native_host", logs

        state = _call_tool(proc, 5, "inspect_runtime", {"target": "state"})
        assert state["ok"] is True and state["target"] == "state" and "counts" in state, state

        reg = _call_tool(proc, 6, "inspect_runtime", {"target": "registration"})
        assert "ok" in reg and reg["target"] == "registration" and "browsers" in reg, reg

        ipc = _call_tool(proc, 7, "inspect_runtime", {"target": "ipc", "ipc_action": "list"})
        assert ipc["ok"] is True and ipc["target"] == "ipc" and ipc["action"] == "list", ipc

        bad_target = _call_tool(proc, 8, "inspect_runtime", {"target": "invalid"})
        assert bad_target["ok"] is False and "Invalid target" in bad_target["error"], bad_target

        tmp_root = tempfile.gettempdir()
        sim_before = set(glob.glob(os.path.join(tmp_root, "mpv_nh_sim_*")))
        sim = _call_tool(
            proc,
            9,
            "simulate_native_message",
            {
                "payload": json.dumps({"action": "ping", "request_id": "smoke-ping-1"}),
                "seed_state": json.dumps({"config": {"ytdl_quality": "1080"}}),
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
        last_cmd_bytes = None
        if had_last_cmd:
            with open(real_last_cmd, "rb") as fh:
                last_cmd_bytes = fh.read()
        dry_before = set(glob.glob(os.path.join(tmp_root, "mpv_dryrun_*")))

        dry = _call_tool(
            proc,
            10,
            "test_mpv_pipeline",
            {
                "mode": "dry_run",
                "urls": [
                    "https://example.com/a.mp4",
                    json.dumps({"id": "vid2", "title": "Video 2", "url": "https://example.com/b.mp4"}),
                ],
                "options": json.dumps({"start_paused": True, "geometry": "1280x720"}),
            },
        )
        dry_after = set(glob.glob(os.path.join(tmp_root, "mpv_dryrun_*")))
        assert dry["ok"] is True and "--pause" in dry["argv"] and "--geometry=1280x720" in dry["argv"], dry
        assert "#EXTM3U" in dry["m3u_content"] and "mpv_organizer_id=vid2" in dry["m3u_content"], dry
        assert dry_after <= dry_before, f"Leaked dry_run temp dirs: {dry_after - dry_before}"
        if had_last_cmd:
            assert os.stat(real_last_cmd).st_mtime_ns == last_cmd_stat, "Real last_mpv_command.txt mtime changed!"
            with open(real_last_cmd, "rb") as fh:
                assert fh.read() == last_cmd_bytes, "Real last_mpv_command.txt content changed!"
        else:
            assert not os.path.exists(real_last_cmd), "Real last_mpv_command.txt was created by dry_run!"

        hl_before = set(glob.glob(os.path.join(tmp_root, "mpv_headless_*")))
        headless = _call_tool(proc, 11, "test_mpv_pipeline", {"mode": "headless"})
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

        lint = _call_tool(proc, 12, "verify_repo", {"mode": "lint"})
        assert lint["ok"] is True, lint

        # 4. Bug-pattern SQLite MCP tools (isolated temp DB)
        b1 = _call_tool(
            proc,
            13,
            "log_bug_pattern",
            {
                "slug": "smoke-test-pattern",
                "title": "Smoke test repeatable pattern",
                "location": "foo.py:bar",
                "details": "Detailed root cause note",
            },
        )
        assert b1["ok"] is True and b1["hits"] == 1 and b1["status"] == "watching", b1

        b2 = _call_tool(
            proc,
            14,
            "log_bug_pattern",
            {
                "slug": "smoke-test-pattern",
                "title": "Smoke test repeatable pattern",
                "location": "foo.py:bar",
                "note": "Regressed again",
            },
        )
        assert b2["ok"] is True and b2["hits"] == 2 and b2["status"] == "promote_candidate", b2

        bq = _call_tool(proc, 15, "query_bug_patterns", {"search": "smoke-test"})
        assert bq["ok"] is True and bq["count"] == 1 and "details" not in bq["items"][0], bq

        bg = _call_tool(proc, 16, "get_bug_pattern", {"slug": "smoke-test-pattern"})
        assert bg["ok"] is True and bg["pattern"]["details"] == "Detailed root cause note", bg
        assert bg["pattern"]["occurrences"][0]["occurrence_count"] == 2, bg

        bgrad = _call_tool(
            proc,
            17,
            "graduate_bug_pattern",
            {"slug": "smoke-test-pattern", "test_ref": "testing_tools/scripts/test_mcp_server.py::test_bug_store"},
        )
        assert bgrad["ok"] is True and bgrad["status"] == "graduated", bgrad

        bq_active = _call_tool(proc, 18, "query_bug_patterns", {"search": "smoke-test"})
        assert bq_active["ok"] is True and bq_active["count"] == 0, bq_active

        bq_all = _call_tool(proc, 19, "query_bug_patterns", {"search": "smoke-test", "include_graduated": True})
        assert bq_all["ok"] is True and bq_all["count"] == 1 and bq_all["items"][0]["status"] == "graduated", bq_all

        brem = _call_tool(proc, 20, "remove_bug_pattern", {"slug": "smoke-test-pattern", "reason": "smoke cleanup"})
        assert brem["ok"] is True and brem["removed"] == "pattern", brem

        if had_real_bug_db:
            assert os.stat(real_bug_db).st_mtime_ns == real_bug_db_mtime, "Real bug_patterns.db was modified by smoke test!"
        else:
            assert not os.path.exists(real_bug_db), "Real bug_patterns.db was created by smoke test!"

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
        shutil.rmtree(bug_tmp_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
