import os
import re
import sys
import tempfile

sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

CONFIG = [
    {
        "source": "utils/SystemLogger.module.js",
        "target": "utils/SystemLogger.js",
        "namespace": "MPV_INTERNAL",
        "dependencies": {}
    },
    {
        "source": "utils/anilist_renderer.module.js",
        "target": "utils/anilist_renderer.js",
        "namespace": "MPV_INTERNAL",
        "dependencies": {
            "./commUtils.module.js": "window.MPV_INTERNAL"
        }
    },
    {
        "source": "utils/commUtils.module.js",
        "target": "utils/commUtils.js",
        "namespace": "MPV_INTERNAL",
        "dependencies": {}
    },
    {
        "source": "utils/security.module.js",
        "target": "utils/security.js",
        "namespace": "MPV_SECURITY",
        "dependencies": {}
    },
    {
        "source": "utils/nativeConnection.module.js",
        "target": "utils/nativeConnection.js",
        "namespace": "MPV_INTERNAL",
        "dependencies": {
            "./security.module.js": "window.MPV_SECURITY",
            "./commUtils.module.js": "window.MPV_INTERNAL",
            "./SystemLogger.module.js": "window.MPV_INTERNAL"
        }
    },
    {
        "source": "utils/MpvInterface.module.js",
        "target": "utils/MpvInterface.js",
        "namespace": "MPV_INTERNAL",
        "dependencies": {
            "./commUtils.module.js": "window.MPV_INTERNAL"
        }
    },
    {
        "source": "utils/domUtils.module.js",
        "target": "utils/domUtils.js",
        "namespace": "MPV_INTERNAL",
        "dependencies": {}
    }
]

def render_module_js(config, project_root=None):
    base_dir = project_root or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    source_rel = config["source"]
    source_path = source_rel
    if not os.path.isabs(source_path):
        source_path = os.path.join(base_dir, source_path)
    namespace = config["namespace"]
    dependencies = config["dependencies"]

    with open(source_path, "r", encoding="utf-8") as f:
        content = f.read()

    # Handle Imports
    def handle_import(match):
        imports_str = match.group(1).replace('\n', ' ').strip()
        imports = [i.strip() for i in imports_str.split(',') if i.strip()]
        path = match.group(2)

        if path in dependencies:
            dep_ns = dependencies[path]
            lines = [f'const {i} = {dep_ns}.{i};' for i in imports]
            return '\n'.join(lines)
        raise ValueError(f"Unmapped import in {source_rel}: {path}")

    content = re.sub(r'import\s+\{\s*([\s\S]*?)\s*\}\s+from\s+"(.*?)";', handle_import, content)

    # Handle Star Imports
    def handle_star_import(match):
        alias = match.group(1)
        path = match.group(2)
        if path in dependencies:
            return f'const {alias} = {dependencies[path]};'
        raise ValueError(f"Unmapped import in {source_rel}: {path}")

    content = re.sub(r'import\s+\*\s+as\s+(\w+)\s+from\s+"(.*?)";', handle_star_import, content)

    # Handle Exports
    content = re.sub(r'^export\s+class\s+(\w+)(.*)', r'const \1 = MPV.\1 = class \1\2', content, flags=re.MULTILINE)
    content = re.sub(r'^export\s+(async\s+)?function\s+(\w+)(.*)', r'const \2 = MPV.\2 = \1function \2\3', content, flags=re.MULTILINE)
    content = re.sub(r'^export\s+const\s+(\w+)\s*=(.*)', r'const \1 = MPV.\1 =\2', content, flags=re.MULTILINE)
    content = re.sub(r'^export\s+\{[\s\S]*?\};', '', content, flags=re.MULTILINE)

    # Final Output Construction
    output = []
    output.append(f"// AUTO-GENERATED from {os.path.basename(source_path)}. DO NOT EDIT MANUALLY.")
    output.append(f"window.{namespace} = window.{namespace} || {{}};")
    output.append("(() => {")
    output.append(f"\tconst MPV = window.{namespace};")

    for line in content.split('\n'):
        if line.strip():
            output.append("\t" + line)
        else:
            output.append("")

    output.append("})();")
    return "\n".join(output)


def process_file(config, verbose=False, project_root=PROJECT_ROOT):
    source_rel = config["source"]
    target_rel = config["target"]
    source_path = source_rel if os.path.isabs(source_rel) else os.path.join(project_root, source_rel)
    target_path = target_rel if os.path.isabs(target_rel) else os.path.join(project_root, target_rel)
    namespace = config["namespace"]

    if verbose:
        print(f"Processing {source_rel} -> {target_rel} ({namespace})")

    if not os.path.exists(source_path):
        print(f"❌ ERROR: Source file {source_path} not found.")
        return False

    rendered = render_module_js(config, project_root=project_root)
    target_dir = os.path.dirname(target_path)
    target_name = os.path.basename(target_path)
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=target_dir,
            prefix=f".{target_name}.",
            suffix=".tmp",
            delete=False,
        ) as tmp_file:
            tmp_path = tmp_file.name
            tmp_file.write(rendered)
        os.replace(tmp_path, target_path)
        tmp_path = None
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError as cleanup_err:
                print(f"Warning: failed to remove temp JS file {tmp_path}: {cleanup_err}", file=sys.stderr)
    return True

if __name__ == "__main__":
    verbose = "--verbose" in sys.argv or "-v" in sys.argv
    built = 0
    for config in CONFIG:
        if process_file(config, verbose=verbose):
            built += 1
        else:
            sys.exit(1)
    if verbose:
        print(f"  ✅ JS Build: {built}/{len(CONFIG)} modules transpiled.")
