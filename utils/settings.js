/**
 * Manages the settings UI, including loading, saving, and event handling for all preferences.
 */
export class OptionsManager {
	/**
	 * @param {object} dependencies - An object containing functions and elements this manager depends on.
	 * @param {Function} dependencies.sendMessageAsync - The promise-based function to send messages to the background script.
	 * @param {Function} dependencies.showStatus - The function to display status messages to the user.
	 * @param {Function} dependencies.fetchAniListReleases - The function to refresh AniList data.
	 */
	constructor(dependencies) {
		this.sendMessageAsync = dependencies.sendMessageAsync;
		this.showStatus = dependencies.showStatus;
		this.fetchAniListReleases = dependencies.fetchAniListReleases;

		this.elements = {
			get geometrySelect() {
				return document.getElementById("geometry-select");
			},
		};

		try {
			this.currentMode = localStorage.getItem("mpv_settings_view_mode") || "simple";
			this.currentCategory = localStorage.getItem("mpv_settings_category") || "all";
			const savedFavs = localStorage.getItem("mpv_favorite_settings");
			this.favoriteSettings = new Set(savedFavs ? JSON.parse(savedFavs) : []);
		} catch (e) {
			this.currentMode = "simple";
			this.currentCategory = "all";
			this.favoriteSettings = new Set();
		}

		this.preferenceMappings = [
			{ key: "launchGeometry", elementId: "geometry-select", type: "select" },
			{
				key: "customGeometryWidth",
				elementId: "custom-width",
				type: "input",
			},
			{
				key: "customGeometryHeight",
				elementId: "custom-height",
				type: "input",
			},
			{ key: "mpvDecoder", elementId: "mpv-decoder-select", type: "select" },
			{
				key: "forceTerminal",
				elementId: "force-terminal-checkbox",
				type: "checkbox",
			},
			{
				key: "showPlayNewButton",
				elementId: "show-play-new-button-checkbox",
				type: "checkbox",
			},
			{
				key: "duplicateUrlBehavior",
				elementId: "duplicate-behavior-select",
				type: "select",
			},
			{
				key: "syncGlobalRemovals",
				elementId: "sync-global-removals-checkbox",
				type: "checkbox",
			},
			{
				key: "syncGlobalRemovalsLive",
				elementId: "sync-global-removals-live-checkbox",
				type: "checkbox",
			},
			{
				key: "oneClickAdd",
				elementId: "one-click-add-checkbox",
				type: "checkbox",
			},
			{
				key: "autoAppendOnAdd",
				elementId: "auto-append-on-add-checkbox",
				type: "checkbox",
			},
			{
				key: "liveRemoval",
				elementId: "live-removal-checkbox",
				type: "checkbox",
			},
			{
				key: "streamScannerTimeout",
				elementId: "scanner-timeout-input",
				type: "input",
				transform: Number,
			},
			{
				key: "confirmRemoveFolder",
				elementId: "confirm-remove-folder-checkbox",
				type: "checkbox",
			},
			{
				key: "confirmClearPlaylist",
				elementId: "confirm-clear-playlist-checkbox",
				type: "checkbox",
			},
			{
				key: "confirmCloseMpv",
				elementId: "confirm-close-mpv-checkbox",
				type: "checkbox",
			},
			{
				key: "confirmPlayNew",
				elementId: "confirm-play-new-checkbox",
				type: "checkbox",
			},
			{
				key: "confirmFolderSwitch",
				elementId: "confirm-folder-switch-checkbox",
				type: "checkbox",
			},
			{
				key: "clearOnItemFinish",
				elementId: "clear-on-item-finish-checkbox",
				type: "checkbox",
			},
			{
				key: "clearOnCompletion",
				elementId: "clear-on-completion-select",
				type: "select",
			},
			{ key: "clearScope", elementId: "clear-scope-select", type: "select" },
			{
				key: "ytUseCookies",
				elementId: "yt-use-cookies-checkbox",
				type: "checkbox",
			},
			{
				key: "ytMarkWatched",
				elementId: "yt-mark-watched-checkbox",
				type: "checkbox",
			},
			{
				key: "ytIgnoreConfig",
				elementId: "yt-ignore-config-checkbox",
				type: "checkbox",
			},
			{
				key: "otherSitesUseCookies",
				elementId: "other-sites-use-cookies-checkbox",
				type: "checkbox",
			},
			{
				key: "autofocusNewFolder",
				elementId: "autofocus-new-folder-checkbox",
				type: "checkbox",
			},
			{
				key: "enableDblclickCopy",
				elementId: "enable-dblclick-copy-checkbox",
				type: "checkbox",
			},
			{
				key: "showCopyTitleButton",
				elementId: "show-copy-title-button-checkbox",
				type: "checkbox",
			},
			{
				key: "showWatchedStatusGui",
				elementId: "show-watched-status-gui-checkbox",
				type: "checkbox",
			},
			{
				key: "lockAnilistPanel",
				elementId: "lock-anilist-panel-checkbox",
				type: "checkbox",
			},
			{
				key: "forcePanelAttached",
				elementId: "force-panel-attached-checkbox",
				type: "checkbox",
			},
			{
				key: "anilistAttachOnOpen",
				elementId: "anilist-attach-on-open-checkbox",
				type: "checkbox",
			},
			{
				key: "enableAnilistIntegration",
				elementId: "enable-anilist-integration-checkbox",
				type: "checkbox",
			},
			{
				key: "disableAnilistCache",
				elementId: "disable-anilist-cache-checkbox",
				type: "checkbox",
			},
			{
				key: "anilistImageHeight",
				elementId: "anilist-image-height-slider",
				type: "slider",
				transform: Number,
			},
			{ key: "ytdlQuality", elementId: "ytdl-quality-select", type: "select" },
			{
				key: "showMinimizedStub",
				elementId: "show-minimized-stub-checkbox",
				type: "checkbox",
			},
			{
				key: "ytdlpUpdateBehavior",
				elementId: "ytdlp-update-behavior-select",
				type: "select",
			},
			{ key: "mode", elementId: "default-ui-mode-select", type: "select" },
			{
				key: "kbAddPlaylist",
				elementId: "kb-add-playlist-input",
				type: "input",
			},
			{
				key: "kbPlayPlaylist",
				elementId: "kb-play-playlist-input",
				type: "input",
			},
			{
				key: "kbToggleController",
				elementId: "kb-toggle-ui-input",
				type: "input",
			},
			{
				key: "kbSwitchPlaylist",
				elementId: "kb-switch-playlist-input",
				type: "input",
			},
			{ key: "kbOpenPopup", elementId: "kb-open-popup-input", type: "input" },
			{
				key: "autoAddAutoOff",
				elementId: "auto-add-auto-off-checkbox",
				type: "checkbox",
			},
			{
				key: "autoAddInactivityTimeout",
				elementId: "auto-add-timeout-input",
				type: "input",
				transform: Number,
			},
			{
				key: "enableSmartResume",
				elementId: "enable-smart-resume-checkbox",
				type: "checkbox",
			},
			{
				key: "enablePreciseResume",
				elementId: "enable-precise-resume-checkbox",
				type: "checkbox",
			},
			{
				key: "enableActiveItemHighlight",
				elementId: "enable-active-highlight-checkbox",
				type: "checkbox",
			},
			{
				key: "disableNetworkOverrides",
				elementId: "disable-network-overrides-checkbox",
				type: "checkbox",
			},
			{
				key: "targetedDefaults",
				elementId: "targeted-defaults-select",
				type: "select",
			},
			{
				key: "enableCache",
				elementId: "enable-cache-checkbox",
				type: "checkbox",
			},
			{
				key: "httpPersistence",
				elementId: "http-persistence-select",
				type: "select",
			},
			{
				key: "demuxerMaxBytes",
				elementId: "demuxer-max-bytes-input",
				type: "input",
			},
			{
				key: "demuxerMaxBackBytes",
				elementId: "demuxer-max-back-bytes-input",
				type: "input",
			},
			{
				key: "cacheSecs",
				elementId: "cache-secs-input",
				type: "input",
				transform: Number,
			},
			{
				key: "demuxerReadaheadSecs",
				elementId: "demuxer-readahead-secs-input",
				type: "input",
				transform: Number,
			},
			{
				key: "streamBufferSize",
				elementId: "stream-buffer-size-input",
				type: "input",
			},
			{
				key: "ytdlpConcurrentFragments",
				elementId: "ytdlp-concurrent-fragments-input",
				type: "input",
				transform: Number,
			},
			{
				key: "enableReconnect",
				elementId: "enable-reconnect-checkbox",
				type: "checkbox",
			},
			{
				key: "reconnectDelay",
				elementId: "reconnect-delay-input",
				type: "input",
				transform: Number,
			},
			{
				key: "performanceProfile",
				elementId: "performance-profile-select",
				type: "select",
			},
			{ key: "ffmpegPath", elementId: "ffmpeg-path-input", type: "input" },
			{ key: "nodePath", elementId: "node-path-input", type: "input" },
			{
				key: "popupWidth",
				elementId: "popup-width-slider",
				type: "slider",
				transform: Number,
			},
			{
				key: "popupWidthLocked",
				elementId: "btn-lock-popup-width",
				type: "custom",
			},
			{
				key: "ultraScalers",
				elementId: "ultra-scalers-checkbox",
				type: "checkbox",
			},
			{
				key: "enableDisplaySync",
				elementId: "enable-display-sync-checkbox",
				type: "checkbox",
			},
			{
				key: "overrideDisplayFps",
				elementId: "override-display-fps-input",
				type: "input",
			},
			{
				key: "ultraInterpolation",
				elementId: "ultra-interpolation-select",
				type: "select",
			},
			{
				key: "ultraDeband",
				elementId: "ultra-deband-checkbox",
				type: "checkbox",
			},
			{ key: "ultraFbo", elementId: "ultra-fbo-checkbox", type: "checkbox" },
		];

		this.debouncedSaveAllPreferences = this._debounce(
			this.saveAllPreferences.bind(this),
			200,
		);
	}

	_debounce(func, wait) {
		let timeout;
		return (...args) => {
			const later = () => {
				clearTimeout(timeout);
				func.apply(this, args);
			};
			clearTimeout(timeout);
			timeout = setTimeout(later, wait);
		};
	}

	updateAllPreferencesUI(prefs) {
		const isCustom = prefs.launchGeometry === "custom";
		const isUltra = prefs.performanceProfile === "ultra";
		document.getElementById("ultra-options-container").style.display = isUltra
			? "block"
			: "none";

		const videoSyncCheckbox = document.getElementById(
			"enable-display-sync-checkbox",
		);
		const interpSelect = document.getElementById("ultra-interpolation-select");
		if (videoSyncCheckbox && interpSelect) {
			const isSyncEnabled = !!prefs.enableDisplaySync;
			interpSelect.disabled = !isSyncEnabled;
			interpSelect.parentElement.style.opacity = isSyncEnabled ? "1" : "0.5";
		}

		this.preferenceMappings.forEach((mapping) => {
			const el = document.getElementById(mapping.elementId);
			if (el) {
				const value = prefs[mapping.key];
				if (mapping.type === "checkbox") {
					el.checked = !!value;
				} else {
					el.value = value !== undefined ? value : "";
				}
			}
		});

		document.getElementById("custom-geometry-container").style.display =
			isCustom ? "flex" : "none";
		const enableAnilist = prefs.enableAnilistIntegration ?? true;
		document.getElementById("anilist-options-container").style.display =
			enableAnilist ? "block" : "none";
		document.getElementById("shared-anilist-section").style.display =
			enableAnilist ? "block" : "none";

		const networkMasterToggle = document.getElementById(
			"disable-network-overrides-checkbox",
		);
		if (networkMasterToggle) {
			this._updateNetworkingSectionState(networkMasterToggle.checked);
		}

		const ytCookiesToggle = document.getElementById("yt-use-cookies-checkbox");
		const ytMarkWatchedToggle = document.getElementById(
			"yt-mark-watched-checkbox",
		);
		const ytIgnoreConfigToggle = document.getElementById(
			"yt-ignore-config-checkbox",
		);
		if (ytCookiesToggle) {
			if (ytMarkWatchedToggle) {
				ytMarkWatchedToggle.disabled = !ytCookiesToggle.checked;
				ytMarkWatchedToggle.parentElement.style.opacity =
					ytCookiesToggle.checked ? "1" : "0.5";
			}
			if (ytIgnoreConfigToggle) {
				ytIgnoreConfigToggle.disabled = !ytCookiesToggle.checked;
				ytIgnoreConfigToggle.parentElement.style.opacity =
					ytCookiesToggle.checked ? "1" : "0.5";
			}
		}

		const customFlagsRaw = prefs.customMpvFlags || [];
		const customFlags = Array.isArray(customFlagsRaw)
			? customFlagsRaw
			: typeof customFlagsRaw === "string"
				? customFlagsRaw.match(/(?:[^\s"]+|"[^"]*")+/g) || []
				: [];

		const normalizedCustomFlags = customFlags.map((f) =>
			typeof f === "string" ? { flag: f, enabled: true } : f,
		);
		this._renderMpvFlagsList(normalizedCustomFlags);

		const automaticFlags = prefs.automaticMpvFlags || [];
		this._renderAutomaticMpvFlagsList(automaticFlags);

		this._updateAnilistImageSize(prefs.anilistImageHeight || 126);
		this._updatePopupWidth(prefs.popupWidth || 600);
		this._updatePopupWidthLock(prefs.popupWidthLocked || false);

		this._renderScraperFilterList(prefs.scraperFilterWords || []);
		this._renderRestrictedDomainsList(prefs.restrictedDomains || []);
		this._renderBuiltInFilterList();
		this._renderDependencyStatus(prefs.dependencyStatus);

		const bufferingPresetSelect = document.getElementById("buffering-preset-select");
		if (bufferingPresetSelect) {
			bufferingPresetSelect.value = this._detectBufferingPreset(prefs);
		}
	}

	_renderRestrictedDomainsList(domains = []) {
		const container = document.getElementById(
			"restricted-domains-list-container",
		);
		if (!container) return;
		container.innerHTML = "";
		domains.forEach((domain) => {
			const pill = document.createElement("div");
			pill.className = "filter-pill";
			pill.textContent = domain;
			pill.dataset.domain = domain;
			pill.title = "Click to remove";
			container.appendChild(pill);
		});
	}

	async _addRestrictedDomain() {
		const input = document.getElementById("restricted-domain-input");
		if (!input) return;
		let newDomain = input.value.trim().toLowerCase();
		if (!newDomain) return;

		try {
			if (newDomain.includes("://")) {
				newDomain = new URL(newDomain).hostname;
			} else {
				newDomain = newDomain.split("/")[0];
			}
		} catch (e) {
			console.debug("[Settings] Invalid domain format:", e);
		}

		if (!/^[a-z0-9]+([-.]{1}[a-z0-9]+)*\.[a-z]{2,13}$/.test(newDomain)) {
			this.showStatus('Invalid format. Use "domain.com"', true);
			return;
		}

		const response = await this.sendMessageAsync({
			action: "get_ui_preferences",
		});
		const currentDomains = response?.preferences?.restrictedDomains || [];

		if (!currentDomains.includes(newDomain)) {
			const newDomains = [...currentDomains, newDomain];
			this._renderRestrictedDomainsList(newDomains);
			await this.sendMessageAsync({
				action: "set_ui_preferences",
				preferences: { restrictedDomains: newDomains },
			});
			this.showStatus(`Domain "${newDomain}" restricted.`);
		} else {
			this.showStatus("Domain already in list.", true);
		}
		input.value = "";
	}

	async _removeRestrictedDomain(domainToRemove) {
		const response = await this.sendMessageAsync({
			action: "get_ui_preferences",
		});
		const currentDomains = response?.preferences?.restrictedDomains || [];
		const newDomains = currentDomains.filter((d) => d !== domainToRemove);
		await this.sendMessageAsync({
			action: "set_ui_preferences",
			preferences: { restrictedDomains: newDomains },
		});
		this._renderRestrictedDomainsList(newDomains);
	}

	_renderDependencyStatus(status) {
		if (!status) return;

		const mpvEl = document.querySelector("#diag-mpv-status .dependency-value");
		const ytdlpEl = document.querySelector(
			"#diag-ytdlp-status .dependency-value",
		);
		const ffmpegEl = document.querySelector(
			"#diag-ffmpeg-status .dependency-value",
		);
		const nodeEl = document.querySelector(
			"#diag-node-status .dependency-value",
		);

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

	_updateNetworkingSectionState(isDisabled) {
		const networkingSection = document
			.getElementById("disable-network-overrides-checkbox")
			?.closest(".settings-section");
		if (networkingSection) {
			const content = networkingSection.querySelector(
				".settings-section-content",
			);
			const otherControls = Array.from(content.children).filter(
				(child) =>
					!child.contains(
						document.getElementById("disable-network-overrides-checkbox"),
					),
			);

			otherControls.forEach((control) => {
				if (isDisabled) {
					control.classList.add("disabled-overlay");
				} else {
					control.classList.remove("disabled-overlay");
				}

				control.querySelectorAll("input, select").forEach((input) => {
					input.disabled = isDisabled;
				});
			});
		}
	}

	saveAllPreferences() {
		const preferences = {};

		this.preferenceMappings.forEach((mapping) => {
			const el = document.getElementById(mapping.elementId);
			if (el) {
				let value;
				if (mapping.type === "checkbox") {
					value = el.checked;
				} else {
					value = el.value;
				}
				preferences[mapping.key] = mapping.transform
					? mapping.transform(value)
					: typeof value === "string"
						? value.trim()
						: value;
			}
		});

		const flagPills = document.querySelectorAll(
			"#mpv-flags-list-container .filter-pill",
		);
		if (flagPills.length > 0) {
			preferences.customMpvFlags = Array.from(flagPills).map((p) => ({
				flag: p.dataset.flag,
				enabled: !p.classList.contains("disabled"),
			}));
		} else {
			preferences.customMpvFlags = [];
		}

		const automaticFlagPills = document.querySelectorAll(
			"#automatic-mpv-flags-list-container .filter-pill",
		);
		if (automaticFlagPills.length > 0) {
			preferences.automaticMpvFlags = Array.from(automaticFlagPills).map(
				(p) => {
					return {
						flag: p.dataset.flag,
						description: p.title,
						enabled: !p.classList.contains("disabled"),
					};
				},
			);
		}

		preferences.streamScannerTimeout =
			Number(preferences.streamScannerTimeout) || 60;

		this.sendMessageAsync({
			action: "set_ui_preferences",
			preferences: preferences,
		}).then((response) => {
			if (!response?.success) {
				this.showStatus("Failed to save settings.", true);
			}
		});
	}

	_updateAnilistImageSize(height) {
		const baseWidth = 50;
		const defaultHeight = 70;
		const effectiveHeight = Number(height || defaultHeight);
		const scalingFactor = effectiveHeight / defaultHeight;
		const effectiveWidth = Math.round(baseWidth * scalingFactor);

		document.documentElement.style.setProperty(
			"--anilist-item-width",
			`${effectiveWidth}px`,
		);
		document.documentElement.style.setProperty(
			"--anilist-image-height",
			`${effectiveHeight}px`,
		);
		document.getElementById("anilist-image-size-current").textContent =
			`${effectiveHeight}px`;
	}

	_updatePopupWidth(width) {
		let effectiveWidth = Number(width || 600);
		if (effectiveWidth > 780) effectiveWidth = 780;

		document.documentElement.style.width = `${effectiveWidth}px`;
		document.body.style.width = `${effectiveWidth}px`;
		const currentPopupWidthEl = document.getElementById("popup-width-current");
		if (currentPopupWidthEl) {
			currentPopupWidthEl.textContent = `${effectiveWidth}px`;
		}
	}

	_updatePopupWidthLock(isLocked) {
		const container = document.getElementById("popup-width-controls-container");
		const lockBtn = document.getElementById("btn-lock-popup-width");
		if (container) {
			container.style.display = isLocked ? "none" : "flex";
		}
		if (lockBtn) {
			const lockIcon = lockBtn.querySelector(".lock-icon");
			const unlockIcon = lockBtn.querySelector(".unlock-icon");
			if (lockIcon && unlockIcon) {
				lockIcon.style.display = isLocked ? "block" : "none";
				unlockIcon.style.display = isLocked ? "none" : "block";
			}
			lockBtn.classList.toggle("active", isLocked);
		}
	}

	_renderMpvFlagsList(flags = []) {
		const container = document.getElementById("mpv-flags-list-container");
		if (!container) return;
		container.innerHTML = "";
		flags.forEach((flagData) => {
			const pill = document.createElement("div");
			pill.className = "filter-pill";
			if (flagData.enabled === false) {
				pill.classList.add("disabled");
			}
			pill.textContent = flagData.flag;
			pill.dataset.flag = flagData.flag;
			pill.title = "Click to toggle. Double-click to remove.";
			container.appendChild(pill);
		});
	}

	_renderAutomaticMpvFlagsList(flags = []) {
		const container = document.getElementById(
			"automatic-mpv-flags-list-container",
		);
		if (!container) return;
		container.innerHTML = "";
		flags.forEach((flagData) => {
			const pill = document.createElement("div");
			pill.className = "filter-pill";
			if (!flagData.enabled) {
				pill.classList.add("disabled");
			}
			pill.textContent = flagData.flag;
			pill.dataset.flag = flagData.flag;
			pill.title = flagData.description || "";
			container.appendChild(pill);
		});
	}

	_addMpvFlag() {
		const input = document.getElementById("mpv-flag-input");
		if (!input) return;
		const newFlag = input.value.trim();
		if (!newFlag) return;

		const existing = Array.from(
			document.querySelectorAll("#mpv-flags-list-container .filter-pill"),
		).find((p) => p.dataset.flag === newFlag);
		if (existing) {
			input.value = "";
			return;
		}

		const container = document.getElementById("mpv-flags-list-container");
		const pill = document.createElement("div");
		pill.className = "filter-pill";
		pill.textContent = newFlag;
		pill.dataset.flag = newFlag;
		pill.title = "Click to toggle. Double-click to remove.";
		container.appendChild(pill);

		input.value = "";
		this.debouncedSaveAllPreferences();
	}

	_toggleMpvFlag(element) {
		element.classList.toggle("disabled");
		this.debouncedSaveAllPreferences();
	}

	_removeMpvFlag(element) {
		element.remove();
		this.debouncedSaveAllPreferences();
	}

	_resetMpvFlags() {
		this._renderMpvFlagsList([]);
		this.debouncedSaveAllPreferences();
	}

	_renderScraperFilterList(words = []) {
		const container = document.getElementById("scraper-filter-list-container");
		if (!container) return;
		container.innerHTML = "";
		words.forEach((word) => {
			const pill = document.createElement("div");
			pill.className = "filter-pill";
			pill.textContent = word;
			pill.dataset.word = word;
			pill.title = "Click to remove";
			container.appendChild(pill);
		});
	}

	_renderBuiltInFilterList() {
		const container = document.getElementById(
			"scraper-builtin-filter-list-container",
		);
		if (!container) return;
		const builtInWords = [
			"watch",
			"online",
			"free",
			"episode",
			"season",
			"full",
			"hd",
			"eng sub",
			"subbed",
			"dubbed",
			"animepahe",
		];
		container.innerHTML = "";
		builtInWords.forEach((word) => {
			const pill = document.createElement("div");
			pill.className = "filter-pill readonly";
			pill.textContent = word;
			pill.title = "This is a built-in filter and cannot be removed.";
			container.appendChild(pill);
		});
	}

	async _addScraperFilterWord() {
		const input = document.getElementById("scraper-filter-input");
		if (!input) return;
		const newWord = input.value.trim().toLowerCase();
		if (!newWord) return;

		const response = await this.sendMessageAsync({
			action: "get_ui_preferences",
		});
		const currentWords = response?.preferences?.scraperFilterWords || [];

		if (!currentWords.includes(newWord)) {
			const newWords = [...currentWords, newWord];
			await this.sendMessageAsync({
				action: "set_ui_preferences",
				preferences: { scraperFilterWords: newWords },
			});
			this._renderScraperFilterList(newWords);
		}
		input.value = "";
	}

	async _removeScraperFilterWord(wordToRemove) {
		const response = await this.sendMessageAsync({
			action: "get_ui_preferences",
		});
		const currentWords = response?.preferences?.scraperFilterWords || [];
		const newWords = currentWords.filter((word) => word !== wordToRemove);
		await this.sendMessageAsync({
			action: "set_ui_preferences",
			preferences: { scraperFilterWords: newWords },
		});
		this._renderScraperFilterList(newWords);
	}

	initializeEventListeners() {
		this.preferenceMappings.forEach((mapping) => {
			const control = document.getElementById(mapping.elementId);
			if (control) {
				const eventType =
					mapping.type === "textarea" ||
					mapping.type === "input" ||
					mapping.type === "slider"
						? "input"
						: "change";
				control.addEventListener(eventType, this.debouncedSaveAllPreferences);

				if (mapping.elementId === "disable-network-overrides-checkbox") {
					control.addEventListener("change", () =>
						this._updateNetworkingSectionState(control.checked),
					);
				}

				if (mapping.elementId === "yt-use-cookies-checkbox") {
					control.addEventListener("change", () => {
						const ytMarkWatchedToggle = document.getElementById(
							"yt-mark-watched-checkbox",
						);
						const ytIgnoreConfigToggle = document.getElementById(
							"yt-ignore-config-checkbox",
						);
						if (ytMarkWatchedToggle) {
							ytMarkWatchedToggle.disabled = !control.checked;
							ytMarkWatchedToggle.parentElement.style.opacity = control.checked
								? "1"
								: "0.5";
						}
						if (ytIgnoreConfigToggle) {
							ytIgnoreConfigToggle.disabled = !control.checked;
							ytIgnoreConfigToggle.parentElement.style.opacity = control.checked
								? "1"
								: "0.5";
						}
					});
				}

				if (mapping.elementId === "enable-display-sync-checkbox") {
					control.addEventListener("change", () => {
						const interpSelect = document.getElementById(
							"ultra-interpolation-select",
						);
						if (interpSelect) {
							interpSelect.disabled = !control.checked;
							interpSelect.parentElement.style.opacity = control.checked
								? "1"
								: "0.5";
						}
					});
				}
			}
		});

		const performanceProfileSelect = document.getElementById(
			"performance-profile-select",
		);
		if (performanceProfileSelect) {
			performanceProfileSelect.addEventListener("change", () => {
				document.getElementById("ultra-options-container").style.display =
					performanceProfileSelect.value === "ultra" ? "block" : "none";
			});
		}

		const geometrySelect = document.getElementById("geometry-select");
		if (geometrySelect) {
			geometrySelect.addEventListener("change", () => {
				document.getElementById("custom-geometry-container").style.display =
					geometrySelect.value === "custom" ? "flex" : "none";
				this.debouncedSaveAllPreferences();
			});
		}

		const anilistSlider = document.getElementById(
			"anilist-image-height-slider",
		);
		if (anilistSlider) {
			anilistSlider.addEventListener("input", () =>
				this._updateAnilistImageSize(anilistSlider.value),
			);
		}

		const popupWidthSlider = document.getElementById("popup-width-slider");
		if (popupWidthSlider) {
			popupWidthSlider.addEventListener("input", () =>
				this._updatePopupWidth(popupWidthSlider.value),
			);
		}

		const lockBtn = document.getElementById("btn-lock-popup-width");
		if (lockBtn) {
			lockBtn.addEventListener("click", async () => {
				const response = await this.sendMessageAsync({
					action: "get_ui_preferences",
				});
				const currentlyLocked =
					response?.preferences?.popupWidthLocked || false;
				const newLockedState = !currentlyLocked;

				await this.sendMessageAsync({
					action: "set_ui_preferences",
					preferences: { popupWidthLocked: newLockedState },
				});
				this._updatePopupWidthLock(newLockedState);
			});
		}

		const anilistEnableCheck = document.getElementById(
			"enable-anilist-integration-checkbox",
		);
		if (anilistEnableCheck) {
			anilistEnableCheck.addEventListener("change", () => {
				const isEnabled = anilistEnableCheck.checked;
				document.getElementById("anilist-options-container").style.display =
					isEnabled ? "block" : "none";
				document.getElementById("shared-anilist-section").style.display =
					isEnabled ? "block" : "none";
				if (
					isEnabled &&
					document.getElementById("shared-anilist-section").open
				) {
					this.fetchAniListReleases(true);
				}
			});
		}

		const anilistCacheCheck = document.getElementById(
			"disable-anilist-cache-checkbox",
		);
		if (anilistCacheCheck) {
			anilistCacheCheck.addEventListener("change", () => {
				if (document.getElementById("shared-anilist-section").open) {
					this.fetchAniListReleases(true);
				}
			});
		}

		const manualYtdlpBtn = document.getElementById("btn-manual-ytdlp-update");
		if (manualYtdlpBtn) {
			manualYtdlpBtn.addEventListener("click", () => {
				this.showStatus("Starting yt-dlp update...");
				this.sendMessageAsync({ action: "manual_ytdlp_update" });
			});
		}

		const scraperInput = document.getElementById("scraper-filter-input");
		if (scraperInput) {
			scraperInput.addEventListener("keydown", (e) => {
				if (e.key === "Enter") {
					e.preventDefault();
					this._addScraperFilterWord();
				}
			});
		}

		const scraperList = document.getElementById(
			"scraper-filter-list-container",
		);
		if (scraperList) {
			scraperList.addEventListener("click", (e) => {
				if (e.target.classList.contains("filter-pill")) {
					this._removeScraperFilterWord(e.target.dataset.word);
				}
			});
		}

		const restrictedInput = document.getElementById("restricted-domain-input");
		if (restrictedInput) {
			restrictedInput.addEventListener("keydown", (e) => {
				if (e.key === "Enter") {
					e.preventDefault();
					this._addRestrictedDomain();
				}
			});
		}

		const restrictedList = document.getElementById(
			"restricted-domains-list-container",
		);
		if (restrictedList) {
			restrictedList.addEventListener("click", (e) => {
				if (e.target.classList.contains("filter-pill")) {
					this._removeRestrictedDomain(e.target.dataset.domain);
				}
			});
		}

		const mpvFlagInput = document.getElementById("mpv-flag-input");
		if (mpvFlagInput) {
			mpvFlagInput.addEventListener("keydown", (e) => {
				if (e.key === "Enter") {
					e.preventDefault();
					this._addMpvFlag();
				}
			});
		}

		const mpvFlagsList = document.getElementById("mpv-flags-list-container");
		if (mpvFlagsList) {
			let clickTimer = null;

			mpvFlagsList.addEventListener("click", (e) => {
				if (e.target.classList.contains("filter-pill")) {
					if (clickTimer) {
						clearTimeout(clickTimer);
						clickTimer = null;
						this._removeMpvFlag(e.target);
					} else {
						clickTimer = setTimeout(() => {
							clickTimer = null;
							this._toggleMpvFlag(e.target);
						}, 250);
					}
				}
			});
		}

		const resetMpvFlagsBtn = document.getElementById("btn-reset-mpv-flags");
		if (resetMpvFlagsBtn) {
			resetMpvFlagsBtn.addEventListener("click", () => this._resetMpvFlags());
		}

		const automaticMpvFlagsList = document.getElementById(
			"automatic-mpv-flags-list-container",
		);
		if (automaticMpvFlagsList) {
			automaticMpvFlagsList.addEventListener("click", (e) => {
				if (e.target.classList.contains("filter-pill")) {
					this._toggleAutomaticMpvFlag(e.target);
				}
			});
		}

		const resetAutomaticMpvFlagsBtn = document.getElementById(
			"btn-reset-automatic-mpv-flags",
		);
		if (resetAutomaticMpvFlagsBtn) {
			resetAutomaticMpvFlagsBtn.addEventListener("click", () =>
				this._resetAutomaticMpvFlags(),
			);
		}

		const searchInput = document.getElementById("settings-search-input");
		if (searchInput) {
			searchInput.addEventListener("input", (e) =>
				this._handleSettingsSearch(e.target.value),
			);
		}

		const clearSearchBtn = document.getElementById("btn-clear-settings-search");
		if (clearSearchBtn) {
			clearSearchBtn.addEventListener("click", () => {
				if (searchInput) {
					searchInput.value = "";
					this._handleSettingsSearch("");
					searchInput.focus();
				}
			});
		}

		const btnModeSimple = document.getElementById("btn-mode-simple");
		const btnModeAdvanced = document.getElementById("btn-mode-advanced");
		if (btnModeSimple) {
			btnModeSimple.addEventListener("click", () => this.setSettingsMode("simple"));
		}
		if (btnModeAdvanced) {
			btnModeAdvanced.addEventListener("click", () => this.setSettingsMode("advanced"));
		}

		const catTabs = document.querySelectorAll(".cat-tab-btn");
		catTabs.forEach((tab) => {
			tab.addEventListener("click", () => {
				const cat = tab.dataset.category || tab.dataset.cat || "all";
				this.applyCategoryFilter(cat);
			});
		});

		const bufferingPresetSelect = document.getElementById("buffering-preset-select");
		if (bufferingPresetSelect) {
			bufferingPresetSelect.addEventListener("change", () => {
				this._applyBufferingPreset(bufferingPresetSelect.value);
			});
		}

		const bufferInputs = [
			"enable-cache-checkbox",
			"demuxer-max-bytes-input",
			"demuxer-max-back-bytes-input",
			"cache-secs-input",
			"demuxer-readahead-secs-input",
			"stream-buffer-size-input",
			"ytdlp-concurrent-fragments-input",
			"enable-reconnect-checkbox",
			"reconnect-delay-input",
		];
		bufferInputs.forEach((id) => {
			const el = document.getElementById(id);
			if (el) {
				const evt = el.type === "checkbox" ? "change" : "input";
				el.addEventListener(evt, () => this._syncBufferingPresetState());
			}
		});

		const recordBtns = document.querySelectorAll(".btn-record-keybind");
		recordBtns.forEach((btn) => {
			const input = btn.parentElement.querySelector("input");
			if (input) {
				btn.addEventListener("click", () => this._startRecording(btn, input));
			}
		});

		const reloadBtns = document.querySelectorAll(".section-reload-btn");
		reloadBtns.forEach((btn) => {
			btn.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				this._handleSectionReload(btn);
			});
		});

		const refreshDepsBtn = document.getElementById(
			"btn-force-refresh-dependencies",
		);
		if (refreshDepsBtn) {
			refreshDepsBtn.addEventListener("click", () =>
				this._handleForceRefreshDependencies(refreshDepsBtn),
			);
		}

		const copyDiagBtn = document.getElementById("btn-copy-diagnostics");
		if (copyDiagBtn) {
			copyDiagBtn.addEventListener("click", async () => {
				if (copyDiagBtn.disabled) return;
				copyDiagBtn.disabled = true;
				const originalHtml = copyDiagBtn.innerHTML;
				copyDiagBtn.textContent = "Generating Report...";

				this.showStatus("Collecting system diagnostics...");

				try {
					const response = await this.sendMessageAsync({
						action: "get_unified_diagnostics",
					});

					if (response?.success) {
						const blob = JSON.stringify(response.data || response.result || response, null, 2);
						await navigator.clipboard.writeText(blob);
						this.showStatus("Diagnostic report copied to clipboard!");
					} else {
						this.showStatus(response?.error || "Failed to generate report.", true);
					}
				} catch (e) {
					this.showStatus("Error: " + e.message, true);
				} finally {
					copyDiagBtn.disabled = false;
					copyDiagBtn.innerHTML = originalHtml;
				}
			});
		}

		// Initialize Favorite Settings Buttons
		this._initializeFavoriteButtons();

		// Apply initial view mode and category tab
		this.setSettingsMode(this.currentMode);
		this.applyCategoryFilter(this.currentCategory);
	}

	async _handleForceRefreshDependencies(btn) {
		if (btn.disabled) return;

		btn.disabled = true;
		const originalText = btn.textContent;
		btn.textContent = "Refreshing...";

		this.showStatus("Refreshing system dependencies...");

		try {
			const response = await this.sendMessageAsync({
				action: "force_refresh_dependencies",
			});
			if (response?.success) {
				this._renderDependencyStatus({
					mpv: response.mpv,
					ytdlp: response.ytdlp,
					ffmpeg: response.ffmpeg,
					node: response.node,
				});
				this.showStatus("Dependencies refreshed!");
			} else {
				this.showStatus("Failed to refresh dependencies.", true);
			}
		} catch (e) {
			this.showStatus("Error: " + e.message, true);
		} finally {
			btn.disabled = false;
			btn.textContent = originalText;
		}
	}

	async _handleSectionReload(btn) {
		if (btn.classList.contains("reloading")) return;

		btn.classList.add("reloading");

		this.showStatus("Syncing settings across all tabs...");

		try {
			const syncPromise = this.sendMessageAsync({
				action: "force_reload_settings",
			});
			const delayPromise = new Promise((resolve) => setTimeout(resolve, 600));

			await Promise.all([syncPromise, delayPromise]);

			const response = await this.sendMessageAsync({
				action: "get_ui_preferences",
			});
			if (response?.success) {
				this.updateAllPreferencesUI(response.preferences);
			}

			setTimeout(() => {
				btn.classList.remove("reloading");
				this.showStatus("Settings synchronized!");
			}, 200);
		} catch (e) {
			btn.classList.remove("reloading");
			this.showStatus("Failed to sync settings.", true);
		}
	}

	_toggleAutomaticMpvFlag(element) {
		element.classList.toggle("disabled");
		this.debouncedSaveAllPreferences();
	}

	setSettingsMode(mode) {
		this.currentMode = mode === "advanced" ? "advanced" : "simple";
		try {
			localStorage.setItem("mpv_settings_view_mode", this.currentMode);
		} catch (e) {
			console.debug("[Settings] Failed to save settings view mode:", e);
		}

		const container = document.getElementById("shared-settings-container");
		if (container) {
			if (this.currentMode === "simple") {
				container.classList.add("mode-simple");
				container.classList.remove("mode-advanced");
			} else {
				container.classList.add("mode-advanced");
				container.classList.remove("mode-simple");
			}
		}

		const btnSimple = document.getElementById("btn-mode-simple");
		const btnAdvanced = document.getElementById("btn-mode-advanced");
		if (btnSimple && btnAdvanced) {
			btnSimple.classList.toggle("active", this.currentMode === "simple");
			btnAdvanced.classList.toggle("active", this.currentMode === "advanced");
		}

		const searchInput = document.getElementById("settings-search-input");
		if (searchInput && searchInput.value.trim()) {
			this._handleSettingsSearch(searchInput.value);
		}
	}

	_getSettingIdentifier(group) {
		if (!group) return null;
		if (group.dataset.settingId) return group.dataset.settingId;
		const favBtn = group.querySelector(".btn-fav-setting");
		if (favBtn?.dataset?.settingId) return favBtn.dataset.settingId;
		const input = group.querySelector(
			"input, select, textarea, button:not(.btn-fav-setting)",
		);
		if (input && input.id) return input.id;
		if (group.id) return group.id;
		if (group.dataset.settingName)
			return group.dataset.settingName.trim().replace(/\s+/g, "-");
		return null;
	}

	_initializeFavoriteButtons() {
		const wrapper = document.getElementById("settings-sections-wrapper");
		if (!wrapper) return;

		const groups = wrapper.querySelectorAll(".control-group, .setting-item");
		groups.forEach((group) => {
			if (group.id === "custom-geometry-container") return;
			const id = this._getSettingIdentifier(group);
			if (!id) return;
			if (group.querySelector(".btn-fav-setting")) return;

			const starBtn = document.createElement("button");
			starBtn.type = "button";
			starBtn.className = "btn-fav-setting";
			starBtn.dataset.settingId = id;
			starBtn.title = this.favoriteSettings.has(id)
				? "Remove from Favorites"
				: "Pin to Favorites";
			starBtn.innerHTML =
				'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';

			const label = group.querySelector(".settings-label, label");
			if (label) {
				label.insertAdjacentElement("beforebegin", starBtn);
			} else {
				group.insertAdjacentElement("afterbegin", starBtn);
			}

			starBtn.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				this._toggleFavorite(id);
			});
		});

		this._updateFavoriteUI();
	}

	_toggleFavorite(id) {
		if (this.favoriteSettings.has(id)) {
			this.favoriteSettings.delete(id);
		} else {
			this.favoriteSettings.add(id);
		}

		try {
			localStorage.setItem(
				"mpv_favorite_settings",
				JSON.stringify([...this.favoriteSettings]),
			);
		} catch (e) {
			console.debug("[Settings] Failed to save favorite settings:", e);
		}

		this._updateFavoriteUI();

		if (this.currentCategory === "favorites") {
			this.applyCategoryFilter("favorites");
		}
	}

	_updateFavoriteUI() {
		const starBtns = document.querySelectorAll(".btn-fav-setting");
		starBtns.forEach((btn) => {
			const isFav = this.favoriteSettings.has(btn.dataset.settingId);
			btn.classList.toggle("is-favorite", isFav);
			btn.title = isFav ? "Remove from Favorites" : "Pin to Favorites";
			const group = btn.closest(".control-group, .setting-item");
			if (group) {
				group.classList.toggle("is-favorite-setting", isFav);
			}
		});

		const favTab = document.querySelector(
			'.cat-tab-btn[data-category="favorites"], .cat-tab-btn[data-cat="favorites"]',
		);
		if (favTab) {
			const label = favTab.querySelector(".fav-tab-label");
			const count = this.favoriteSettings.size;
			if (label) {
				label.textContent = count > 0 ? `Favorites (${count})` : "Favorites";
			} else {
				favTab.textContent = count > 0 ? `Favorites (${count})` : "Favorites";
			}
		}
	}

	applyCategoryFilter(cat = "all") {
		this.currentCategory = cat;
		try {
			localStorage.setItem("mpv_settings_category", this.currentCategory);
		} catch (e) {
			console.debug("[Settings] Failed to save settings category:", e);
		}

		const catTabs = document.querySelectorAll(".cat-tab-btn");
		catTabs.forEach((tab) => {
			const tabCat = tab.dataset.category || tab.dataset.cat;
			tab.classList.toggle("active", tabCat === this.currentCategory);
		});

		const searchInput = document.getElementById("settings-search-input");
		if (searchInput && searchInput.value) {
			searchInput.value = "";
			const clearBtn = document.getElementById("btn-clear-settings-search");
			if (clearBtn) clearBtn.style.display = "none";
			const statusEl = document.getElementById("settings-search-status");
			if (statusEl) {
				statusEl.textContent = "";
				statusEl.style.display = "none";
			}
		}

		const wrapper = document.getElementById("settings-sections-wrapper");
		if (!wrapper) return;
		const sections = wrapper.querySelectorAll(".settings-section");
		const emptyNotice = document.getElementById("favorites-empty-notice");

		if (this.currentCategory === "favorites") {
			const hasFavorites = this.favoriteSettings.size > 0;
			if (emptyNotice) {
				emptyNotice.style.display = hasFavorites ? "none" : "flex";
			}

			sections.forEach((section) => {
				section.style.borderColor = "var(--border-primary)";
				section.style.boxShadow = "none";

				section
					.querySelectorAll(".settings-compact-separator, .settings-group-header")
					.forEach((el) => {
						el.style.display = "none";
					});

				const items = section.querySelectorAll(".control-group, .setting-item");
				let sectionFavCount = 0;

				items.forEach((item) => {
					if (item.id === "custom-geometry-container") {
						const geometrySelect = document.getElementById("geometry-select");
						const geomGroup = geometrySelect?.closest(".control-group");
						const isGeomFav = geomGroup && this.favoriteSettings.has(this._getSettingIdentifier(geomGroup));
						item.style.display =
							isGeomFav && geometrySelect?.value === "custom"
								? "flex"
								: "none";
						item.classList.toggle("fav-visible-override", Boolean(isGeomFav));
						return;
					}

					item.style.backgroundColor = "transparent";
					const id = this._getSettingIdentifier(item);
					const isFav = this.favoriteSettings.has(id);

					if (isFav) {
						item.style.display = "";
						item.classList.add("fav-visible-override");
						sectionFavCount++;
					} else {
						item.style.display = "none";
						item.classList.remove("fav-visible-override");
					}
				});

				if (sectionFavCount > 0) {
					section.style.display = "block";
					section.open = true;
				} else {
					section.style.display = "none";
				}
			});
		} else {
			if (emptyNotice) emptyNotice.style.display = "none";

			sections.forEach((section) => {
				section.style.borderColor = "var(--border-primary)";
				section.style.boxShadow = "none";

				section
					.querySelectorAll(".settings-compact-separator, .settings-group-header")
					.forEach((el) => {
						el.style.display = "";
					});

				const items = section.querySelectorAll(".control-group, .setting-item");
				items.forEach((item) => {
					if (item.id === "custom-geometry-container") {
						const geometrySelect = document.getElementById("geometry-select");
						item.style.display =
							geometrySelect?.value === "custom" ? "flex" : "none";
						item.style.backgroundColor = "transparent";
						item.classList.remove("fav-visible-override");
						return;
					}
					item.style.display = "";
					item.style.backgroundColor = "transparent";
					item.classList.remove("fav-visible-override");
				});

				const secCat = section.dataset.category || section.dataset.cat;
				if (this.currentCategory === "all") {
					section.style.display = "block";
				} else if (secCat === this.currentCategory) {
					section.style.display = "block";
					section.open = true;
				} else {
					section.style.display = "none";
				}
			});
		}
	}

	_getBufferingPresets() {
		return {
			default: {
				enableCache: true,
				demuxerMaxBytes: "1G",
				demuxerMaxBackBytes: "500M",
				cacheSecs: 500,
				demuxerReadaheadSecs: 500,
				streamBufferSize: "10M",
				ytdlpConcurrentFragments: 4,
				enableReconnect: true,
				reconnectDelay: 4,
			},
			smooth: {
				enableCache: true,
				demuxerMaxBytes: "2G",
				demuxerMaxBackBytes: "1G",
				cacheSecs: 1200,
				demuxerReadaheadSecs: 1200,
				streamBufferSize: "32M",
				ytdlpConcurrentFragments: 8,
				enableReconnect: true,
				reconnectDelay: 2,
			},
			"low-ram": {
				enableCache: true,
				demuxerMaxBytes: "250M",
				demuxerMaxBackBytes: "50M",
				cacheSecs: 60,
				demuxerReadaheadSecs: 60,
				streamBufferSize: "2M",
				ytdlpConcurrentFragments: 2,
				enableReconnect: true,
				reconnectDelay: 4,
			},
		};
	}

	_applyBufferingPreset(presetKey) {
		if (presetKey === "custom") return;
		const presets = this._getBufferingPresets();
		const preset = presets[presetKey];
		if (!preset) return;

		const cacheEl = document.getElementById("enable-cache-checkbox");
		const maxBytesEl = document.getElementById("demuxer-max-bytes-input");
		const maxBackBytesEl = document.getElementById("demuxer-max-back-bytes-input");
		const cacheSecsEl = document.getElementById("cache-secs-input");
		const readaheadSecsEl = document.getElementById("demuxer-readahead-secs-input");
		const bufferSizeEl = document.getElementById("stream-buffer-size-input");
		const fragmentsEl = document.getElementById("ytdlp-concurrent-fragments-input");
		const reconnectEl = document.getElementById("enable-reconnect-checkbox");
		const reconnectDelayEl = document.getElementById("reconnect-delay-input");

		if (cacheEl) cacheEl.checked = preset.enableCache;
		if (maxBytesEl) maxBytesEl.value = preset.demuxerMaxBytes;
		if (maxBackBytesEl) maxBackBytesEl.value = preset.demuxerMaxBackBytes;
		if (cacheSecsEl) cacheSecsEl.value = preset.cacheSecs;
		if (readaheadSecsEl) readaheadSecsEl.value = preset.demuxerReadaheadSecs;
		if (bufferSizeEl) bufferSizeEl.value = preset.streamBufferSize;
		if (fragmentsEl) fragmentsEl.value = preset.ytdlpConcurrentFragments;
		if (reconnectEl) reconnectEl.checked = preset.enableReconnect;
		if (reconnectDelayEl) reconnectDelayEl.value = preset.reconnectDelay;

		this.debouncedSaveAllPreferences();
	}

	_detectBufferingPreset(prefs) {
		if (!prefs) return "custom";
		const presets = this._getBufferingPresets();
		for (const [key, preset] of Object.entries(presets)) {
			const matches =
				(prefs.enableCache ?? true) === preset.enableCache &&
				String(prefs.demuxerMaxBytes ?? "1G").toUpperCase() === preset.demuxerMaxBytes.toUpperCase() &&
				String(prefs.demuxerMaxBackBytes ?? "500M").toUpperCase() === preset.demuxerMaxBackBytes.toUpperCase() &&
				Number(prefs.cacheSecs ?? 500) === preset.cacheSecs &&
				Number(prefs.demuxerReadaheadSecs ?? 500) === preset.demuxerReadaheadSecs &&
				String(prefs.streamBufferSize ?? "10M").toUpperCase() === preset.streamBufferSize.toUpperCase() &&
				Number(prefs.ytdlpConcurrentFragments ?? 4) === preset.ytdlpConcurrentFragments &&
				(prefs.enableReconnect ?? true) === preset.enableReconnect &&
				Number(prefs.reconnectDelay ?? 4) === preset.reconnectDelay;

			if (matches) return key;
		}
		return "custom";
	}

	_syncBufferingPresetState() {
		const currentValues = {
			enableCache: document.getElementById("enable-cache-checkbox")?.checked,
			demuxerMaxBytes: document.getElementById("demuxer-max-bytes-input")?.value,
			demuxerMaxBackBytes: document.getElementById("demuxer-max-back-bytes-input")?.value,
			cacheSecs: document.getElementById("cache-secs-input")?.value,
			demuxerReadaheadSecs: document.getElementById("demuxer-readahead-secs-input")?.value,
			streamBufferSize: document.getElementById("stream-buffer-size-input")?.value,
			ytdlpConcurrentFragments: document.getElementById("ytdlp-concurrent-fragments-input")?.value,
			enableReconnect: document.getElementById("enable-reconnect-checkbox")?.checked,
			reconnectDelay: document.getElementById("reconnect-delay-input")?.value,
		};
		const matched = this._detectBufferingPreset(currentValues);
		const select = document.getElementById("buffering-preset-select");
		if (select) {
			select.value = matched;
		}
	}

	_handleSettingsSearch(query) {
		const wrapper = document.getElementById("settings-sections-wrapper");
		if (!wrapper) return;

		const sections = Array.from(wrapper.querySelectorAll(".settings-section"));
		const normalizedQuery = (query || "").toLowerCase().trim();
		const clearBtn = document.getElementById("btn-clear-settings-search");
		const statusEl = document.getElementById("settings-search-status");

		if (clearBtn) {
			clearBtn.style.display = normalizedQuery ? "inline-flex" : "none";
		}

		if (!normalizedQuery) {
			if (statusEl) {
				statusEl.textContent = "";
				statusEl.style.display = "none";
			}
			this.applyCategoryFilter(this.currentCategory);
			return;
		}

		if (statusEl) {
			statusEl.style.display = "flex";
		}

		const emptyNotice = document.getElementById("favorites-empty-notice");
		if (emptyNotice) emptyNotice.style.display = "none";

		let totalMatches = 0;
		const isSimpleMode = this.currentMode === "simple";
		const isFavoritesTab = this.currentCategory === "favorites";

		sections.forEach((section) => {
			const sectionName = (section.dataset.sectionName || "").toLowerCase();
			const sectionTitle = (section.querySelector("summary span")?.textContent || "").toLowerCase();
			const sectionMatches = sectionName.includes(normalizedQuery) || sectionTitle.includes(normalizedQuery);

			section
				.querySelectorAll(".settings-compact-separator, .settings-group-header")
				.forEach((el) => {
					el.style.display = "none";
				});

			const items = Array.from(section.querySelectorAll(".control-group, .setting-item"));
			let sectionMatchCount = 0;

			items.forEach((item) => {
				if (item.id === "custom-geometry-container") {
					const geometrySelect = document.getElementById("geometry-select");
					const geomGroup = geometrySelect?.closest(".control-group");
					const geomVisible = geomGroup && geomGroup.style.display !== "none";
					item.style.display =
						geomVisible && geometrySelect?.value === "custom"
							? "flex"
							: "none";
					return;
				}

				const isAdvancedItem =
					item.classList.contains("setting-advanced") ||
					item.closest(".group-advanced") !== null;

				if (isFavoritesTab) {
					const id = this._getSettingIdentifier(item);
					if (!this.favoriteSettings.has(id)) {
						item.style.display = "none";
						item.style.backgroundColor = "transparent";
						return;
					}
				} else if (isSimpleMode && isAdvancedItem) {
					item.style.display = "none";
					item.style.backgroundColor = "transparent";
					return;
				}

				const settingName = (item.dataset.settingName || "").toLowerCase();
				const textContent = (item.textContent || "").toLowerCase();
				const helpTitle = (item.querySelector(".help-icon")?.getAttribute("title") || "").toLowerCase();

				const matches =
					sectionMatches ||
					settingName.includes(normalizedQuery) ||
					textContent.includes(normalizedQuery) ||
					helpTitle.includes(normalizedQuery);

				if (matches) {
					item.style.display = "";
					item.style.backgroundColor = "rgba(88, 101, 242, 0.12)";
					if (isFavoritesTab) item.classList.add("fav-visible-override");
					sectionMatchCount++;
					totalMatches++;
				} else {
					item.style.display = "none";
					item.style.backgroundColor = "transparent";
				}
			});

			if (sectionMatchCount > 0 || (sectionMatches && !isFavoritesTab)) {
				section.style.display = "block";
				section.open = true;
				section.style.borderColor = "var(--accent-primary)";
				section.style.boxShadow = "0 0 10px rgba(88, 101, 242, 0.2)";
			} else {
				section.style.display = "none";
				section.style.borderColor = "var(--border-primary)";
				section.style.boxShadow = "none";
			}
		});

		if (statusEl) {
			if (totalMatches > 0) {
				const suffix = isFavoritesTab
					? " in Favorites"
					: isSimpleMode
						? " (Simple mode — switch to Advanced for more)"
						: "";
				statusEl.textContent = `Found ${totalMatches} matching setting${totalMatches === 1 ? "" : "s"}${suffix}`;
			} else {
				statusEl.textContent = `No settings found matching "${query}"`;
			}
		}
	}

	_startRecording(btn, input) {
		this._stopRecording();

		this.activeRecorder = { btn, input, originalValue: input.value };
		btn.classList.add("recording");
		btn.innerHTML =
			'<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4"/><path d="M12 18v4"/><path d="M4.93 4.93l2.83 2.83"/><path d="M16.24 16.24l2.83 2.83"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="M4.93 19.07l2.83-2.83"/><path d="M16.24 7.76l2.83-2.83"/></svg>';
		input.value = "Press combination...";
		input.classList.add("recording-active");

		this.keyHandler = (e) => {
			e.preventDefault();
			e.stopPropagation();

			const forbiddenKeys = [
				"Control",
				"Shift",
				"Alt",
				"Meta",
				"CapsLock",
				"Tab",
			];
			if (forbiddenKeys.includes(e.key)) return;

			const combo = [];
			if (e.ctrlKey) combo.push("Ctrl");
			if (e.shiftKey) combo.push("Shift");
			if (e.altKey) combo.push("Alt");
			if (e.metaKey) combo.push("Meta");

			let keyName = e.key;
			if (keyName === " ") keyName = "Space";
			if (keyName.length === 1) keyName = keyName.toUpperCase();

			combo.push(keyName);

			const comboStr = combo.join("+");
			input.value = comboStr;
			this._stopRecording();
			this.debouncedSaveAllPreferences();
		};

		window.addEventListener("keydown", this.keyHandler, true);

		this.escHandler = (e) => {
			if (e.key === "Escape") {
				input.value = this.activeRecorder.originalValue;
				this._stopRecording();
			}
		};
		window.addEventListener("keydown", this.escHandler);
	}

	_stopRecording() {
		if (this.activeRecorder) {
			this.activeRecorder.btn.classList.remove("recording");
			this.activeRecorder.btn.innerHTML =
				'<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>';
			this.activeRecorder.input.classList.remove("recording-active");
			this.activeRecorder = null;
		}
		if (this.keyHandler)
			window.removeEventListener("keydown", this.keyHandler, true);
		if (this.escHandler) window.removeEventListener("keydown", this.escHandler);
	}

	async _resetAutomaticMpvFlags() {
		const response = await this.sendMessageAsync({
			action: "get_default_automatic_flags",
		});
		if (response && response.flags) {
			this._renderAutomaticMpvFlagsList(response.flags);
			this.debouncedSaveAllPreferences();
		}
	}
}
