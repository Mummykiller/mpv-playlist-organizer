import ast
import io
import os
import sys
import unittest
import subprocess
import time
import re
import shutil

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
        return False, 0, 1

    # Check if node is installed
    try:
        subprocess.run(["node", "--version"], capture_output=True, check=True)
    except (subprocess.CalledProcessError, FileNotFoundError):
        print(f"  {YELLOW}⚠️  Skipping JS tests: Node.js is not installed.{RESET}")
        return True, 0, 0

    # 1. JS Unit Tests
    scripts_dir = os.path.join(TESTING_TOOLS_DIR, 'scripts')
    js_tests = sorted(f for f in os.listdir(scripts_dir) if f.startswith("test_") and f.endswith(".js"))
    js_passed = 0

    for test_file in js_tests:
        js_test_path = os.path.join(scripts_dir, test_file)
        result = subprocess.run(["node", js_test_path], capture_output=True, text=True)
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

    # 2. All JS & Module JS Syntax and Empty Catch Block Check
    js_files = []
    for root_dir, dirs, files in os.walk(PROJECT_ROOT):
        dirs[:] = [d for d in dirs if d not in {'.git', '__pycache__', 'node_modules'}]
        for f in sorted(files):
            if f.endswith('.js'):
                js_files.append(os.path.join(root_dir, f))

    syntax_ok = 0
    js_empty_catch_regex = re.compile(r'catch\s*(?:\([^)]*\))?\s*\{\s*\}')
    for js_file in js_files:
        rel_name = os.path.relpath(js_file, PROJECT_ROOT)
        check = subprocess.run(["node", "--check", js_file], capture_output=True, text=True)
        if check.returncode == 0:
            syntax_ok += 1
        else:
            print(f"\n  {RED}{BOLD}❌ JS SYNTAX ERROR in {rel_name}:{RESET}")
            print(f"{RED}{check.stderr.strip()}{RESET}")
            all_success = False

        # JS AST Gate: Check for silent empty catch blocks
        try:
            with open(js_file, "r", encoding="utf-8") as fh:
                js_content = fh.read()
            empty_catches = [
                js_content.count('\n', 0, m.start()) + 1
                for m in js_empty_catch_regex.finditer(js_content)
            ]
            if empty_catches:
                print(f"\n  {RED}{BOLD}❌ JS AST Gate: Silent empty catch block found in {rel_name} at line(s) {empty_catches}{RESET}")
                all_success = False
        except Exception as e:
            print(f"\n  {RED}{BOLD}❌ Could not read {rel_name}: {e}{RESET}")
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
        ruff_res = subprocess.run(
            [ruff_bin, "check", "--no-fix", "."],
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
    biome_cmd = None
    if biome_bin:
        biome_cmd = [biome_bin, "check", "."]
    elif shutil.which("npx"):
        probe = subprocess.run(
            ["npx", "--no-install", "@biomejs/biome", "--version"],
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
        )
        if probe.returncode == 0:
            biome_cmd = ["npx", "--no-install", "@biomejs/biome", "check", "."]

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

    return all_success, total_passed, total_checks, syntax_ok, len(js_files), py_ok, len(py_files)


def run_all_tests(verbose=False):
    """Main entry point running all test batches concisely."""
    t_start = time.time()

    b1_ok, b1_pass, b1_total = run_python_batch(
        "Backend Logic & Robustness",
        ["test_logging_system.py", "test_robustness.py", "test_repro_crash.py", "test_native_host_boot.py", "test_security_claims.py"],
        verbose=verbose,
    )

    b2_ok, b2_pass, b2_total, syntax_ok, js_total_files, py_ok, py_total_files = run_js_batch(verbose=verbose)

    b3_ok, b3_pass, b3_total = run_python_batch(
        "Cross-Environment Integration",
        "test_logging_pipeline.py",
        verbose=verbose,
    )

    total_pass = b1_pass + b2_pass + b3_pass
    total_tests = b1_total + b2_total + b3_total
    elapsed = time.time() - t_start
    all_ok = all([b1_ok, b2_ok, b3_ok])

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
    if "--watch" in sys.argv:
        start_watch_mode()
    else:
        sys.exit(0 if run_all_tests(verbose=verbose) else 1)
