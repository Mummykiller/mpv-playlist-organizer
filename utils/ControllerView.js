/**
 * @class ControllerView
 * Manages UI/Shadow-DOM state synchronization, preferences application, resize/repositioning,
 * status/log/button UI helpers, and page scraping helpers for MpvController.
 */
window.MPV_INTERNAL = window.MPV_INTERNAL || {};

(() => {
	const MPV = window.MPV_INTERNAL;

	MPV.ControllerView = class ControllerView {
		constructor(controller) {
			this.controller = controller;
		}

		updateTaskUI(tasks) {
			const c = this.controller;
			if (!c.ui.shadowRoot) return;
			const dashboard = c.ui.shadowRoot.getElementById("progress-dashboard");
			if (!dashboard) return;

			// Filter for only 'processing' or 'queued' tasks to show in the bar
			const activeTasks = (tasks || []).filter(
				(t) => t.status === "processing" || t.status === "queued",
			);

			if (activeTasks.length === 0) {
				dashboard.style.display = "none";
				return;
			}

			// Show the first/most important task
			const task = activeTasks[0];
			dashboard.style.display = "flex";

			const label = dashboard.querySelector(".progress-label");
			const percentText = dashboard.querySelector(".progress-percent");
			const barFill = dashboard.querySelector(".progress-bar-fill");
			const cancelBtn = dashboard.querySelector("#btn-cancel-task");

			if (label) label.textContent = task.label;

			const percent =
				task.total > 0 ? Math.round((task.progress / task.total) * 100) : 0;
			if (percentText) percentText.textContent = `${percent}%`;
			if (barFill) barFill.style.width = `${percent}%`;

			if (cancelBtn) {
				cancelBtn.onclick = () => {
					c.bridge.send("cancel_task", null, { task_id: task.id });
					cancelBtn.disabled = true;
					cancelBtn.style.opacity = "0.5";
				};
				cancelBtn.disabled = false;
				cancelBtn.style.opacity = "1";
			}
		}

		syncUiToState(state) {
			const c = this.controller;
			if (!c.ui.shadowRoot) return;

			const relevantState = {
				minimized: state.minimized,
				pinned: state.pinned,
				logVisible: state.logVisible,
				logFilters: state.logFilters,
				uiMode: state.uiMode,
				isFolderActive: state.isFolderActive,
				lastPlayedId: state.lastPlayedId,
				isClosing: state.isClosing,
				anilistVisible: state.anilistVisible,
				anilistHeight: state.anilistImageHeight,
				detected: !!state.detectedUrl,
				showStub: state.settings.showMinimizedStub,
				highlight: state.settings.enableActiveItemHighlight,
				showPlayNewButton: state.settings.showPlayNewButton,
				enableAnilistIntegration: state.settings.enableAnilistIntegration,
				lockAnilistPanel: state.settings.lockAnilistPanel,
				forcePanelAttached: state.settings.forcePanelAttached,
				anilistAttachOnOpen: state.settings.anilistAttachOnOpen,
				suppressed: c.suppressedByWatchdog,
			};
			const currentHash = JSON.stringify(relevantState);
			if (currentHash === c._lastUpdateHash) return;
			c._lastUpdateHash = currentHash;

			// 0. Update Playlist Highlight (Glow)
			if (c.playlistUI) {
				c.playlistUI.syncActiveHighlight(
					state.lastPlayedId,
					state.isFolderActive,
				);
			}

			// 1. Visibility
			if (c.suppressedByWatchdog) {
				c.ui.controllerHost.style.display = "none";
				c.ui.minimizedHost.style.display = "none";
				c.ui.anilistPanelHost.style.display = "none";
			} else if (state.minimized) {
				c.ui.controllerHost.style.display = "none";

				// Respect the "Show Minimized Stub" setting.
				if (state.settings.showMinimizedStub === false) {
					c.ui.minimizedHost.style.display = "none";
				} else {
					c.ui.minimizedHost.style.display = "block";

					// Reset position if it's somehow stuck or hidden
					if (
						!c.ui.minimizedHost.style.top ||
						c.ui.minimizedHost.style.top.startsWith("-")
					) {
						Object.assign(c.ui.minimizedHost.style, {
							top: "15px",
							left: "15px",
							right: "auto",
							bottom: "auto",
						});
					}
					this.validateAndRepositionMinimizedStub();
				}
			} else {
				c.ui.minimizedHost.style.display = "none";
				c.ui.controllerHost.style.display = "block";
				this.validateAndRepositionController();
			}

			this.updateAddButtonState();
			this.updateAdaptiveElements();

			// 2. Log Panel
			const logContainer = c.ui.shadowRoot.getElementById("log-container");
			const toggleLogBtn = c.ui.shadowRoot.getElementById("btn-toggle-log");
			if (logContainer && toggleLogBtn) {
				logContainer.classList.toggle("log-hidden", !state.logVisible);
				toggleLogBtn.classList.toggle("active", state.logVisible);
			}

			// 3. Pin State
			const pinBtn = c.ui.shadowRoot.getElementById("btn-toggle-pin");
			const dragHandle = c.ui.shadowRoot.getElementById("status-banner");
			if (pinBtn && dragHandle) {
				c.ui.controllerHost.classList.toggle("pinned", state.pinned);
				pinBtn.classList.toggle("active-toggle", state.pinned);
				dragHandle.style.cursor = state.pinned ? "default" : "grab";
				dragHandle.title = state.pinned ? "Pinned" : "Click and hold to drag";
			}

			// 4. AniList State
			if (c.anilistUI) {
				if (
					c.anilistUI.panelHost.style.display === "none" &&
					state.anilistVisible
				) {
					c.anilistUI.toggleVisibility(true, false);
				} else if (
					c.anilistUI.panelHost.style.display !== "none" &&
					!state.anilistVisible
				) {
					c.anilistUI.toggleVisibility(false, false);
				}

				if (c.anilistUI.panelHost) {
					const baseWidth = 50;
					const defaultHeight = 70;
					const effectiveHeight = Number(state.anilistImageHeight || 126);
					const scalingFactor = effectiveHeight / defaultHeight;
					const effectiveWidth = Math.round(baseWidth * scalingFactor);

					c.anilistUI.panelHost.style.setProperty(
						"--anilist-item-width",
						`${effectiveWidth}px`,
					);
					c.anilistUI.panelHost.style.setProperty(
						"--anilist-image-height",
						`${effectiveHeight}px`,
					);
				}

				c.anilistUI.isEnabled = state.settings.enableAnilistIntegration;
				c.anilistUI.isLocked = state.settings.lockAnilistPanel;
				c.anilistUI.forceAttached = state.settings.forcePanelAttached;
				c.anilistUI.attachOnOpen = state.settings.anilistAttachOnOpen ?? true;
				c.anilistUI.updateDynamicStyles();
			}

			// 5. Log Filters
			const infoBtn = c.ui.shadowRoot.getElementById("btn-filter-info");
			const errorBtn = c.ui.shadowRoot.getElementById("btn-filter-error");
			infoBtn?.classList.toggle("active", state.logFilters.info);
			errorBtn?.classList.toggle("active", state.logFilters.error);

			logContainer?.querySelectorAll(".log-item").forEach((item) => {
				const isError = item.classList.contains("log-item-error");
				const visible = state.logFilters[isError ? "error" : "info"];
				item.classList.toggle("hidden-by-filter", !visible);
			});

			// 6. UI Mode
			const fullUi = c.ui.shadowRoot.getElementById("full-ui-container");
			const compactUi = c.ui.shadowRoot.getElementById("compact-ui-container");
			const modeBtn = c.ui.shadowRoot.getElementById("btn-toggle-ui-mode");

			if (fullUi && compactUi && modeBtn) {
				const isFull = state.uiMode === "full";
				fullUi.style.display = isFull ? "flex" : "none";
				compactUi.style.display = isFull ? "none" : "flex";
				modeBtn.querySelector(".icon-full-ui").style.display = isFull
					? "block"
					: "none";
				modeBtn.querySelector(".icon-compact-ui").style.display = isFull
					? "none"
					: "block";
			}

			// 7. Playback Controls
			const playNewBtn = c.ui.shadowRoot.getElementById("btn-play-new");
			const playbackControls =
				c.ui.shadowRoot.getElementById("playback-controls");
			if (playNewBtn && playbackControls) {
				const showPlayNew = state.settings.showPlayNewButton;
				playNewBtn.style.display = showPlayNew ? "flex" : "none";
				playbackControls.style.gridTemplateColumns = showPlayNew
					? "1fr 1fr auto"
					: "1fr auto";
			}

			const stubBtn = c.ui.shadowRoot.getElementById("btn-toggle-stub");
			stubBtn?.classList.toggle(
				"active-toggle",
				state.settings.showMinimizedStub,
			);
		}

		async applyInitialState(positionOverride = null) {
			const c = this.controller;
			try {
				const response = await c.bridge.send("get_ui_preferences");
				if (!c.ui.shadowRoot || !c.ui.controllerHost) return;

				const prefs = response?.preferences || {};

				const mappedSettings = {
					enableActiveItemHighlight: true,
					enableSmartResume: true,
					showMinimizedStub: true,
					showPlayNewButton: false,
					enableAnilistIntegration: true,
					lockAnilistPanel: false,
					forcePanelAttached: false,
					anilistAttachOnOpen: true,
					showWatchedStatusGui: true,
					enableDblclickCopy: false,
					showCopyTitleButton: false,
					confirmClearPlaylist: true,
					confirmCloseMpv: true,
					confirmPlayNew: true,
					confirmFolderSwitch: true,
					autoAppendOnAdd: true,
					liveRemoval: true,
					oneClickAdd: false,
					...prefs,
				};

				c.state.update(
					{
						kbAddPlaylist: prefs.kbAddPlaylist,
						kbToggleController: prefs.kbToggleController,
						kbOpenPopup: prefs.kbOpenPopup,
						kbPlayPlaylist: prefs.kbPlayPlaylist,
						kbSwitchPlaylist: prefs.kbSwitchPlaylist,
						anilistVisible: prefs.anilistPanelVisible ?? false,
						anilistImageHeight: prefs.anilistImageHeight ?? 126,
						settings: mappedSettings,
						pinned: prefs.pinned ?? false,
						logVisible: prefs.logVisible ?? true,
						logFilters: prefs.logFilters ?? { info: true, error: true },
						uiMode: prefs.mode === "minimized" ? "full" : prefs.mode || "full",
					},
					true,
				);

				if (prefs.scraperFilterWords) {
					c.pageScraper.updateFilterWords(prefs.scraperFilterWords);
				}

				const position = positionOverride || prefs.position;
				if (position && c.ui.controllerHost) {
					Object.assign(c.ui.controllerHost.style, position);
				}

				if (c.anilistUI) {
					if (prefs.anilistPanelPosition) {
						Object.assign(
							c.anilistUI.panelHost.style,
							prefs.anilistPanelPosition,
						);
						c.anilistUI.isManuallyPositioned = true;
					}
					if (prefs.anilistPanelSize) {
						Object.assign(c.anilistUI.panelHost.style, prefs.anilistPanelSize);
					}

					c.anilistUI.isLocked = prefs.lockAnilistPanel ?? false;
					c.anilistUI.forceAttached = prefs.forcePanelAttached ?? false;
					c.anilistUI.attachOnOpen = prefs.anilistAttachOnOpen ?? true;
					c.anilistUI.isEnabled = prefs.enableAnilistIntegration ?? true;
					c.anilistUI.toggleVisibility(c.state.state.anilistVisible, false);
				}

				if (c.ui.minimizedHost && prefs.minimizedStubPosition) {
					Object.assign(
						c.ui.minimizedHost.style,
						prefs.minimizedStubPosition,
					);
					c.ui.minimizedHost.classList.remove("top-left", "top-right");
				}

				const shouldBeMinimized =
					typeof prefs.minimized === "boolean"
						? prefs.minimized
						: prefs.mode === "minimized";
				c.state.update({ minimized: shouldBeMinimized }, true);
				this.syncUiToState(c.state.state);
			} catch (e) {
				console.error("[UI][Controller] Error applying initial state:", e);
				MPV.logger?.error?.(
					`[Controller] Error applying initial state: ${e.message}`,
					{ persist: true, stack: e.stack },
				);
				this.updateStatusBanner("Error applying initial state", false);
			}
		}

		applyPreferences(prefs) {
			const c = this.controller;
			if (!c.ui.shadowRoot || !c.ui.controllerHost) return;

			const currentSettings = c.state.state.settings;
			const newSettings = { ...currentSettings, ...prefs };
			const updateDelta = { settings: newSettings };

			if (prefs.minimized !== undefined) updateDelta.minimized = prefs.minimized;
			if (prefs.pinned !== undefined) updateDelta.pinned = prefs.pinned;
			if (prefs.mode !== undefined) {
				updateDelta.uiMode =
					prefs.mode === "minimized" ? "full" : prefs.mode || "full";
			}
			if (prefs.anilistPanelVisible !== undefined)
				updateDelta.anilistVisible = prefs.anilistPanelVisible;
			if (prefs.anilistImageHeight !== undefined)
				updateDelta.anilistImageHeight = prefs.anilistImageHeight;

			c.state.update(updateDelta);

			const renderingRelated = [
				"enableActiveItemHighlight",
				"showWatchedStatusGui",
				"showCopyTitleButton",
				"enableDblclickCopy",
			];
			if (
				renderingRelated.some((key) => prefs[key] !== undefined) &&
				c.playlistUI?.currentPlaylist
			) {
				c.playlistUI.render(
					c.playlistUI.currentPlaylist,
					c.state.state.lastPlayedId,
					c.state.state.isFolderActive,
				);
			}
		}

		syncFolderChange(req) {
			const c = this.controller;
			if (!c.ui.shadowRoot) return;
			const full = c.ui.shadowRoot.getElementById("folder-select");
			if (full && full.value !== req.folderId) {
				full.value = req.folderId;
				const compact = c.ui.shadowRoot.getElementById("compact-folder-select");
				if (compact) compact.value = req.folderId;
				c._updateFolderSubscription(req.folderId);
				if (req.playlist) {
					c._lastPlaylistFingerprint = c._getPlaylistFingerprint(req.playlist);
					c.playlistUI?.render(
						req.playlist,
						req.lastPlayedId,
						req.isFolderActive,
					);
				} else {
					c.refreshPlaylist();
				}
			}
		}

		handleRightClickScrape(send) {
			const c = this.controller;
			let url = window.location.href;
			let title = null;

			const isSafeWebUrl = (href) =>
				typeof window !== "undefined" &&
				window.MPV_SECURITY &&
				typeof window.MPV_SECURITY.isValidWebUrl === "function"
					? window.MPV_SECURITY.isValidWebUrl(href)
					: href.startsWith("http://") || href.startsWith("https://");

			if (
				window.location.hostname.includes("youtube.com") &&
				c.lastRightClickedElement
			) {
				const videoContainer = c.lastRightClickedElement.closest(
					"ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer",
				);
				if (videoContainer) {
					const linkEl = videoContainer.querySelector(
						"a#video-title-link, a#thumbnail, a.yt-simple-endpoint",
					);
					if (linkEl && linkEl.href && isSafeWebUrl(linkEl.href)) {
						url = linkEl.href;
					}

					const titleSelectors = [
						"#video-title",
						"#title-text",
						"span#video-title",
						".ytp-title-link",
					];
					const channelSelectors = [
						"#channel-name .yt-formatted-string",
						".ytd-channel-name .yt-formatted-string",
						"#byline-container .yt-formatted-string",
						"#owner-name a",
					];

					let videoTitle = null;
					for (const selector of titleSelectors) {
						const el = videoContainer.querySelector(selector);
						if (el) {
							videoTitle = el.textContent.trim();
							break;
						}
					}

					let channelName = null;
					for (const selector of channelSelectors) {
						const el = videoContainer.querySelector(selector);
						if (el) {
							channelName = el.textContent.trim();
							break;
						}
					}

					if (videoTitle) {
						title = channelName ? `${channelName} - ${videoTitle}` : videoTitle;
					}
				}
			}

			if (!title && c.lastRightClickedElement) {
				const linkElement = c.lastRightClickedElement.closest("a");
				if (linkElement && linkElement.href && isSafeWebUrl(linkElement.href)) {
					url = linkElement.href;
					title = linkElement.textContent.trim();
				}
			}

			if (!title || !url) {
				const details = c.pageScraper.scrapePageDetails(
					url || window.location.href,
				);
				url = url || details.url;
				title = title || details.title;
			}

			send({ url, title });
		}

		async waitForAccurateDetails(url, timeoutMs = 1500, originPageUrl = null) {
			const c = this.controller;
			const currentUrl = window.location.href;

			if (originPageUrl && currentUrl !== originPageUrl) {
				console.warn("[Controller] Scrape Page URL mismatch. Tab navigated away.", {
					origin: originPageUrl,
					current: currentUrl,
				});
				return { url, title: url, isProvisional: true };
			}

			const details = c.pageScraper.scrapePageDetails(url);
			const startFingerprint = details.fingerprint;
			if (!details.isProvisional) return details;

			return new Promise((resolve) => {
				const startTime = Date.now();
				const throttleMs = 100;
				let observer = null;
				let timeoutId = null;
				let throttleTimer = null;
				let lastCheckTime = 0;
				let settled = false;

				const finalize = () => {
					if (settled) return;
					settled = true;
					if (observer) observer.disconnect();
					if (timeoutId) clearTimeout(timeoutId);
					if (throttleTimer) clearTimeout(throttleTimer);
					resolve(c.pageScraper.scrapePageDetails(url));
				};

				const checkDetails = () => {
					if (settled) return;
					lastCheckTime = Date.now();
					const currentDetails = c.pageScraper.scrapePageDetails(url);

					if (currentDetails.fingerprint !== startFingerprint) {
						console.warn(
							"[Controller] Page content changed during wait. Aborting accurate scrape.",
						);
						finalize();
						return;
					}

					if (!currentDetails.isProvisional || Date.now() - startTime >= timeoutMs) {
						finalize();
					}
				};

				observer = new MutationObserver(() => {
					if (settled) return;
					const elapsed = Date.now() - lastCheckTime;
					if (elapsed >= throttleMs) {
						if (throttleTimer) {
							clearTimeout(throttleTimer);
							throttleTimer = null;
						}
						checkDetails();
					} else if (!throttleTimer) {
						throttleTimer = setTimeout(() => {
							throttleTimer = null;
							checkDetails();
						}, throttleMs - elapsed);
					}
				});

				observer.observe(document.documentElement, {
					childList: true,
					subtree: true,
					characterData: true,
				});

				timeoutId = setTimeout(finalize, timeoutMs);
			});
		}

		showStackedClearConfirmation(folderId, message, requestData) {
			if (MPV.domUtils?.confirmStacked) {
				return MPV.domUtils.confirmStacked(folderId, message, requestData);
			}
			return this.showPageLevelConfirmation(message);
		}

		showPageLevelConfirmation(message) {
			return MPV.domUtils.confirm(message);
		}

		updateStatusBanner(text, isSuccess = false) {
			const c = this.controller;
			if (MPV.domUtils?.updateStatusBanner && c.ui?.shadowRoot) {
				return MPV.domUtils.updateStatusBanner(c.ui.shadowRoot, text, {
					isSuccess,
				});
			}
			const statusBanner = c.ui.shadowRoot?.getElementById("status-banner");
			const streamStatus = c.ui.shadowRoot?.getElementById("stream-status");
			if (!statusBanner || !streamStatus) return;

			streamStatus.textContent = text;
			statusBanner.classList.toggle("detected", isSuccess);
		}

		updateAddButtonState() {
			const c = this.controller;
			if (!c.ui.shadowRoot) return;

			const addBtn = c.ui.shadowRoot.getElementById("btn-add");
			const compactAddBtn = c.ui.shadowRoot.getElementById("btn-compact-add");
			const minimizedStub = c.ui.minimizedHost?.shadowRoot?.getElementById(
				"m3u8-minimized-stub",
			);

			const hostname = window.location.hostname;
			const isYouTube =
				hostname.includes("youtube.com") &&
				window.location.pathname.includes("/watch");
			const url =
				c.state.state.detectedUrl || (isYouTube ? window.location.href : null);

			[addBtn, compactAddBtn, minimizedStub].forEach((btn) => {
				btn?.classList.remove("url-in-playlist", "stream-present");
			});

			if (!url) {
				this.updateStatusBanner("No stream/playlist detected", false);
				if (minimizedStub) {
					minimizedStub.title =
						"Left-click: Open Controller\nRight-click: Drag to move";
					minimizedStub.classList.remove("stream-present", "url-in-playlist");
				}
				[addBtn, compactAddBtn].forEach((btn) => {
					if (btn) {
						btn.disabled = true;
						btn.title = "No stream detected";
					}
				});
			} else {
				this.updateStatusBanner(
					isYouTube ? "YouTube Video detected" : "Stream/video detected",
					true,
				);

				const playlist = c.playlistUI?.currentPlaylist || [];
				const isUrlInPlaylist = playlist.some((item) => item.url === url);
				const targets = [addBtn, compactAddBtn, minimizedStub];

				if (isUrlInPlaylist) {
					targets.forEach((btn) => {
						if (!btn) return;
						btn.classList.add("url-in-playlist");
						btn.title =
							btn === minimizedStub
								? "URL is already in playlist\nLeft-click: Open Controller\nRight-click: Drag to move"
								: "URL is already in this playlist";
					});
				} else {
					targets.forEach((btn) => {
						if (!btn) return;
						btn.classList.add("stream-present");
						btn.title =
							btn === minimizedStub
								? "Stream Detected!\nLeft-click: Add to Playlist\nRight-click: Drag to move"
								: "Click to add URL to playlist";
					});
				}

				[addBtn, compactAddBtn].forEach((btn) => {
					if (btn) btn.disabled = false;
				});
			}
		}

		updateAdaptiveElements() {
			const c = this.controller;
			if (!c.ui.shadowRoot) return;
			const state = c.state.state;
			const leftAniBtn = c.ui.shadowRoot.getElementById(
				"btn-toggle-anilist-left",
			);
			const rightAniBtn = c.ui.shadowRoot.getElementById(
				"btn-toggle-anilist-right",
			);

			const showAnilistButtons = state.settings.enableAnilistIntegration;
			if (leftAniBtn) {
				leftAniBtn.style.display =
					showAnilistButtons && state.uiMode === "compact" ? "flex" : "none";
			}
			if (rightAniBtn) {
				rightAniBtn.style.display =
					showAnilistButtons && state.uiMode === "full" ? "flex" : "none";
			}

			if (c.anilistUI) c.anilistUI.validatePosition();
		}

		addLogEntry(log) {
			const c = this.controller;
			if (!c.ui.shadowRoot) return;
			const container = c.ui.shadowRoot.getElementById("log-container");
			if (!container) return;

			const placeholder = container.querySelector("#log-placeholder");
			if (placeholder) placeholder.remove();

			const entry = document.createElement("div");
			entry.className = `log-item log-item-${log.type || "info"}`;

			let logText = log.text;

			if (c.playlistUI?.currentPlaylist) {
				const uuidPattern =
					/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
				const match = logText.match(uuidPattern);
				if (match) {
					const id = match[0];
					const item = c.playlistUI.currentPlaylist.find((i) => i.id === id);
					if (item && item.title) {
						logText = logText.replace(id, `'[${item.title}]'`);
					} else {
						logText = logText.replace(id, id.substring(0, 8));
					}
				}
			}

			const isError = log.type === "error";
			if (!c.state.state.logFilters[isError ? "error" : "info"]) {
				entry.classList.add("hidden-by-filter");
			}

			const timestamp = new Date().toLocaleTimeString([], {
				hour12: false,
				hour: "2-digit",
				minute: "2-digit",
				second: "2-digit",
			});
			const timeSpan = document.createElement("span");
			timeSpan.className = "log-timestamp";
			timeSpan.textContent = `[${timestamp}]`;
			const textSpan = document.createElement("span");
			textSpan.className = "log-text";
			textSpan.textContent = logText;
			entry.append(timeSpan, " ", textSpan);

			container.appendChild(entry);
			container.scrollTop = container.scrollHeight;
		}

		handleResize() {
			const c = this.controller;
			const host = c.ui.controllerHost;
			if (!host || host.style.display === "none") {
				this.validateAndRepositionMinimizedStub();
				return;
			}

			const maxX = window.innerWidth - host.offsetWidth;
			const maxY = window.innerHeight - host.offsetHeight;
			const isOffScreen = host.offsetLeft > maxX || host.offsetTop > maxY;

			if (isOffScreen) {
				if (!c.preResizePosition) {
					c.preResizePosition = {
						left: host.style.left,
						top: host.style.top,
					};
				}
				this.validateAndRepositionController();
			} else if (c.preResizePosition) {
				const originalLeft = parseFloat(c.preResizePosition.left) || 0;
				const originalTop = parseFloat(c.preResizePosition.top) || 0;
				if (originalLeft <= maxX && originalTop <= maxY) {
					c.preResizePosition = null;
				}
			}
		}

		_validateAndRepositionHost(host, prefKey) {
			if (!host || host.style.display === "none") return;

			requestAnimationFrame(() => {
				const rect = host.getBoundingClientRect();
				if (rect.width === 0 || rect.height === 0) return;

				const vw = window.innerWidth;
				const vh = window.innerHeight;
				let newLeft = rect.left;
				let newTop = rect.top;
				let changed = false;

				if (rect.right > vw) {
					newLeft = Math.max(0, vw - rect.width);
					changed = true;
				}
				if (rect.bottom > vh) {
					newTop = Math.max(0, vh - rect.height);
					changed = true;
				}
				if (rect.left < 0) {
					newLeft = 0;
					changed = true;
				}
				if (rect.top < 0) {
					newTop = 0;
					changed = true;
				}

				if (changed) {
					const pos = {
						left: `${newLeft}px`,
						top: `${newTop}px`,
						right: "auto",
						bottom: "auto",
					};
					Object.assign(host.style, pos);
					this.controller.savePreference({ [prefKey]: pos });
				}
			});
		}

		validateAndRepositionController() {
			this._validateAndRepositionHost(
				this.controller.ui.controllerHost,
				"position",
			);
		}

		validateAndRepositionMinimizedStub() {
			this._validateAndRepositionHost(
				this.controller.ui.minimizedHost,
				"minimizedStubPosition",
			);
		}

		handleGlobalKeydown(e) {
			const c = this.controller;
			if (
				["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName) ||
				e.target.isContentEditable
			) {
				return;
			}

			const combo = this.normalizeKeyCombo(e);
			const state = c.state.state;
			const normalize = (str) =>
				(str || "")
					.replace(/\s+/g, "")
					.toLowerCase()
					.replace("control", "ctrl")
					.replace("command", "meta")
					.replace("option", "alt");

			if (state.kbAddPlaylist && combo === normalize(state.kbAddPlaylist)) {
				e.preventDefault();
				e.stopPropagation();
				const folderId = c.ui.shadowRoot?.getElementById("folder-select")?.value;
				if (folderId && state.detectedUrl) {
					c.sendCommandToBackground("add", folderId, {
						data: c.pageScraper.scrapePageDetails(state.detectedUrl),
					});
				}
			} else if (
				state.kbToggleController &&
				combo === normalize(state.kbToggleController)
			) {
				e.preventDefault();
				e.stopPropagation();
				c.setMinimizedState(!state.minimized);
			} else if (
				state.kbPlayPlaylist &&
				combo === normalize(state.kbPlayPlaylist)
			) {
				e.preventDefault();
				e.stopPropagation();
				const folderId = c.ui.shadowRoot?.getElementById("folder-select")?.value;
				if (folderId) c.sendCommandToBackground("play", folderId);
			} else if (
				state.kbSwitchPlaylist &&
				combo === normalize(state.kbSwitchPlaylist)
			) {
				e.preventDefault();
				e.stopPropagation();
				c.bridge.send("switch_playlist");
			} else if (state.kbOpenPopup && combo === normalize(state.kbOpenPopup)) {
				e.preventDefault();
				e.stopPropagation();
				c.bridge.send("open_popup");
			}
		}

		normalizeKeyCombo(e) {
			const modifiers = [];
			if (e.ctrlKey) modifiers.push("ctrl");
			if (e.shiftKey) modifiers.push("shift");
			if (e.altKey) modifiers.push("alt");
			if (e.metaKey) modifiers.push("meta");

			let key = e.key.toLowerCase();
			if (key === " ") key = "space";
			if (key === "escape") key = "esc";
			if (["control", "shift", "alt", "meta"].includes(key)) return null;

			return [...modifiers, key].join("+");
		}
	};
})();
