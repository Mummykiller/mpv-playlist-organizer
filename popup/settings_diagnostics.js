// popup/settings_diagnostics.js
// Extracted dependency status rendering, section reload, and diagnostics reporting for OptionsManager.

export function renderDependencyStatus(status) {
	if (!status) return;

	const mpvEl = document.querySelector("#diag-mpv-status .dependency-value");
	const ytdlpEl = document.querySelector("#diag-ytdlp-status .dependency-value");
	const ffmpegEl = document.querySelector("#diag-ffmpeg-status .dependency-value");
	const nodeEl = document.querySelector("#diag-node-status .dependency-value");

	if (mpvEl) {
		if (status.mpv?.found) {
			mpvEl.textContent = `Found at ${status.mpv.path}`;
			mpvEl.style.color = "var(--accent-positive)";
		} else {
			mpvEl.textContent = status.mpv?.error || "Not Found";
			mpvEl.style.color = "var(--accent-danger)";
		}
	}

	if (ytdlpEl) {
		if (status.ytdlp?.found) {
			ytdlpEl.textContent = `${status.ytdlp.version || "Found"} at ${status.ytdlp.path}`;
			ytdlpEl.style.color = "var(--accent-positive)";
		} else {
			ytdlpEl.textContent = status.ytdlp?.error || "Not Found";
			ytdlpEl.style.color = "var(--accent-danger)";
		}
	}

	if (ffmpegEl) {
		if (status.ffmpeg?.found) {
			ffmpegEl.textContent = `${status.ffmpeg.version || "Found"} at ${status.ffmpeg.path}`;
			ffmpegEl.style.color = "var(--accent-positive)";
		} else {
			ffmpegEl.textContent = status.ffmpeg?.error || "Not Found";
			ffmpegEl.style.color = "var(--accent-danger)";
		}
	}

	if (nodeEl) {
		if (status.node?.found) {
			nodeEl.textContent = `${status.node.version || "Found"} at ${status.node.path}`;
			nodeEl.style.color = "var(--accent-positive)";
		} else {
			nodeEl.textContent = status.node?.error || "Not Found";
			nodeEl.style.color = "var(--text-secondary)";
		}
	}
}

export async function handleForceRefreshDependencies(ctx, btn) {
	if (btn.disabled) return;

	btn.disabled = true;
	const originalText = btn.textContent;
	btn.textContent = "Refreshing...";

	ctx.showStatus("Refreshing system dependencies...");

	try {
		const response = await ctx.sendMessageAsync({
			action: "force_refresh_dependencies",
		});
		if (response?.success) {
			renderDependencyStatus({
				mpv: response.mpv,
				ytdlp: response.ytdlp,
				ffmpeg: response.ffmpeg,
				node: response.node,
			});
			ctx.showStatus("Dependencies refreshed!");
		} else {
			ctx.showStatus("Failed to refresh dependencies.", true);
		}
	} catch (e) {
		ctx.showStatus("Error: " + e.message, true);
	} finally {
		btn.disabled = false;
		btn.textContent = originalText;
	}
}

export async function handleSectionReload(ctx, btn) {
	if (btn.classList.contains("reloading")) return;

	btn.classList.add("reloading");
	ctx.showStatus("Syncing settings across all tabs...");

	try {
		const syncPromise = ctx.sendMessageAsync({
			action: "force_reload_settings",
		});
		const delayPromise = new Promise((resolve) => setTimeout(resolve, 600));

		await Promise.all([syncPromise, delayPromise]);

		const response = await ctx.sendMessageAsync({
			action: "get_ui_preferences",
		});
		if (response?.success) {
			ctx.updateAllPreferencesUI(response.preferences);
		}

		setTimeout(() => {
			btn.classList.remove("reloading");
			ctx.showStatus("Settings synchronized!");
		}, 200);
	} catch (e) {
		btn.classList.remove("reloading");
		ctx.showStatus("Failed to sync settings.", true);
	}
}

export function bindDiagnosticsListeners(ctx) {
	const reloadBtns = document.querySelectorAll(".section-reload-btn");
	reloadBtns.forEach((btn) => {
		btn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			handleSectionReload(ctx, btn);
		});
	});

	const refreshDepsBtn = document.getElementById("btn-force-refresh-dependencies");
	if (refreshDepsBtn) {
		refreshDepsBtn.addEventListener("click", () =>
			handleForceRefreshDependencies(ctx, refreshDepsBtn),
		);
	}

	const copyDiagBtn = document.getElementById("btn-copy-diagnostics");
	if (copyDiagBtn) {
		copyDiagBtn.addEventListener("click", async () => {
			if (copyDiagBtn.disabled) return;
			copyDiagBtn.disabled = true;
			const originalHtml = copyDiagBtn.innerHTML;
			copyDiagBtn.textContent = "Generating Report...";

			ctx.showStatus("Collecting system diagnostics...");

			try {
				const response = await ctx.sendMessageAsync({
					action: "get_unified_diagnostics",
				});

				if (response?.success) {
					const blob = JSON.stringify(response.data || response.result || response, null, 2);
					await navigator.clipboard.writeText(blob);
					ctx.showStatus("Diagnostic report copied to clipboard!");
				} else {
					ctx.showStatus(response?.error || "Failed to generate report.", true);
				}
			} catch (e) {
				ctx.showStatus("Error: " + e.message, true);
			} finally {
				copyDiagBtn.disabled = false;
				copyDiagBtn.innerHTML = originalHtml;
			}
		});
	}
}
