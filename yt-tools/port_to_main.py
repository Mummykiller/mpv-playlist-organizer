#!/usr/bin/env python3
"""Port a standalone Shinku's YouTube Tools extension back into the main MPV Playlist Organizer extension.

Usage:
    python3 yt-tools/port_to_main.py [--source DIR] [--dry-run]

By default, ports from `yt-tools-standalone/` into the repository root.
"""

import argparse
import re
import shutil
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE_DIR = ROOT_DIR / "yt-tools-standalone"

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

REQUIRED_FILES = (
	"yt-tools/yt_defaults.js",
	"yt-tools/yt_bridge.js",
	"yt-tools/yt_content.js",
	"popup/popup_youtube.js",
	"background/yt_tools_service.js",
)


def validate_source_dir(source_dir: Path) -> None:
	"""Ensure `source_dir` contains all required standalone YouTube Tools files."""
	if not source_dir.is_dir():
		raise FileNotFoundError(f"Standalone source directory not found: {source_dir}")
	missing = [rel for rel in REQUIRED_FILES if not (source_dir / rel).is_file()]
	if missing:
		raise FileNotFoundError(
			f"Standalone source directory {source_dir} is missing required file(s): {', '.join(missing)}"
		)


def adapt_service_for_main(service_src: str) -> str:
	"""Restore the main-extension SystemLogger import in background/yt_tools_service.js."""
	target_import = 'import { logger } from "../utils/SystemLogger.module.js";'
	if target_import in service_src:
		return service_src
	return re.sub(
		r"^const logger = console;[ \t]*$",
		target_import,
		service_src,
		count=1,
		flags=re.MULTILINE,
	)


def _find_settings_panel_span(html: str) -> tuple[int, int] | None:
	"""Return (inner_start, inner_end) offsets for `#yt-tools-settings-panel` using balanced div matching."""
	open_match = re.search(r'<div\s+id="yt-tools-settings-panel"[^>]*>', html)
	if not open_match:
		return None
	inner_start = open_match.end()
	depth = 1
	pos = inner_start
	tag_re = re.compile(r"<(/?)div\b[^>]*>", re.IGNORECASE)
	for m in tag_re.finditer(html, pos):
		if m.group(1) == "/":
			depth -= 1
			if depth == 0:
				return (inner_start, m.start())
		else:
			depth += 1
	return None


def sync_settings_panel_html(src_html: str, dst_html: str) -> str:
	"""Sync the inner category containers of `#yt-tools-settings-panel` into main `popup.html`."""
	src_span = _find_settings_panel_span(src_html)
	dst_span = _find_settings_panel_span(dst_html)
	if not src_span or not dst_span:
		return dst_html

	src_inner = src_html[src_span[0] : src_span[1]]
	inner_lines = [line.strip() for line in src_inner.splitlines() if line.strip()]
	formatted_inner = "\n" + "\n".join(f"            {line}" for line in inner_lines) + "\n        "
	return dst_html[: dst_span[0]] + formatted_inner + dst_html[dst_span[1] :]


def extract_yt_css_section(css_text: str) -> str:
	"""Locate the YouTube Tools CSS section starting at the marker or `.yt-tools-header`."""
	marker = "/* ========================================================================\n   Shinku's YouTube Tools"
	idx = css_text.find(marker)
	if idx == -1:
		idx = css_text.find(".yt-tools-header")
	return css_text[idx:] if idx != -1 else ""


def sync_popup_css(src_css: str, dst_css: str) -> str:
	"""Sync the YouTube Tools CSS section from standalone `popup.css` into main `popup.css`."""
	src_section = extract_yt_css_section(src_css)
	if not src_section:
		return dst_css
	dst_marker_idx = dst_css.find(
		"/* ========================================================================\n   Shinku's YouTube Tools"
	)
	if dst_marker_idx == -1:
		dst_marker_idx = dst_css.find(".yt-tools-header")
	if dst_marker_idx == -1:
		return dst_css.rstrip() + "\n\n" + src_section.lstrip()
	return dst_css[:dst_marker_idx] + src_section.lstrip()


def port_to_main(source_dir: Path, root_dir: Path = ROOT_DIR, dry_run: bool = False) -> list[str]:
	"""Port standalone YouTube Tools files from `source_dir` into `root_dir`.

	Returns a list of repo-relative paths that were updated (or would be updated in dry-run mode).
	"""
	validate_source_dir(source_dir)
	actions: list[str] = []

	def record_copy_bytes(src_path: Path, dst_path: Path) -> None:
		rel = str(dst_path.relative_to(root_dir))
		src_bytes = src_path.read_bytes()
		if dst_path.exists() and dst_path.read_bytes() == src_bytes:
			return
		actions.append(rel)
		if not dry_run:
			dst_path.parent.mkdir(parents=True, exist_ok=True)
			shutil.copy2(src_path, dst_path)

	def record_write_text(dst_path: Path, content: str) -> None:
		rel = str(dst_path.relative_to(root_dir))
		if dst_path.exists() and dst_path.read_text(encoding="utf-8") == content:
			return
		actions.append(rel)
		if not dry_run:
			dst_path.parent.mkdir(parents=True, exist_ok=True)
			dst_path.write_text(content, encoding="utf-8")

	# 1. Port yt-tools/*.js
	for filename in YT_TOOL_FILES:
		record_copy_bytes(source_dir / "yt-tools" / filename, root_dir / "yt-tools" / filename)

	# 2. Port icons (prefer images/icon*.png, fallback to icons/icon*.png)
	for icon in ICON_FILES:
		src_icon = source_dir / "images" / icon
		if not src_icon.is_file():
			src_icon = source_dir / "icons" / icon
		if src_icon.is_file():
			record_copy_bytes(src_icon, root_dir / "yt-tools" / "icons" / icon)

	# 3. Port popup/popup_youtube.js
	record_copy_bytes(source_dir / "popup" / "popup_youtube.js", root_dir / "popup" / "popup_youtube.js")

	# 4. Port & adapt background/yt_tools_service.js
	service_src = (source_dir / "background" / "yt_tools_service.js").read_text(encoding="utf-8")
	record_write_text(
		root_dir / "background" / "yt_tools_service.js",
		adapt_service_for_main(service_src),
	)

	# 5. Sync #yt-tools-settings-panel containers in popup.html
	src_html_path = source_dir / "popup.html"
	dst_html_path = root_dir / "popup.html"
	if src_html_path.is_file() and dst_html_path.is_file():
		updated_html = sync_settings_panel_html(
			src_html_path.read_text(encoding="utf-8"),
			dst_html_path.read_text(encoding="utf-8"),
		)
		record_write_text(dst_html_path, updated_html)

	# 6. Sync YouTube Tools CSS section in popup.css
	src_css_path = source_dir / "popup.css"
	dst_css_path = root_dir / "popup.css"
	if src_css_path.is_file() and dst_css_path.is_file():
		updated_css = sync_popup_css(
			src_css_path.read_text(encoding="utf-8"),
			dst_css_path.read_text(encoding="utf-8"),
		)
		record_write_text(dst_css_path, updated_css)

	return actions


def main() -> None:
	parser = argparse.ArgumentParser(
		description="Port standalone Shinku's YouTube Tools into the main MPV Playlist Organizer extension."
	)
	parser.add_argument(
		"--source",
		type=Path,
		default=DEFAULT_SOURCE_DIR,
		help="Path to the standalone YouTube Tools directory",
	)
	parser.add_argument(
		"--dry-run",
		action="store_true",
		help="Show which files would be updated without writing changes",
	)
	args = parser.parse_args()

	source_dir = args.source.resolve()
	actions = port_to_main(source_dir, root_dir=ROOT_DIR, dry_run=args.dry_run)
	mode = "Would update" if args.dry_run else "Updated"
	if actions:
		print(f"{mode} {len(actions)} file(s) from {source_dir}:")
		for rel in actions:
			print(f"  - {rel}")
	else:
		print(f"Main extension is already in sync with {source_dir}.")


if __name__ == "__main__":
	main()
