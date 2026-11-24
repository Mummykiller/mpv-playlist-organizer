import json
import os
import shutil
import subprocess
import sys
import unittest
from unittest.mock import patch

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MCP_DIR = os.path.join(PROJECT_ROOT, "mcp_server")
if MCP_DIR not in sys.path:
    sys.path.insert(0, MCP_DIR)

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
        self.assertEqual(payload.get("tools_count"), 5)

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


if __name__ == "__main__":
    unittest.main()
