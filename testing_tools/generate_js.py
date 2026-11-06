import re
import os

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
            "../background/messaging.js": "window.MPV_INTERNAL",
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

def process_file(config, verbose=False):
    source_path = config["source"]
    target_path = config["target"]
    namespace = config["namespace"]
    dependencies = config["dependencies"]

    if verbose:
        print(f"Processing {source_path} -> {target_path} ({namespace})")

    if not os.path.exists(source_path):
        print(f"❌ ERROR: Source file {source_path} not found.")
        return False

    with open(source_path, "r") as f:
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
        else:
            return f'// import {{ {", ".join(imports)} }} from "{path}"; // UNMAPPED'

    content = re.sub(r'import\s+\{\s*([\s\S]*?)\s*\}\s+from\s+"(.*?)";', handle_import, content)

    # Handle Star Imports
    def handle_star_import(match):
        alias = match.group(1)
        path = match.group(2)
        if path in dependencies:
            return f'const {alias} = {dependencies[path]};'
        return f'// import * as {alias} from "{path}"; // UNMAPPED'

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

    with open(target_path, "w") as f:
        f.write("\n".join(output))
    return True

if __name__ == "__main__":
    import sys
    verbose = "--verbose" in sys.argv
    built = 0
    for config in CONFIG:
        if process_file(config, verbose=verbose):
            built += 1
        else:
            sys.exit(1)
    if verbose:
        print(f"  ✅ JS Build: {built}/{len(CONFIG)} modules transpiled.")
