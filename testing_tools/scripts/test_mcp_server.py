import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MCP_DIR = os.path.join(PROJECT_ROOT, "mcp_server")
if MCP_DIR not in sys.path:
    sys.path.insert(0, MCP_DIR)

import bug_store  # noqa: E402
import tools_impl  # noqa: E402


class TestMcpServer(unittest.TestCase):
    def test_mcp_smoke_suite(self):
        """Runs mcp_server/test_smoke.py against the stdio MCP server."""
        if not shutil.which("uv"):
            self.skipTest("uv not installed")
        env = os.environ.copy()
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        proc = subprocess.run(
            [sys.executable, "-B", os.path.join(MCP_DIR, "test_smoke.py")],
            cwd=PROJECT_ROOT,
            env=env,
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(
            proc.returncode,
            0,
            f"mcp_server/test_smoke.py failed:\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}",
        )
        payload = json.loads(proc.stdout.strip().splitlines()[-1])
        self.assertTrue(payload.get("smoke_ok"))
        self.assertEqual(payload.get("tools_count"), 10)

    def test_verify_repo_fix_mode_stages(self):
        """verify_repo(mode='fix') runs build, bridge contract, ruff --fix, and full verify."""
        calls = []

        def fake_run_cmd(cmd, timeout=120):
            calls.append(cmd)
            return 0, "(10/10 tests, 5 JS syntax OK, 5 Python static OK)", ""

        with (
            patch.object(tools_impl, "_run_cmd", side_effect=fake_run_cmd),
            patch.object(tools_impl.shutil, "which", return_value="/usr/bin/ruff"),
        ):
            res = tools_impl.verify_repo(mode="fix")

        self.assertTrue(res["ok"], res)
        self.assertEqual(res["mode"], "fix")
        stage_names = [s["name"] for s in res["stages"]]
        self.assertEqual(stage_names, ["generate_js", "generate_bridge_contract", "ruff_fix", "verify_full"])
        self.assertEqual(len(calls), 4)
        self.assertIn("--fix", calls[2])

    def test_inspect_runtime_invalid_target(self):
        res = tools_impl.inspect_runtime(target="unknown")
        self.assertFalse(res["ok"])
        self.assertIn("Invalid target", res["error"])

    def test_bug_store_lifecycle_and_validation(self):
        """Verifies bug_store CRUD, same-location repeat hits, graduation, reopening, and validation."""
        with tempfile.TemporaryDirectory(prefix="mpv_bugstore_test_") as tmp_dir:
            db_path = os.path.join(tmp_dir, "bugs.db")

            # Default category='general' passes validation
            r1 = bug_store.log_bug_pattern(
                slug="stale-gen",
                title="Stale session_generation teardown",
                location="utils/session_services.py:LauncherService.close",
                details="Capture session_generation under sync_lock before releasing.",
                db_path=db_path,
            )
            self.assertTrue(r1["ok"], r1)
            self.assertEqual(r1["hits"], 1)
            self.assertEqual(r1["locations"], 1)
            self.assertEqual(r1["status"], "watching")
            self.assertFalse(r1["promote_hint"])

            # Same-location repeat regression increments occurrence_count and hits -> promote_candidate
            r2 = bug_store.log_bug_pattern(
                slug="stale-gen",
                title="Stale session_generation teardown",
                location="utils/session_services.py:LauncherService.close",
                category="concurrency",
                severity="high",
                note="Regressed on reconnect",
                db_path=db_path,
            )
            self.assertTrue(r2["ok"], r2)
            self.assertEqual(r2["hits"], 2)
            self.assertEqual(r2["locations"], 1)
            self.assertEqual(r2["location_hits"], 2)
            self.assertEqual(r2["status"], "promote_candidate")
            self.assertTrue(r2["promote_hint"])

            # Distinct second location increments both locations and hits
            r3 = bug_store.log_bug_pattern(
                slug="stale-gen",
                title="Stale session_generation teardown",
                location="utils/handlers/playback_handler.py:PlaybackHandler._check_session_liveness",
                category="concurrency",
                severity="high",
                db_path=db_path,
            )
            self.assertTrue(r3["ok"], r3)
            self.assertEqual(r3["hits"], 3)
            self.assertEqual(r3["locations"], 2)

            # Query returns compact index without details
            q = bug_store.query_bug_patterns(search="playback_handler", db_path=db_path)
            self.assertTrue(q["ok"], q)
            self.assertEqual(q["count"], 1)
            self.assertEqual(q["items"][0]["slug"], "stale-gen")
            self.assertNotIn("details", q["items"][0])

            # Get returns full details + occurrences
            g = bug_store.get_bug_pattern("stale-gen", db_path=db_path)
            self.assertTrue(g["ok"], g)
            self.assertIn("sync_lock", g["pattern"]["details"])
            self.assertEqual(len(g["pattern"]["occurrences"]), 2)

            # Graduate keeps record with test_ref and hides from default query
            grad = bug_store.graduate_bug_pattern(
                slug="stale-gen",
                test_ref="testing_tools/scripts/test_playback_ipc_concurrency.py::test_check_session_liveness_guards_generation",
                note="Covered by concurrency regression suite",
                db_path=db_path,
            )
            self.assertTrue(grad["ok"], grad)
            self.assertEqual(grad["status"], "graduated")
            self.assertEqual(bug_store.query_bug_patterns(db_path=db_path)["count"], 0)
            q_grad = bug_store.query_bug_patterns(status="graduated", db_path=db_path)
            self.assertEqual(q_grad["count"], 1)
            self.assertIn("test_playback_ipc_concurrency.py", q_grad["items"][0]["test_ref"])

            # Logging a new regression on a graduated pattern reopens it
            reopen = bug_store.log_bug_pattern(
                slug="stale-gen",
                title="Stale session_generation teardown",
                location="utils/session_services.py:EnrichmentService",
                db_path=db_path,
            )
            self.assertTrue(reopen["ok"], reopen)
            self.assertTrue(reopen.get("reopened"))
            self.assertEqual(reopen["status"], "promote_candidate")
            self.assertEqual(reopen["hits"], 4)

            # Remove single occurrence vs. full pattern
            rem_occ = bug_store.remove_bug_pattern(
                slug="stale-gen",
                location="utils/session_services.py:EnrichmentService",
                db_path=db_path,
            )
            self.assertTrue(rem_occ["ok"], rem_occ)
            self.assertEqual(rem_occ["removed"], "occurrence")
            self.assertEqual(rem_occ["remaining_hits"], 3)

            rem_all = bug_store.remove_bug_pattern(slug="stale-gen", reason="cleanup", db_path=db_path)
            self.assertTrue(rem_all["ok"], rem_all)
            self.assertEqual(rem_all["removed"], "pattern")
            self.assertFalse(bug_store.get_bug_pattern("stale-gen", db_path=db_path)["ok"])

            # Validation rejects bad slug, category, severity, and empty test_ref
            self.assertFalse(bug_store.log_bug_pattern("BAD SLUG!", "T", "a.py:b", db_path=db_path)["ok"])
            self.assertFalse(bug_store.log_bug_pattern("ok-slug", "T", "a.py:b", category="nope", db_path=db_path)["ok"])
            self.assertFalse(bug_store.log_bug_pattern("ok-slug", "T", "a.py:b", severity="critical", db_path=db_path)["ok"])
            self.assertFalse(bug_store.graduate_bug_pattern("ok-slug", "   ", db_path=db_path)["ok"])

    def test_bug_store_severity_preservation_remove_validation_and_connect_cleanup(self):
        """Verifies severity=None preserves existing severity, empty location is rejected, and _connect closes on error."""
        with tempfile.TemporaryDirectory(prefix="mpv_bugstore_sev_") as tmp_dir:
            db_path = os.path.join(tmp_dir, "bugs.db")

            # Insert with default severity=None -> 'medium'
            r_def = bug_store.log_bug_pattern("def-sev", "Default sev", "a.py:fn", db_path=db_path)
            self.assertTrue(r_def["ok"], r_def)
            self.assertEqual(bug_store.get_bug_pattern("def-sev", db_path=db_path)["pattern"]["severity"], "medium")

            # Insert with severity='high', then update with severity=None -> preserves 'high'
            r_hi = bug_store.log_bug_pattern("hi-sev", "High sev", "a.py:f1", severity="high", db_path=db_path)
            self.assertTrue(r_hi["ok"], r_hi)
            r_hi2 = bug_store.log_bug_pattern("hi-sev", "High sev", "a.py:f2", db_path=db_path)
            self.assertTrue(r_hi2["ok"], r_hi2)
            self.assertEqual(bug_store.get_bug_pattern("hi-sev", db_path=db_path)["pattern"]["severity"], "high")

            # Empty/whitespace location must return error and NOT delete the pattern
            for bad_loc in ("", "   "):
                rem = bug_store.remove_bug_pattern("hi-sev", location=bad_loc, db_path=db_path)
                self.assertFalse(rem["ok"], rem)
                self.assertIn("Invalid location", rem["error"])
            self.assertTrue(bug_store.get_bug_pattern("hi-sev", db_path=db_path)["ok"])

            # _connect closes connection if PRAGMA/schema setup fails
            closed = {"flag": False}

            class FakeConn:
                row_factory = None

                def execute(self, _sql):
                    raise RuntimeError("pragma boom")

                def close(self):
                    closed["flag"] = True

            with patch.object(bug_store.sqlite3, "connect", return_value=FakeConn()):
                with self.assertRaises(RuntimeError):
                    bug_store._connect(db_path=db_path)
            self.assertTrue(closed["flag"])

    def test_check_repo_drift_gating_and_authorized_rebuild(self):
        """Verifies source_newer is informational and rebuilt generated files with modified source are allowed."""
        fake_computed = {
            "js_drift": [],
            "contract_drift": {
                "drifted": False,
                "target": tools_impl.BRIDGE_CONTRACT_REL,
                "target_missing": False,
                "content_diff": False,
                "source_newer": True,
            },
            "js_targets": {
                "utils/domUtils.js": {
                    "source": "utils/domUtils.module.js",
                    "target_missing": False,
                    "source_missing": False,
                    "content_diff": False,
                    "source_newer": True,
                }
            },
        }
        fake_standalone = {"present": False, "drifted": False, "checked_files": 0, "diffs": []}

        # Case 1: Both source and rebuilt target modified in git, content_diff=False -> ok=True
        git_both = " M utils/domUtils.module.js\n M utils/domUtils.js\n"
        with (
            patch.object(tools_impl, "_compute_generated_drift", return_value=fake_computed),
            patch.object(tools_impl, "_run_cmd", return_value=(0, git_both, "")),
            patch.object(tools_impl, "_check_yt_tools_standalone_drift", return_value=fake_standalone),
            patch.object(tools_impl.os, "walk", return_value=[]),
        ):
            res_ok = tools_impl.check_repo_drift()
        self.assertTrue(res_ok["ok"], res_ok)
        self.assertEqual(res_ok["generated_file_edits"], [])

        # Case 2: Only generated target modified in git (source unmodified) -> flagged
        git_target_only = " M utils/domUtils.js\n"
        with (
            patch.object(tools_impl, "_compute_generated_drift", return_value=fake_computed),
            patch.object(tools_impl, "_run_cmd", return_value=(0, git_target_only, "")),
            patch.object(tools_impl, "_check_yt_tools_standalone_drift", return_value=fake_standalone),
            patch.object(tools_impl.os, "walk", return_value=[]),
        ):
            res_bad = tools_impl.check_repo_drift()
        self.assertFalse(res_bad["ok"], res_bad)
        self.assertEqual(res_bad["generated_file_edits"], ["M utils/domUtils.js"])

        # Case 3: _compute_generated_drift uses python3 -B subprocess
        seen_cmds = []

        def fake_sub(cmd, timeout=30):
            seen_cmds.append(cmd)
            return 0, json.dumps(fake_computed), ""

        with patch.object(tools_impl, "_run_cmd", side_effect=fake_sub):
            out = tools_impl._compute_generated_drift(PROJECT_ROOT)
        self.assertEqual(out["js_drift"], [])
        self.assertIn("-B", seen_cmds[0])

    def test_yt_tools_standalone_drift_detects_extra_files(self):
        """Verifies _check_yt_tools_standalone_drift flags extra/stale files not emitted by export_standalone."""
        with tempfile.TemporaryDirectory(prefix="mpv_yt_drift_") as tmp_root:
            os.makedirs(os.path.join(tmp_root, "yt-tools"), exist_ok=True)
            os.makedirs(os.path.join(tmp_root, "popup"), exist_ok=True)
            os.makedirs(os.path.join(tmp_root, "background"), exist_ok=True)
            os.makedirs(os.path.join(tmp_root, "yt-tools-standalone", "yt-tools"), exist_ok=True)
            os.makedirs(os.path.join(tmp_root, "yt-tools-standalone", "popup"), exist_ok=True)
            os.makedirs(os.path.join(tmp_root, "yt-tools-standalone", "background"), exist_ok=True)

            exporter_src = (
                "YT_TOOL_FILES = ['a.js']\n"
                "ICON_FILES = []\n"
                "MANIFEST = {'name': 'test'}\n"
                "STANDALONE_BACKGROUND_JS = 'bg'\n"
                "STANDALONE_POPUP_HTML = '<html></html>'\n"
                "STANDALONE_POPUP_JS = 'pop'\n"
                "def adapt_service_for_standalone(s): return s\n"
                "def build_standalone_css(s): return s\n"
            )
            with open(os.path.join(tmp_root, "yt-tools", "export_standalone.py"), "w", encoding="utf-8") as fh:
                fh.write(exporter_src)
            with open(os.path.join(tmp_root, "yt-tools", "a.js"), "w", encoding="utf-8") as fh:
                fh.write("console.log(1);")
            with open(os.path.join(tmp_root, "popup", "popup_youtube.js"), "w", encoding="utf-8") as fh:
                fh.write("pop_yt")
            with open(os.path.join(tmp_root, "background", "yt_tools_service.js"), "w", encoding="utf-8") as fh:
                fh.write("svc")
            with open(os.path.join(tmp_root, "popup.css"), "w", encoding="utf-8") as fh:
                fh.write("body{}")

            # Populate matching standalone files + one stale extra file
            standalone = os.path.join(tmp_root, "yt-tools-standalone")
            expected_files = {
                "yt-tools/a.js": "console.log(1);",
                "popup/popup_youtube.js": "pop_yt",
                "background/yt_tools_service.js": "svc",
                "popup.css": "body{}",
                "manifest.json": json.dumps({"name": "test"}, indent=2) + "\n",
                "background.js": "bg",
                "popup.html": "<html></html>",
                "popup.js": "pop",
                "stale_extra.js": "should be flagged",
            }
            for rel, content in expected_files.items():
                with open(os.path.join(standalone, rel), "w", encoding="utf-8") as fh:
                    fh.write(content)

            with patch.object(tools_impl, "REPO_ROOT", tmp_root):
                res = tools_impl._check_yt_tools_standalone_drift()

            self.assertTrue(res["present"])
            self.assertTrue(res["drifted"])
            self.assertIn({"file": "stale_extra.js", "status": "extra"}, res["diffs"])

    def test_linters_stderr_and_empty_filename_guards(self):
        """Verifies _lint_ruff surfaces stderr when stdout is empty and empty filenames do not crash relpath."""
        with (
            patch.object(tools_impl.shutil, "which", return_value="/usr/bin/ruff"),
            patch.object(tools_impl, "_run_cmd", return_value=(2, "", "ruff failed: invalid pyproject.toml")),
        ):
            r_err = tools_impl._lint_ruff()
        self.assertFalse(r_err["ok"])
        self.assertGreaterEqual(r_err["errors"], 1)
        self.assertTrue(any("invalid pyproject.toml" in d.get("message", "") for d in r_err["diagnostics"]))

        ruff_empty_file = json.dumps([{"filename": "", "code": "E999", "message": "boom", "location": {"row": 1}}])
        with (
            patch.object(tools_impl.shutil, "which", return_value="/usr/bin/ruff"),
            patch.object(tools_impl, "_run_cmd", return_value=(1, ruff_empty_file, "")),
        ):
            r_empty = tools_impl._lint_ruff()
        self.assertEqual(r_empty["diagnostics"][0]["file"], "")

        pyright_empty = json.dumps({"generalDiagnostics": [{"severity": "error", "file": "", "message": "err"}]})
        with (
            patch.object(tools_impl.shutil, "which", return_value="/usr/bin/pyright"),
            patch.object(tools_impl, "_run_cmd", return_value=(1, pyright_empty, "")),
        ):
            p_empty = tools_impl._lint_pyright()
        self.assertEqual(p_empty["diagnostics"][0]["file"], "")

        sc_empty = json.dumps([{"file": "", "line": 1, "code": 2086, "message": "quote"}])
        with (
            patch.object(tools_impl.shutil, "which", return_value="/usr/bin/shellcheck"),
            patch.object(tools_impl, "_run_cmd", return_value=(1, sc_empty, "")),
        ):
            s_empty = tools_impl._lint_shellcheck()
        self.assertEqual(s_empty["diagnostics"][0]["file"], "")

    def test_inspect_runtime_state_shard_lookup_parity(self):
        """Verifies shard lookup mirrors file_io._get_safe_shard_path for special-char names and traversal."""
        with tempfile.TemporaryDirectory(prefix="mpv_state_shard_") as data_dir:
            playlists_dir = os.path.join(data_dir, "playlists")
            os.makedirs(playlists_dir, exist_ok=True)
            folder_name = "Anime: Season 1 (HD)"
            with open(os.path.join(data_dir, "index.json"), "w", encoding="utf-8") as fh:
                json.dump({folder_name: {}, "../escape": {}}, fh)
            with open(os.path.join(playlists_dir, f"{folder_name}.json"), "w", encoding="utf-8") as fh:
                json.dump({"playlist": [{"id": "1", "title": "Ep 1", "url": "https://example.com/1"}]}, fh)
            # Place a decoy file outside playlists_dir
            with open(os.path.join(data_dir, "escape.json"), "w", encoding="utf-8") as fh:
                json.dump({"playlist": [{"id": "bad", "title": "Bad", "url": "https://evil.example"}]}, fh)

            self.assertEqual(tools_impl._folder_item_count(data_dir, folder_name, {}), 1)
            urls = tools_impl._load_folder_urls(data_dir, folder_name)
            self.assertTrue(urls["found"])
            self.assertEqual(urls["total"], 1)
            self.assertEqual(urls["items"][0]["title"], "Ep 1")

            self.assertEqual(tools_impl._folder_item_count(data_dir, "../escape", {}), 0)

    def test_mpv_pipeline_validation_and_subprocess_isolation(self):
        """Verifies headless timeout validation and dry_run subprocess isolation + error handling."""
        for bad_timeout in ("abc", True, float("nan"), float("inf")):
            res = tools_impl.test_mpv_pipeline(mode="headless", options={"timeout": bad_timeout})
            self.assertFalse(res["ok"], res)
            self.assertEqual(res["mode"], "headless")
            self.assertIn("Invalid timeout", res["error"])

        # Non-JSON-serializable option returns clean error in dry_run
        bad_opt = tools_impl.test_mpv_pipeline(mode="dry_run", options={"bad": object()})
        self.assertFalse(bad_opt["ok"])
        self.assertEqual(bad_opt["mode"], "dry_run")

        # Valid dry_run succeeds in subprocess without mutating in-process file_io globals
        if PROJECT_ROOT not in sys.path:
            sys.path.insert(0, PROJECT_ROOT)
        import file_io

        orig_data = file_io.DATA_DIR
        orig_temp = file_io.TEMP_DIR
        ok_res = tools_impl.test_mpv_pipeline(mode="dry_run", urls=["https://example.com/v.mp4"])
        self.assertTrue(ok_res["ok"], ok_res)
        self.assertEqual(file_io.DATA_DIR, orig_data)
        self.assertEqual(file_io.TEMP_DIR, orig_temp)

    def test_native_host_harness_request_id_validation_duplicates_and_win32_reader(self):
        """Verifies request_id validation, duplicate request_id counting, and win32 pipe reader fallback."""
        if PROJECT_ROOT not in sys.path:
            sys.path.insert(0, PROJECT_ROOT)
        from testing_tools import native_host_harness

        # Invalid request_id types rejected cleanly via simulate_native_message
        for bad_id in (["list"], {"dict": 1}, True):
            res = tools_impl.simulate_native_message({"action": "ping", "request_id": bad_id})
            self.assertFalse(res["ok"], res)
            self.assertIn("Invalid request_id", res["error"])

        # Duplicate request_ids in a batch wait for BOTH responses
        dup_res = tools_impl.simulate_native_message(
            [
                {"action": "ping", "request_id": "dup-1"},
                {"action": "ping", "request_id": "dup-1"},
            ],
            timeout=5.0,
        )
        self.assertTrue(dup_res["ok"], dup_res)
        dup_frames = [f for f in dup_res["frames"] if f.get("requestId") == "dup-1" or f.get("request_id") == "dup-1"]
        self.assertEqual(len(dup_frames), 2, dup_res)

        # Windows pipe reader fallback works across partial reads, timeout, and EOF
        r_fd, w_fd = os.pipe()
        try:
            with os.fdopen(r_fd, "rb", buffering=0) as r_stream:
                with patch.object(native_host_harness.sys, "platform", "win32"):
                    os.write(w_fd, b"he")
                    data, is_eof = native_host_harness._read_exact_with_timeout(r_stream, 5, native_host_harness.time.monotonic() + 0.05)
                    self.assertIsNone(data)
                    self.assertFalse(is_eof)

                    os.write(w_fd, b"llo!")
                    data2, is_eof2 = native_host_harness._read_exact_with_timeout(r_stream, 5, native_host_harness.time.monotonic() + 1.0)
                    self.assertEqual(data2, b"hello")
                    self.assertFalse(is_eof2)

                    os.close(w_fd)
                    w_fd = -1
                    data3, is_eof3 = native_host_harness._read_exact_with_timeout(r_stream, 5, native_host_harness.time.monotonic() + 1.0)
                    self.assertEqual(data3, b"!")
                    self.assertTrue(is_eof3)
        finally:
            if w_fd >= 0:
                os.close(w_fd)

    def test_list_ipc_sockets_probes_real_mpv_pid_and_tail_one_log_deque(self):
        """Regression: _list_ipc_sockets probes Unix socket for real MPV PID (not native_host filename PID) and _tail_one_log uses deque."""
        with tempfile.TemporaryDirectory(prefix="mpv_ipc_probe_") as tmp_dir:
            sock_path = os.path.join(tmp_dir, "mpv-socket-11111")
            with open(sock_path, "w", encoding="utf-8") as fh:
                fh.write("")

            seen_pids = []

            def fake_verify(pid):
                seen_pids.append(pid)
                return {"alive": True, "is_mpv": pid == 22222}

            with (
                patch.object(tools_impl, "_get_ipc_dir", return_value=tmp_dir),
                patch.object(tools_impl.stat, "S_ISSOCK", return_value=True),
                patch.object(tools_impl, "_query_mpv_properties", return_value={"values": {"pid": 22222}, "errors": {}}),
                patch.object(tools_impl, "_verify_mpv_pid", side_effect=fake_verify),
            ):
                res = tools_impl._list_ipc_sockets()

            self.assertTrue(res["ok"])
            self.assertEqual(len(res["sockets"]), 1)
            entry = res["sockets"][0]
            self.assertEqual(seen_pids, [22222])
            self.assertEqual(entry["pid"], 22222)
            self.assertEqual(entry["host_pid"], 11111)
            self.assertFalse(entry["stale"])
            self.assertTrue(entry["alive"])
            self.assertTrue(entry["is_mpv"])

            # Verify _tail_one_log uses bounded deque and masks only the returned slice
            log_path = os.path.join(tmp_dir, "native_host.log")
            with open(log_path, "w", encoding="utf-8") as fh:
                for i in range(10):
                    fh.write(f"2026-01-01 - INFO - line {i} MPV_PLAYLIST_TOKEN=secret{i}\n")
            with patch.object(tools_impl, "_mask_text", wraps=tools_impl._mask_text) as spy_mask:
                tailed = tools_impl._tail_one_log(log_path, tmp_dir, max_lines=3, grep=None, level="INFO")
            self.assertEqual(spy_mask.call_count, 3)
            self.assertTrue(tailed["exists"])
            self.assertEqual(tailed["total_matched"], 10)
            self.assertEqual(tailed["returned"], 3)
            self.assertTrue(tailed["truncated"])
            self.assertEqual(len(tailed["lines"]), 3)
            self.assertIn("line 9", tailed["lines"][-1])
            self.assertNotIn("secret9", tailed["lines"][-1])


if __name__ == "__main__":
    unittest.main()
