import collections
import contextlib
import importlib.util
import io
import json
import logging
import math
import os
import re
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
from typing import Any

sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"

logger = logging.getLogger("mpv_mcp")

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TESTING_TOOLS_DIR = os.path.join(REPO_ROOT, "testing_tools")

BRIDGE_CONTRACT_REL = "testing_tools/scripts/bridge_contract.js"

ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
SAFE_TARGET_RE = re.compile(r"^[A-Za-z0-9_.-]+\.(py|js)$")
SAFE_PROP_RE = re.compile(r"^[a-zA-Z0-9_./-]{1,64}$")
EXT_ORIGIN_RE = re.compile(r"^chrome-extension://[a-p]{32}/$")

LOG_FILES = {
    "native_host": "native_host.log",
    "ipc_events": "ipc_events.log",
    "browser_errors": "browser_errors.log",
    "crash": "native_host_crash.log",
}

SENSITIVE_KEY_PARTS = (
    "token",
    "cookie",
    "secret",
    "password",
    "passwd",
    "auth",
    "api_key",
    "apikey",
    "bearer",
    "session_key",
)

LINUX_NATIVE_HOST_DIRS = {
    "Google Chrome": "~/.config/google-chrome/NativeMessagingHosts",
    "Chromium": "~/.config/chromium/NativeMessagingHosts",
    "Brave": "~/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts",
    "Microsoft Edge": "~/.config/microsoft-edge/NativeMessagingHosts",
    "Vivaldi": "~/.config/vivaldi/NativeMessagingHosts",
    "Opera": "~/.config/opera/NativeMessagingHosts",
}

HOST_NAME = "com.mpv_playlist_organizer.handler"
SNAPSHOT_PROPS = (
    "media-title",
    "path",
    "pause",
    "time-pos",
    "duration",
    "playlist-pos",
    "playlist-count",
)


def compact_json(data: Any) -> str:
    return json.dumps(data, separators=(",", ":"), ensure_ascii=False, default=str)


def strip_ansi(text: str) -> str:
    return ANSI_RE.sub("", text or "")


def _repo_env() -> dict[str, str]:
    env = os.environ.copy()
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["NO_COLOR"] = "1"
    return env


def _python_bin() -> str:
    return shutil.which("python3") or sys.executable


def _ensure_repo_on_path() -> None:
    if REPO_ROOT not in sys.path:
        sys.path.insert(0, REPO_ROOT)


def _resolve_data_dir() -> str:
    _ensure_repo_on_path()
    with contextlib.redirect_stdout(io.StringIO()):
        import file_io

        return file_io.get_user_data_dir()


def _mask_text(text: str, data_dir: str | None = None) -> str:
    _ensure_repo_on_path()
    with contextlib.redirect_stdout(io.StringIO()):
        from utils import security

        masked = security.mask_path(text, data_dir=data_dir, script_dir=REPO_ROOT)
    masked = re.sub(r"(?i)(MPV_PLAYLIST_TOKEN\s*[=:]\s*)[^\s'\"&]+", r"\1[REDACTED]", masked)
    masked = re.sub(r"(?i)((?:authorization|cookie)\s*:\s*)[^\r\n]+", r"\1[REDACTED]", masked)
    return masked


def _redact_obj(obj: Any, data_dir: str | None = None) -> Any:
    if isinstance(obj, dict):
        out: dict[str, Any] = {}
        for k, v in obj.items():
            k_str = str(k).lower()
            if any(part in k_str for part in SENSITIVE_KEY_PARTS):
                out[k] = "[REDACTED]"
            else:
                out[k] = _redact_obj(v, data_dir=data_dir)
        return out
    if isinstance(obj, list):
        return [_redact_obj(item, data_dir=data_dir) for item in obj]
    if isinstance(obj, str):
        return _mask_text(obj, data_dir=data_dir)
    return obj


def _run_cmd(cmd: list[str], timeout: int = 120) -> tuple[int, str, str]:
    try:
        proc = subprocess.run(
            cmd,
            cwd=REPO_ROOT,
            env=_repo_env(),
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return proc.returncode, strip_ansi(proc.stdout), strip_ansi(proc.stderr)
    except subprocess.TimeoutExpired as exc:
        out_raw = exc.stdout.decode("utf-8", errors="replace") if isinstance(exc.stdout, bytes) else (exc.stdout or "")
        err_raw = exc.stderr.decode("utf-8", errors="replace") if isinstance(exc.stderr, bytes) else (exc.stderr or "")
        timeout_msg = f"Command timed out after {timeout}s"
        combined_err = f"{err_raw}\n{timeout_msg}".strip() if err_raw else timeout_msg
        return -1, strip_ansi(out_raw), strip_ansi(combined_err)


def _trim_lines(text: str, limit: int = 40) -> tuple[list[str], bool, int]:
    lines = [ln for ln in text.splitlines() if ln.strip()]
    total = len(lines)
    if total > limit:
        return lines[-limit:], True, total
    return lines, False, total


# ---------------------------------------------------------------------------
# 1. verify_repo
# ---------------------------------------------------------------------------


def _run_build(sync_contract: bool) -> dict[str, Any]:
    stages: list[dict[str, Any]] = []
    rc, out, err = _run_cmd([_python_bin(), os.path.join(TESTING_TOOLS_DIR, "generate_js.py")])
    stages.append(
        {
            "name": "generate_js",
            "ok": rc == 0,
            **({} if rc == 0 else {"error": _trim_lines(err or out, 20)[0]}),
        }
    )
    if rc != 0:
        return {"ok": False, "mode": "build", "stages": stages}

    if sync_contract:
        rc2, out2, err2 = _run_cmd([_python_bin(), os.path.join(TESTING_TOOLS_DIR, "generate_bridge_contract.py")])
        stages.append(
            {
                "name": "generate_bridge_contract",
                "ok": rc2 == 0,
                **({} if rc2 == 0 else {"error": _trim_lines(err2 or out2, 20)[0]}),
            }
        )
        if rc2 != 0:
            return {"ok": False, "mode": "build", "stages": stages}

    return {"ok": True, "mode": "build", "stages": stages}


def _cap_diags(diags: list[dict[str, Any]], cap: int = 25) -> tuple[list[dict[str, Any]], bool]:
    if len(diags) > cap:
        return diags[:cap], True
    return diags, False


def _lint_ruff() -> dict[str, Any]:
    bin_path = shutil.which("ruff")
    if not bin_path:
        return {"ok": True, "skipped": True, "reason": "not_installed"}
    cfg = os.path.join(TESTING_TOOLS_DIR, "pyproject.toml")
    cmd = [bin_path, "check", "--no-fix", "--output-format", "json"]
    if os.path.isfile(cfg):
        cmd.extend(["--config", cfg])
    cmd.append(".")
    rc, out, err = _run_cmd(cmd)
    if rc == 0:
        return {"ok": True, "errors": 0}
    diags: list[dict[str, Any]] = []
    try:
        items = json.loads(out) if out.strip() else []
        for item in items:
            fname = item.get("filename", "")
            diags.append(
                {
                    "file": os.path.relpath(fname, REPO_ROOT) if fname else "",
                    "line": (item.get("location") or {}).get("row"),
                    "rule": item.get("code"),
                    "message": item.get("message"),
                }
            )
    except json.JSONDecodeError as exc:
        logger.debug("ruff json parse fallback: %s", exc)
        for line in (out or err).splitlines():
            if line.strip():
                diags.append({"message": line.strip()})
    if not diags and err.strip():
        for line in err.strip().splitlines():
            if line.strip():
                diags.append({"message": line.strip()})
    capped, trunc = _cap_diags(diags)
    return {"ok": False, "errors": max(1, len(diags)), "diagnostics": capped, "truncated": trunc}


def _lint_biome() -> dict[str, Any]:
    bin_path = shutil.which("biome")
    if not bin_path:
        for candidate_root in (REPO_ROOT, TESTING_TOOLS_DIR):
            candidate = os.path.join(candidate_root, "node_modules", ".bin", "biome")
            if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
                bin_path = candidate
                break
    if not bin_path:
        return {"ok": True, "skipped": True, "reason": "not_installed"}
    cfg = os.path.join(TESTING_TOOLS_DIR, "biome.json")
    cmd = [bin_path, "check", "--reporter=json"]
    if os.path.isfile(cfg):
        cmd.extend(["--config-path", cfg])
    cmd.append(".")
    rc, out, err = _run_cmd(cmd)
    if rc == 0:
        return {"ok": True, "errors": 0}
    diags: list[dict[str, Any]] = []
    try:
        payload = json.loads(out)
        for d in payload.get("diagnostics", []):
            loc = d.get("location") or {}
            path_obj = loc.get("path") or {}
            diags.append(
                {
                    "file": path_obj.get("file") if isinstance(path_obj, dict) else path_obj,
                    "rule": d.get("category"),
                    "message": d.get("description") or str(d.get("message", "")),
                }
            )
    except json.JSONDecodeError as exc:
        logger.debug("biome json parse fallback: %s", exc)
        for line in (out or err).splitlines():
            if line.strip():
                diags.append({"message": line.strip()})
    capped, trunc = _cap_diags(diags)
    return {"ok": False, "errors": max(1, len(diags)), "diagnostics": capped, "truncated": trunc}


def _lint_pyright() -> dict[str, Any]:
    bin_path = shutil.which("pyright")
    if not bin_path:
        return {"ok": True, "skipped": True, "reason": "not_installed"}
    cfg = os.path.join(TESTING_TOOLS_DIR, "pyrightconfig.json")
    cmd = [bin_path, "--outputjson"]
    if os.path.isfile(cfg):
        cmd.extend(["-p", cfg])
    else:
        cmd.append(".")
    rc, out, err = _run_cmd(cmd)
    if rc == 0:
        return {"ok": True, "errors": 0}
    diags: list[dict[str, Any]] = []
    try:
        payload = json.loads(out)
        for d in payload.get("generalDiagnostics", []):
            if d.get("severity") == "error":
                fname = d.get("file", "")
                diags.append(
                    {
                        "file": os.path.relpath(fname, REPO_ROOT) if fname else "",
                        "line": ((d.get("range") or {}).get("start") or {}).get("line", 0) + 1,
                        "rule": d.get("rule"),
                        "message": d.get("message"),
                    }
                )
    except json.JSONDecodeError as exc:
        logger.debug("pyright json parse fallback: %s", exc)
        for line in (out or err).splitlines():
            if line.strip():
                diags.append({"message": line.strip()})
    capped, trunc = _cap_diags(diags)
    return {"ok": False, "errors": max(1, len(diags)), "diagnostics": capped, "truncated": trunc}


def _lint_lua() -> dict[str, dict[str, Any]]:
    lua_dir = os.path.join(REPO_ROOT, "mpv_scripts")
    lua_files = (
        sorted(os.path.join(lua_dir, f) for f in os.listdir(lua_dir) if f.endswith(".lua"))
        if os.path.isdir(lua_dir)
        else []
    )
    results: dict[str, dict[str, Any]] = {}

    luac_bin = shutil.which("luac")
    if not luac_bin or not lua_files:
        results["luac"] = {"ok": True, "skipped": True, "reason": "not_installed_or_no_files"}
    else:
        diags: list[dict[str, Any]] = []
        for lf in lua_files:
            rc, out, err = _run_cmd([luac_bin, "-p", lf])
            if rc != 0:
                diags.append({"file": os.path.relpath(lf, REPO_ROOT), "message": (err or out).strip()})
        capped, trunc = _cap_diags(diags)
        results["luac"] = (
            {"ok": True, "errors": 0}
            if not diags
            else {"ok": False, "errors": len(diags), "diagnostics": capped, "truncated": trunc}
        )

    luacheck_bin = shutil.which("luacheck")
    if not luacheck_bin or not lua_files:
        results["luacheck"] = {"ok": True, "skipped": True, "reason": "not_installed_or_no_files"}
    else:
        cfg = os.path.join(TESTING_TOOLS_DIR, ".luacheckrc")
        cmd = [luacheck_bin, "--no-color"]
        if os.path.isfile(cfg):
            cmd.extend(["--config", cfg])
        cmd.extend(lua_files)
        rc, out, err = _run_cmd(cmd)
        if rc == 0:
            results["luacheck"] = {"ok": True, "errors": 0}
        else:
            diags = [
                {"message": ln.strip()}
                for ln in (out or err).splitlines()
                if ln.strip() and not ln.startswith("Total:")
            ]
            capped, trunc = _cap_diags(diags)
            results["luacheck"] = {"ok": False, "errors": len(diags), "diagnostics": capped, "truncated": trunc}
    return results


def _lint_shellcheck() -> dict[str, Any]:
    bin_path = shutil.which("shellcheck")
    if not bin_path:
        return {"ok": True, "skipped": True, "reason": "not_installed"}
    skip_dirs = {
        ".git",
        "__pycache__",
        "node_modules",
        ".venv",
        "yt-tools-legacy",
        "yt-tools-standalone",
        "mpv-playlist-organizer-release",
    }
    sh_files: list[str] = []
    for root_dir, dirs, files in os.walk(REPO_ROOT):
        dirs[:] = [d for d in dirs if d not in skip_dirs]
        for fname in sorted(files):
            if fname.endswith(".sh"):
                sh_files.append(os.path.join(root_dir, fname))
    if not sh_files:
        return {"ok": True, "errors": 0}
    rc, out, err = _run_cmd([bin_path, "-f", "json", *sh_files])
    if rc == 0:
        return {"ok": True, "errors": 0}
    diags: list[dict[str, Any]] = []
    try:
        for item in json.loads(out):
            fname = item.get("file", "")
            diags.append(
                {
                    "file": os.path.relpath(fname, REPO_ROOT) if fname else "",
                    "line": item.get("line"),
                    "rule": f"SC{item.get('code')}",
                    "message": item.get("message"),
                }
            )
    except json.JSONDecodeError as exc:
        logger.debug("shellcheck json parse fallback: %s", exc)
        for line in (out or err).splitlines():
            if line.strip():
                diags.append({"message": line.strip()})
    capped, trunc = _cap_diags(diags)
    return {"ok": False, "errors": len(diags), "diagnostics": capped, "truncated": trunc}


def _parse_suite_summary(output: str) -> dict[str, Any]:
    m_pass = re.search(r"\((\d+)/(\d+)\s+tests,\s*(\d+)\s+JS syntax OK,\s*(\d+)\s+Python static OK\)", output)
    if m_pass:
        passed, total = int(m_pass.group(1)), int(m_pass.group(2))
        return {
            "passed": passed,
            "failed": total - passed,
            "total": total,
            "js_syntax_ok": int(m_pass.group(3)),
            "py_static_ok": int(m_pass.group(4)),
        }
    m_fail = re.search(r"Suite failed\s*\((\d+)/(\d+)\s+tests passed\)", output)
    if m_fail:
        passed, total = int(m_fail.group(1)), int(m_fail.group(2))
        return {"passed": passed, "failed": total - passed, "total": total}
    return {}


def _run_fix() -> dict[str, Any]:
    build_res = _run_build(sync_contract=True)
    stages: list[dict[str, Any]] = list(build_res["stages"])
    if not build_res["ok"]:
        return {"ok": False, "mode": "fix", "stages": stages}

    ruff_bin = shutil.which("ruff")
    if ruff_bin:
        cfg = os.path.join(TESTING_TOOLS_DIR, "pyproject.toml")
        cmd = [ruff_bin, "check", "--fix"]
        if os.path.isfile(cfg):
            cmd.extend(["--config", cfg])
        cmd.append(".")
        rc_rf, out_rf, err_rf = _run_cmd(cmd)
        stages.append(
            {
                "name": "ruff_fix",
                "ok": rc_rf == 0,
                **({} if rc_rf == 0 else {"error": _trim_lines(err_rf or out_rf, 20)[0]}),
            }
        )
    else:
        stages.append({"name": "ruff_fix", "ok": True, "skipped": True, "reason": "not_installed"})

    rc_v, out_v, err_v = _run_cmd([_python_bin(), os.path.join(REPO_ROOT, "verify_changes.py")], timeout=180)
    combined = (out_v + "\n" + err_v).strip()
    verify_stage: dict[str, Any] = {
        "name": "verify_full",
        "ok": rc_v == 0,
        "summary": _parse_suite_summary(combined),
    }
    if rc_v != 0:
        fail_lines, trunc, _ = _trim_lines(combined, 40)
        verify_stage["failure_lines"] = fail_lines
        verify_stage["truncated"] = trunc
    stages.append(verify_stage)

    all_ok = all(s.get("ok", False) for s in stages)
    return {"ok": all_ok, "mode": "fix", "stages": stages}


def verify_repo(mode: str = "full", target: str | None = None, sync_contract: bool = False) -> dict[str, Any]:
    allowed = {"build", "lint", "test", "targeted", "fix", "full"}
    if mode not in allowed:
        return {"ok": False, "error": f"Invalid mode '{mode}'. Allowed: {sorted(allowed)}"}

    if mode == "build":
        return _run_build(sync_contract=sync_contract)

    if mode == "fix":
        return _run_fix()

    if mode == "lint":
        linters: dict[str, Any] = {
            "ruff": _lint_ruff(),
            "biome": _lint_biome(),
            "pyright": _lint_pyright(),
            **_lint_lua(),
            "shellcheck": _lint_shellcheck(),
        }
        all_ok = all(v.get("ok", False) for v in linters.values())
        return {"ok": all_ok, "mode": "lint", "linters": linters}

    if mode == "targeted":
        if not target or not SAFE_TARGET_RE.match(target):
            return {"ok": False, "mode": "targeted", "error": "target must be a test filename (*.py or *.js)"}
        script_path = os.path.join(TESTING_TOOLS_DIR, "scripts", target)
        if not os.path.isfile(script_path):
            return {"ok": False, "mode": "targeted", "error": f"Test file not found: testing_tools/scripts/{target}"}
        if target.endswith(".py"):
            rc, out, err = _run_cmd([_python_bin(), os.path.join(TESTING_TOOLS_DIR, "run_suite.py"), "--worker", target])
            worker_info: dict[str, Any] = {}
            cleaned_lines: list[str] = []
            for line in out.splitlines():
                if line.startswith("__WORKER_RESULT__:"):
                    try:
                        worker_info = json.loads(line[len("__WORKER_RESULT__:") :])
                    except json.JSONDecodeError as exc:
                        logger.debug("worker json parse error: %s", exc)
                elif line.strip():
                    cleaned_lines.append(line)
            passed = int(worker_info.get("passed", 0))
            total = int(worker_info.get("total", 0))
            ok = rc == 0 and bool(worker_info.get("ok", rc == 0))
            res: dict[str, Any] = {
                "ok": ok,
                "mode": "targeted",
                "target": target,
                "passed": passed,
                "failed": max(0, total - passed),
                "total": total,
            }
            if not ok:
                tail, trunc, _ = _trim_lines("\n".join(cleaned_lines) + ("\n" + err if err else ""), 40)
                res["failure_lines"] = tail
                res["truncated"] = trunc
            return res

        node_bin = shutil.which("node")
        if not node_bin:
            return {"ok": False, "mode": "targeted", "error": "node executable not found"}
        rc, out, err = _run_cmd([node_bin, script_path])
        res = {"ok": rc == 0, "mode": "targeted", "target": target}
        if rc != 0:
            tail, trunc, _ = _trim_lines(err or out, 40)
            res["failure_lines"] = tail
            res["truncated"] = trunc
        return res

    script = (
        os.path.join(REPO_ROOT, "verify_changes.py")
        if mode == "full"
        else os.path.join(TESTING_TOOLS_DIR, "run_suite.py")
    )
    rc, out, err = _run_cmd([_python_bin(), script], timeout=180)
    combined = (out + "\n" + err).strip()
    summary = _parse_suite_summary(combined)
    result: dict[str, Any] = {"ok": rc == 0, "mode": mode, "summary": summary}
    if rc != 0:
        fail_lines, trunc, _ = _trim_lines(combined, 40)
        result["failure_lines"] = fail_lines
        result["truncated"] = trunc
    return result


# ---------------------------------------------------------------------------
# 2. check_repo_drift
# ---------------------------------------------------------------------------


def _check_yt_tools_standalone_drift() -> dict[str, Any]:
    standalone_dir = os.path.join(REPO_ROOT, "yt-tools-standalone")
    if not os.path.isdir(standalone_dir):
        return {"present": False, "drifted": False, "checked_files": 0, "diffs": []}

    exporter_path = os.path.join(REPO_ROOT, "yt-tools", "export_standalone.py")
    spec = importlib.util.spec_from_file_location("yt_export_standalone_ro", exporter_path)
    if spec is None or spec.loader is None:
        return {"present": True, "drifted": True, "checked_files": 0, "diffs": [{"file": "yt-tools/export_standalone.py", "status": "load_error"}]}

    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    expected_text: dict[str, str] = {}
    for fname in mod.YT_TOOL_FILES:
        src_path = os.path.join(REPO_ROOT, "yt-tools", fname)
        with open(src_path, "r", encoding="utf-8") as fh:
            expected_text[f"yt-tools/{fname}"] = fh.read()

    with open(os.path.join(REPO_ROOT, "popup", "popup_youtube.js"), "r", encoding="utf-8") as fh:
        expected_text["popup/popup_youtube.js"] = fh.read()

    with open(os.path.join(REPO_ROOT, "background", "yt_tools_service.js"), "r", encoding="utf-8") as fh:
        expected_text["background/yt_tools_service.js"] = mod.adapt_service_for_standalone(fh.read())

    with open(os.path.join(REPO_ROOT, "popup.css"), "r", encoding="utf-8") as fh:
        expected_text["popup.css"] = mod.build_standalone_css(fh.read())

    expected_text["manifest.json"] = json.dumps(mod.MANIFEST, indent=2) + "\n"
    expected_text["background.js"] = mod.STANDALONE_BACKGROUND_JS
    expected_text["popup.html"] = mod.STANDALONE_POPUP_HTML
    expected_text["popup.js"] = mod.STANDALONE_POPUP_JS

    diffs: list[dict[str, str]] = []
    expected_files: set[str] = set(expected_text.keys())
    checked = 0

    for rel_path, expected_content in sorted(expected_text.items()):
        checked += 1
        actual_path = os.path.join(standalone_dir, rel_path)
        if not os.path.isfile(actual_path):
            diffs.append({"file": rel_path, "status": "missing"})
            continue
        try:
            with open(actual_path, "r", encoding="utf-8") as fh:
                if fh.read() != expected_content:
                    diffs.append({"file": rel_path, "status": "content_diff"})
        except OSError as exc:
            logger.debug("standalone read error %s: %s", rel_path, exc)
            diffs.append({"file": rel_path, "status": "read_error"})

    for icon_name in mod.ICON_FILES:
        src_icon = os.path.join(REPO_ROOT, "yt-tools", "icons", icon_name)
        if not os.path.isfile(src_icon):
            src_icon = os.path.join(REPO_ROOT, "images", icon_name)
        if not os.path.isfile(src_icon):
            continue
        checked += 1
        rel_icon = f"images/{icon_name}"
        expected_files.add(rel_icon)
        actual_icon = os.path.join(standalone_dir, rel_icon)
        if not os.path.isfile(actual_icon):
            diffs.append({"file": rel_icon, "status": "missing"})
            continue
        try:
            with open(src_icon, "rb") as sfh, open(actual_icon, "rb") as afh:
                if sfh.read() != afh.read():
                    diffs.append({"file": rel_icon, "status": "content_diff"})
        except OSError as exc:
            logger.debug("standalone icon read error %s: %s", rel_icon, exc)
            diffs.append({"file": rel_icon, "status": "read_error"})

    for root_dir, dirs, files in os.walk(standalone_dir):
        dirs[:] = [d for d in sorted(dirs) if d != ".git"]
        for fname in sorted(files):
            abs_path = os.path.join(root_dir, fname)
            rel_path = os.path.relpath(abs_path, standalone_dir).replace(os.sep, "/")
            if rel_path not in expected_files:
                diffs.append({"file": rel_path, "status": "extra"})

    return {
        "present": True,
        "drifted": len(diffs) > 0,
        "checked_files": checked,
        "diffs": diffs[:30],
        "truncated": len(diffs) > 30,
    }


_DRIFT_SUBPROCESS_SCRIPT = r"""
import contextlib, io, json, os, sys
repo_root = sys.argv[1]
bridge_contract_rel = sys.argv[2]
sys.path.insert(0, repo_root)
with contextlib.redirect_stdout(io.StringIO()):
    from testing_tools import generate_bridge_contract, generate_js

js_drift = []
js_targets = {}
for cfg in generate_js.CONFIG:
    src_abs = os.path.join(repo_root, cfg["source"])
    tgt_abs = os.path.join(repo_root, cfg["target"])
    source_missing = not os.path.isfile(src_abs)
    target_missing = not os.path.isfile(tgt_abs)
    source_newer = False
    content_diff = target_missing
    if not target_missing and not source_missing:
        source_newer = os.path.getmtime(src_abs) > os.path.getmtime(tgt_abs)
        with open(tgt_abs, "r", encoding="utf-8") as fh:
            actual = fh.read()
        with contextlib.redirect_stdout(io.StringIO()):
            expected = generate_js.render_module_js(cfg, project_root=repo_root)
        content_diff = actual != expected
    js_targets[cfg["target"]] = {
        "source": cfg["source"],
        "target_missing": target_missing,
        "source_missing": source_missing,
        "content_diff": content_diff,
        "source_newer": source_newer,
    }
    if target_missing or content_diff or source_missing:
        js_drift.append({
            "source": cfg["source"],
            "target": cfg["target"],
            "source_missing": source_missing,
            "target_missing": target_missing,
            "content_diff": content_diff,
            "source_newer": source_newer,
        })

contract_abs = os.path.join(repo_root, bridge_contract_rel)
contract_missing = not os.path.isfile(contract_abs)
contract_content_diff = contract_missing
contract_source_newer = False
if not contract_missing:
    models_abs = os.path.join(repo_root, "utils", "native_link", "models.py")
    trans_abs = os.path.join(repo_root, "utils", "native_link", "translator.py")
    contract_mtime = os.path.getmtime(contract_abs)
    src_mtimes = [os.path.getmtime(p) for p in (models_abs, trans_abs) if os.path.isfile(p)]
    if src_mtimes:
        contract_source_newer = max(src_mtimes) > contract_mtime
    with open(contract_abs, "r", encoding="utf-8") as fh:
        actual_contract = fh.read()
    with contextlib.redirect_stdout(io.StringIO()):
        expected_contract = generate_bridge_contract.render_bridge_contract()
    contract_content_diff = actual_contract != expected_contract

contract_drift = {
    "drifted": contract_missing or contract_content_diff,
    "target": bridge_contract_rel,
    "target_missing": contract_missing,
    "content_diff": contract_content_diff,
    "source_newer": contract_source_newer,
}
sys.stdout.write(json.dumps({
    "js_drift": js_drift,
    "contract_drift": contract_drift,
    "js_targets": js_targets,
}))
"""


def _compute_generated_drift(repo_root: str) -> dict[str, Any]:
    rc, out, err = _run_cmd(
        [_python_bin(), "-B", "-c", _DRIFT_SUBPROCESS_SCRIPT, repo_root, BRIDGE_CONTRACT_REL],
        timeout=30,
    )
    if rc != 0:
        msg = (err or out or f"drift subprocess exited with code {rc}").strip()
        raise RuntimeError(msg)
    return json.loads(out)


def _parse_git_porcelain(git_out: str) -> dict[str, str]:
    modified: dict[str, str] = {}
    for ln in git_out.splitlines():
        if len(ln) < 4:
            continue
        raw_path = ln[3:].strip()
        if " -> " in raw_path:
            raw_path = raw_path.split(" -> ", 1)[1].strip()
        raw_path = raw_path.strip('"').replace(os.sep, "/")
        modified[raw_path] = ln.strip()
    return modified


def check_repo_drift(include_pycache: bool = True) -> dict[str, Any]:
    try:
        computed = _compute_generated_drift(REPO_ROOT)
    except (RuntimeError, json.JSONDecodeError) as exc:
        return {"ok": False, "error": f"Failed to compute generated drift: {exc}"}

    js_drift: list[dict[str, Any]] = computed["js_drift"]
    contract_drift: dict[str, Any] = computed["contract_drift"]
    js_targets: dict[str, dict[str, Any]] = computed["js_targets"]

    target_sources: dict[str, tuple[str, ...]] = {
        tgt: (info["source"], "testing_tools/generate_js.py")
        for tgt, info in js_targets.items()
    }
    target_sources[BRIDGE_CONTRACT_REL] = (
        "utils/native_link/models.py",
        "utils/native_link/translator.py",
        "testing_tools/generate_bridge_contract.py",
    )

    git_query_paths: list[str] = []
    seen_paths: set[str] = set()
    for tgt, srcs in target_sources.items():
        for p in (tgt, *srcs):
            if p not in seen_paths:
                seen_paths.add(p)
                git_query_paths.append(p)

    rc, git_out, _git_err = _run_cmd(["git", "status", "--porcelain", "--", *git_query_paths])
    generated_edits: list[str] = []
    if rc == 0:
        modified_paths = _parse_git_porcelain(git_out)
        for tgt, srcs in target_sources.items():
            if tgt not in modified_paths:
                continue
            has_content_diff = (
                bool(contract_drift.get("content_diff"))
                if tgt == BRIDGE_CONTRACT_REL
                else bool(js_targets.get(tgt, {}).get("content_diff"))
            )
            source_modified = any(src in modified_paths for src in srcs)
            if has_content_diff or not source_modified:
                generated_edits.append(modified_paths[tgt])

    skip_dirs = {
        ".git",
        "node_modules",
        ".venv",
        "mpv-playlist-organizer-release",
        "yt-tools-legacy",
        "yt-tools-standalone",
    }
    pycache_items: list[str] = []
    if include_pycache:
        for root_dir, dirs, files in os.walk(REPO_ROOT):
            if "__pycache__" in dirs:
                pycache_items.append(os.path.relpath(os.path.join(root_dir, "__pycache__"), REPO_ROOT))
            dirs[:] = [d for d in dirs if d not in skip_dirs and d != "__pycache__"]
            for fname in files:
                if fname.endswith((".pyc", ".pyo")):
                    pycache_items.append(os.path.relpath(os.path.join(root_dir, fname), REPO_ROOT))

    yt_standalone_drift = _check_yt_tools_standalone_drift()
    pycache_count = len(pycache_items)
    ok = (
        not js_drift
        and not contract_drift["drifted"]
        and not generated_edits
        and not (yt_standalone_drift["present"] and yt_standalone_drift["drifted"])
        and pycache_count == 0
    )
    return {
        "ok": ok,
        "js_drift": js_drift,
        "contract_drift": contract_drift,
        "yt_tools_standalone_drift": yt_standalone_drift,
        "generated_file_edits": generated_edits,
        "pycache": {
            "count": pycache_count,
            "items": pycache_items[:20],
            "truncated": pycache_count > 20,
        },
    }


# ---------------------------------------------------------------------------
# 3. tail_logs
# ---------------------------------------------------------------------------


def _tail_one_log(
    path: str,
    data_dir: str,
    max_lines: int,
    grep: str | None,
    level: str | None,
) -> dict[str, Any]:
    if not os.path.isfile(path):
        return {"exists": False, "total_matched": 0, "returned": 0, "truncated": False, "lines": []}

    grep_l = grep.lower() if grep else None
    level_u = level.upper() if level else None
    matched: collections.deque[str] = collections.deque(maxlen=max_lines)
    total = 0
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for raw_line in fh:
            line = raw_line.rstrip("\r\n")
            if level_u and f" - {level_u} - " not in line and not re.search(rf"\b{re.escape(level_u)}\b", line):
                continue
            if grep_l and grep_l not in line.lower():
                continue
            total += 1
            matched.append(line)

    sliced = [_mask_text(line, data_dir=data_dir) for line in matched]
    return {
        "exists": True,
        "total_matched": total,
        "returned": len(sliced),
        "truncated": total > max_lines,
        "lines": sliced,
    }


def tail_logs(
    log: str = "native_host",
    lines: int = 50,
    grep: str | None = None,
    level: str | None = None,
) -> dict[str, Any]:
    allowed_logs = set(LOG_FILES) | {"all"}
    if log not in allowed_logs:
        return {"ok": False, "error": f"Invalid log '{log}'. Allowed: {sorted(allowed_logs)}"}

    clamped = max(1, min(int(lines), 200))
    data_dir = _resolve_data_dir()

    if log == "all":
        per_log_cap = max(1, min(clamped, 50))
        logs_out = {
            name: _tail_one_log(os.path.join(data_dir, fname), data_dir, per_log_cap, grep, level)
            for name, fname in LOG_FILES.items()
        }
        return {"ok": True, "log": "all", "logs": logs_out}

    info = _tail_one_log(os.path.join(data_dir, LOG_FILES[log]), data_dir, clamped, grep, level)
    return {"ok": True, "log": log, **info}


# ---------------------------------------------------------------------------
# 4. inspect_runtime_state
# ---------------------------------------------------------------------------


def _read_json_safe(path: str) -> tuple[Any, str | None]:
    if not os.path.isfile(path):
        return None, None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh), None
    except (OSError, json.JSONDecodeError) as exc:
        return None, str(exc)


def _load_folders_readonly(data_dir: str) -> dict[str, Any]:
    index_data, _ = _read_json_safe(os.path.join(data_dir, "index.json"))
    if isinstance(index_data, dict):
        return index_data
    folders_data, _ = _read_json_safe(os.path.join(data_dir, "folders.json"))
    if isinstance(folders_data, dict):
        return folders_data
    return {}


def _resolve_safe_shard_path(data_dir: str, folder_id: str) -> str | None:
    """Mirrors file_io._get_safe_shard_path naming and containment logic without mutating globals."""
    if not folder_id or not isinstance(folder_id, str):
        return None
    clean_id = folder_id
    if "/" in clean_id or "\\" in clean_id or ".." in clean_id or clean_id in (".", ".."):
        _ensure_repo_on_path()
        with contextlib.redirect_stdout(io.StringIO()):
            import file_io

            clean_id = file_io.sanitize_folder_name(clean_id).replace("..", "").strip(". ")
    if not clean_id:
        return None
    playlists_dir = os.path.join(data_dir, "playlists")
    playlists_real = os.path.realpath(playlists_dir)
    shard_path = os.path.join(playlists_dir, f"{clean_id}.json")
    shard_real = os.path.realpath(shard_path)
    try:
        in_dir = os.path.commonpath([playlists_real, shard_real]) == playlists_real
    except ValueError:
        in_dir = False
    if not in_dir or os.path.dirname(shard_real) != playlists_real:
        return None
    return shard_path


def _folder_item_count(data_dir: str, folder_id: str, meta: Any) -> int:
    if isinstance(meta, dict):
        if isinstance(meta.get("playlist"), list):
            return len(meta["playlist"])
        if isinstance(meta.get("count"), int):
            return meta["count"]
        if isinstance(meta.get("item_count"), int):
            return meta["item_count"]
    shard_path = _resolve_safe_shard_path(data_dir, folder_id)
    if not shard_path:
        return 0
    shard, _ = _read_json_safe(shard_path)
    if isinstance(shard, list):
        return len(shard)
    if isinstance(shard, dict) and isinstance(shard.get("playlist"), list):
        return len(shard["playlist"])
    return 0


def _load_folder_urls(data_dir: str, folder_name: str) -> dict[str, Any]:
    index_data = _load_folders_readonly(data_dir)
    canonical = next((k for k in index_data if k.lower() == folder_name.lower()), None)
    if canonical is None:
        return {"found": False, "folder": folder_name}

    meta = index_data.get(canonical)
    items: list[Any] = []
    if isinstance(meta, dict) and isinstance(meta.get("playlist"), list):
        items = meta["playlist"]
    else:
        shard_path = _resolve_safe_shard_path(data_dir, canonical)
        shard, _ = _read_json_safe(shard_path) if shard_path else (None, None)
        if isinstance(shard, list):
            items = shard
        elif isinstance(shard, dict) and isinstance(shard.get("playlist"), list):
            items = shard["playlist"]

    scrubbed_urls: list[dict[str, Any]] = []
    for item in items[:100]:
        if isinstance(item, dict):
            scrubbed_urls.append(
                {
                    "id": item.get("id"),
                    "title": item.get("title"),
                    "url": _mask_text(str(item.get("url", "")), data_dir=data_dir),
                    "watched": item.get("watched"),
                }
            )
        else:
            scrubbed_urls.append({"url": _mask_text(str(item), data_dir=data_dir)})
    return {
        "found": True,
        "folder": canonical,
        "total": len(items),
        "truncated": len(items) > 100,
        "items": scrubbed_urls,
    }


def inspect_runtime_state(
    sections: list[str] | None = None,
    include_urls_for_folder: str | None = None,
) -> dict[str, Any]:
    valid_sections = {"session", "config", "counts", "flags", "playlists"}
    req_sections = sections if sections is not None else ["session", "config", "counts"]
    bad = [s for s in req_sections if s not in valid_sections]
    if bad:
        return {"ok": False, "error": f"Invalid sections {bad}. Allowed: {sorted(valid_sections)}"}

    data_dir = _resolve_data_dir()
    out: dict[str, Any] = {"ok": True, "data_dir_exists": os.path.isdir(data_dir)}

    if "session" in req_sections:
        data, err = _read_json_safe(os.path.join(data_dir, "session.json"))
        out["session"] = {"exists": data is not None, "error": err, "data": _redact_obj(data, data_dir)}

    if "config" in req_sections:
        data, err = _read_json_safe(os.path.join(data_dir, "config.json"))
        out["config"] = {"exists": data is not None, "error": err, "data": _redact_obj(data, data_dir)}

    flags_dir = os.path.join(data_dir, "flags")
    playlists_dir = os.path.join(data_dir, "playlists")
    flag_files = sorted(os.listdir(flags_dir)) if os.path.isdir(flags_dir) else []
    playlist_files = sorted(os.listdir(playlists_dir)) if os.path.isdir(playlists_dir) else []

    if "counts" in req_sections:
        folders = _load_folders_readonly(data_dir)
        folder_summaries = [
            {"name": name, "count": _folder_item_count(data_dir, name, meta)}
            for name, meta in sorted(folders.items())
        ]
        out["counts"] = {
            "folders_count": len(folder_summaries),
            "total_items": sum(f["count"] for f in folder_summaries),
            "folders": folder_summaries[:50],
            "folders_truncated": len(folder_summaries) > 50,
            "flags_count": len(flag_files),
            "playlists_count": len(playlist_files),
        }

    if "flags" in req_sections:
        out["flags"] = {
            "count": len(flag_files),
            "files": flag_files[:50],
            "truncated": len(flag_files) > 50,
        }

    if "playlists" in req_sections:
        out["playlists"] = {
            "count": len(playlist_files),
            "files": playlist_files[:50],
            "truncated": len(playlist_files) > 50,
        }

    if include_urls_for_folder:
        out["folder_urls"] = _load_folder_urls(data_dir, include_urls_for_folder)

    return out


# ---------------------------------------------------------------------------
# 5. check_native_host_registration
# ---------------------------------------------------------------------------


def check_native_host_registration() -> dict[str, Any]:
    data_dir = _resolve_data_dir()
    wrapper_path = os.path.join(REPO_ROOT, "run_native_host.sh")
    wrapper_exists = os.path.isfile(wrapper_path)
    wrapper_exec = wrapper_exists and os.access(wrapper_path, os.X_OK)
    wrapper_points_native = False
    if wrapper_exists:
        with open(wrapper_path, "r", encoding="utf-8", errors="replace") as fh:
            wrapper_points_native = "native_host.py" in fh.read()

    manifest_path = os.path.join(data_dir, f"{HOST_NAME}-chrome.json")
    manifest_data, manifest_err = _read_json_safe(manifest_path)
    manifest_valid = False
    manifest_issues: list[str] = []
    if manifest_data is None:
        manifest_issues.append(manifest_err or "manifest_missing")
    elif not isinstance(manifest_data, dict):
        manifest_issues.append("manifest_not_object")
    else:
        if manifest_data.get("name") != HOST_NAME:
            manifest_issues.append("invalid_name")
        if manifest_data.get("type") != "stdio":
            manifest_issues.append("invalid_type")
        m_path = manifest_data.get("path", "")
        if not m_path or os.path.realpath(str(m_path)) != os.path.realpath(wrapper_path):
            manifest_issues.append("path_mismatch")
        origins = manifest_data.get("allowed_origins")
        if not isinstance(origins, list) or not origins or not all(
            isinstance(o, str) and EXT_ORIGIN_RE.match(o) for o in origins
        ):
            manifest_issues.append("invalid_allowed_origins")
        manifest_valid = len(manifest_issues) == 0

    browsers: dict[str, Any] = {}
    linked_count = 0
    for browser, dir_tpl in LINUX_NATIVE_HOST_DIRS.items():
        expanded_dir = os.path.expanduser(dir_tpl)
        link_path = os.path.join(expanded_dir, f"{HOST_NAME}.json")
        is_link = os.path.islink(link_path)
        exists = os.path.exists(link_path)
        target = os.readlink(link_path) if is_link else None
        points_to_manifest = bool(
            exists and os.path.realpath(link_path) == os.path.realpath(manifest_path)
        )
        if points_to_manifest:
            linked_count += 1
        browsers[browser] = {
            "dir_exists": os.path.isdir(expanded_dir),
            "symlink_present": is_link,
            "target_valid": points_to_manifest,
            **({"target": _mask_text(target, data_dir=data_dir)} if target else {}),
        }

    ok = wrapper_exists and wrapper_exec and wrapper_points_native and manifest_valid and linked_count > 0
    return {
        "ok": ok,
        "wrapper": {
            "exists": wrapper_exists,
            "executable": wrapper_exec,
            "references_native_host": wrapper_points_native,
        },
        "manifest": {
            "exists": manifest_data is not None,
            "valid": manifest_valid,
            "issues": manifest_issues,
            "allowed_origins": manifest_data.get("allowed_origins") if isinstance(manifest_data, dict) else None,
        },
        "browsers": browsers,
        "linked_browsers": linked_count,
    }


# ---------------------------------------------------------------------------
# 6. probe_mpv_ipc
# ---------------------------------------------------------------------------


def _get_ipc_dir() -> str:
    xdg = os.environ.get("XDG_RUNTIME_DIR")
    if xdg:
        return os.path.join(xdg, "mpv_playlist_organizer_ipc")
    return os.path.join(os.path.expanduser("~"), ".mpv_playlist_organizer_ipc")


def _verify_mpv_pid(pid: int) -> dict[str, Any]:
    proc_cmdline = f"/proc/{pid}/cmdline"
    if not os.path.exists(f"/proc/{pid}"):
        return {"alive": False, "is_mpv": False}
    try:
        with open(proc_cmdline, "rb") as fh:
            raw = fh.read(4096)
        args = [a for a in raw.decode("utf-8", errors="replace").split("\0") if a]
        is_mpv = any("mpv" in os.path.basename(a).lower() for a in args[:2])
        return {"alive": True, "is_mpv": is_mpv}
    except OSError as exc:
        return {"alive": True, "is_mpv": False, "error": str(exc)}


def _list_ipc_sockets() -> dict[str, Any]:
    ipc_dir = _get_ipc_dir()
    if not os.path.isdir(ipc_dir):
        return {"ok": True, "action": "list", "ipc_dir_exists": False, "sockets": []}

    entries: list[dict[str, Any]] = []
    for name in sorted(os.listdir(ipc_dir)):
        if not name.startswith("mpv-socket-"):
            continue
        full = os.path.join(ipc_dir, name)
        try:
            st = os.lstat(full)
            is_sock = stat.S_ISSOCK(st.st_mode)
        except OSError:
            is_sock = False
        pid_str = name[len("mpv-socket-") :]
        host_pid = int(pid_str) if pid_str.isdigit() else None
        mpv_pid: int | None = None
        if is_sock:
            try:
                probe = _query_mpv_properties(full, ["pid"], timeout=0.5)
                probed_pid = probe.get("values", {}).get("pid")
                if isinstance(probed_pid, int) and not isinstance(probed_pid, bool):
                    mpv_pid = probed_pid
            except OSError:
                mpv_pid = None
        proc_info = _verify_mpv_pid(mpv_pid) if mpv_pid is not None else {"alive": False, "is_mpv": False}
        stale = not (is_sock and mpv_pid is not None and proc_info["alive"] and proc_info["is_mpv"])
        entries.append(
            {
                "socket_path": full,
                "pid": mpv_pid,
                "host_pid": host_pid,
                "is_socket": is_sock,
                "alive": proc_info["alive"],
                "is_mpv": proc_info["is_mpv"],
                "stale": stale,
            }
        )
    return {
        "ok": True,
        "action": "list",
        "ipc_dir_exists": True,
        "total": len(entries),
        "sockets": entries[:50],
        "truncated": len(entries) > 50,
    }


def _validate_ipc_socket_path(socket_path: str | None) -> tuple[str | None, str | None]:
    if not socket_path:
        return None, "socket_path is required"
    ipc_real = os.path.realpath(_get_ipc_dir())
    cand_real = os.path.realpath(socket_path)
    if os.path.dirname(cand_real) != ipc_real or not os.path.basename(cand_real).startswith("mpv-socket-"):
        return None, "socket_path must reside inside the mpv IPC directory and match mpv-socket-*"
    try:
        st = os.stat(cand_real)
        if not stat.S_ISSOCK(st.st_mode):
            return None, "socket_path is not a Unix socket"
    except OSError as exc:
        return None, f"socket stat failed: {exc}"
    return cand_real, None


def _query_mpv_properties(sock_path: str, props: list[str], timeout: float = 1.5) -> dict[str, Any]:
    values: dict[str, Any] = {}
    errors: dict[str, str] = {}
    deadline = time.monotonic() + max(0.1, float(timeout))
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.settimeout(max(0.1, deadline - time.monotonic()))
        sock.connect(sock_path)
        with sock.makefile("r", encoding="utf-8", errors="replace") as reader:
            for idx, prop in enumerate(props, start=1):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    errors[prop] = "timeout"
                    break
                sock.settimeout(remaining)
                req = json.dumps({"command": ["get_property", prop], "request_id": idx}) + "\n"
                sock.sendall(req.encode("utf-8"))
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        errors[prop] = "timeout"
                        break
                    sock.settimeout(remaining)
                    line = reader.readline()
                    if not line:
                        errors[prop] = "eof"
                        break
                    try:
                        msg = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if msg.get("request_id") == idx:
                        if msg.get("error") == "success":
                            values[prop] = msg.get("data")
                        else:
                            errors[prop] = str(msg.get("error", "unknown_error"))
                        break
    return {"values": values, "errors": errors}


def probe_mpv_ipc(
    action: str = "list",
    socket_path: str | None = None,
    property_name: str | None = None,
) -> dict[str, Any]:
    if action not in {"list", "get_property", "snapshot"}:
        return {"ok": False, "error": f"Invalid action '{action}'. Allowed: ['get_property', 'list', 'snapshot']"}

    if action == "list":
        return _list_ipc_sockets()

    if action == "get_property":
        if not property_name or not SAFE_PROP_RE.match(property_name):
            return {"ok": False, "error": "Invalid or missing property_name"}
        validated, err = _validate_ipc_socket_path(socket_path)
        if err or not validated:
            return {"ok": False, "error": err}
        try:
            res = _query_mpv_properties(validated, [property_name], timeout=1.5)
            ok = property_name in res["values"]
            return {
                "ok": ok,
                "action": "get_property",
                "socket_path": validated,
                "property": property_name,
                **({"value": res["values"][property_name]} if ok else {"error": res["errors"].get(property_name)}),
            }
        except OSError as exc:
            return {"ok": False, "action": "get_property", "socket_path": validated, "error": str(exc)}

    # snapshot
    target_sock = socket_path
    if not target_sock:
        listed = _list_ipc_sockets()
        live = [s["socket_path"] for s in listed.get("sockets", []) if not s.get("stale")]
        if len(live) != 1:
            return {
                "ok": False,
                "action": "snapshot",
                "error": f"Expected 1 live socket for auto-select, found {len(live)}",
                "live_sockets": live,
            }
        target_sock = live[0]

    validated, err = _validate_ipc_socket_path(target_sock)
    if err or not validated:
        return {"ok": False, "action": "snapshot", "error": err}
    try:
        res = _query_mpv_properties(validated, list(SNAPSHOT_PROPS), timeout=2.0)
        return {
            "ok": bool(res["values"]),
            "action": "snapshot",
            "socket_path": validated,
            "properties": res["values"],
            **({"errors": res["errors"]} if res["errors"] else {}),
        }
    except OSError as exc:
        return {"ok": False, "action": "snapshot", "socket_path": validated, "error": str(exc)}


# ---------------------------------------------------------------------------
# 3 (Unified). inspect_runtime
# ---------------------------------------------------------------------------


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
) -> dict[str, Any]:
    if target == "logs":
        res = tail_logs(log=log, lines=lines, grep=grep, level=level)
    elif target == "state":
        res = inspect_runtime_state(sections=sections, include_urls_for_folder=include_urls_for_folder)
    elif target == "registration":
        res = check_native_host_registration()
    elif target == "ipc":
        res = probe_mpv_ipc(action=ipc_action, socket_path=socket_path, property_name=property_name)
    else:
        return {
            "ok": False,
            "error": f"Invalid target '{target}'. Allowed: ['ipc', 'logs', 'registration', 'state']",
        }
    return {"target": target, **res}


# ---------------------------------------------------------------------------
# 4. simulate_native_message
# ---------------------------------------------------------------------------


def _mask_sim_text(text: str, sim_data_dir: str, sim_tmp_dir: str) -> str:
    masked = _mask_text(text, data_dir=sim_data_dir)
    if sim_tmp_dir:
        masked = masked.replace(sim_tmp_dir, "<SIM_TMP_DIR>")
    return strip_ansi(masked)


def _replace_str_in_obj(obj: Any, old: str, new: str) -> Any:
    if isinstance(obj, str):
        return obj.replace(old, new)
    if isinstance(obj, dict):
        return {k: _replace_str_in_obj(v, old, new) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_replace_str_in_obj(item, old, new) for item in obj]
    return obj


def _redact_sim_obj(obj: Any, sim_data_dir: str, sim_tmp_dir: str) -> Any:
    redacted = _redact_obj(obj, data_dir=sim_data_dir)
    if sim_tmp_dir:
        return _replace_str_in_obj(redacted, sim_tmp_dir, "<SIM_TMP_DIR>")
    return redacted


def simulate_native_message(
    payload: dict[str, Any] | list[dict[str, Any]] | str,
    seed_state: dict[str, Any] | str | None = None,
    timeout: float = 5.0,
) -> dict[str, Any]:
    parsed = payload
    if isinstance(payload, str):
        try:
            parsed = json.loads(payload)
        except json.JSONDecodeError as exc:
            return {"ok": False, "error": f"Invalid JSON payload: {exc}"}

    parsed_seed: dict[str, Any] | None = None
    if isinstance(seed_state, str):
        stripped_seed = seed_state.strip()
        if stripped_seed:
            try:
                loaded_seed = json.loads(stripped_seed)
            except json.JSONDecodeError as exc:
                return {"ok": False, "error": f"Invalid JSON seed_state: {exc}"}
            if not isinstance(loaded_seed, dict):
                return {"ok": False, "error": "seed_state must be a JSON object when provided"}
            parsed_seed = loaded_seed
    elif seed_state is not None:
        if not isinstance(seed_state, dict):
            return {"ok": False, "error": "seed_state must be a JSON object when provided"}
        parsed_seed = seed_state

    if isinstance(parsed, dict):
        payloads = [parsed]
    elif isinstance(parsed, list) and parsed and all(isinstance(p, dict) for p in parsed):
        payloads = parsed
    else:
        return {"ok": False, "error": "payload must be a JSON object or non-empty list of JSON objects"}

    if len(payloads) > 20:
        return {"ok": False, "error": "Maximum 20 messages per simulation call"}

    _ensure_repo_on_path()
    from testing_tools import native_host_harness

    try:
        sim_res = native_host_harness.run_native_message_session(
            payloads=payloads,
            seed_state=parsed_seed,
            timeout=timeout,
            project_root=REPO_ROOT,
        )
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}

    frames = sim_res["frames"]
    frames_truncated = len(frames) > 50
    redacted_frames = [
        _redact_sim_obj(frame, sim_res["data_dir"], sim_res["tmp_dir"])
        for frame in frames[:50]
    ]

    masked_stderr = _mask_sim_text(sim_res["stderr_raw"], sim_res["data_dir"], sim_res["tmp_dir"])
    stderr_lines, stderr_truncated, _total_err = _trim_lines(masked_stderr, limit=40)

    return {
        "ok": sim_res["exit_code"] == 0 and not sim_res["timed_out"],
        "exit_code": sim_res["exit_code"],
        "timed_out": sim_res["timed_out"],
        "frames_count": len(frames),
        "frames": redacted_frames,
        "frames_truncated": frames_truncated,
        "stderr": stderr_lines,
        "stderr_truncated": stderr_truncated,
    }


# ---------------------------------------------------------------------------
# 10. test_mpv_pipeline
# ---------------------------------------------------------------------------

_LUA_ERR_RE = re.compile(r"(?:lua error|error loading|stack traceback|syntax error)", re.IGNORECASE)

_DRY_RUN_SUBPROCESS_SCRIPT = r"""
import contextlib, io, json, os, sys

payload = json.loads(sys.stdin.read())
repo_root = payload["repo_root"]
tmp_dir = payload["tmp_dir"]
items = payload["items"]
options = payload["options"]

sys.path.insert(0, repo_root)
try:
    with contextlib.redirect_stdout(io.StringIO()):
        import file_io
        import services
        from utils import session_ipc_ops

        tmp_data_dir = os.path.join(tmp_dir, "data")
        tmp_flag_dir = os.path.join(tmp_data_dir, "flags")
        os.makedirs(tmp_flag_dir, exist_ok=True)

        file_io.TEMP_DIR = tmp_dir
        file_io.initialize_paths(tmp_data_dir)

        m3u_content = session_ipc_ops.generate_m3u_content(items)
        first = items[0]
        cmd_urls = [it["url"] for it in items]
        use_ipc = bool(options.get("with_ipc", True))
        load_scripts = bool(options.get("load_scripts", True))
        ipc_path = os.path.join(tmp_dir, "mpv-dryrun.sock") if use_ipc else None

        argv, has_terminal = services.construct_mpv_command(
            mpv_exe=str(options.get("mpv_exe") or "mpv"),
            ipc_path=ipc_path,
            url=cmd_urls if len(cmd_urls) > 1 else cmd_urls[0],
            is_youtube=bool(options.get("is_youtube", False)),
            ytdl_raw_options=options.get("ytdl_raw_options"),
            geometry=options.get("geometry"),
            custom_width=options.get("custom_width"),
            custom_height=options.get("custom_height"),
            custom_mpv_flags=options.get("custom_mpv_flags"),
            automatic_mpv_flags=options.get("automatic_mpv_flags"),
            headers=options.get("headers"),
            disable_http_persistent=bool(options.get("disable_http_persistent", False)),
            start_paused=bool(options.get("start_paused", False)),
            script_dir=repo_root if load_scripts else None,
            load_on_completion_script=load_scripts,
            title=options.get("title") or first.get("title"),
            use_ytdl_mpv=bool(options.get("use_ytdl_mpv", False)),
            is_youtube_override=bool(options.get("is_youtube_override", False)),
            idle=bool(options.get("idle", False)),
            force_terminal=bool(options.get("force_terminal", False)),
            settings=options.get("settings") if isinstance(options.get("settings"), dict) else None,
            flag_dir=tmp_flag_dir if load_scripts else None,
            playlist_start_index=options.get("playlist_start_index"),
            cookies_browser=options.get("cookies_browser"),
            cookies_file=options.get("cookies_file"),
            start_time=options.get("start_time"),
        )
    sys.stdout.write(json.dumps({
        "ok": True,
        "has_terminal_flag": bool(has_terminal),
        "argv": [str(a) for a in argv],
        "m3u_content": m3u_content,
    }))
except Exception as exc:
    sys.stdout.write(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}))
"""


def _normalize_dry_run_urls(urls: list[Any] | None) -> tuple[list[dict[str, Any]] | None, str | None]:
    if urls is None:
        return [
            {"id": "dryrun-1", "title": "Sample Stream", "url": "https://example.com/sample.mp4"}
        ], None
    if not isinstance(urls, list) or not urls:
        return None, "urls must be a non-empty list when provided"
    if len(urls) > 50:
        return None, "Maximum 50 URLs supported in dry_run"

    items: list[dict[str, Any]] = []
    for idx, entry in enumerate(urls, start=1):
        if isinstance(entry, str):
            stripped = entry.strip()
            if stripped.startswith("{"):
                try:
                    parsed_entry = json.loads(stripped)
                except json.JSONDecodeError as exc:
                    return None, f"Invalid JSON url entry at index {idx - 1}: {exc}"
                if isinstance(parsed_entry, dict) and isinstance(parsed_entry.get("url"), str):
                    item = dict(parsed_entry)
                    item.setdefault("title", item["url"])
                    items.append(item)
                else:
                    return None, f"Invalid url entry at index {idx - 1}: expected string or object with 'url'"
            else:
                items.append({"id": f"dryrun-{idx}", "title": f"Item {idx}", "url": entry})
        elif isinstance(entry, dict) and isinstance(entry.get("url"), str):
            item = dict(entry)
            item.setdefault("title", item["url"])
            items.append(item)
        else:
            return None, f"Invalid url entry at index {idx - 1}: expected string or object with 'url'"
    return items, None


def _run_mpv_dry_run(urls: list[Any] | None, options: dict[str, Any]) -> dict[str, Any]:
    items, err = _normalize_dry_run_urls(urls)
    if err or items is None:
        return {"ok": False, "mode": "dry_run", "error": err}

    with tempfile.TemporaryDirectory(prefix="mpv_dryrun_") as tmp_dir:
        tmp_data_dir = os.path.join(tmp_dir, "data")
        try:
            req_json = json.dumps(
                {
                    "repo_root": REPO_ROOT,
                    "tmp_dir": tmp_dir,
                    "items": items,
                    "options": options,
                }
            )
        except (TypeError, ValueError) as exc:
            return {"ok": False, "mode": "dry_run", "error": f"Invalid options: {exc}"}

        try:
            proc = subprocess.run(
                [_python_bin(), "-B", "-c", _DRY_RUN_SUBPROCESS_SCRIPT],
                input=req_json,
                cwd=REPO_ROOT,
                env=_repo_env(),
                capture_output=True,
                text=True,
                timeout=15,
            )
        except subprocess.TimeoutExpired:
            return {"ok": False, "mode": "dry_run", "error": "Dry-run builder subprocess timed out"}
        except OSError as exc:
            return {"ok": False, "mode": "dry_run", "error": f"Failed to launch dry-run subprocess: {exc}"}

        if proc.returncode != 0:
            err_msg = strip_ansi(proc.stderr or proc.stdout).strip() or f"exit code {proc.returncode}"
            return {"ok": False, "mode": "dry_run", "error": f"Dry-run subprocess failed: {err_msg}"}

        try:
            sub_res = json.loads(proc.stdout)
        except json.JSONDecodeError as exc:
            return {"ok": False, "mode": "dry_run", "error": f"Invalid dry-run subprocess output: {exc}"}

        if not sub_res.get("ok"):
            return {"ok": False, "mode": "dry_run", "error": str(sub_res.get("error") or "Dry-run builder error")}

        argv = sub_res["argv"]
        has_terminal = sub_res["has_terminal_flag"]
        m3u_content = sub_res["m3u_content"]

        masked_argv = [
            _mask_text(str(arg), data_dir=tmp_data_dir).replace(tmp_dir, "<DRYRUN_TMP>")
            for arg in argv
        ]
        masked_m3u_raw = _mask_text(m3u_content, data_dir=tmp_data_dir).replace(tmp_dir, "<DRYRUN_TMP>")
        m3u_lines = masked_m3u_raw.splitlines()
        m3u_truncated = len(m3u_lines) > 200
        masked_m3u = "\n".join(m3u_lines[:200])

        return {
            "ok": True,
            "mode": "dry_run",
            "items_count": len(items),
            "has_terminal_flag": bool(has_terminal),
            "argv": masked_argv,
            "m3u_content": masked_m3u,
            "m3u_truncated": m3u_truncated,
        }


def _run_mpv_headless(options: dict[str, Any]) -> dict[str, Any]:
    raw_timeout = options.get("timeout", 4.0)
    if isinstance(raw_timeout, bool):
        return {"ok": False, "mode": "headless", "error": f"Invalid timeout {raw_timeout!r}: must be a number"}
    try:
        timeout_val = float(raw_timeout)
    except (TypeError, ValueError):
        return {"ok": False, "mode": "headless", "error": f"Invalid timeout {raw_timeout!r}: must be a number"}
    if not math.isfinite(timeout_val):
        return {"ok": False, "mode": "headless", "error": f"Invalid timeout {raw_timeout!r}: must be finite"}
    timeout = max(1.0, min(timeout_val, 5.0))

    mpv_bin = shutil.which("mpv")
    if not mpv_bin:
        return {"ok": False, "mode": "headless", "error": "mpv binary not found in PATH"}
    lua_dir = os.path.join(REPO_ROOT, "mpv_scripts")
    lua_files = (
        sorted(os.path.join(lua_dir, f) for f in os.listdir(lua_dir) if f.endswith(".lua"))
        if os.path.isdir(lua_dir)
        else []
    )

    with tempfile.TemporaryDirectory(prefix="mpv_headless_") as tmp_dir:
        sock_path = os.path.join(tmp_dir, "mpv-headless.sock")
        flag_dir = os.path.join(tmp_dir, "flags")
        xdg_data = os.path.join(tmp_dir, "xdg_data")
        os.makedirs(flag_dir, exist_ok=True)
        os.makedirs(xdg_data, exist_ok=True)

        env = _repo_env()
        env["XDG_DATA_HOME"] = xdg_data
        env["HOME"] = tmp_dir
        env["XDG_RUNTIME_DIR"] = tmp_dir

        cmd = [
            mpv_bin,
            "--no-config",
            "--idle=yes",
            "--vo=null",
            "--ao=null",
            "--no-terminal",
            "--msg-level=all=warn,cplayer=status,script=info",
            f"--input-ipc-server={sock_path}",
            f"--script-opts=on_completion-flag_dir={flag_dir}",
            *[f"--script={p}" for p in lua_files],
        ]

        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
            cwd=REPO_ROOT,
            start_new_session=True,
        )

        ipc_connected = False
        pid_verified = False
        props: dict[str, Any] = {}
        ipc_errors: dict[str, str] = {}
        exit_code: int | None = None
        stdout_txt = ""
        stderr_txt = ""

        try:
            sock_deadline = time.monotonic() + min(2.5, timeout)
            while time.monotonic() < sock_deadline:
                if proc.poll() is not None:
                    break
                if os.path.exists(sock_path):
                    try:
                        if stat.S_ISSOCK(os.stat(sock_path).st_mode):
                            ipc_connected = True
                            break
                    except OSError as exc:
                        logger.debug("headless socket stat retry: %s", exc)
                time.sleep(0.05)

            if ipc_connected:
                try:
                    ipc_res = _query_mpv_properties(
                        sock_path,
                        ["mpv-version", "idle-active", "pid", "playlist-count", "pause"],
                        timeout=1.5,
                    )
                    props = ipc_res["values"]
                    ipc_errors = ipc_res["errors"]
                    pid_verified = props.get("pid") == proc.pid
                except OSError as exc:
                    ipc_errors["query"] = str(exc)

                try:
                    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
                        sock.settimeout(1.0)
                        sock.connect(sock_path)
                        sock.sendall(b'{"command":["quit"],"request_id":99}\n')
                except OSError as exc:
                    logger.debug("headless mpv quit IPC send: %s", exc)

            try:
                stdout_txt, stderr_txt = proc.communicate(timeout=1.5)
                exit_code = proc.returncode
            except subprocess.TimeoutExpired:
                proc.terminate()
                try:
                    stdout_txt, stderr_txt = proc.communicate(timeout=1.0)
                    exit_code = proc.returncode
                except subprocess.TimeoutExpired:
                    proc.kill()
                    stdout_txt, stderr_txt = proc.communicate(timeout=1.0)
                    exit_code = proc.returncode
        finally:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=1.0)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=1.0)
            for stream in (proc.stdout, proc.stderr):
                if stream and not stream.closed:
                    try:
                        stream.close()
                    except OSError as exc:
                        logger.debug("Error closing headless mpv stream: %s", exc)
            if os.path.exists(sock_path):
                try:
                    os.remove(sock_path)
                except OSError as exc:
                    logger.debug("Error removing headless socket: %s", exc)

        combined = strip_ansi(f"{stdout_txt}\n{stderr_txt}")
        masked_combined = _mask_text(combined, data_dir=xdg_data).replace(tmp_dir, "<HEADLESS_TMP>")
        lua_errors = [ln.strip() for ln in masked_combined.splitlines() if _LUA_ERR_RE.search(ln)]
        tail_lines, truncated, _total = _trim_lines(masked_combined, limit=40)

        ok = ipc_connected and pid_verified and not lua_errors
        return {
            "ok": ok,
            "mode": "headless",
            "ipc_connected": ipc_connected,
            "pid_verified": pid_verified,
            "scripts_loaded": [os.path.basename(p) for p in lua_files],
            "lua_errors": lua_errors[:20],
            "properties": props,
            **({"ipc_errors": ipc_errors} if ipc_errors else {}),
            "exit_code": exit_code,
            "output_tail": tail_lines,
            "truncated": truncated,
        }


def test_mpv_pipeline(
    mode: str = "dry_run",
    urls: list[Any] | None = None,
    options: dict[str, Any] | str | None = None,
) -> dict[str, Any]:
    if mode not in {"dry_run", "headless"}:
        return {"ok": False, "error": f"Invalid mode '{mode}'. Allowed: ['dry_run', 'headless']"}
    parsed_opts: dict[str, Any] = {}
    if isinstance(options, str):
        stripped_opts = options.strip()
        if stripped_opts:
            try:
                loaded_opts = json.loads(stripped_opts)
            except json.JSONDecodeError as exc:
                return {"ok": False, "mode": mode, "error": f"Invalid JSON options: {exc}"}
            if not isinstance(loaded_opts, dict):
                return {"ok": False, "mode": mode, "error": "options must be a JSON object when provided"}
            parsed_opts = loaded_opts
    elif options is not None:
        if not isinstance(options, dict):
            return {"ok": False, "error": "options must be a JSON object when provided"}
        parsed_opts = options

    if mode == "dry_run":
        return _run_mpv_dry_run(urls=urls, options=parsed_opts)
    return _run_mpv_headless(options=parsed_opts)
