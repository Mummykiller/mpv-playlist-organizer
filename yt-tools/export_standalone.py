#!/usr/bin/env python3
"""Export Shinku's YouTube Tools into a standalone Chrome extension folder.

Usage:
    python3 yt-tools/export_standalone.py [--out DIR] [--zip]

By default, writes the standalone extension to `yt-tools-standalone/` right next
to `yt-tools/`.
"""

import argparse
import json
import re
import shutil
import zipfile
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
YT_TOOLS_DIR = ROOT_DIR / "yt-tools"
DEFAULT_OUT_DIR = ROOT_DIR / "yt-tools-standalone"

YT_TOOL_FILES = (
	"yt_defaults.js",
	"yt_bridge.js",
	"yt_content.js",
)

ICON_FILES = (
	"icon16.png",
	"icon32.png",
	"icon48.png",
	"icon128.png",
)

MANIFEST = {
	"manifest_version": 3,
	"name": "Shinku's YouTube Tools",
	"version": "1.0.0",
	"description": "Standalone YouTube playback enhancements, feed clutter removal, hover-preview guard, and Watch Later library.",
	"permissions": ["storage", "scripting", "contextMenus", "tabs"],
	"host_permissions": ["*://*.youtube.com/*"],
	"background": {
		"service_worker": "background.js",
		"type": "module",
	},
	"action": {
		"default_popup": "popup.html",
		"default_title": "Shinku's YouTube Tools",
		"default_icon": {
			"16": "images/icon16.png",
			"32": "images/icon32.png",
			"48": "images/icon48.png",
			"128": "images/icon128.png",
		},
	},
	"icons": {
		"16": "images/icon16.png",
		"32": "images/icon32.png",
		"48": "images/icon48.png",
		"128": "images/icon128.png",
	},
}

STANDALONE_BACKGROUND_JS = """import {
	syncYtToolsRegistration,
	setYtToolsEnabled,
	handleSaveYouTubeLinkToLibrary,
	YT_LIBRARY_MENU_ID,
} from "./background/yt_tools_service.js";

async function syncContextMenu() {
	if (!chrome?.contextMenus) return;
	await new Promise((resolve) => chrome.contextMenus.removeAll(resolve));
	const { shinkuYtToolsEnabled } = await chrome.storage.local.get("shinkuYtToolsEnabled");
	if (shinkuYtToolsEnabled) {
		chrome.contextMenus.create({
			id: YT_LIBRARY_MENU_ID,
			title: "Save to Shinku YT Library",
			contexts: ["link", "page"],
			documentUrlPatterns: ["*://*.youtube.com/*"],
		});
	}
}

async function initExtension() {
	const { shinkuYtToolsEnabled } = await chrome.storage.local.get("shinkuYtToolsEnabled");
	if (shinkuYtToolsEnabled === undefined) {
		await chrome.storage.local.set({ shinkuYtToolsEnabled: true });
	}
	await syncYtToolsRegistration();
	await syncContextMenu();
}

chrome.runtime.onInstalled.addListener(() => {
	initExtension().catch((err) => console.error("[YT Tools] onInstalled failed:", err));
});

chrome.runtime.onStartup.addListener(() => {
	initExtension().catch((err) => console.error("[YT Tools] onStartup failed:", err));
});

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
	if (!request || typeof request !== "object") return false;

	if (request.action === "get_yt_tools_enabled") {
		chrome.storage.local
			.get("shinkuYtToolsEnabled")
			.then(({ shinkuYtToolsEnabled }) => {
				sendResponse({ success: true, enabled: Boolean(shinkuYtToolsEnabled) });
			})
			.catch((err) => sendResponse({ success: false, error: err?.message || String(err) }));
		return true;
	}

	if (request.action === "set_yt_tools_enabled") {
		setYtToolsEnabled(Boolean(request.enabled))
			.then(async (res) => {
				await syncContextMenu();
				sendResponse(res);
			})
			.catch((err) => sendResponse({ success: false, error: err?.message || String(err) }));
		return true;
	}

	return false;
});

if (chrome.contextMenus?.onClicked) {
	chrome.contextMenus.onClicked.addListener((info, tab) => {
		if (info.menuItemId !== YT_LIBRARY_MENU_ID) return;
		const targetUrl = info.linkUrl || info.pageUrl || tab?.url;
		if (targetUrl) {
			handleSaveYouTubeLinkToLibrary(targetUrl, tab).catch((err) =>
				console.error("[YT Tools] Context menu save failed:", err)
			);
		}
	});
}
"""

STANDALONE_POPUP_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Shinku's YouTube Tools</title>
	<link rel="stylesheet" href="popup.css">
</head>
<body>
	<div id="youtube-tools-view">
		<div class="yt-tools-header">
			<label class="yt-master-toggle-label" for="yt-tools-master-enable">
				<span class="yt-toggle-switch">
					<input type="checkbox" id="yt-tools-master-enable">
					<span class="yt-toggle-slider"></span>
				</span>
				<span>Enable YouTube Tools</span>
			</label>
			<div class="yt-subview-tabs" role="tablist" aria-label="YouTube Tools Views">
				<button type="button" class="yt-subview-btn active" data-yt-subview="library" role="tab" aria-selected="true">Library</button>
				<button type="button" class="yt-subview-btn" data-yt-subview="settings" role="tab" aria-selected="false">Settings</button>
			</div>
		</div>

		<div id="yt-tools-disabled-notice" style="display: none;">
			YouTube Tools is currently disabled. Toggle the switch above to enable playback enhancements and feed filtering on YouTube.
		</div>

		<div id="yt-tools-library-panel" class="yt-tools-panel">
			<div id="yt-library-list" class="yt-library-list"></div>
			<div id="yt-library-empty" class="yt-library-empty">
				No saved YouTube videos yet.<br>
				Click the <strong>+</strong> button on a YouTube video or right-click a video link and choose <strong>Save to Shinku YT Library</strong>.
			</div>
			<div id="yt-library-done-folder" class="yt-done-folder" style="display: none;"></div>
		</div>

		<div id="yt-tools-settings-panel" class="yt-tools-panel" style="display: none;">
			<div id="yt-frame-removal-settings" class="yt-settings-group"></div>
			<div id="yt-distraction-settings" class="yt-settings-group"></div>
			<div id="yt-video-player-settings" class="yt-settings-group"></div>
			<div id="yt-thumbnail-title-settings" class="yt-settings-group"></div>
			<div id="yt-playlist-manager-settings" class="yt-settings-group"></div>
		</div>
	</div>

	<div id="yt-status-bar" class="yt-status-bar" aria-live="polite"></div>

	<script src="yt-tools/yt_defaults.js"></script>
	<script type="module" src="popup.js"></script>
</body>
</html>
"""

STANDALONE_POPUP_JS = """import { createYouTubeToolsManager } from "./popup/popup_youtube.js";

const statusBar = document.getElementById("yt-status-bar");
let statusTimer = null;

function showStatus(text, isError = false) {
	if (!statusBar) return;
	statusBar.textContent = String(text || "");
	statusBar.classList.toggle("is-error", Boolean(isError));
	statusBar.classList.toggle("visible", Boolean(text));
	if (statusTimer !== null) {
		clearTimeout(statusTimer);
	}
	if (text) {
		statusTimer = setTimeout(() => {
			statusBar.classList.remove("visible");
			statusTimer = null;
		}, 3000);
	}
}

document.addEventListener("DOMContentLoaded", () => {
	const manager = createYouTubeToolsManager({ showStatus });
	manager.initialize();
});
"""

STANDALONE_CSS_BASE = """* {
	box-sizing: border-box;
}

body {
	margin: 0;
	padding: 12px;
	width: 420px;
	max-height: 580px;
	overflow-y: auto;
	background-color: var(--bg-primary);
	color: var(--text-primary);
	font-family: var(--font-sans);
	font-size: 13px;
}

input[type="number"],
input[type="text"],
select {
	background-color: var(--bg-primary);
	color: var(--text-primary);
	border: 1px solid var(--border-primary);
	border-radius: var(--radius);
	outline: none;
	font-family: var(--font-sans);
}

input[type="number"]:focus,
input[type="text"]:focus,
select:focus {
	border-color: var(--accent-primary);
}

#youtube-tools-view {
	display: flex;
	flex-direction: column;
	gap: 10px;
}

.yt-status-bar {
	display: none;
	margin-top: 8px;
	padding: 6px 10px;
	border-radius: var(--radius);
	background-color: rgba(87, 242, 135, 0.12);
	border: 1px solid rgba(87, 242, 135, 0.35);
	color: var(--accent-success);
	font-size: 12px;
}

.yt-status-bar.visible {
	display: block;
}

.yt-status-bar.is-error {
	background-color: rgba(237, 66, 69, 0.14);
	border-color: rgba(237, 66, 69, 0.4);
	color: var(--accent-danger);
}
"""


def build_standalone_css(popup_css_text: str) -> str:
	"""Extract :root variables and YouTube Tools styles from popup.css."""
	root_match = re.search(r":root\s*\{.*?\}", popup_css_text, re.DOTALL)
	root_block = root_match.group(0) if root_match else ""

	yt_marker = "/* ========================================================================\n   Shinku's YouTube Tools"
	yt_idx = popup_css_text.find(yt_marker)
	if yt_idx == -1:
		yt_idx = popup_css_text.find(".yt-tools-header")
	yt_block = popup_css_text[yt_idx:] if yt_idx != -1 else ""

	return f"{root_block}\n\n{STANDALONE_CSS_BASE}\n{yt_block}".strip() + "\n"


def export_standalone(out_dir: Path, make_zip: bool = False) -> Path:
	"""Build a complete standalone YouTube Tools Chrome extension at `out_dir`."""
	if out_dir.exists():
		shutil.rmtree(out_dir)

	(out_dir / "yt-tools").mkdir(parents=True, exist_ok=True)
	(out_dir / "background").mkdir(parents=True, exist_ok=True)
	(out_dir / "popup").mkdir(parents=True, exist_ok=True)
	(out_dir / "images").mkdir(parents=True, exist_ok=True)

	# 1. Copy yt-tools runtime scripts
	for filename in YT_TOOL_FILES:
		shutil.copy2(YT_TOOLS_DIR / filename, out_dir / "yt-tools" / filename)

	# 2. Copy popup controller
	shutil.copy2(ROOT_DIR / "popup" / "popup_youtube.js", out_dir / "popup" / "popup_youtube.js")

	# 3. Copy & adapt background/yt_tools_service.js (drop main-repo SystemLogger dependency)
	service_src = (ROOT_DIR / "background" / "yt_tools_service.js").read_text(encoding="utf-8")
	service_standalone = service_src.replace(
		'import { logger } from "../utils/SystemLogger.module.js";',
		"const logger = console;",
	)
	(out_dir / "background" / "yt_tools_service.js").write_text(service_standalone, encoding="utf-8")

	# 4. Copy dedicated YT Tools icons (falling back to main images/ only if missing)
	for icon in ICON_FILES:
		src_icon = YT_TOOLS_DIR / "icons" / icon
		if not src_icon.exists():
			src_icon = ROOT_DIR / "images" / icon
		if src_icon.exists():
			shutil.copy2(src_icon, out_dir / "images" / icon)

	# 5. Write standalone manifest, background, popup HTML/JS/CSS
	(out_dir / "manifest.json").write_text(json.dumps(MANIFEST, indent=2) + "\n", encoding="utf-8")
	(out_dir / "background.js").write_text(STANDALONE_BACKGROUND_JS, encoding="utf-8")
	(out_dir / "popup.html").write_text(STANDALONE_POPUP_HTML, encoding="utf-8")
	(out_dir / "popup.js").write_text(STANDALONE_POPUP_JS, encoding="utf-8")

	popup_css_text = (ROOT_DIR / "popup.css").read_text(encoding="utf-8")
	(out_dir / "popup.css").write_text(build_standalone_css(popup_css_text), encoding="utf-8")

	if make_zip:
		zip_path = out_dir.with_suffix(".zip")
		with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
			for file_path in sorted(out_dir.rglob("*")):
				if file_path.is_file():
					zf.write(file_path, file_path.relative_to(out_dir.parent))
		return zip_path

	return out_dir


def main() -> None:
	parser = argparse.ArgumentParser(description="Export Shinku's YouTube Tools as a standalone Chrome extension.")
	parser.add_argument("--out", type=Path, default=DEFAULT_OUT_DIR, help="Output folder path")
	parser.add_argument("--zip", action="store_true", help="Also create a .zip archive next to the output folder")
	args = parser.parse_args()

	out_dir = args.out.resolve()
	export_standalone(out_dir, make_zip=args.zip)
	print(f"Exported standalone YouTube Tools extension to: {out_dir}")
	if args.zip:
		print(f"Created zip archive: {out_dir.with_suffix('.zip')}")


if __name__ == "__main__":
	main()
