import * as settingsLists from "../popup/settings_lists.js";
import * as settingsDiagnostics from "../popup/settings_diagnostics.js";
import * as settingsUi from "../popup/settings_ui.js";

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
		const ultraOptionsContainer = document.getElementById(
			"ultra-options-container",
		);
		if (ultraOptionsContainer) {
			ultraOptionsContainer.style.display = isUltra ? "block" : "none";
		}

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
			if (mapping.type === "custom") return;
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

		const customGeometryContainer = document.getElementById(
			"custom-geometry-container",
		);
		if (customGeometryContainer) {
			customGeometryContainer.style.display = isCustom ? "flex" : "none";
		}
		const enableAnilist = prefs.enableAnilistIntegration ?? true;
		const anilistOptionsContainer = document.getElementById(
			"anilist-options-container",
		);
		if (anilistOptionsContainer) {
			anilistOptionsContainer.style.display = enableAnilist
				? "block"
				: "none";
		}
		const sharedAnilistSection = document.getElementById(
			"shared-anilist-section",
		);
		if (sharedAnilistSection) {
			sharedAnilistSection.style.display = enableAnilist ? "block" : "none";
		}

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
		this._updatePopupWidthLock(prefs.popupWidthLocked === true);

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
		settingsLists.renderRestrictedDomainsList(domains);
	}

	async _addRestrictedDomain() {
		return settingsLists.addRestrictedDomain(this);
	}

	async _removeRestrictedDomain(domainToRemove) {
		return settingsLists.removeRestrictedDomain(this, domainToRemove);
	}

	_renderDependencyStatus(status) {
		settingsDiagnostics.renderDependencyStatus(status);
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
			if (mapping.type === "custom") return;
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
		} else {
			preferences.automaticMpvFlags = [];
		}

		preferences.streamScannerTimeout =
			Number(preferences.streamScannerTimeout) || 60;

		this.sendMessageAsync({
			action: "set_ui_preferences",
			preferences: preferences,
		})
			.then((response) => {
				if (!response?.success) {
					this.showStatus("Failed to save settings.", true);
				}
			})
			.catch((err) => {
				console.error("[SettingsManager] Failed to save settings:", err);
				this.showStatus("Failed to save settings.", true);
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
		const anilistSizeEl = document.getElementById("anilist-image-size-current");
		if (anilistSizeEl) {
			anilistSizeEl.textContent = `${effectiveHeight}px`;
		}
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
		settingsLists.renderMpvFlagsList(flags);
	}

	_renderAutomaticMpvFlagsList(flags = []) {
		settingsLists.renderAutomaticMpvFlagsList(flags);
	}

	_addMpvFlag() {
		settingsLists.addMpvFlag(this);
	}

	_toggleMpvFlag(element) {
		settingsLists.toggleMpvFlag(this, element);
	}

	_removeMpvFlag(element) {
		settingsLists.removeMpvFlag(this, element);
	}

	_resetMpvFlags() {
		settingsLists.resetMpvFlags(this);
	}

	_renderScraperFilterList(words = []) {
		settingsLists.renderScraperFilterList(words);
	}

	_renderBuiltInFilterList() {
		settingsLists.renderBuiltInFilterList();
	}

	async _addScraperFilterWord() {
		return settingsLists.addScraperFilterWord(this);
	}

	async _removeScraperFilterWord(wordToRemove) {
		return settingsLists.removeScraperFilterWord(this, wordToRemove);
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
				const ultraContainer = document.getElementById(
					"ultra-options-container",
				);
				if (ultraContainer) {
					ultraContainer.style.display =
						performanceProfileSelect.value === "ultra" ? "block" : "none";
				}
			});
		}

		const geometrySelect = document.getElementById("geometry-select");
		if (geometrySelect) {
			geometrySelect.addEventListener("change", () => {
				const customGeoContainer = document.getElementById(
					"custom-geometry-container",
				);
				if (customGeoContainer) {
					customGeoContainer.style.display =
						geometrySelect.value === "custom" ? "flex" : "none";
				}
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
				try {
					const response = await this.sendMessageAsync({
						action: "get_ui_preferences",
					});
					const currentlyLocked =
						response?.preferences?.popupWidthLocked === true;
					const newLockedState = !currentlyLocked;

					await this.sendMessageAsync({
						action: "set_ui_preferences",
						preferences: { popupWidthLocked: newLockedState },
					});
					this._updatePopupWidthLock(newLockedState);
				} catch (err) {
					console.error(
						"[SettingsManager] Failed to toggle popup width lock:",
						err,
					);
					this.showStatus("Failed to update popup width lock.", true);
				}
			});
		}

		const anilistEnableCheck = document.getElementById(
			"enable-anilist-integration-checkbox",
		);
		if (anilistEnableCheck) {
			anilistEnableCheck.addEventListener("change", () => {
				const isEnabled = anilistEnableCheck.checked;
				const anilistOptionsContainer = document.getElementById(
					"anilist-options-container",
				);
				if (anilistOptionsContainer) {
					anilistOptionsContainer.style.display = isEnabled ? "block" : "none";
				}
				const sharedAnilistSection = document.getElementById(
					"shared-anilist-section",
				);
				if (sharedAnilistSection) {
					sharedAnilistSection.style.display = isEnabled ? "block" : "none";
				}
				if (isEnabled && sharedAnilistSection?.open) {
					this.fetchAniListReleases(true);
				}
			});
		}

		const anilistCacheCheck = document.getElementById(
			"disable-anilist-cache-checkbox",
		);
		if (anilistCacheCheck) {
			anilistCacheCheck.addEventListener("change", () => {
				if (document.getElementById("shared-anilist-section")?.open) {
					this.fetchAniListReleases(true);
				}
			});
		}

		const manualYtdlpBtn = document.getElementById("btn-manual-ytdlp-update");
		if (manualYtdlpBtn) {
			manualYtdlpBtn.addEventListener("click", () => {
				this.showStatus("Starting yt-dlp update...");
				this.sendMessageAsync({ action: "manual_ytdlp_update" }).catch((err) => {
					console.error(
						"[SettingsManager] Failed to start yt-dlp update:",
						err,
					);
					this.showStatus("Failed to start yt-dlp update.", true);
				});
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

		settingsDiagnostics.bindDiagnosticsListeners(this);

		// Initialize Favorite Settings Buttons
		this._initializeFavoriteButtons();

		// Apply initial view mode and category tab
		this.setSettingsMode(this.currentMode);
		this.applyCategoryFilter(this.currentCategory);
	}

	_toggleAutomaticMpvFlag(element) {
		settingsLists.toggleAutomaticMpvFlag(this, element);
	}

	setSettingsMode(mode) {
		settingsUi.setSettingsMode(this, mode);
	}

	_getSettingIdentifier(group) {
		return settingsUi.getSettingIdentifier(group);
	}

	_initializeFavoriteButtons() {
		settingsUi.initializeFavoriteButtons(this);
	}

	_toggleFavorite(id) {
		settingsUi.toggleFavorite(this, id);
	}

	applyCategoryFilter(cat = "all") {
		settingsUi.applyCategoryFilter(this, cat);
	}

	_applyBufferingPreset(presetKey) {
		settingsLists.applyBufferingPreset(this, presetKey);
	}

	_detectBufferingPreset(prefs) {
		return settingsLists.detectBufferingPreset(prefs);
	}

	_syncBufferingPresetState() {
		settingsLists.syncBufferingPresetState();
	}

	_handleSettingsSearch(query) {
		settingsUi.handleSettingsSearch(this, query);
	}

	_startRecording(btn, input) {
		settingsUi.startRecording(this, btn, input);
	}

	async _resetAutomaticMpvFlags() {
		return settingsLists.resetAutomaticMpvFlags(this);
	}
}
