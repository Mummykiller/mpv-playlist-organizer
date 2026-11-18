// popup/popup_youtube.js
// Isolated YouTube Tools UI controller ("extension within the extension").

const GROUP_CONTAINER_MAP = {
	videoPlayer: "yt-video-player-settings",
	"video-player": "yt-video-player-settings",
	"video-player-settings": "yt-video-player-settings",
	"yt-video-player-settings": "yt-video-player-settings",
	frameRemoval: "yt-frame-removal-settings",
	"frame-removal": "yt-frame-removal-settings",
	"frame-removal-settings": "yt-frame-removal-settings",
	"yt-frame-removal-settings": "yt-frame-removal-settings",
	distractionSettings: "yt-distraction-settings",
	"distraction-settings": "yt-distraction-settings",
	"yt-distraction-settings": "yt-distraction-settings",
	thumbnailTitleSettings: "yt-thumbnail-title-settings",
	"thumbnail-title-settings": "yt-thumbnail-title-settings",
	"yt-thumbnail-title-settings": "yt-thumbnail-title-settings",
	playlistManager: "yt-playlist-manager-settings",
	"playlist-manager": "yt-playlist-manager-settings",
	"yt-playlist-manager-settings": "yt-playlist-manager-settings",
};

const GROUP_FALLBACK_TITLES = {
	"yt-frame-removal-settings": "Feed & Card Filtering",
	"yt-distraction-settings": "Page Layout & Anti-Distraction",
	"yt-video-player-settings": "Video Player & Playback",
	"yt-thumbnail-title-settings": "Thumbnails, Titles & Links",
	"yt-playlist-manager-settings": "Watch Later / Library",
};

function formatTime(seconds) {
	const total = Math.max(0, Math.floor(Number(seconds) || 0));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const pad = (n) => String(n).padStart(2, "0");
	return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function isSafeHttpUrl(url) {
	if (typeof url !== "string" || !url) return false;
	try {
		const parsed = new URL(url);
		return parsed.protocol === "https:" || parsed.protocol === "http:";
	} catch {
		return false;
	}
}

function normalizeLibraryEntries(rawLibrary) {
	if (!rawLibrary) return [];
	if (Array.isArray(rawLibrary)) {
		return rawLibrary
			.filter((item) => item && typeof item === "object" && (item.id || item.videoId))
			.map((item) => ({ ...item, id: String(item.id || item.videoId) }));
	}
	if (typeof rawLibrary === "object") {
		return Object.entries(rawLibrary)
			.filter(([, item]) => item && typeof item === "object")
			.map(([key, item]) => ({ ...item, id: String(item.id || item.videoId || key) }));
	}
	return [];
}

function normalizeQualities(rawQualities) {
	if (!Array.isArray(rawQualities)) return [];
	return rawQualities.map((q) => {
		if (q && typeof q === "object") {
			const value = String(q.value ?? q.id ?? q.label ?? "");
			const label = String(q.label ?? q.name ?? value);
			return { value, label };
		}
		return { value: String(q), label: String(q) };
	});
}

function buildNormalizedGroup(groupId, rawGroup, rawItems) {
	const containerId =
		rawGroup?.containerId ||
		GROUP_CONTAINER_MAP[groupId] ||
		"yt-video-player-settings";
	const title =
		rawGroup?.title ||
		rawGroup?.label ||
		GROUP_FALLBACK_TITLES[containerId] ||
		"";
	const masterKey = rawGroup?.masterKey || null;
	const items = [...rawItems];
	if (masterKey && !items.some((it) => (it.key || it.id) === masterKey)) {
		items.unshift({
			key: masterKey,
			label: `Enable ${title || groupId}`,
			type: "toggle",
			isMaster: true,
		});
	}
	return {
		groupId,
		containerId,
		title,
		masterKey,
		items,
	};
}

function normalizeSchemaGroups(schema) {
	if (!schema) return [];
	if (Array.isArray(schema)) {
		return schema.map((group) => {
			const groupId = group.id || group.key || "";
			const rawItems = Array.isArray(group.controls)
				? group.controls
				: Array.isArray(group.items)
					? group.items
					: Array.isArray(group.settings)
						? group.settings
						: [];
			return buildNormalizedGroup(groupId, group, rawItems);
		});
	}
	if (typeof schema === "object") {
		return Object.entries(schema).map(([key, group]) => {
			if (Array.isArray(group)) {
				const containerId = GROUP_CONTAINER_MAP[key] || "yt-video-player-settings";
				return {
					groupId: key,
					containerId,
					title: GROUP_FALLBACK_TITLES[containerId] || key,
					masterKey: null,
					items: [...group],
				};
			}
			const groupId = group?.id || group?.key || key;
			const containerId =
				group?.containerId ||
				GROUP_CONTAINER_MAP[groupId] ||
				GROUP_CONTAINER_MAP[key] ||
				"yt-video-player-settings";
			const rawItems = Array.isArray(group?.controls)
				? group.controls
				: Array.isArray(group?.items)
					? group.items
					: Array.isArray(group?.settings)
						? group.settings
						: [];
			return buildNormalizedGroup(
				groupId,
				{
					...group,
					containerId,
					title: group?.title || group?.label || GROUP_FALLBACK_TITLES[containerId] || key,
				},
				rawItems
			);
		});
	}
	return [];
}

/**
 * Creates and initializes the YouTube Tools popup manager.
 * @param {object} ctx
 * @param {(text: string, isError?: boolean) => void} [ctx.showStatus]
 * @param {() => void} [ctx.onHideMpvView]
 * @param {() => void} [ctx.onRestoreMpvView]
 */
export function createYouTubeToolsManager(ctx = {}) {
	const { showStatus, onHideMpvView, onRestoreMpvView } = ctx;

	const tabButtons = document.querySelectorAll("#popup-extension-tabs .ext-tab-btn");
	const statusDot = document.getElementById("yt-tools-status-dot");
	const ytToolsView = document.getElementById("youtube-tools-view");
	const miniView = document.getElementById("mini-controller-view");
	const folderView = document.getElementById("folder-management-view");

	const masterEnableCheckbox = document.getElementById("yt-tools-master-enable");
	const disabledNotice = document.getElementById("yt-tools-disabled-notice");
	const subviewButtons = document.querySelectorAll(".yt-subview-btn");
	const libraryPanel = document.getElementById("yt-tools-library-panel");
	const libraryListEl = document.getElementById("yt-library-list");
	const libraryEmptyEl = document.getElementById("yt-library-empty");
	let doneFolderEl = document.getElementById("yt-library-done-folder");
	if (!doneFolderEl && libraryPanel) {
		doneFolderEl = document.createElement("div");
		doneFolderEl.id = "yt-library-done-folder";
		doneFolderEl.className = "yt-done-folder";
		doneFolderEl.style.display = "none";
		libraryPanel.appendChild(doneFolderEl);
	}
	const settingsPanel = document.getElementById("yt-tools-settings-panel");

	let activeExtTab = "mpv";
	let activeSubview = "library";
	let currentEnabled = false;
	let currentSettings = {};
	let currentLibraryRaw = null;
	let renderedControls = [];
	let collapsedUpdaters = [];
	let doneFolderExpanded = false;
	const selectedDoneIds = new Set();

	function getMergedSettings(stored) {
		const defaults =
			globalThis.SHINKU_YT_DEFAULTS && typeof globalThis.SHINKU_YT_DEFAULTS === "object"
				? globalThis.SHINKU_YT_DEFAULTS
				: {};
		const merged = {};
		const src = stored && typeof stored === "object" ? stored : {};
		for (const cat of new Set([...Object.keys(defaults), ...Object.keys(src)])) {
			const defVal = defaults[cat];
			const srcVal = src[cat];
			if (defVal && typeof defVal === "object" && !Array.isArray(defVal)) {
				const catObj = { ...defVal, ...(srcVal && typeof srcVal === "object" ? srcVal : {}) };
				if (
					cat === "video-player-settings" &&
					Object.prototype.hasOwnProperty.call(catObj, "Video-settings")
				) {
					if (!Object.prototype.hasOwnProperty.call(srcVal || {}, "video-settings")) {
						catObj["video-settings"] = catObj["Video-settings"];
					}
					delete catObj["Video-settings"];
				}
				merged[cat] = catObj;
			} else {
				merged[cat] = srcVal !== undefined ? srcVal : defVal;
			}
		}
		return merged;
	}

	function getSettingValue(groupId, key) {
		if (groupId && currentSettings[groupId] && typeof currentSettings[groupId] === "object") {
			return currentSettings[groupId][key];
		}
		return currentSettings[key];
	}

	function updateEnabledUI(enabled) {
		currentEnabled = Boolean(enabled);
		if (masterEnableCheckbox) {
			masterEnableCheckbox.checked = currentEnabled;
		}
		if (statusDot) {
			statusDot.classList.toggle("enabled", currentEnabled);
			statusDot.title = currentEnabled ? "YouTube Tools Enabled" : "YouTube Tools Disabled";
		}
		if (disabledNotice) {
			disabledNotice.style.display = currentEnabled ? "none" : "block";
		}
	}

	function switchExtTab(tab, { persist = true } = {}) {
		if (tab !== "mpv" && tab !== "yt") return;
		activeExtTab = tab;

		if (persist && chrome?.storage?.local?.set) {
			chrome.storage.local
				.set({ popupActiveExtTab: tab })
				.catch((err) => console.debug("[YT Tools] Failed to save popupActiveExtTab:", err));
		}

		tabButtons.forEach((btn) => {
			const isActive = btn.dataset.extTab === tab;
			btn.classList.toggle("active", isActive);
			btn.setAttribute("aria-selected", String(isActive));
		});

		const setupBanner = document.getElementById("native-host-setup-banner");
		if (setupBanner) {
			setupBanner.classList.toggle("hidden-by-yt-tab", tab === "yt");
		}

		if (tab === "yt") {
			if (typeof onHideMpvView === "function") {
				onHideMpvView();
			} else {
				if (miniView) miniView.style.display = "none";
				if (folderView) folderView.style.display = "none";
			}
			if (ytToolsView) ytToolsView.style.display = "flex";
		} else {
			if (ytToolsView) ytToolsView.style.display = "none";
			if (typeof onRestoreMpvView === "function") {
				onRestoreMpvView();
			}
		}
	}

	function switchSubview(subview, { persist = true } = {}) {
		if (subview !== "library" && subview !== "settings") return;
		activeSubview = subview;

		if (persist && chrome?.storage?.local?.set) {
			chrome.storage.local
				.set({ popupYtSubview: subview })
				.catch((err) => console.debug("[YT Tools] Failed to save popupYtSubview:", err));
		}

		subviewButtons.forEach((btn) => {
			const isActive = btn.dataset.ytSubview === subview;
			btn.classList.toggle("active", isActive);
			btn.setAttribute("aria-selected", String(isActive));
		});

		if (libraryPanel) libraryPanel.style.display = subview === "library" ? "block" : "none";
		if (settingsPanel) settingsPanel.style.display = subview === "settings" ? "flex" : "none";
	}

	async function removeLibraryItems(videoIds, successMessage) {
		const idSet = new Set(Array.from(videoIds, (id) => String(id)));
		if (idSet.size === 0) return;
		try {
			const data = await chrome.storage.local.get(["shinkuLibrary"]);
			const raw = data.shinkuLibrary;
			let updated;
			if (Array.isArray(raw)) {
				updated = raw.filter((item) => !idSet.has(String(item?.id || item?.videoId)));
			} else if (raw && typeof raw === "object") {
				updated = { ...raw };
				for (const id of idSet) {
					delete updated[id];
				}
				for (const [k, v] of Object.entries(updated)) {
					if (v && typeof v === "object" && idSet.has(String(v.id || v.videoId))) {
						delete updated[k];
					}
				}
			} else {
				return;
			}
			for (const id of idSet) {
				selectedDoneIds.delete(id);
			}
			await chrome.storage.local.set({ shinkuLibrary: updated });
			showStatus?.(successMessage || `Removed ${idSet.size} video${idSet.size === 1 ? "" : "s"} from YouTube Library.`);
		} catch (err) {
			showStatus?.(`Failed to remove video: ${err.message}`, true);
		}
	}

	async function removeLibraryItem(videoId) {
		return removeLibraryItems([videoId], "Removed video from YouTube Library.");
	}

	function openYouTubeVideo(videoId, currentTime) {
		const t = Math.max(0, Math.floor(Number(currentTime) || 0));
		const url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&t=${t}s`;
		if (chrome?.tabs?.create) {
			chrome.tabs.create({ url });
		} else {
			window.open(url, "_blank", "noopener,noreferrer");
		}
	}

	function createLibraryCard(item, { selectable = false, onSelectionChange = null } = {}) {
		const videoId = item.id;
		const title = String(item.title || `YouTube Video (${videoId})`);
		const uploader = String(item.uploader || item.channel || item.author || "Unknown channel");
		const currentTime = Math.max(0, Number(item.currentTime) || 0);
		const duration = Math.max(0, Number(item.duration) || 0);
		const pct = item.done
			? 100
			: duration > 0
				? Math.min(100, Math.max(0, (currentTime / duration) * 100))
				: Math.min(100, Math.max(0, Number(item.progress) || 0));

		const card = document.createElement("div");
		card.className = item.done ? "yt-library-card yt-done-card" : "yt-library-card";
		card.title = item.done ? "Open video from start" : "Open video at saved timestamp";
		card.addEventListener("click", () => openYouTubeVideo(videoId, item.done ? 0 : currentTime));

		if (selectable) {
			const checkbox = document.createElement("input");
			checkbox.type = "checkbox";
			checkbox.className = "yt-done-select-checkbox";
			checkbox.checked = selectedDoneIds.has(videoId);
			checkbox.setAttribute("aria-label", `Select ${title}`);
			checkbox.addEventListener("click", (e) => {
				e.stopPropagation();
			});
			checkbox.addEventListener("change", () => {
				if (checkbox.checked) {
					selectedDoneIds.add(videoId);
				} else {
					selectedDoneIds.delete(videoId);
				}
				onSelectionChange?.();
			});
			card.appendChild(checkbox);
		}

		const thumbWrap = document.createElement("div");
		thumbWrap.className = "yt-lib-thumb-wrap";
		const thumbUrl = isSafeHttpUrl(item.thumbnail)
			? item.thumbnail
			: `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/mqdefault.jpg`;
		const img = document.createElement("img");
		img.className = "yt-lib-thumb";
		img.src = thumbUrl;
		img.alt = "";
		img.loading = "lazy";
		thumbWrap.appendChild(img);

		const info = document.createElement("div");
		info.className = "yt-lib-info";

		const titleEl = document.createElement("div");
		titleEl.className = "yt-lib-title";
		titleEl.textContent = title;

		const uploaderEl = document.createElement("div");
		uploaderEl.className = "yt-lib-uploader";
		uploaderEl.textContent = uploader;

		const metaRow = document.createElement("div");
		metaRow.className = "yt-lib-meta";
		const timeEl = document.createElement("span");
		timeEl.className = "yt-lib-time";
		timeEl.textContent =
			duration > 0 ? `${formatTime(currentTime)} / ${formatTime(duration)}` : formatTime(currentTime);
		metaRow.appendChild(timeEl);

		const progressTrack = document.createElement("div");
		progressTrack.className = "yt-lib-progress-track";
		const progressFill = document.createElement("div");
		progressFill.className = "yt-lib-progress-fill";
		progressFill.style.width = `${pct.toFixed(1)}%`;
		progressTrack.appendChild(progressFill);

		info.append(titleEl, uploaderEl, metaRow, progressTrack);

		const removeBtn = document.createElement("button");
		removeBtn.type = "button";
		removeBtn.className = "yt-lib-remove-btn";
		removeBtn.title = "Remove from library";
		removeBtn.textContent = "×";
		removeBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			removeLibraryItem(videoId);
		});

		card.append(thumbWrap, info, removeBtn);
		return card;
	}

	function renderDoneFolder(doneEntries) {
		if (!doneFolderEl) return;
		doneFolderEl.replaceChildren();

		if (doneEntries.length === 0) {
			doneFolderEl.style.display = "none";
			return;
		}

		doneFolderEl.style.display = "flex";

		const headerBtn = document.createElement("button");
		headerBtn.type = "button";
		headerBtn.className = "yt-done-folder-header";
		headerBtn.setAttribute("aria-expanded", String(doneFolderExpanded));

		const titleWrap = document.createElement("span");
		titleWrap.className = "yt-done-folder-title-wrap";

		const chevron = document.createElement("span");
		chevron.className = "yt-done-folder-chevron";
		chevron.textContent = doneFolderExpanded ? "▾" : "▸";

		const label = document.createElement("span");
		label.textContent = "Done";

		titleWrap.append(chevron, label);

		const countBadge = document.createElement("span");
		countBadge.className = "yt-done-folder-count";
		countBadge.textContent = String(doneEntries.length);

		headerBtn.append(titleWrap, countBadge);
		headerBtn.addEventListener("click", () => {
			doneFolderExpanded = !doneFolderExpanded;
			renderLibrary(currentLibraryRaw);
		});

		doneFolderEl.appendChild(headerBtn);

		if (!doneFolderExpanded) {
			return;
		}

		const toolbar = document.createElement("div");
		toolbar.className = "yt-done-folder-toolbar";

		const selectAllLabel = document.createElement("label");
		selectAllLabel.className = "yt-done-select-all-label";
		const selectAllCb = document.createElement("input");
		selectAllCb.type = "checkbox";
		selectAllCb.id = "yt-done-select-all";
		const selectAllText = document.createElement("span");
		selectAllText.textContent = "Select all";
		selectAllLabel.append(selectAllCb, selectAllText);

		const actionsWrap = document.createElement("div");
		actionsWrap.className = "yt-done-folder-actions";

		const clearSelectedBtn = document.createElement("button");
		clearSelectedBtn.type = "button";
		clearSelectedBtn.id = "yt-done-clear-selected";
		clearSelectedBtn.className = "yt-done-action-btn";

		const clearAllBtn = document.createElement("button");
		clearAllBtn.type = "button";
		clearAllBtn.id = "yt-done-clear-all";
		clearAllBtn.className = "yt-done-action-btn";
		clearAllBtn.textContent = "Clear Folder";

		function syncDoneToolbarState() {
			const selectedCount = doneEntries.filter((it) => selectedDoneIds.has(it.id)).length;
			selectAllCb.checked = selectedCount > 0 && selectedCount === doneEntries.length;
			selectAllCb.indeterminate = selectedCount > 0 && selectedCount < doneEntries.length;
			clearSelectedBtn.disabled = selectedCount === 0;
			clearSelectedBtn.textContent =
				selectedCount > 0 ? `Clear Selected (${selectedCount})` : "Clear Selected";
		}

		selectAllCb.addEventListener("change", () => {
			if (selectAllCb.checked) {
				for (const it of doneEntries) {
					selectedDoneIds.add(it.id);
				}
			} else {
				for (const it of doneEntries) {
					selectedDoneIds.delete(it.id);
				}
			}
			const checkboxes = listEl.querySelectorAll(".yt-done-select-checkbox");
			checkboxes.forEach((cb, idx) => {
				if (doneEntries[idx]) {
					cb.checked = selectedDoneIds.has(doneEntries[idx].id);
				}
			});
			syncDoneToolbarState();
		});

		clearSelectedBtn.addEventListener("click", () => {
			const toRemove = doneEntries.filter((it) => selectedDoneIds.has(it.id)).map((it) => it.id);
			removeLibraryItems(toRemove, `Cleared ${toRemove.length} selected video${toRemove.length === 1 ? "" : "s"} from Done.`);
		});

		clearAllBtn.addEventListener("click", () => {
			const toRemove = doneEntries.map((it) => it.id);
			removeLibraryItems(toRemove, `Cleared all ${toRemove.length} videos from Done.`);
		});

		actionsWrap.append(clearSelectedBtn, clearAllBtn);
		toolbar.append(selectAllLabel, actionsWrap);
		doneFolderEl.appendChild(toolbar);

		const listEl = document.createElement("div");
		listEl.className = "yt-done-folder-list";
		for (const item of doneEntries) {
			listEl.appendChild(
				createLibraryCard(item, {
					selectable: true,
					onSelectionChange: syncDoneToolbarState,
				})
			);
		}
		doneFolderEl.appendChild(listEl);
		syncDoneToolbarState();
	}

	function renderLibrary(rawLibrary) {
		currentLibraryRaw = rawLibrary;
		if (!libraryListEl || !libraryEmptyEl) return;

		libraryListEl.replaceChildren();
		const entries = normalizeLibraryEntries(rawLibrary);
		const activeEntries = entries.filter((item) => !item.done);
		const doneEntries = entries.filter((item) => Boolean(item.done));

		activeEntries.sort((a, b) => {
			const ta = Number(a.updatedAt || a.lastWatched || a.timestamp || 0);
			const tb = Number(b.updatedAt || b.lastWatched || b.timestamp || 0);
			return tb - ta;
		});

		doneEntries.sort((a, b) => {
			const ta = Number(a.doneAt || a.updatedAt || a.lastWatched || a.timestamp || 0);
			const tb = Number(b.doneAt || b.updatedAt || b.lastWatched || b.timestamp || 0);
			return tb - ta;
		});

		const doneIdSet = new Set(doneEntries.map((it) => it.id));
		for (const id of [...selectedDoneIds]) {
			if (!doneIdSet.has(id)) {
				selectedDoneIds.delete(id);
			}
		}

		if (activeEntries.length === 0) {
			libraryListEl.style.display = "none";
			libraryEmptyEl.style.display = doneEntries.length === 0 ? "block" : "none";
		} else {
			libraryListEl.style.display = "flex";
			libraryEmptyEl.style.display = "none";
			for (const item of activeEntries) {
				libraryListEl.appendChild(createLibraryCard(item));
			}
		}

		renderDoneFolder(doneEntries);
	}

	async function saveSetting(groupId, key, value) {
		if (groupId) {
			const prevGroup =
				currentSettings[groupId] && typeof currentSettings[groupId] === "object"
					? currentSettings[groupId]
					: {};
			currentSettings = {
				...currentSettings,
				[groupId]: { ...prevGroup, [key]: value },
			};
		} else {
			currentSettings = { ...currentSettings, [key]: value };
		}
		try {
			await chrome.storage.local.set({ shinkuExtensionSettings: currentSettings });
		} catch (err) {
			showStatus?.(`Failed to save YouTube setting: ${err.message}`, true);
		}
	}

	function renderSettings() {
		const groups = normalizeSchemaGroups(globalThis.SHINKU_YT_UI_SCHEMA);
		const qualities = normalizeQualities(globalThis.SHINKU_YT_QUALITIES);
		renderedControls = [];
		collapsedUpdaters = [];

		// Clear all group containers
		if (settingsPanel) {
			settingsPanel.querySelectorAll(".yt-settings-group").forEach((el) => el.replaceChildren());
		} else {
			for (const id of [
				"yt-frame-removal-settings",
				"yt-distraction-settings",
				"yt-video-player-settings",
				"yt-thumbnail-title-settings",
				"yt-playlist-manager-settings",
			]) {
				const el = document.getElementById(id);
				if (el) el.replaceChildren();
			}
		}

		for (const group of groups) {
			let container = document.getElementById(group.containerId);
			if (!container && settingsPanel && group.containerId) {
				container = document.createElement("div");
				container.id = group.containerId;
				container.className = "yt-settings-group";
				settingsPanel.appendChild(container);
			}
			if (!container) continue;

			let masterKey = group.masterKey;
			if (!masterKey) {
				const explicitMaster = group.items.find((it) => it && (it.isMaster || it.master));
				if (explicitMaster) masterKey = explicitMaster.key || explicitMaster.id;
			}

			const header = document.createElement("div");
			header.className = "yt-settings-group-header";

			const collapseBtn = document.createElement("button");
			collapseBtn.type = "button";
			collapseBtn.className = "yt-settings-collapse-btn";

			const chevron = document.createElement("span");
			chevron.className = "yt-settings-chevron";

			const titleSpan = document.createElement("span");
			titleSpan.className = "yt-settings-title";
			titleSpan.textContent = group.title || GROUP_FALLBACK_TITLES[group.containerId] || "Settings";

			const disabledPill = document.createElement("span");
			disabledPill.className = "yt-settings-disabled-pill";
			disabledPill.textContent = "Disabled";

			collapseBtn.append(chevron, titleSpan, disabledPill);
			header.appendChild(collapseBtn);

			const childrenContainer = document.createElement("div");
			childrenContainer.className = "yt-settings-children";

			let isMinimized = masterKey ? !Boolean(getSettingValue(group.groupId, masterKey)) : false;

			const applyGroupVisualState = () => {
				const isEnabled = masterKey ? Boolean(getSettingValue(group.groupId, masterKey)) : true;
				container.classList.toggle("is-disabled", !isEnabled);
				container.classList.toggle("is-collapsed", isMinimized);
				disabledPill.style.display = isEnabled ? "none" : "inline-flex";
				childrenContainer.classList.toggle("collapsed", isMinimized);
				chevron.textContent = isMinimized ? "▸" : "▾";
				collapseBtn.setAttribute("aria-expanded", String(!isMinimized));
			};

			collapseBtn.addEventListener("click", () => {
				isMinimized = !isMinimized;
				applyGroupVisualState();
			});

			if (masterKey) {
				const switchLabel = document.createElement("label");
				switchLabel.className = "yt-toggle-switch yt-group-master-switch";
				switchLabel.title = `Enable or disable ${titleSpan.textContent}`;
				switchLabel.addEventListener("click", (e) => e.stopPropagation());

				const masterCheckbox = document.createElement("input");
				masterCheckbox.type = "checkbox";
				masterCheckbox.id = `yt-setting-${masterKey}`;
				masterCheckbox.checked = Boolean(getSettingValue(group.groupId, masterKey));
				masterCheckbox.setAttribute("aria-label", `Enable ${titleSpan.textContent}`);

				const slider = document.createElement("span");
				slider.className = "yt-toggle-slider";

				masterCheckbox.addEventListener("change", () => {
					const nextEnabled = masterCheckbox.checked;
					saveSetting(group.groupId, masterKey, nextEnabled);
					isMinimized = !nextEnabled;
					applyGroupVisualState();
				});

				switchLabel.append(masterCheckbox, slider);
				header.appendChild(switchLabel);
				renderedControls.push({
					groupId: group.groupId,
					key: masterKey,
					type: "checkbox",
					controlEl: masterCheckbox,
				});
			}

			container.appendChild(header);
			collapsedUpdaters.push(applyGroupVisualState);

			for (const item of group.items) {
				if (!item || typeof item !== "object") continue;
				const key = item.key || item.id || item.settingKey;
				if (!key) continue;
				const isStandaloneMode = !document.getElementById("popup-extension-tabs");
				if (item.mainExtensionOnly && isStandaloneMode) continue;

				const isMasterItem = Boolean(item.isMaster || item.master || key === masterKey);
				if (isMasterItem) continue;

				const row = document.createElement("div");
				row.className = "yt-setting-row";

				const labelWrap = document.createElement("label");
				labelWrap.className = "yt-setting-label";
				const inputId = `yt-setting-${key}`;
				labelWrap.htmlFor = inputId;
				labelWrap.textContent = String(item.label || item.title || item.name || key);

				if (item.description || item.tooltip) {
					const desc = document.createElement("span");
					desc.className = "yt-setting-desc";
					desc.textContent = String(item.description || item.tooltip);
					labelWrap.appendChild(desc);
				}

				const type = String(item.type || "checkbox").toLowerCase();
				let controlEl;

				if (type === "select" || type === "quality") {
					const select = document.createElement("select");
					select.id = inputId;
					select.className = "yt-setting-select";
					const opts =
						Array.isArray(item.options) && item.options.length > 0
							? normalizeQualities(item.options)
							: qualities;
					for (const opt of opts) {
						const optionEl = document.createElement("option");
						optionEl.value = opt.value;
						optionEl.textContent = opt.label;
						select.appendChild(optionEl);
					}
					const currentVal = getSettingValue(group.groupId, key);
					if (currentVal !== undefined) {
						select.value = String(currentVal);
					}
					select.addEventListener("change", () => saveSetting(group.groupId, key, select.value));
					controlEl = select;
				} else if (type === "number" || type === "range") {
					const input = document.createElement("input");
					input.type = "number";
					input.id = inputId;
					input.className = "yt-setting-number";
					if (item.min !== undefined) input.min = String(item.min);
					if (item.max !== undefined) input.max = String(item.max);
					if (item.step !== undefined) input.step = String(item.step);
					const currentVal = getSettingValue(group.groupId, key);
					input.value = currentVal !== undefined ? String(currentVal) : "";
					input.addEventListener("change", () => {
						const trimmed = input.value.trim();
						if (trimmed === "") {
							const prevVal = getSettingValue(group.groupId, key);
							input.value = prevVal !== undefined ? String(prevVal) : "";
							return;
						}
						let num = Number(trimmed);
						if (Number.isNaN(num)) {
							const prevVal = getSettingValue(group.groupId, key);
							input.value = prevVal !== undefined ? String(prevVal) : "";
							return;
						}
						if (item.min !== undefined && Number.isFinite(Number(item.min))) {
							num = Math.max(Number(item.min), num);
						}
						if (item.max !== undefined && Number.isFinite(Number(item.max))) {
							num = Math.min(Number(item.max), num);
						}
						input.value = String(num);
						saveSetting(group.groupId, key, num);
					});
					controlEl = input;
				} else if (type === "text") {
					const input = document.createElement("input");
					input.type = "text";
					input.id = inputId;
					input.className = "yt-setting-text";
					if (item.placeholder) input.placeholder = String(item.placeholder);
					const currentVal = getSettingValue(group.groupId, key);
					input.value = currentVal !== undefined ? String(currentVal) : "";
					input.addEventListener("change", () => saveSetting(group.groupId, key, input.value));
					controlEl = input;
				} else {
					const checkbox = document.createElement("input");
					checkbox.type = "checkbox";
					checkbox.id = inputId;
					checkbox.className = "yt-setting-checkbox";
					checkbox.checked = Boolean(getSettingValue(group.groupId, key));
					checkbox.addEventListener("change", () => {
						saveSetting(group.groupId, key, checkbox.checked);
					});
					controlEl = checkbox;
				}

				renderedControls.push({ groupId: group.groupId, key, type, controlEl });
				row.append(labelWrap, controlEl);
				childrenContainer.appendChild(row);
			}

			container.appendChild(childrenContainer);
			applyGroupVisualState();
		}
	}

	function syncSettingsUI() {
		if (renderedControls.length === 0) {
			renderSettings();
			return;
		}
		for (const { groupId, key, type, controlEl } of renderedControls) {
			if (document.activeElement === controlEl) continue;
			const val = getSettingValue(groupId, key);
			if (type === "select" || type === "quality") {
				if (val !== undefined) controlEl.value = String(val);
			} else if (type === "number" || type === "range" || type === "text") {
				controlEl.value = val !== undefined ? String(val) : "";
			} else {
				controlEl.checked = Boolean(val);
			}
		}
		for (const updateCollapsedState of collapsedUpdaters) {
			updateCollapsedState();
		}
	}

	async function initialize() {
		tabButtons.forEach((btn) => {
			btn.addEventListener("click", () => switchExtTab(btn.dataset.extTab));
		});

		subviewButtons.forEach((btn) => {
			btn.addEventListener("click", () => switchSubview(btn.dataset.ytSubview));
		});

		if (masterEnableCheckbox) {
			masterEnableCheckbox.addEventListener("change", async () => {
				const prevEnabled = currentEnabled;
				const enabled = masterEnableCheckbox.checked;
				updateEnabledUI(enabled);
				try {
					const response = await chrome.runtime.sendMessage({
						action: "set_yt_tools_enabled",
						enabled,
					});
					if (response && response.success === false) {
						updateEnabledUI(prevEnabled);
						showStatus?.(response.error || "Failed to toggle YouTube Tools.", true);
					} else {
						showStatus?.(enabled ? "YouTube Tools enabled." : "YouTube Tools disabled.");
					}
				} catch (err) {
					updateEnabledUI(prevEnabled);
					showStatus?.(`Failed to toggle YouTube Tools: ${err.message}`, true);
				}
			});
		}

		chrome.storage.onChanged.addListener((changes, areaName) => {
			if (areaName !== "local") return;
			if (changes.shinkuYtToolsEnabled) {
				updateEnabledUI(Boolean(changes.shinkuYtToolsEnabled.newValue));
			}
			if (changes.shinkuLibrary) {
				renderLibrary(changes.shinkuLibrary.newValue);
			}
			if (changes.shinkuExtensionSettings) {
				currentSettings = getMergedSettings(changes.shinkuExtensionSettings.newValue);
				syncSettingsUI();
			}
		});

		try {
			const stored = await chrome.storage.local.get([
				"shinkuYtToolsEnabled",
				"shinkuExtensionSettings",
				"shinkuLibrary",
				"popupActiveExtTab",
				"popupYtSubview",
			]);
			updateEnabledUI(Boolean(stored.shinkuYtToolsEnabled));
			currentSettings = getMergedSettings(stored.shinkuExtensionSettings);
			renderLibrary(stored.shinkuLibrary);
			renderSettings();
			if (stored.popupYtSubview === "library" || stored.popupYtSubview === "settings") {
				switchSubview(stored.popupYtSubview, { persist: false });
			}
			if (stored.popupActiveExtTab === "yt" || stored.popupActiveExtTab === "mpv") {
				switchExtTab(stored.popupActiveExtTab, { persist: false });
			}
			const isStandaloneMode = !document.getElementById("popup-extension-tabs");
			if (
				!isStandaloneMode &&
				stored.shinkuYtToolsEnabled &&
				getSettingValue("playlist-manager", "yt-dominant-on-youtube") &&
				chrome?.tabs?.query
			) {
				try {
					const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
					const activeUrl = tabs?.[0]?.url || "";
					if (activeUrl) {
						const parsed = new URL(activeUrl);
						if (parsed.hostname.toLowerCase().includes("youtube.com")) {
							switchExtTab("yt", { persist: false });
						}
					}
				} catch (tabErr) {
					console.debug("[YT Tools] Active tab dominant check skipped:", tabErr);
				}
			}
		} catch (err) {
			showStatus?.(`Failed to load YouTube Tools state: ${err.message}`, true);
		}
	}

	return {
		initialize,
		switchExtTab,
		switchSubview,
		getActiveExtTab: () => activeExtTab,
	};
}
