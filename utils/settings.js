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
				key: "ultraVideoSync",
				elementId: "ultra-video-sync-checkbox",
				type: "checkbox",
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
			"ultra-video-sync-checkbox",
		);
		const interpSelect = document.getElementById("ultra-interpolation-select");
		if (videoSyncCheckbox && interpSelect) {
			const isSyncEnabled = videoSyncCheckbox.checked;
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
		} catch (e) {}

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

				if (mapping.elementId === "ultra-video-sync-checkbox") {
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

	_handleSettingsSearch(query) {
		const wrapper = document.getElementById("settings-sections-wrapper");
		const sections = Array.from(wrapper.querySelectorAll(".settings-section"));
		const normalizedQuery = query.toLowerCase().trim();

		if (!normalizedQuery) {
			sections.sort((a, b) => 0);
			sections.forEach((s) => {
				s.style.display = "block";
				s.style.boxShadow = "none";
				s.style.borderColor = "var(--border-primary)";
			});
			return;
		}

		const scoredSections = sections.map((section) => {
			const sectionName = section.dataset.sectionName || "";
			const settings = Array.from(
				section.querySelectorAll(".control-group, .setting-item"),
			);

			let bestScore = 0;
			if (sectionName.includes(normalizedQuery)) bestScore = 10;

			settings.forEach((setting) => {
				const settingName = setting.dataset.settingName || "";
				if (settingName.includes(normalizedQuery)) {
					bestScore = Math.max(bestScore, 5);
					setting.style.backgroundColor = "rgba(88, 101, 242, 0.1)";
				} else {
					setting.style.backgroundColor = "transparent";
				}
			});

			return { element: section, score: bestScore };
		});

		scoredSections.sort((a, b) => b.score - a.score);

		scoredSections.forEach((item) => {
			wrapper.appendChild(item.element);
			if (item.score > 0) {
				item.element.open = true;
				item.element.style.borderColor = "var(--accent-primary)";
				item.element.style.boxShadow = "0 0 10px rgba(88, 101, 242, 0.2)";
			} else {
				item.element.style.borderColor = "var(--border-primary)";
				item.element.style.boxShadow = "none";
			}
		});
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
