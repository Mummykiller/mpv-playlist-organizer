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


if __name__ == "__main__":
    unittest.main()
