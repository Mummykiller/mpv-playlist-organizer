import ast
import io
import json
import os
import sys
import unittest
import subprocess
import time
import re
import shutil
from concurrent.futures import ThreadPoolExecutor

os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
sys.dont_write_bytecode = True

# ANSI Color Codes
GREEN = "\033[92m"
RED = "\033[91m"
YELLOW = "\033[93m"
BLUE = "\033[94m"
MAGENTA = "\033[95m"
CYAN = "\033[96m"
BOLD = "\033[1m"
RESET = "\033[0m"

TESTING_TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(TESTING_TOOLS_DIR)
sys.path.insert(0, TESTING_TOOLS_DIR)


class ConciseTestResult(unittest.TestResult):
    """Quiet on success, immediately verbose on any failure or error."""
    def __init__(self, verbose=False):
        super().__init__()
        self.verbose = verbose
        self.passed = 0
        self._stdout_buffer = io.StringIO()
        self._stderr_buffer = io.StringIO()
        self._orig_stdout = None
        self._orig_stderr = None

    def startTest(self, test):
        super().startTest(test)
        if not self.verbose:
            self._orig_stdout = sys.stdout
            self._orig_stderr = sys.stderr
            self._stdout_buffer = io.StringIO()
            self._stderr_buffer = io.StringIO()
            sys.stdout = self._stdout_buffer
            sys.stderr = self._stderr_buffer

    def _restore_streams(self):
        if self._orig_stdout is not None:
            sys.stdout = self._orig_stdout
            sys.stderr = self._orig_stderr
            self._orig_stdout = None
            self._orig_stderr = None

    def stopTest(self, test):
        self._restore_streams()
        super().stopTest(test)

    def addSuccess(self, test):
        self._restore_streams()
        super().addSuccess(test)
        self.passed += 1
        if self.verbose:
            doc = test.shortDescription()
            desc = f" - {doc}" if doc else ""
            method_name = getattr(test, '_testMethodName', str(test))
            class_name = test.__class__.__name__
            print(f"    {GREEN}✅ {class_name}.{method_name}{RESET}{desc}")

    def _dump_captured(self):
        out = self._stdout_buffer.getvalue().strip()
        err = self._stderr_buffer.getvalue().strip()
        if out:
            print(f"    --- Captured stdout ---\n{out}")
        if err:
            print(f"    --- Captured stderr ---\n{err}")

    def addFailure(self, test, err):
        self._restore_streams()
        super().addFailure(test, err)
        print(f"\n{RED}{BOLD}  ❌ FAIL: {test}{RESET}")
        self._dump_captured()
        print(f"{RED}{self.failures[-1][1]}{RESET}")

    def addError(self, test, err):
        self._restore_streams()
        super().addError(test, err)
        print(f"\n{YELLOW}{BOLD}  ⚠️  ERROR: {test}{RESET}")
        self._dump_captured()
        print(f"{YELLOW}{self.errors[-1][1]}{RESET}")


def run_python_batch(name, pattern, verbose=False):
    """Runs a subset of Python tests quietly on success, showing immediate tracebacks on failure."""
    t0 = time.time()
    loader = unittest.TestLoader()
    start_dir = os.path.join(TESTING_TOOLS_DIR, 'scripts')

    if isinstance(pattern, list):
        suite = unittest.TestSuite()
        for p in pattern:
            suite.addTests(loader.discover(start_dir, pattern=p))
    else:
        suite = loader.discover(start_dir, pattern=pattern)

    total = suite.countTestCases()
    if total == 0:
        print(f"  {YELLOW}⚠️  {name}: 0 tests found{RESET}")
        return True, 0, 0

    result = ConciseTestResult(verbose=verbose)
    suite.run(result)
    elapsed = time.time() - t0

    if result.wasSuccessful():
        if verbose:
            print(f"  {GREEN}✅ {name}: {result.passed}/{total} passed ({elapsed:.1f}s){RESET}")
        return True, result.passed, total
    else:
        failed = len(result.failures) + len(result.errors)
        print(f"\n  {RED}{BOLD}❌ {name}: {result.passed}/{total} passed, {failed} failed ({elapsed:.1f}s){RESET}")
        return False, result.passed, total


def run_js_batch(verbose=False):
    """Runs contract sync, JS unit tests, JS syntax checks, and Python static checks."""
    all_success = True
    total_passed = 0
    total_checks = 0

    # 0. Sync the Communication Contract
    try:
        subprocess.run(
            [sys.executable, os.path.join(TESTING_TOOLS_DIR, "generate_bridge_contract.py")],
            check=True,
            capture_output=True,
            text=True,
        )
    except subprocess.CalledProcessError as e:
        print(f"  {RED}{BOLD}❌ Contract Sync FAILED:{RESET}\n{RED}{e.stderr or e.stdout}{RESET}")
        return False, 0, 1, 0, 0, 0, 0

    # Check if node is installed
    try:
        subprocess.run(["node", "--version"], capture_output=True, check=True)
    except (subprocess.CalledProcessError, FileNotFoundError):
        print(f"  {YELLOW}⚠️  Skipping JS tests: Node.js is not installed.{RESET}")
        return True, 0, 0, 0, 0, 0, 0

    # 1. JS Unit Tests (parallel)
    scripts_dir = os.path.join(TESTING_TOOLS_DIR, 'scripts')
    js_tests = sorted(f for f in os.listdir(scripts_dir) if f.startswith("test_") and f.endswith(".js"))
    js_passed = 0

    def _run_one_js_test(test_file):
        js_test_path = os.path.join(scripts_dir, test_file)
        return test_file, subprocess.run(["node", js_test_path], capture_output=True, text=True)

    max_js_workers = min(len(js_tests), os.cpu_count() or 4) if js_tests else 1
    with ThreadPoolExecutor(max_workers=max_js_workers) as pool:
        js_results = list(pool.map(_run_one_js_test, js_tests))

    for test_file, result in js_results:
        if result.returncode == 0:
            js_passed += 1
            if verbose:
                print(f"    {GREEN}✅ {test_file}{RESET}")
                if result.stdout.strip():
                    for line in result.stdout.strip().splitlines():
                        if line.strip():
                            print(f"       {CYAN}•{RESET} {line.strip()}")
        else:
            print(f"\n  {RED}{BOLD}❌ JS Test FAILED: {test_file}{RESET}")
            if result.stdout:
                print(f"{RED}{result.stdout.strip()}{RESET}")
            if result.stderr:
                print(f"{RED}{result.stderr.strip()}{RESET}")
            all_success = False

    if js_passed != len(js_tests) or verbose:
        status_icon = f"{GREEN}✅" if js_passed == len(js_tests) else f"{RED}{BOLD}❌"
        print(f"  {status_icon} JS Unit Tests: {js_passed}/{len(js_tests)} passed{RESET}")
    total_passed += js_passed
    total_checks += len(js_tests)

    # 2. All JS & Module JS Syntax and Empty Catch Block Check (parallel)
    js_files = []
    for root_dir, dirs, files in os.walk(PROJECT_ROOT):
        dirs[:] = [d for d in dirs if d not in {'.git', '__pycache__', 'node_modules'}]
        for f in sorted(files):
            if f.endswith('.js'):
                js_files.append(os.path.join(root_dir, f))

    syntax_ok = 0
    js_empty_catch_regex = re.compile(
        r'catch\s*(?:\([^)]*\))?\s*\{(?:\s|//[^\n]*|/\*[\s\S]*?\*/)*\}'
    )

    def _check_one_js_file(js_file):
        rel_name = os.path.relpath(js_file, PROJECT_ROOT)
        check = subprocess.run(["node", "--check", js_file], capture_output=True, text=True)
        empty_catches = []
        read_err = None
        try:
            with open(js_file, "r", encoding="utf-8") as fh:
                js_content = fh.read()
            empty_catches = [
                js_content.count('\n', 0, m.start()) + 1
                for m in js_empty_catch_regex.finditer(js_content)
            ]
        except Exception as e:
            read_err = str(e)
        return rel_name, check, empty_catches, read_err

    max_syntax_workers = min(len(js_files), max(4, os.cpu_count() or 4)) if js_files else 1
    with ThreadPoolExecutor(max_workers=max_syntax_workers) as pool:
        syntax_results = list(pool.map(_check_one_js_file, js_files))

    for rel_name, check, empty_catches, read_err in syntax_results:
        if check.returncode == 0:
            syntax_ok += 1
        else:
            print(f"\n  {RED}{BOLD}❌ JS SYNTAX ERROR in {rel_name}:{RESET}")
            print(f"{RED}{check.stderr.strip()}{RESET}")
            all_success = False

        if read_err is not None:
            print(f"\n  {RED}{BOLD}❌ Could not read {rel_name}: {read_err}{RESET}")
            all_success = False
        elif empty_catches:
            print(f"\n  {RED}{BOLD}❌ JS AST Gate: Silent empty/comment-only catch block found in {rel_name} at line(s) {empty_catches}{RESET}")
            all_success = False

    if syntax_ok != len(js_files) or verbose:
        status_icon = f"{GREEN}✅" if syntax_ok == len(js_files) else f"{RED}{BOLD}❌"
        print(f"  {status_icon} JS Syntax & AST Gate: {syntax_ok}/{len(js_files)} files OK{RESET}")

    # 3. Python Static Analysis (Hardened AST Syntax + Bare Except + Silent Pass Check)
    py_files = []
    for root_dir, dirs, files in os.walk(PROJECT_ROOT):
        dirs[:] = [d for d in dirs if d not in {'.git', '__pycache__', 'node_modules'}]
        for f in sorted(files):
            if f.endswith('.py'):
                py_files.append(os.path.join(root_dir, f))

    def _is_silent_pass(handler_node):
        has_raise = any(isinstance(n, ast.Raise) for n in ast.walk(handler_node))
        has_call = any(isinstance(n, ast.Call) for n in ast.walk(handler_node))
        if has_raise or has_call:
            return False
        for stmt in handler_node.body:
            if isinstance(stmt, ast.Pass):
                continue
            if isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Constant):
                continue
            return False
        return True

    py_ok = 0
    for py_file in py_files:
        rel_name = os.path.relpath(py_file, PROJECT_ROOT)
        try:
            with open(py_file, "r", encoding="utf-8") as fh:
                source = fh.read()
            tree = ast.parse(source, filename=rel_name)
            ast_errors = []
            for node in ast.walk(tree):
                if isinstance(node, ast.ExceptHandler):
                    if node.type is None:
                        ast_errors.append(f"Bare 'except:' found at line {node.lineno}")
                    elif _is_silent_pass(node):
                        exc_type = ast.unparse(node.type) if hasattr(ast, "unparse") else "Exception"
                        ast_errors.append(f"Silent 'except {exc_type}: pass' without logging/raise at line {node.lineno}")

            if ast_errors:
                for err in ast_errors:
                    print(f"\n  {RED}{BOLD}❌ Python AST Gate: {err} in {rel_name}{RESET}")
                all_success = False
            else:
                py_ok += 1
        except SyntaxError as e:
            print(f"\n  {RED}{BOLD}❌ PYTHON SYNTAX ERROR in {rel_name}:{e.lineno}: {e.msg}{RESET}")
            all_success = False

    if py_ok != len(py_files) or verbose:
        status_icon = f"{GREEN}✅" if py_ok == len(py_files) else f"{RED}{BOLD}❌"
        print(f"  {status_icon} Python AST Gate: {py_ok}/{len(py_files)} files OK{RESET}")

    # 4. Non-Interactive Static Linters (Executed without prompting when available)
    ruff_bin = shutil.which("ruff")
    if ruff_bin:
        ruff_cmd = [ruff_bin, "check", "--no-fix"]
        ruff_cfg = os.path.join(TESTING_TOOLS_DIR, "pyproject.toml")
        if os.path.isfile(ruff_cfg):
            ruff_cmd.extend(["--config", ruff_cfg])
        ruff_cmd.append(".")
        ruff_res = subprocess.run(
            ruff_cmd,
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
        )
        if ruff_res.returncode == 0:
            if verbose:
                print(f"  {GREEN}✅ Ruff Linter: Clean{RESET}")
        else:
            print(f"\n  {RED}{BOLD}❌ Ruff Linter violations detected:{RESET}")
            if ruff_res.stdout:
                print(f"{RED}{ruff_res.stdout.strip()}{RESET}")
            if ruff_res.stderr:
                print(f"{RED}{ruff_res.stderr.strip()}{RESET}")
            all_success = False
    elif verbose:
        print(f"  {CYAN}ℹ️  Ruff linter not installed (skipping).{RESET}")

    biome_bin = shutil.which("biome")
    if not biome_bin:
        for candidate_root in (PROJECT_ROOT, TESTING_TOOLS_DIR):
            candidate = os.path.join(candidate_root, "node_modules", ".bin", "biome")
            if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
                biome_bin = candidate
                break
    biome_cmd = None
    if biome_bin:
        biome_cmd = [biome_bin, "check"]
        biome_cfg = os.path.join(TESTING_TOOLS_DIR, "biome.json")
        if os.path.isfile(biome_cfg):
            biome_cmd.extend(["--config-path", biome_cfg])
        biome_cmd.append(".")

    if biome_cmd:
        biome_res = subprocess.run(
            biome_cmd,
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
        )
        if biome_res.returncode == 0:
            if verbose:
                print(f"  {GREEN}✅ Biome Linter: Clean{RESET}")
        else:
            print(f"\n  {RED}{BOLD}❌ Biome Linter violations detected:{RESET}")
            if biome_res.stdout:
                print(f"{RED}{biome_res.stdout.strip()}{RESET}")
            if biome_res.stderr:
                print(f"{RED}{biome_res.stderr.strip()}{RESET}")
            all_success = False
    elif verbose:
        print(f"  {CYAN}ℹ️  Biome linter not installed (skipping).{RESET}")

    # 5. Lua Syntax Check (mpv_scripts/*.lua via luac -p when available)
    luac_bin = shutil.which("luac")
    lua_dir = os.path.join(PROJECT_ROOT, "mpv_scripts")
    lua_files = sorted(
        os.path.join(lua_dir, f)
        for f in os.listdir(lua_dir)
        if f.endswith(".lua")
    ) if os.path.isdir(lua_dir) else []
    if luac_bin and lua_files:
        lua_ok = 0
        for lua_file in lua_files:
            rel_lua = os.path.relpath(lua_file, PROJECT_ROOT)
            lua_res = subprocess.run(
                [luac_bin, "-p", lua_file],
                cwd=PROJECT_ROOT,
                capture_output=True,
                text=True,
            )
            if lua_res.returncode == 0:
                lua_ok += 1
            else:
                print(f"\n  {RED}{BOLD}❌ Lua Syntax Error in {rel_lua}:{RESET}")
                if lua_res.stdout:
                    print(f"{RED}{lua_res.stdout.strip()}{RESET}")
                if lua_res.stderr:
                    print(f"{RED}{lua_res.stderr.strip()}{RESET}")
                all_success = False
        if lua_ok != len(lua_files) or verbose:
            status_icon = f"{GREEN}✅" if lua_ok == len(lua_files) else f"{RED}{BOLD}❌"
            print(f"  {status_icon} Lua Syntax Check (luac -p): {lua_ok}/{len(lua_files)} files OK{RESET}")
    elif verbose and not luac_bin:
        print(f"  {CYAN}ℹ️  luac not installed (skipping Lua syntax check).{RESET}")

    return all_success, total_passed, total_checks, syntax_ok, len(js_files), py_ok, len(py_files)


PYTHON_TEST_FILES = [
    "test_logging_system.py",
    "test_robustness.py",
    "test_repro_crash.py",
    "test_native_host_boot.py",
    "test_security_claims.py",
    "test_storage_locking.py",
    "test_playback_ipc_concurrency.py",
    "test_server_and_installer.py",
    "test_logging_pipeline.py",
]

_WORKER_RESULT_PREFIX = "__WORKER_RESULT__:"


def _run_python_worker(test_file, verbose=False):
    """Runs a single Python test module in an isolated subprocess for parallel execution."""
    rel_suite = os.path.relpath(os.path.abspath(__file__), PROJECT_ROOT)
    cmd = [sys.executable, rel_suite, "--worker", test_file]
    if verbose:
        cmd.append("--verbose")
    proc = subprocess.run(cmd, cwd=PROJECT_ROOT, capture_output=True, text=True)

    ok = proc.returncode == 0
    passed = 0
    total = 0
    output_lines = []
    for line in proc.stdout.splitlines():
        if line.startswith(_WORKER_RESULT_PREFIX):
            try:
                payload = json.loads(line[len(_WORKER_RESULT_PREFIX):])
                ok = ok and bool(payload.get("ok", False))
                passed = int(payload.get("passed", 0))
                total = int(payload.get("total", 0))
            except (ValueError, TypeError) as e:
                output_lines.append(f"Worker result parse error for {test_file}: {e}")
                ok = False
        else:
            output_lines.append(line)

    return test_file, ok, passed, total, "\n".join(output_lines).strip(), proc.stderr.strip()


def run_all_tests(verbose=False):
    """Main entry point running all test batches concurrently."""
    t_start = time.time()

    max_py_workers = min(len(PYTHON_TEST_FILES), os.cpu_count() or 4)
    with ThreadPoolExecutor(max_workers=max_py_workers) as pool:
        py_futures = [pool.submit(_run_python_worker, tf, verbose) for tf in PYTHON_TEST_FILES]

        # Run JS tests, syntax checks, AST gates, and linters concurrently with Python workers
        b2_ok, b2_pass, b2_total, syntax_ok, js_total_files, py_ok, py_total_files = run_js_batch(verbose=verbose)

        py_results = [f.result() for f in py_futures]

    py_all_ok = True
    py_pass = 0
    py_total = 0
    for test_file, ok, passed, total, stdout_text, stderr_text in py_results:
        py_pass += passed
        py_total += total
        if not ok:
            py_all_ok = False
        if stdout_text and (verbose or not ok):
            print(stdout_text)
        if stderr_text and not ok:
            print(stderr_text, file=sys.stderr)

    total_pass = py_pass + b2_pass
    total_tests = py_total + b2_total
    elapsed = time.time() - t_start
    all_ok = py_all_ok and b2_ok

    if all_ok:
        print(f"{GREEN}{BOLD}✨ Ran all tests and all passed ({total_pass}/{total_tests} tests, {syntax_ok} JS syntax OK, {py_ok} Python static OK) in {elapsed:.1f}s{RESET}")
    else:
        print(f"\n{RED}{BOLD}🛑 Suite failed ({total_pass}/{total_tests} tests passed) in {elapsed:.1f}s{RESET}")

    return all_ok


def start_watch_mode():
    """Monitors files and re-runs tests on change."""
    try:
        from watchdog.observers import Observer
        from watchdog.events import FileSystemEventHandler
    except ImportError:
        print(f"{RED}❌ Error: 'watchdog' package required for watch mode.{RESET}")
        print("   Install it with: pip install watchdog")
        return

    class TestWatchHandler(FileSystemEventHandler):
        def __init__(self):
            self.last_run = 0
            self.cooldown = 2

        def on_modified(self, event):
            if event.is_directory:
                return
            if not any(event.src_path.endswith(ext) for ext in ['.py', '.js', '.module.js']):
                return
            if time.time() - self.last_run < self.cooldown:
                return
            print(f"\n{YELLOW}🔄 Change detected in {os.path.basename(event.src_path)}. Re-running tests...{RESET}")
            self.last_run = time.time()
            run_all_tests()

    event_handler = TestWatchHandler()
    observer = Observer()
    observer.schedule(event_handler, PROJECT_ROOT, recursive=True)

    print(f"\n{CYAN}👀 Watch mode active. Monitoring {PROJECT_ROOT}... (Ctrl+C to stop){RESET}")
    run_all_tests()

    observer.start()
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        observer.stop()
    observer.join()


if __name__ == "__main__":
    verbose = "--verbose" in sys.argv or "-v" in sys.argv
    if "--worker" in sys.argv:
        idx = sys.argv.index("--worker")
        if idx + 1 >= len(sys.argv):
            print("Missing test file argument for --worker", file=sys.stderr)
            sys.exit(2)
        target_file = sys.argv[idx + 1]
        ok, passed, total = run_python_batch(target_file, target_file, verbose=verbose)
        print(f"{_WORKER_RESULT_PREFIX}{json.dumps({'ok': ok, 'passed': passed, 'total': total})}")
        sys.exit(0 if ok else 1)
    elif "--watch" in sys.argv:
        start_watch_mode()
    else:
        sys.exit(0 if run_all_tests(verbose=verbose) else 1)
