# Installer.py Refactoring Plan

## Overview
This document outlines the fixes and improvements needed for `installer.py` based on code review findings.

---

## 🔴 Priority 1: Critical Fixes (Must Do)

### 1.1 Fix Unix CLI Argument Order Bug
**Location:** Line 446 in `UnixLogic.install_cli()`

**Current Code:**
```python
f.write(f'"{sys.executable}" "$@" "{script_path}"\n')
```

**Fix:**
```python
f.write(f'exec "{sys.executable}" "{script_path}" "$@"\n')
```

**Reasoning:**
- Arguments must come after the script path
- Using `exec` prevents creating unnecessary subprocess

**Testing:**
- Create CLI wrapper on Linux/macOS
- Test: `./mpv-cli --help` should pass arguments correctly

---

### 1.2 Add Browser Validation for Bypass Scripts
**Location:** All `install()` methods in logic classes

**Current Issue:** Bypass script can be created without selecting a browser

**Fix:**
```python
def install(self, extension_id, create_bypass, browser_for_bypass, enable_youtube_bypass):
    # Add validation at the start
    if create_bypass and not browser_for_bypass:
        raise ValueError("A browser must be selected when 'Create Bypass Script' is enabled")
    
    # Continue with existing logic...
```

**Also Update GUI:** `HostManagerApp.run_install()`
```python
def run_install(self):
    # ... existing validation ...
    
    # New validation
    if self.create_bypass_var.get() and not self.browser_var.get():
        messagebox.showerror("Error", "Please select a browser for the bypass script.")
        return
    
    # ... continue ...
```

**Testing:**
- Try installing with "Create Bypass Script" checked but no browser selected
- Should show error message

---

### 1.3 Add Infinite Loop Prevention for Windows Console Hiding
**Location:** Lines 8-14

**Current Issue:** If pythonw.exe fails, could cause issues

**Fix:**
```python
import sys
import os

os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
sys.dont_write_bytecode = True

# Add flag to prevent infinite relaunches
if '--no-relaunch' not in sys.argv:
    if sys.platform == "win32" and sys.executable.endswith("python.exe"):
        import subprocess
        pythonw_exe = sys.executable.replace("python.exe", "pythonw.exe")
        if os.path.exists(pythonw_exe):
            subprocess.Popen([pythonw_exe, __file__, '--no-relaunch'] + sys.argv[1:])
            sys.exit(0)
        # If pythonw.exe doesn't exist, continue with python.exe
```

**Testing:**
- Launch with python.exe on Windows
- Verify it switches to pythonw.exe
- Manually test with missing pythonw.exe

---

## ⚠️ Priority 2: Important Improvements (Should Do)

### 2.1 Update User-Agent Generation Strategy
**Location:** Lines 50-73 `_generate_user_agent()`

**Current Issue:** Hardcoded version numbers become outdated

**Options:**

**Option A: Document Update Requirements (Easy)**
```python
def _generate_user_agent(browser_name, os_name):
    """
    Generates a plausible User-Agent string based on browser and OS.
    
    NOTE: Browser versions are approximations and should be updated periodically
    to match current stable releases. Last updated: [DATE]
    
    To update:
    1. Check current versions at https://www.whatismybrowser.com/guides/the-latest-version/
    2. Update the version strings below
    3. Update the date in this docstring
    """
    # ... existing code with comment about updating ...
```

**Option B: Dynamic Generation (Better)**
- Create a separate config file for user agents
- Load from JSON: `data/user_agents.json`
```json
{
  "last_updated": "2025-01-01",
  "browsers": {
    "chrome": "120.0.0.0",
    "firefox": "120.0",
    "brave": "120.0.0.0",
    "edge": "120.0.0.0",
    "vivaldi": "6.5.3206.50",
    "opera": "100.0.0.0"
  },
  "os": {
    "Linux": "X11; Linux x86_64",
    "Windows": "Windows NT 10.0; Win64; x64",
    "Darwin": "Macintosh; Intel Mac OS X 10_15_7"
  }
}
```

**Option C: Use Library (Best, but adds dependency)**
```python
# Add to imports if acceptable
try:
    from fake_useragent import UserAgent
    ua = UserAgent()
    HAS_FAKE_UA = True
except ImportError:
    HAS_FAKE_UA = False

def _generate_user_agent(browser_name, os_name):
    if HAS_FAKE_UA:
        # Map browser names to fake_useragent methods
        browser_map = {
            'chrome': 'chrome',
            'firefox': 'firefox',
            'edge': 'edge',
            'brave': 'chrome',  # Use Chrome UA for Brave
            'vivaldi': 'chrome',
            'opera': 'opera'
        }
        ua_gen = UserAgent()
        browser_method = browser_map.get(browser_name, 'chrome')
        return getattr(ua_gen, browser_method)
    else:
        # Fallback to current hardcoded implementation
        # ... existing code ...
```

**Recommendation:** Start with Option A (documentation), then consider Option B for next version

---

### 2.2 Make Cookie Test Timeout Configurable
**Location:** Line 116 in `run_diagnostics()`

**Fix:**
```python
# Add at top of file with other config constants
COOKIE_TEST_TIMEOUT = 30  # seconds

# In run_diagnostics():
proc = subprocess.run(cmd, capture_output=True, text=True, 
                     startupinfo=startupinfo, timeout=COOKIE_TEST_TIMEOUT)
```

**Alternative:** Add to config.json
```python
# Load timeout from config
try:
    with open(CONFIG_FILE, 'r') as f:
        config = json.load(f)
    timeout = config.get('diagnostics_timeout', 30)
except:
    timeout = 30
```

---

### 2.3 Strengthen Extension ID Validation
**Location:** Lines 670-673 in `run_install()`

**Current Issue:** Warning can be bypassed, no check for empty after bypass

**Fix:**
```python
def run_install(self):
    extension_id = self.extension_id_var.get().strip()
    if not extension_id:
        messagebox.showerror("Error", "Extension ID cannot be empty.")
        return
    
    # Stricter validation with better feedback
    if not re.match(r"^[a-p]{32}$", extension_id):
        result = messagebox.askyesno(
            "Invalid Extension ID Format",
            f"The Extension ID '{extension_id}' doesn't match the standard Chrome "
            f"extension format (32 lowercase letters a-p).\n\n"
            f"Example: abcdefghijklmnopabcdefghijklmnop\n\n"
            f"Installing with an incorrect ID will prevent the extension from "
            f"connecting to the native host.\n\n"
            f"Continue anyway?",
            icon='warning'
        )
        if not result:
            return
    
    # ... rest of method ...
```

---

### 2.4 Add Atomic Config File Writes
**Location:** Various locations where config.json is written

**Current Issue:** File corruption if write fails mid-operation

**Fix - Create Helper Function:**
```python
def _atomic_write_json(file_path, data):
    """Atomically write JSON data to file using temporary file + rename."""
    import tempfile
    
    # Write to temp file first
    fd, temp_path = tempfile.mkstemp(
        dir=os.path.dirname(file_path),
        prefix='.tmp_',
        suffix='.json'
    )
    
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(data, f, indent=4)
        
        # Atomic rename (on POSIX) or best-effort on Windows
        if platform.system() == 'Windows':
            # Windows doesn't have atomic rename, but this is safer than direct write
            if os.path.exists(file_path):
                os.remove(file_path)
        os.rename(temp_path, file_path)
        
    except Exception:
        # Clean up temp file on error
        if os.path.exists(temp_path):
            os.remove(temp_path)
        raise

# Use in install methods:
# OLD: json.dump({"mpv_path": mpv_path}, f, indent=4)
# NEW:
_atomic_write_json(CONFIG_FILE, {"mpv_path": mpv_path})
```

---

## 💡 Priority 3: Nice to Have (Optional)

### 3.1 Extract Magic Numbers to Constants
**Location:** Lines 562-565 (window dimensions)

**Fix:**
```python
class HostManagerApp:
    # Window configuration
    WINDOW_WIDTH = 600
    WINDOW_HEIGHT = 500
    
    def __init__(self, root):
        # ...
        center_x = int(screen_width / 2 - self.WINDOW_WIDTH / 2)
        center_y = int(screen_height / 2 - self.WINDOW_HEIGHT / 2)
        self.root.geometry(f'{self.WINDOW_WIDTH}x{self.WINDOW_HEIGHT}+{center_x}+{center_y}')
```

---

### 3.2 Add Browser Name Enum
**Location:** Throughout file

**Fix:**
```python
from enum import Enum

class BrowserType(Enum):
    BRAVE = "brave"
    CHROME = "chrome"
    EDGE = "edge"
    FIREFOX = "firefox"
    VIVALDI = "vivaldi"
    OPERA = "opera"
    
    @classmethod
    def get_values(cls):
        return tuple(b.value for b in cls)

# Use in GUI:
self.browser_combobox['values'] = BrowserType.get_values()
```

---

### 3.3 Improve Error Messages with Actionable Steps
**Location:** Various error messages

**Example - MPV Not Found:**
```python
# Current:
raise FileNotFoundError("mpv.exe not found in PATH or config...")

# Better:
error_msg = (
    "mpv.exe was not found.\n\n"
    "To fix this, you can:\n"
    "1. Download MPV from https://mpv.io/installation/\n"
    "2. Add MPV to your system PATH, or\n"
    "3. Click 'Browse' to manually select mpv.exe\n\n"
    "Installation cannot continue without MPV."
)
raise FileNotFoundError(error_msg)
```

---

### 3.4 Add More Comprehensive Diagnostics
**Location:** `run_diagnostics()` method

**Additions:**
```python
def run_diagnostics(self, browser):
    results = []
    has_critical_error = False
    
    # ... existing checks ...
    
    # 5. Check Python version
    py_version = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
    if sys.version_info < (3, 7):
        results.append(f"⚠️ Python {py_version} (3.7+ recommended)")
    else:
        results.append(f"✅ Python {py_version}")
    
    # 6. Check write permissions
    try:
        test_file = os.path.join(DATA_DIR, '.write_test')
        with open(test_file, 'w') as f:
            f.write('test')
        os.remove(test_file)
        results.append("✅ Write permissions OK")
    except Exception as e:
        results.append(f"❌ Cannot write to data directory: {e}")
        has_critical_error = True
    
    # 7. Check manifest exists
    manifest_exists = os.path.exists(os.path.join(DATA_DIR, f"{HOST_NAME}-chrome.json")) or \
                     os.path.exists(os.path.join(DATA_DIR, f"{HOST_NAME}.json"))
    if manifest_exists:
        results.append("✅ Native messaging manifest found")
    else:
        results.append("⚠️ Manifest not found (run install first)")
    
    return "\n".join(results), has_critical_error
```

---

### 3.5 Add Logging to File
**Location:** New utility function

**Implementation:**
```python
import logging
from datetime import datetime

def setup_file_logging():
    """Set up file logging for debugging purposes."""
    log_dir = os.path.join(DATA_DIR, 'logs')
    os.makedirs(log_dir, exist_ok=True)
    
    log_file = os.path.join(
        log_dir, 
        f"installer_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log"
    )
    
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(levelname)s - %(message)s',
        handlers=[
            logging.FileHandler(log_file),
            logging.StreamHandler()
        ]
    )
    
    return log_file

# Add checkbox in GUI to enable file logging
```

---

## 📋 Implementation Checklist

### Phase 1: Critical Fixes
- [ ] Fix Unix CLI argument order bug
- [ ] Add browser validation for bypass scripts
- [ ] Add infinite loop prevention for Windows
- [ ] Test all fixes on Windows/Linux/macOS

### Phase 2: Important Improvements
- [ ] Document User-Agent update requirements
- [ ] Make cookie test timeout configurable
- [ ] Strengthen extension ID validation
- [ ] Add atomic config file writes
- [ ] Update tests

### Phase 3: Polish
- [ ] Extract magic numbers to constants
- [ ] Add browser enum
- [ ] Improve error messages
- [ ] Enhanced diagnostics
- [ ] Optional: Add file logging

---



### Manual Test Cases
1. **Install on fresh system** - No existing config
2. **Upgrade install** - Existing config present
3. **Browser selection** - Each supported browser
4. **Bypass script creation** - With/without YouTube
5. **Diagnostics** - All pass/some fail scenarios
6. **Uninstall** - Clean removal
7. **CLI wrapper** - Verify argument passing
8. **PATH addition** - Windows registry modification

---

## 📊 Success Criteria

### Must Have (Before Release)
- ✅ All critical bugs fixed
- ✅ No data corruption possible
- ✅ Clear error messages
- ✅ Works on Windows/Linux/macOS

### Nice to Have
- ✅ Comprehensive test coverage
- ✅ File logging for debugging
- ✅ Enhanced diagnostics

---

## 🔄 Migration Notes

**Config File Changes:**
- No breaking changes to existing `config.json`
- New installs will have improved structure
- Old configs remain compatible

**User Impact:**
- Users should reinstall after update
- No manual config migration needed
- Existing bypass scripts will continue working

---

