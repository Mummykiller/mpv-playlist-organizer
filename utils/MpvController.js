/**
 * @class MpvController
 * Coordinator for the MPV Playlist Organizer.
 * Namespaced Global version.
 */
window.MPV_INTERNAL = window.MPV_INTERNAL || {};

(() => {
	const MPV = window.MPV_INTERNAL;

	MPV.MpvController = class MpvController {
		constructor() {
			this.isTearingDown = false;
			this.tabId = null;
			this.observedFolderKey = null; // Key for the currently watched folder bucket
			this.preFullscreenPosition = null;
			this.preResizePosition = null;
			this._lastUpdateHash = "";
			this._lastPlaylistFingerprint = "";
			this._isPlaylistDirty = false;
			this.suppressedByWatchdog = false;

			// 1. Initialize Logic Modules
			this.timers = new MPV.ControllerTimers(this);
			this.actions = new MPV.ControllerActions(this);
			this.view = new MPV.ControllerView(this);
			this.bridge = new MPV.MessageBridge({
				onLog: (log) => this.addLogEntry(log),
			});

			this.state = new MPV.ContentState({
				onUpdate: (state) => this._syncUiToState(state),
			});

			this.nav = new MPV.NavigationObserver({
				onNavigation: (url) => this._handleNavigation(url),
				onMutation: () => this._handleDomMutation(),
				onValidate: () => {
					if (!document.getElementById("m3u8-controller-host")) {
						this._recoverFromHostRemoval();
					}
				},
			});

			// 2. Initialize UI Managers (PlaylistUI and AniListUI are instantiated in init() after Shadow DOM creation)
			this.ui = new MPV.UIManager();
			this.playlistUI = null;
			this.anilistUI = null;
			this.pageScraper = new MPV.PageScraper();

			// Unified Playback State Subscription (Must happen AFTER UI initialization)
			this.playbackUnsubscribe = null;
			this._storageListener = null;
			this._taskListener = null;
			this.focusListener = null;
			this.visibilityChangeListener = null;
			this.messageListener = null;

			// --- Message Dispatcher ---
			this.actionMap = {
				ping: (req, send) => send({ success: true }),
				init_ui_state: (req) => this._handleInitState(req),
				playlist_dirty: (req) => this.actionMap.render_playlist(req),
				render_playlist: (req) => {
					const currentFolderId =
						this.ui.shadowRoot?.getElementById("folder-select")?.value;

					const activePbFolder = MPV.playbackStateManager.state.folderId;
					const isMatchingActiveFolder = activePbFolder && req.folderId && activePbFolder.toLowerCase() === req.folderId.toLowerCase();
					if (req.isFolderActive || isMatchingActiveFolder || !activePbFolder) {
						// 1. Update Playback Status (Normalization handled by manager)
						MPV.playbackStateManager.update({
							folderId: req.folderId,
							isRunning: req.isFolderActive,
							isPaused: req.isPaused,
							isIdle: req.isIdle,
							isClosing: req.isClosing,
							lastPlayedId: req.lastPlayedId,
							needsAppend: req.needsAppend,
							sessionIds: req.sessionIds,
						});
					}

					// 2. Folder Guard for rendering
					if (req.folderId && currentFolderId && req.folderId.toLowerCase() !== currentFolderId.toLowerCase()) return;

					// 3. Visibility Guard: Mark as dirty and defer if tab is hidden
					if (document.visibilityState !== "visible") {
						this._isPlaylistDirty = true;
						return;
					}

					// 4. Render Playlist
					const playlistToRender = req.playlist;
					if (playlistToRender) {
						this._lastPlaylistFingerprint = this._getPlaylistFingerprint(playlistToRender);
						this.playlistUI?.render(
							playlistToRender,
							req.lastPlayedId || this.state.state.lastPlayedId,
							req.isFolderActive ?? this.state.state.isFolderActive,
							req.completedIds || []
						);
					} else {
						// Payload-less signal: fetch fresh data (usually from storage)
						this.refreshPlaylist(
							req.lastPlayedId || this.state.state.lastPlayedId, 
							req.isFolderActive ?? this.state.state.isFolderActive, 
							req.isPaused, 
							req.needsAppend,
							req.completedIds || []
						);
					}
				},
				detected_url_changed: (req) => {
					if (this.tabId && req.tabId !== this.tabId) return;

					if (req.url) {
						this.state.update({ detectedUrl: req.url });
					} else {
						this.state.update({ detectedUrl: null });
					}
					this.updateAddButtonState();
				},
				get_controller_state: (req, send) => {
					const folderId = this.ui.shadowRoot?.getElementById("folder-select")?.value;
					send({
						success: true,
						folderId: folderId,
						isFolderActive: this.state.state.isFolderActive,
						lastPlayedId: this.state.state.lastPlayedId,
						isClosing: this.state.state.isClosing,
						playlist: this.playlistUI?.currentPlaylist,
					});
				},
				folders_changed: (req) =>
					this.updateFolderDropdowns(
						req.folderId,
						req.lastPlayedId,
						req.isFolderActive,
					),
				last_folder_changed: (req) => this._syncFolderChange(req),
				update_playlist_item: (req) => {
					const currentFolderId = this.ui.shadowRoot?.getElementById("folder-select")?.value;
					if (currentFolderId && req.folderId && currentFolderId.toLowerCase() === req.folderId.toLowerCase()) {
						this.playlistUI?.updateItemDelta(req.itemId, req.delta);
					}
				},
				log: (req) => this.addLogEntry(req.log),
				preferences_changed: (req) => {
					if (req.preferences && Object.keys(req.preferences).length > 0) {
						let prefsToApply = req.preferences;

						// If a domain is specified and it's not the current domain,
						// only apply non-domain-specific preferences (global ones).
						if (req.domain && req.domain !== window.location.hostname) {
							const DOMAIN_KEYS = MPV.DOMAIN_SPECIFIC_KEYS || [];
							prefsToApply = {};
							for (const [key, value] of Object.entries(req.preferences)) {
								if (!DOMAIN_KEYS.includes(key)) {
									prefsToApply[key] = value;
								}
							}
						}

						if (Object.keys(prefsToApply).length > 0) {
							this.applyPreferences(prefsToApply);
						}
					} else {
						this.applyInitialState().then(() => this.refreshPlaylist());
					}
				},
				show_confirmation: (req, send) =>
					this._handleAsyncConfirmation(req, send),
				show_clear_confirmation: async (req) => {
					let message = "";
					
					if (req.scope === "all") {
						message = `MPV finished naturally. Clear the entire folder "${req.folderId}"?`;
					} else {
						let scopeText = "";
						if (req.titles && req.titles.length > 0) {
							// List all titles in separate lanes (even if only one)
							scopeText = "\n" + req.titles.map(t => ` • "${t}"`).join("\n");
						} else {
							scopeText = req.count > 1 ? `${req.count} items` : "item";
						}
						message = `MPV finished naturally. Clear ${scopeText}\nin "${req.folderId}"?`;
					}
					
					// Add Live Warning Footer if applicable
					// Only show if the folder is active, live removal is enabled, AND we aren't already quitting MPV
					if (this.state.state.isFolderActive && this.state.state.settings.liveRemoval && !req.isQuitting) {
						message += "\n\n(This will also remove them from the running MPV instance)";
					}
					
					const result = await this.showStackedClearConfirmation(req.folderId, message, req);
					
					if (result !== null) { 
						// result is either the final request data (confirmed) or false (cancelled)
						const confirmed = result !== false;
						const finalReq = confirmed ? result : req;

						this.bridge.send("confirm_clear_playlist", null, {
							confirmed,
							folderId: finalReq.folderId,
							playedIds: finalReq.playedIds,
							sessionIds: finalReq.sessionIds,
							scope: finalReq.scope,
						});
					}
				},
				set_minimized_state: (req, send) => {
					if (req.domain && req.domain !== window.location.hostname) {
						if (send) send({ success: true });
						return;
					}
					this.setMinimizedState(req.minimized);
					if (send) send({ success: true });
				},
				auto_add_state_changed: (req) => {
					this._updateAutoAddVisuals(req.active);
				},
				ytdlp_update_confirm: () => this._handleYtdlpUpdateConfirm(),
				scrape_and_get_details: async (req, send) => {
					// Prefer the URL passed in the request (from background scanner)
					// otherwise fall back to local state or current location.
					const url = req.detectedUrl || this.state.state.detectedUrl || window.location.href;
					const timeoutMs = typeof req.timeoutMs === "number" && req.timeoutMs > 0 ? req.timeoutMs : 1500;
					const details = await this.waitForAccurateDetails(url, timeoutMs, req.originPageUrl);
					send(details);
				},
			};

			// Bind core lifecycle and event methods
			this.handleMessage = this.handleMessage.bind(this);
			this.handleGlobalKeydown = this.handleGlobalKeydown.bind(this);
			this.handleFullscreenChange = this.handleFullscreenChange.bind(this);
		}

		_initPlaybackSubscription() {
			if (this.playbackUnsubscribe) {
				this.playbackUnsubscribe();
				this.playbackUnsubscribe = null;
			}
			this.playbackUnsubscribe = MPV.playbackStateManager.subscribe((pbState) => {
				const currentFolderId = this.ui.shadowRoot?.getElementById("folder-select")?.value;
				const isCurrentFolder = pbState.folderId && currentFolderId && pbState.folderId.toLowerCase() === currentFolderId.toLowerCase();

				// Map the playback status to internal ContentState
				this.state.update({
					isFolderActive: isCurrentFolder && (pbState.status !== "stopped" || pbState.needsAppend),
					lastPlayedId: isCurrentFolder ? pbState.lastPlayedId : this.state.state.lastPlayedId,
					isClosing: isCurrentFolder ? pbState.isClosing : false
				}, true);

				// Only update UI if we are looking at the relevant folder
				if (isCurrentFolder) {
					this.setPlaybackActive(
						pbState.status !== "stopped", 
						pbState.needsAppend, 
						pbState.status === "paused"
					);
					this.setPlaybackLoading(pbState.status === "loading");
					this.setPlaybackClosing(pbState.isClosing);
					
					if (pbState.lastPlayedId) {
						this.playlistUI?.syncActiveHighlight(pbState.lastPlayedId, pbState.status !== "stopped");
					}
				} else {
					this.setPlaybackActive(false, false, false);
					this.setPlaybackLoading(false);
					this.setPlaybackClosing(false);
					this.playlistUI?.syncActiveHighlight(null, false);
				}
			});
		}

		_initStorageObservation() {
			if (this._storageListener) {
				try {
					chrome.storage?.onChanged?.removeListener(this._storageListener);
				} catch (e) {
					console.debug("[MPV Controller] Chrome API call failed:", e?.message || e);
				}
			}
			this._storageListener = (changes, area) => {
				if (area !== "local" || this.isTearingDown) return;

				// 1. Settings Channel: Sync Layout & UI Prefs
				if (changes.mpv_settings) {
					const newSettings = changes.mpv_settings.newValue;
					if (newSettings && newSettings.uiPreferences) {
						const domain = window.location.hostname;
						const globalPrefs = newSettings.uiPreferences.global || {};
						const domainPrefs = (domain && newSettings.uiPreferences.domains?.[domain]) || {};
						const DOMAIN_KEYS = MPV.DOMAIN_SPECIFIC_KEYS || [];

						// Filter out domain-specific keys from globalPrefs
						const safeGlobalPrefs = {};
						for (const [key, value] of Object.entries(globalPrefs)) {
							if (!DOMAIN_KEYS.includes(key)) {
								safeGlobalPrefs[key] = value;
							}
						}

						// Merge safe global prefs with this domain's specific overrides
						this.applyPreferences({ ...safeGlobalPrefs, ...domainPrefs });
					}
				}

				// 2. Folder Index Channel: Sync Dropdowns
				if (changes.mpv_folder_index) {
					this.updateFolderDropdowns();
				}

				// 3. Dynamic Folder Channel: Sync Playlist Content
				if (this.observedFolderKey && changes[this.observedFolderKey]) {
					const newFolderData = changes[this.observedFolderKey].newValue;
					const currentFolderId = this.ui.shadowRoot?.getElementById("folder-select")?.value;
					
					if (newFolderData && currentFolderId) {
						const newFingerprint = this._getPlaylistFingerprint(newFolderData.playlist);
						const hasStructuralChange = newFingerprint !== this._lastPlaylistFingerprint;
						const hasHighlightChange = newFolderData.lastPlayedId !== this.state.state.lastPlayedId;

						if (hasStructuralChange) {
							this._lastPlaylistFingerprint = newFingerprint;
							this.playlistUI?.render(
								newFolderData.playlist,
								newFolderData.lastPlayedId || this.state.state.lastPlayedId,
								this.state.state.isFolderActive
							);
						} else if (hasHighlightChange) {
							// Surgical update: just the highlight
							this.playlistUI?.syncActiveHighlight(
								newFolderData.lastPlayedId, 
								this.state.state.isFolderActive
							);
						}
						
						// Always sync the playback manager state silently
						if (newFolderData.lastPlayedId) {
							this.state.update({ lastPlayedId: newFolderData.lastPlayedId }, true);
						}
					}
				}
			};
			if (this.checkContext() && chrome.storage?.onChanged) {
				try {
					chrome.storage.onChanged.addListener(this._storageListener);
				} catch (e) {
					console.debug("[MPV Controller] Chrome API call failed:", e?.message || e);
				}
			}
		}

		_getPlaylistFingerprint(playlist) {
			if (!playlist || !Array.isArray(playlist)) return "";
			// A fingerprint consists of the count and the ordered sequence of IDs + watch status.
			// This detects additions, removals, reorders, and status changes as a fallback for IPC.
			return `${playlist.length}:` + playlist.map(item => 
				`${item.id}:${!!item.watched}:${!!item.markedAsWatched}`
			).join(",");
		}

		_initTaskObservation() {
			if (this._taskListener) {
				try {
					chrome.storage?.onChanged?.removeListener(this._taskListener);
				} catch (e) {
					console.debug("[MPV Controller] Chrome API call failed:", e?.message || e);
				}
			}
			this._taskListener = (changes, area) => {
				if (area === "local" && changes.mpv_active_tasks && !this.isTearingDown) {
					this._updateTaskUI(changes.mpv_active_tasks.newValue);
				}
			};
			if (this.checkContext() && chrome.storage?.onChanged) {
				try {
					chrome.storage.onChanged.addListener(this._taskListener);
				} catch (e) {
					console.debug("[MPV Controller] Chrome API call failed:", e?.message || e);
				}
			}
		}

		_updateTaskUI(tasks) { return this.view.updateTaskUI(tasks); }

		_updateFolderSubscription(folderId) {
			this.observedFolderKey = folderId ? `mpv_folder_data_${folderId}` : null;
		}

		async init() {
			// Strict Invariant: Never render or mount controller in an iframe
			let isTopFrame = false;
			try {
				isTopFrame = window.top === window.self;
			} catch (e) {
				isTopFrame = false;
			}
			if (!isTopFrame || !this.checkContext()) return;

			// Revive state & modules if re-initializing after teardown()
			this.isTearingDown = false;
			this._initialStateApplied = false;
			this._lastUpdateHash = "";
			if (this.bridge) this.bridge.isDestroyed = false;
			if (this.state) this.state.isDestroyed = false;
			if (this.nav) {
				if (this.nav.observer || this.nav.pollInterval) {
					this.nav.destroy();
				}
				this.nav.isDestroyed = false;
			}

			// Setup message listener before awaiting get_ui_preferences so ping succeeds
			if (this.messageListener) {
				try {
					chrome.runtime?.onMessage?.removeListener(this.messageListener);
				} catch (e) {
					console.debug("[MPV Controller] Chrome API call failed:", e?.message || e);
				}
			}
			this.messageListener = (req, sender, send) =>
				this.handleMessage(req, sender, send);
			if (this.checkContext() && chrome.runtime?.onMessage) {
				try {
					chrome.runtime.onMessage.addListener(this.messageListener);
				} catch (e) {
					console.debug("[MPV Controller] Chrome API call failed:", e?.message || e);
				}
			}

			const initialPrefs = await this.bridge.send("get_ui_preferences");
			if (this.isTearingDown || !this.checkContext()) return;
			const restrictedDomains =
				initialPrefs?.preferences?.restrictedDomains || [];
			const currentHostname = window.location.hostname;

			const isRestricted = restrictedDomains.some(
				(domain) =>
					currentHostname === domain || currentHostname.endsWith("." + domain),
			);

			if (isRestricted) {
				this.teardown();
				return;
			}

			if (!this._storageListener) this._initStorageObservation();
			if (!this._taskListener) this._initTaskObservation();
			if (!this.playbackUnsubscribe) this._initPlaybackSubscription();

			window.mpvControllerInitialized = true;

			// 1. Prepare UI
			this.ui.createAndInjectUi();

			// 2. Initialize UI Components
			this.playlistUI = new MPV.PlaylistUI(this, this.ui);
			this.anilistUI = new MPV.AniListUI(this, this.ui);

			this.playlistUI.bindEvents();
			this.anilistUI.bindEvents();
			this._bindControllerEvents();

			// Check for any active tasks now that the UI shadowRoot exists
			if (this.checkContext() && chrome.storage?.local) {
				try {
					chrome.storage.local.get("mpv_active_tasks", (data) => {
						if (!this.isTearingDown && data?.mpv_active_tasks) {
							this._updateTaskUI(data.mpv_active_tasks);
						}
					});
				} catch (e) {
					console.debug("[MPV Controller] Chrome API call failed:", e?.message || e);
				}
			}

			// 3. Start Observation Modules
			this.nav.init();
			this._reportCurrentUrl();
			this._startHeartbeat();

			// 4. Initial Sync
			await this.applyInitialState();
			if (this.isTearingDown || !this.checkContext()) return;
			this._initialStateApplied = true;
			await this.updateFolderDropdowns();
			if (this.isTearingDown || !this.checkContext()) return;

			await this.bridge.send("content_script_init");
			if (this.isTearingDown || !this.checkContext()) return;

			// 5. Fullscreen & Visibility Watchdog
			this._initFullscreenSettleCheck();
			this._startVisualWatchdog();

			// 6. Global Event Listeners
			if (this.focusListener) {
				window.removeEventListener("focus", this.focusListener);
			}
			this.focusListener = this._safeWrap(() => {
				// Proactively refresh status when tab gains focus
				this.refreshPlaylist();
			});
			window.addEventListener("focus", this.focusListener);

			if (this.visibilityChangeListener) {
				document.removeEventListener("visibilitychange", this.visibilityChangeListener);
			}
			this.visibilityChangeListener = this._safeWrap(() => {
				if (document.visibilityState === "visible") {
					if (this._isPlaylistDirty) {
						this.refreshPlaylist();
						this._isPlaylistDirty = false;
					}
					MPV.playbackStateManager.requestSync();
				}
			});
			document.addEventListener("visibilitychange", this.visibilityChangeListener);
		}

		handleMessage(request, sender, sendResponse) {
			if (this.isTearingDown || !request || typeof request !== "object") return;
			const action =
				request.action || (request.foldersChanged ? "folders_changed" : null);
			const handler = Object.hasOwn(this.actionMap, action) ? this.actionMap[action] : null;

			if (handler) {
				try {
					const result = handler(request, sendResponse);
					// If the handler returns a Promise (indicating async work), return true to keep the channel open.
					if (result instanceof Promise) {
						result.catch((err) => {
							MPV.logger?.error(`[Controller] Async error in action '${action}': ${err.message}`, { persist: true, stack: err.stack });
							this.updateStatusBanner?.(`Error in ${action}`, false);
							if (sendResponse) sendResponse({ success: false, error: err.message });
						});
						return true;
					}
					return result; // For sync handlers, return their result (though usually void)
				} catch (err) {
					MPV.logger?.error(`[Controller] Sync error in action '${action}': ${err.message}`, { persist: true, stack: err.stack });
					this.updateStatusBanner?.(`Error in ${action}`, false);
					if (sendResponse) sendResponse({ success: false, error: err.message });
				}
			}
		}

		destroy() {
			this.teardown();
		}

		teardown() {
			this.isTearingDown = true;
			if (this.playbackUnsubscribe) {
				this.playbackUnsubscribe();
				this.playbackUnsubscribe = null;
			}
			if (this._storageListener) {
				try {
					chrome.storage?.onChanged?.removeListener(this._storageListener);
				} catch (e) {
					console.debug("[MPV Controller] Chrome API call failed:", e?.message || e);
				}
				this._storageListener = null;
			}
			if (this._taskListener) {
				try {
					chrome.storage?.onChanged?.removeListener(this._taskListener);
				} catch (e) {
					console.debug("[MPV Controller] Chrome API call failed:", e?.message || e);
				}
				this._taskListener = null;
			}
			this.bridge.destroy();
			this.state.destroy();
			this.nav.destroy();
			this.timers?.destroy();
			if (this.resizeListener) {
				window.removeEventListener("resize", this.resizeListener);
				this.resizeListener = null;
			}
			if (this.focusListener) {
				window.removeEventListener("focus", this.focusListener);
				this.focusListener = null;
			}
			if (this.visibilityChangeListener) {
				document.removeEventListener("visibilitychange", this.visibilityChangeListener);
				this.visibilityChangeListener = null;
			}
			document.removeEventListener(
				"fullscreenchange",
				this.handleFullscreenChange,
			);
			window.removeEventListener("keydown", this.handleGlobalKeydown, true);
			this.ui.teardown();
			this.playlistUI?.destroy?.();
			if (this.anilistUI?.destroy) this.anilistUI.destroy();
			if (this.draggableController) this.draggableController.destroy();
			if (this.draggableMinimized) this.draggableMinimized.destroy();
			window.mpvControllerInitialized = false;
			if (this.messageListener) {
				try {
					chrome.runtime?.onMessage?.removeListener(this.messageListener);
				} catch (e) {
					console.debug("[MPV Controller] Chrome API call failed:", e?.message || e);
				}
				this.messageListener = null;
			}
		}

		// --- State & UI Persistence ---

		savePreference(prefs) {
			return this.bridge.send("set_ui_preferences", null, { preferences: prefs });
		}

		setMinimizedState(shouldBeMinimized, save = true) {
			this.state.update({ minimized: shouldBeMinimized });
			if (save) {
				this.savePreference({ minimized: shouldBeMinimized });
			}
		}

		setPinState(shouldBePinned, save = true) {
			this.state.update({ pinned: shouldBePinned });
			if (save) this.savePreference({ pinned: shouldBePinned });
		}

		// --- State & UI Synchronization ---

		_syncUiToState(state) { return this.view.syncUiToState(state); }

		async applyInitialState(positionOverride = null) { return this.view.applyInitialState(positionOverride); }

		applyPreferences(prefs) { return this.view.applyPreferences(prefs); }

		// --- Message Logic Handlers ---

		async _handleInitState(req) {
			if (!this.ui.controllerHost || this.isTearingDown || !this.checkContext()) return;
			this.tabId = req.tabId;
			this.bridge.tabId = req.tabId;

			if (!this._initialStateApplied) {
				await this.applyInitialState();
				if (this.isTearingDown || !this.checkContext()) return;
				this._initialStateApplied = true;
			}

			this.setMinimizedState(req.shouldBeMinimized, false);
			if (req.detectedUrl) {
				this.state.update({ detectedUrl: req.detectedUrl });
			}
			if (req.folderId) {
				// Proactively seed the state
				MPV.playbackStateManager.update({
					folderId: req.folderId,
					lastPlayedId: req.lastPlayedId,
					isRunning: req.isFolderActive,
					isPaused: req.isPaused,
					needsAppend: req.needsAppend
				});

				await this.updateFolderDropdowns(
					req.folderId,
					req.lastPlayedId,
					req.isFolderActive,
					req.isPaused,
					req.needsAppend
				);
				if (this.isTearingDown || !this.checkContext()) return;
			}
		}

		async _handleYtdlpUpdateConfirm() {
			try {
				const confirmed = await this.showPageLevelConfirmation(
					"YouTube playback failed. This is often caused by an outdated yt-dlp. Would you like to attempt to automatically update it now?",
				);
				if (confirmed && this.checkContext()) {
					try {
						chrome.runtime.sendMessage({ action: "user_confirmed_ytdlp_update" });
					} catch (e) {
					console.debug("[MPV Controller] Chrome API call failed:", e?.message || e);
				}
				}
			} catch (e) {
				MPV.logger?.warn?.("[Controller] Ytdlp update confirm error:", { data: e });
			}
		}

		_handleNavigation(url) {
			this.state.update({ detectedUrl: null });
			this.updateFolderDropdowns();
			this._reportCurrentUrl();
			this.updateAddButtonState();
		}

		_recoverFromHostRemoval() {
			if (this.isTearingDown || !this.checkContext()) return;
			this.teardown();
			this.timers.scheduleTimeout(
				() => {
					if (this.checkContext()) this.init();
				},
				100,
				{ allowDuringTeardown: true },
			);
		}

		_handleDomMutation() {
			if (!document.getElementById("m3u8-controller-host")) {
				this._recoverFromHostRemoval();
				return;
			}
			this._reportCurrentUrl();
		}

		_reportCurrentUrl() {
			this.bridge.send("report_page_url", null, { url: window.location.href });
		}

		_syncFolderChange(req) { return this.view.syncFolderChange(req); }

		async _handleAsyncConfirmation(req, send) {
			const result = await this.showPageLevelConfirmation(req.message);
			if (send) send({ confirmed: result });
			return result;
		}

		async waitForAccurateDetails(url, timeoutMs = 1500, originPageUrl = null) { return this.view.waitForAccurateDetails(url, timeoutMs, originPageUrl); }

		showStackedClearConfirmation(folderId, message, requestData) { return this.view.showStackedClearConfirmation(folderId, message, requestData); }

		showPageLevelConfirmation(message) { return this.view.showPageLevelConfirmation(message); }

		async updateFolderDropdowns(targetId, targetLastPlayed, targetIsActive, targetIsPaused, targetNeedsAppend) {
			return this.actions.updateFolderDropdowns(targetId, targetLastPlayed, targetIsActive, targetIsPaused, targetNeedsAppend);
		}

		refreshPlaylist(targetLastPlayed, targetIsActive, targetIsPaused, targetNeedsAppend, completedIds = []) {
			return this.actions.refreshPlaylist(targetLastPlayed, targetIsActive, targetIsPaused, targetNeedsAppend, completedIds);
		}

		handleWatchedToggle(itemId, isChecked) {
			return this.actions.handleWatchedToggle(itemId, isChecked);
		}

		setPlaybackLoading(isLoading) {
			return this.actions.setPlaybackLoading(isLoading);
		}

		setPlaybackClosing(isClosing) {
			return this.actions.setPlaybackClosing(isClosing);
		}

		setPlaybackActive(isActive, needsAppend = false, isPaused = false) {
			return this.actions.setPlaybackActive(isActive, needsAppend, isPaused);
		}

		async handleSmartReorder(e, btn) {
			return this.actions.handleSmartReorder(e, btn);
		}

		sendCommandToBackground(action, folderId, data = {}) {
			return this.actions.sendCommandToBackground(action, folderId, data);
		}

		_startHeartbeat() {
			return this.timers.startHeartbeat();
		}

		/**
		 * Point 2: Context-Safe Error Wrapping
		 * Returns a function that catches extension context invalidation errors.
		 */
		_safeWrap(fn) {
			return (...args) => {
				if (this.isTearingDown) return;
				try {
					const result = fn.apply(this, args);
					if (result instanceof Promise) {
						return result.catch((e) => {
							if (this.isReloadError(e)) {
								this.teardown();
							} else {
								MPV.logger?.warn?.(`[Controller] _safeWrap promise error: ${e.message}`, { data: e });
								throw e;
							}
						});
					}
					return result;
				} catch (e) {
					if (this.isReloadError(e)) {
						this.teardown();
					} else {
						MPV.logger?.warn?.(`[Controller] _safeWrap sync error: ${e.message}`, { data: e });
						throw e;
					}
				}
			};
		}

		_updateAutoAddVisuals(isActive) {
			return this.actions.updateAutoAddVisuals(isActive);
		}

		isReloadError(e) {
			const MPV = window.MPV_INTERNAL || {};
			return MPV.isExtensionReloadError ? MPV.isExtensionReloadError(e) : false;
		}

		_bindControllerEvents() {
			return this.actions.bindControllerEvents();
		}

		updateStatusBanner(text, isSuccess = false) { return this.view.updateStatusBanner(text, isSuccess); }

		updateAddButtonState() { return this.view.updateAddButtonState(); }

		updateAdaptiveElements() { return this.view.updateAdaptiveElements(); }

		addLogEntry(log) { return this.view.addLogEntry(log); }

		_handleResize() { return this.view.handleResize(); }

		handleGlobalKeydown(e) { return this.view.handleGlobalKeydown(e); }

		handleFullscreenChange() {
			this.timers.checkVisibility();
		}

		_initFullscreenSettleCheck() {
			this.timers.initFullscreenSettleCheck();
		}

		_startVisualWatchdog() {
			this.timers.startVisualWatchdog();
		}

		checkContext() {
			try {
				return !!chrome?.runtime?.id;
			} catch (e) {
				return false;
			}
		}
	};
})();
