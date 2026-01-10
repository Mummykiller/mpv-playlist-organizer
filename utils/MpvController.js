/**
 * @class MpvController
 * Coordinator for the MPV Playlist Organizer.
 * Namespaced Global version.
 */
window.MPV_INTERNAL = window.MPV_INTERNAL || {};

(function() {
    'use strict';

    const MPV = window.MPV_INTERNAL;

    MPV.MpvController = class MpvController {
        constructor() {
            this.isTearingDown = false;
            this.tabId = null;
            this.preFullscreenPosition = null;
            this.preResizePosition = null; 
            this.lastRightClickedElement = null;
            this._lastUpdateHash = '';

            // 1. Initialize Logic Modules
            this.bridge = new MPV.MessageBridge({
                onLog: (log) => this.addLogEntry(log)
            });

            this.state = new MPV.ContentState({
                onUpdate: (state) => this._syncUiToState(state)
            });

            this.nav = new MPV.NavigationObserver({
                onNavigation: (url) => this._handleNavigation(url),
                onMutation: () => this._handleDomMutation(),
                onValidate: () => {
                    if (!document.getElementById('m3u8-controller-host') && !this.isTearingDown) {
                        this.teardown();
                        setTimeout(() => this.init(), 100);
                    }
                }
            });

            // 2. Initialize UI Managers
            this.ui = new MPV.UIManager();
            this.playlistUI = new MPV.PlaylistUI(this, this.ui);
            this.anilistUI = new MPV.AniListUI(this, this.ui);
            this.pageScraper = new MPV.PageScraper();
            
            // --- Message Dispatcher ---
            this.actionMap = {
                'ping': (req, send) => send({ success: true }),
                'init_ui_state': (req) => this._handleInitState(req),
                'render_playlist': (req) => {
                    if (req.playlist) {
                        this.playlistUI?.render(req.playlist, req.last_played_id, req.isFolderActive);
                        this.setPlaybackActive(req.isFolderActive);
                    } else {
                        this.refreshPlaylist();
                    }
                },
                'detected_url_changed': (req) => {
                    if (this.tabId && req.tabId !== this.tabId) return; 
                    
                    if (req.url) {
                        this.state.update({ detectedUrl: req.url });
                        // Report to background so it's cached for the popup
                        this.bridge.send('report_detected_url', null, { url: req.url });
                    } else {
                        this.state.update({ detectedUrl: null });
                        this.bridge.send('report_detected_url', null, { url: null });
                    }
                    this.updateAddButtonState();
                },
                'foldersChanged': (req) => this.updateFolderDropdowns(req.folderId, req.lastPlayedId, req.isFolderActive),
                'last_folder_changed': (req) => this._syncFolderChange(req),
                'log': (req) => this.addLogEntry(req.log),
                'preferences_changed': () => this.applyInitialState(),
                'show_confirmation': (req, send) => this._handleAsyncConfirmation(req, send),
                'show_clear_confirmation': async (req) => {
                    const confirmed = await this.showPageLevelConfirmation(`MPV finished naturally. Clear the playlist in "${req.folderId}"?`);
                    this.bridge.send('confirm_clear_playlist', null, { confirmed, folderId: req.folderId });
                },
                'scrape_and_get_details': (req, send) => {
                    const detectedUrl = this.state.state.detectedUrl;
                    if (detectedUrl) {
                        send(this.pageScraper.scrapePageDetails(detectedUrl));
                    } else {
                        send({ url: null, title: document.title });
                    }
                },
                'set_minimized_state': (req, send) => { this.setMinimizedState(req.minimized); send({ success: true }); },
                'get_details_for_last_right_click': (req, send) => this._handleRightClickScrape(send),
                'ytdlp_update_confirm': () => this._handleYtdlpUpdateConfirm()
            };

            // Bind core lifecycle and event methods
            this.handleMessage = this.handleMessage.bind(this);
            this.handleGlobalKeydown = this.handleGlobalKeydown.bind(this);
            this.handleFullscreenChange = this.handleFullscreenChange.bind(this);
            this.handleMouseDown = this.handleMouseDown.bind(this);
        }

        async init() {
            const initialPrefs = await this.bridge.send('get_ui_preferences');
            const restrictedDomains = initialPrefs?.preferences?.restricted_domains || [];
            const currentHostname = window.location.hostname;
            
            const isRestricted = restrictedDomains.some(domain => 
                currentHostname === domain || currentHostname.endsWith('.' + domain)
            );

            if (isRestricted) return;

            // Setup message listener
            this.messageListener = (req, sender, send) => this.handleMessage(req, sender, send);
            chrome.runtime.onMessage.addListener(this.messageListener);

            // 1. Prepare UI
            this.ui.createAndInjectUi();
            
            // 2. Initialize UI Components
            this.playlistUI = new MPV.PlaylistUI(this, this.ui);
            this.anilistUI = new MPV.AniListUI(this, this.ui);
            
            this.playlistUI.bindEvents();
            this.anilistUI.bindEvents();
            this._bindControllerEvents();

            // 3. Start Observation Modules
            this.nav.init();
            this._startHeartbeat();

            // 4. Initial Sync
            await this.applyInitialState();
            await this.updateFolderDropdowns();
            
            await this.bridge.send('content_script_init');

            // 5. Fullscreen Guard
            if (document.fullscreenElement) {
                this.ui.controllerHost.style.display = 'none';
            }
            
            // 6. Global Event Listeners
            window.addEventListener('mousedown', this.handleMouseDown, true);
        }
        
        handleMouseDown(event) {
            if (event.button === 2) { 
                 this.lastRightClickedElement = event.target;
            }
        }

        handleMessage(request, sender, sendResponse) {
            if (this.isTearingDown) return;
            const action = request.action || (request.foldersChanged ? 'foldersChanged' : null);
            const handler = this.actionMap[action];
            
            if (handler) {
                const result = handler(request, sendResponse);
                // If the handler returns a Promise (indicating async work), return true to keep the channel open.
                if (result instanceof Promise) {
                    return true;
                }
                return result; // For sync handlers, return their result (though usually void)
            }
        }

        teardown() {
            this.isTearingDown = true;
            this.bridge.destroy();
            this.state.destroy();
            this.nav.destroy();
            if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
            if (this.resizeListener) window.removeEventListener('resize', this.resizeListener);
            document.removeEventListener('fullscreenchange', this.handleFullscreenChange);
            window.removeEventListener('keydown', this.handleGlobalKeydown, true);
            window.removeEventListener('mousedown', this.handleMouseDown, true);
            this.ui.teardown();
            window.mpvControllerInitialized = false;
            if (this.messageListener) chrome.runtime.onMessage.removeListener(this.messageListener);
        }

        // --- State & UI Persistence ---

        savePreference(prefs) {
            this.bridge.send('set_ui_preferences', null, { preferences: prefs });
        }

        setMinimizedState(shouldBeMinimized, save = true) {
            this.state.update({ minimized: shouldBeMinimized });
            if (save) this.savePreference({ minimized: shouldBeMinimized });
        }

        setPinState(shouldBePinned, save = true) {
            this.state.update({ pinned: shouldBePinned });
            if (save) this.savePreference({ pinned: shouldBePinned });
        }

        // --- State & UI Synchronization ---

        _syncUiToState(state) {
            if (!this.ui.shadowRoot) return;

            const relevantState = {
                minimized: state.minimized,
                pinned: state.pinned,
                logVisible: state.logVisible,
                uiMode: state.uiMode,
                anilistVisible: state.anilistVisible,
                anilistHeight: state.anilistImageHeight,
                detected: !!state.detectedUrl,
                showStub: state.settings.show_minimized_stub,
                highlight: state.settings.enable_active_item_highlight
            };
            const currentHash = JSON.stringify(relevantState);
            if (currentHash === this._lastUpdateHash) return;
            this._lastUpdateHash = currentHash;
            
            // 1. Visibility
            if (state.minimized) {
                this.ui.controllerHost.style.display = 'none';
                this.ui.minimizedHost.style.display = state.settings.show_minimized_stub ? 'block' : 'none';
                this.validateAndRepositionMinimizedStub();
            } else {
                this.ui.minimizedHost.style.display = 'none';
                this.ui.controllerHost.style.display = 'block';
                this.validateAndRepositionController();
            }

            this.updateAddButtonState();
            this.updateAdaptiveElements();
            
            // 2. Log Panel
            const logContainer = this.ui.shadowRoot.getElementById('log-container');
            const toggleLogBtn = this.ui.shadowRoot.getElementById('btn-toggle-log');
            if (logContainer && toggleLogBtn) {
                 logContainer.classList.toggle('log-hidden', !state.logVisible);
                 toggleLogBtn.classList.toggle('active', state.logVisible);
            }
            
            // 3. Pin State
            const pinBtn = this.ui.shadowRoot.getElementById('btn-toggle-pin');
            const dragHandle = this.ui.shadowRoot.getElementById('status-banner');
            if (pinBtn && dragHandle) {
                this.ui.controllerHost.classList.toggle('pinned', state.pinned);
                pinBtn.classList.toggle('active-toggle', state.pinned);
                dragHandle.style.cursor = state.pinned ? 'default' : 'grab';
                dragHandle.title = state.pinned ? 'Pinned' : 'Click and hold to drag';
            }

            // 4. AniList State
            if (this.anilistUI) {
                 if (this.anilistUI.panelHost.style.display === 'none' && state.anilistVisible) {
                     this.anilistUI.toggleVisibility(true, false);
                 } else if (this.anilistUI.panelHost.style.display !== 'none' && !state.anilistVisible) {
                     this.anilistUI.toggleVisibility(false, false);
                 }

                if (this.anilistUI.panelHost) {
                    const baseWidth = 50;
                    const defaultHeight = 70;
                    const effectiveHeight = Number(state.anilistImageHeight || 126);
                    const scalingFactor = effectiveHeight / defaultHeight;
                    const effectiveWidth = Math.round(baseWidth * scalingFactor);
            
                    this.anilistUI.panelHost.style.setProperty('--anilist-item-width', `${effectiveWidth}px`);
                    this.anilistUI.panelHost.style.setProperty('--anilist-image-height', `${effectiveHeight}px`);
                }
                
                this.anilistUI.isEnabled = state.settings.enable_anilist_integration;
                this.anilistUI.isLocked = state.settings.lockAnilistPanel;
                this.anilistUI.updateDynamicStyles();
            }

            // 5. Log Filters
            const infoBtn = this.ui.shadowRoot.getElementById('btn-filter-info');
            const errorBtn = this.ui.shadowRoot.getElementById('btn-filter-error');
            infoBtn?.classList.toggle('active', state.logFilters.info);
            errorBtn?.classList.toggle('active', state.logFilters.error);
            
            logContainer?.querySelectorAll('.log-item').forEach(item => {
                const isError = item.classList.contains('log-item-error');
                const visible = state.logFilters[isError ? 'error' : 'info'];
                item.classList.toggle('hidden-by-filter', !visible);
            });

            // 6. UI Mode
            const fullUi = this.ui.shadowRoot.getElementById('full-ui-container');
            const compactUi = this.ui.shadowRoot.getElementById('compact-ui-container');
            const modeBtn = this.ui.shadowRoot.getElementById('btn-toggle-ui-mode');
            
            if (fullUi && compactUi && modeBtn) {
                const isFull = state.uiMode === 'full';
                fullUi.style.display = isFull ? 'flex' : 'none';
                compactUi.style.display = isFull ? 'none' : 'flex';
                modeBtn.querySelector('.icon-full-ui').style.display = isFull ? 'block' : 'none';
                modeBtn.querySelector('.icon-compact-ui').style.display = isFull ? 'none' : 'block';
            }
            
            // 7. Playback Controls
            const playNewBtn = this.ui.shadowRoot.getElementById('btn-play-new');
            const playbackControls = this.ui.shadowRoot.getElementById('playback-controls');
            if (playNewBtn && playbackControls) {
                const showPlayNew = state.settings.show_play_new_button;
                playNewBtn.style.display = showPlayNew ? 'flex' : 'none';
                playbackControls.style.gridTemplateColumns = showPlayNew ? '1fr 1fr auto' : '1fr auto';
            }

            const stubBtn = this.ui.shadowRoot.getElementById('btn-toggle-stub');
            stubBtn?.classList.toggle('active-toggle', state.settings.show_minimized_stub);
        }

        async applyInitialState(positionOverride = null) {
            try {
                const response = await this.bridge.send('get_ui_preferences');
                if (!this.ui.shadowRoot || !this.ui.controllerHost) return;

                const prefs = response?.preferences || {};

                this.state.update({
                    kb_add_playlist: prefs.kb_add_playlist,
                    kb_toggle_controller: prefs.kb_toggle_controller,
                    kb_open_popup: prefs.kb_open_popup,
                    kb_play_playlist: prefs.kb_play_playlist,
                    kb_switch_playlist: prefs.kb_switch_playlist,
                    anilistVisible: prefs.anilistPanelVisible ?? false,
                    anilistImageHeight: prefs.anilist_image_height ?? 126,
                    settings: {
                        enable_active_item_highlight: prefs.enable_active_item_highlight ?? true,
                        enable_smart_resume: prefs.enable_smart_resume ?? true,
                        show_minimized_stub: prefs.show_minimized_stub ?? true,
                        show_play_new_button: prefs.show_play_new_button ?? false,
                        enable_anilist_integration: prefs.enable_anilist_integration ?? true,
                        lockAnilistPanel: prefs.lockAnilistPanel ?? false,
                        forcePanelAttached: prefs.forcePanelAttached ?? false,
                        anilistAttachOnOpen: prefs.anilistAttachOnOpen ?? true,
                        enable_dblclick_copy: prefs.enable_dblclick_copy ?? false,
                        show_copy_title_button: prefs.show_copy_title_button ?? false,
                        confirm_clear_playlist: prefs.confirm_clear_playlist ?? true,
                        confirm_close_mpv: prefs.confirm_close_mpv ?? true,
                        confirm_play_new: prefs.confirm_play_new ?? true
                    },
                    pinned: prefs.pinned ?? false,
                    logVisible: prefs.logVisible ?? true,
                    logFilters: prefs.logFilters ?? { info: true, error: true },
                    uiMode: (prefs.mode === 'minimized') ? 'full' : (prefs.mode || 'full')
                }, true);

                if (prefs.scraper_filter_words) {
                    this.pageScraper.updateFilterWords(prefs.scraper_filter_words);
                }

                const position = positionOverride || prefs.position;
                if (position && this.ui.controllerHost) Object.assign(this.ui.controllerHost.style, position);
                
                if (this.anilistUI) {
                    if (prefs.anilistPanelPosition) {
                        Object.assign(this.anilistUI.panelHost.style, prefs.anilistPanelPosition);
                        this.anilistUI.isManuallyPositioned = true;
                    }
                    if (prefs.anilistPanelSize) Object.assign(this.anilistUI.panelHost.style, prefs.anilistPanelSize);
                    
                    this.anilistUI.isLocked = prefs.lockAnilistPanel ?? false;
                    this.anilistUI.forceAttached = prefs.forcePanelAttached ?? false;
                    this.anilistUI.isEnabled = prefs.enable_anilist_integration ?? true;
                    this.anilistUI.toggleVisibility(this.state.state.anilistVisible, false);
                }
                
                if (this.ui.minimizedHost && prefs.minimizedStubPosition) {
                    Object.assign(this.ui.minimizedHost.style, prefs.minimizedStubPosition);
                    this.ui.minimizedHost.classList.remove('top-left', 'top-right');
                }

                const shouldBeMinimized = (typeof prefs.minimized === 'boolean') ? prefs.minimized : (prefs.mode === 'minimized');
                this.state.update({ minimized: shouldBeMinimized }, true);
                this._syncUiToState(this.state.state);

            } catch (e) {
                console.error("[UI][Controller] Error applying initial state:", e);
            }
        }

        // --- Message Logic Handlers ---

        _handleInitState(req) {
            if (!this.ui.controllerHost) return;
            this.tabId = req.tabId;
            this.bridge.tabId = req.tabId; 
            
            this.applyInitialState().then(() => {
                this.setMinimizedState(req.shouldBeMinimized, false);
                if (req.detectedUrl) {
                    this.state.update({ detectedUrl: req.detectedUrl });
                }
                if (req.folderId) {
                    this.updateFolderDropdowns(req.folderId, req.lastPlayedId, req.isFolderActive);
                }
            });
        }

        async _handleYtdlpUpdateConfirm() {
            const confirmed = await this.showPageLevelConfirmation(
                "YouTube playback failed. This is often caused by an outdated yt-dlp. Would you like to attempt to automatically update it now?"
            );
            if (confirmed) {
                chrome.runtime.sendMessage({ action: 'user_confirmed_ytdlp_update' });
            }
        }

        _handleNavigation(url) {
            this.state.update({ detectedUrl: null });
            this.updateFolderDropdowns();
            this._reportCurrentUrl();
            this.updateAddButtonState();
        }

        _handleDomMutation() {
            if (!document.getElementById('m3u8-controller-host')) {
                this.teardown();
                setTimeout(() => this.init(), 100);
                return;
            }
            this._reportCurrentUrl();
        }

        _reportCurrentUrl() {
            this.bridge.send('report_page_url', null, { url: window.location.href });
        }

        _syncFolderChange(req) {
             if (!this.ui.shadowRoot) return;
             const full = this.ui.shadowRoot.getElementById('folder-select');
             if (full && full.value !== req.folderId) {
                 full.value = req.folderId;
                 const compact = this.ui.shadowRoot.getElementById('compact-folder-select');
                 if (compact) compact.value = req.folderId;
                 if (req.playlist) {
                     this.playlistUI?.render(req.playlist, req.lastPlayedId, req.isFolderActive);
                 } else {
                     this.refreshPlaylist();
                 }
             }
        }
        
        async _handleAsyncConfirmation(req, send) {
             const result = await this.showPageLevelConfirmation(req.message);
             if (send) send({ confirmed: result });
             return result;
        }
        
        _handleRightClickScrape(send) {
            let url = window.location.href;
            let title = null;

            if (window.location.hostname.includes('youtube.com') && this.lastRightClickedElement) {
                const videoContainer = this.lastRightClickedElement.closest('ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer');
                if (videoContainer) {
                    const linkEl = videoContainer.querySelector('a#video-title-link, a#thumbnail, a.yt-simple-endpoint');
                    if (linkEl && linkEl.href) {
                        url = linkEl.href;
                    }

                    const titleSelectors = ['#video-title', '#title-text', 'span#video-title', '.ytp-title-link'];
                    const channelSelectors = ['#channel-name .yt-formatted-string', '.ytd-channel-name .yt-formatted-string', '#byline-container .yt-formatted-string', '#owner-name a'];
                    
                    let videoTitle = null;
                    for (const selector of titleSelectors) {
                        const el = videoContainer.querySelector(selector);
                        if (el) { videoTitle = el.textContent.trim(); break; }
                    }

                    let channelName = null;
                    for (const selector of channelSelectors) {
                        const el = videoContainer.querySelector(selector);
                        if (el) { channelName = el.textContent.trim(); break; }
                    }

                    if (videoTitle) {
                        title = channelName ? `${channelName} - ${videoTitle}` : videoTitle;
                    }
                }
            } 
            
            if (!title && this.lastRightClickedElement) {
                 const linkElement = this.lastRightClickedElement.closest('a');
                 if (linkElement && linkElement.href) {
                     url = linkElement.href;
                     title = linkElement.textContent.trim();
                 }
            }

            if (!title || !url) {
                 const details = this.pageScraper.scrapePageDetails(url || window.location.href);
                 url = url || details.url;
                 title = title || details.title;
            }

            send({ url, title });
        }

        showPageLevelConfirmation(message) {
            return new Promise((resolve) => {
                if (document.getElementById('mpv-page-level-modal-host')) {
                    resolve(false);
                    return;
                }

                const modalHost = document.createElement('div');
                modalHost.id = 'mpv-page-level-modal-host';
                modalHost.style.position = 'fixed';
                modalHost.style.top = '0';
                modalHost.style.left = '0';
                modalHost.style.width = '100%';
                modalHost.style.height = '100%';
                modalHost.style.zIndex = '2147483647';

                const shadowRoot = modalHost.attachShadow({ mode: 'open' });

                const style = document.createElement('style');
                style.textContent = `
                    :host {
                        --surface-color: #1d1f23;
                        --border-color: #33363b;
                        --text-primary: #e1e1e1;
                        --accent-primary: #5865f2;
                        --accent-primary-hover: #4f5bda;
                        --surface-hover-color: #2c2e33;
                        --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
                        --border-radius: 6px;
                    }
                    #page-level-confirmation-overlay {
                        position: absolute;
                        top: 0; left: 0; right: 0; bottom: 0;
                        background-color: rgba(0, 0, 0, 0.8);
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        font-family: var(--font-sans);
                    }
                    .modal-content {
                        background-color: var(--surface-color);
                        color: var(--text-primary);
                        padding: 24px;
                        border-radius: var(--border-radius);
                        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
                        text-align: center;
                        border: 1px solid var(--border-color);
                        display: flex;
                        flex-direction: column;
                        gap: 20px;
                        max-width: 400px;
                        width: 90%;
                    }
                    p { margin: 0; font-size: 16px; line-height: 1.5; }
                    .modal-actions { display: flex; justify-content: center; gap: 12px; }
                    button {
                        color: #fff; border: none; border-radius: var(--border-radius);
                        padding: 10px 20px; font-size: 14px; font-weight: 600;
                        cursor: pointer; transition: all 0.15s ease;
                    }
                    #page-level-modal-confirm-btn { background-color: var(--accent-primary); }
                    #page-level-modal-confirm-btn:hover { background-color: var(--accent-primary-hover); }
                    #page-level-modal-cancel-btn { background-color: var(--surface-hover-color); }
                    #page-level-modal-cancel-btn:hover { background-color: var(--border-color); }
                `;

                const modalWrapper = document.createElement('div');
                modalWrapper.id = 'page-level-confirmation-overlay';
                modalWrapper.innerHTML = `
                    <div class="modal-content">
                        <p id="page-level-modal-message"></p>
                        <div class="modal-actions">
                            <button id="page-level-modal-confirm-btn">Confirm</button>
                            <button id="page-level-modal-cancel-btn">Cancel</button>
                        </div>
                    </div>
                `;

                shadowRoot.append(style, modalWrapper);
                shadowRoot.getElementById('page-level-modal-message').textContent = message;
                
                const handleKeyDown = (e) => {
                    if (e.key === 'Enter') { e.preventDefault(); close(true); }
                    else if (e.key === 'Escape') { e.preventDefault(); close(false); }
                };

                const close = (result) => {
                    window.removeEventListener('keydown', handleKeyDown, true);
                    document.body.removeChild(modalHost);
                    resolve(result);
                };

                shadowRoot.getElementById('page-level-modal-confirm-btn').onclick = () => close(true);
                shadowRoot.getElementById('page-level-modal-cancel-btn').onclick = () => close(false);

                window.addEventListener('keydown', handleKeyDown, true);
                document.body.appendChild(modalHost);
                shadowRoot.getElementById('page-level-modal-confirm-btn').focus();
            });
        }

        async updateFolderDropdowns(targetId, targetLastPlayed, targetIsActive) {
            const response = await this.bridge.send('get_all_folder_ids');
            if (!response?.success) return;

            const fullSelect = this.ui.shadowRoot?.getElementById('folder-select');
            const compactSelect = this.ui.shadowRoot?.getElementById('compact-folder-select');
            if (!fullSelect || !compactSelect) return;

            const fragment = document.createDocumentFragment();
            response.folderIds.forEach((id, i) => {
                const opt = document.createElement('option');
                opt.value = id;
                opt.textContent = `${i + 1}. ${id}`;
                fragment.appendChild(opt);
            });

            fullSelect.innerHTML = '';
            compactSelect.innerHTML = '';
            fullSelect.appendChild(fragment.cloneNode(true));
            compactSelect.appendChild(fragment);

            const selectedId = targetId || response.lastUsedFolderId;
            if (selectedId) {
                 fullSelect.value = selectedId;
                 compactSelect.value = selectedId;
            }

            this.refreshPlaylist(targetLastPlayed, targetIsActive);
        }

        refreshPlaylist(targetLastPlayed, targetIsActive) {
            const folderId = this.ui.shadowRoot?.getElementById('folder-select')?.value;
            if (folderId) {
                this.bridge.send('get_playlist', folderId).then(response => {
                    if (response?.success) {
                        this.playlistUI?.render(response.list, targetLastPlayed || response.last_played_id, targetIsActive || response.isFolderActive);
                        this.setPlaybackActive(targetIsActive || response.isFolderActive);
                    }
                });
            }
        }

        setPlaybackLoading(isLoading) {
            if (!this.ui.shadowRoot) return;
            const playBtns = [
                this.ui.shadowRoot.getElementById('btn-play'),
                this.ui.shadowRoot.getElementById('btn-compact-play'),
                this.ui.minimizedHost?.shadowRoot?.getElementById('m3u8-minimized-play-btn')
            ];
            playBtns.forEach(btn => {
                if (btn) {
                    btn.classList.toggle('btn-loading', isLoading);
                    if (isLoading) btn.classList.remove('btn-playing');
                }
            });
        }

        setPlaybackActive(isActive) {
            if (!this.ui.shadowRoot) return;
            const playBtns = [
                this.ui.shadowRoot.getElementById('btn-play'),
                this.ui.shadowRoot.getElementById('btn-compact-play'),
                this.ui.minimizedHost?.shadowRoot?.getElementById('m3u8-minimized-play-btn')
            ];
            playBtns.forEach(btn => {
                if (btn) {
                    btn.classList.toggle('btn-playing', isActive);
                    if (isActive) btn.classList.remove('btn-loading');
                }
            });
        }

        sendCommandToBackground(action, folderId, data = {}) {
            if (action === 'play') {
                this.setPlaybackLoading(true);
            }

            this.bridge.send(action, folderId, data).then(response => {
                if (action === 'play') {
                    this.setPlaybackLoading(false);
                    if (response?.success) {
                        this.setPlaybackActive(true);
                    }
                }

                if (action === 'get_playlist' && response?.success) {
                    this.playlistUI?.render(response.list, response.last_played_id, response.isFolderActive);
                    this.setPlaybackActive(response.isFolderActive);
                }
            }).catch(() => {
                if (action === 'play') this.setPlaybackLoading(false);
            });
        }

        _startHeartbeat() {
            this.heartbeatInterval = setInterval(this._safeWrap(async () => {
                try {
                    await this.bridge.send('heartbeat');
                } catch (e) {
                    console.warn("[Content] Heartbeat failed, tearing down:", e);
                    this.teardown();
                }
            }), 30000);
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
                        return result.catch(e => {
                            if (this.isReloadError(e)) this.teardown();
                            else throw e;
                        });
                    }
                    return result;
                } catch (e) {
                    if (this.isReloadError(e)) this.teardown();
                    else throw e;
                }
            };
        }

        isReloadError(e) {
            const msg = e?.message || "";
            return msg.includes("Extension context invalidated") || 
                   msg.includes("Receiving end does not exist") ||
                   msg.includes("message channel closed");
        }

        _bindControllerEvents() {
            if (!this.ui.shadowRoot) return;

            const root = this.ui.shadowRoot;
            const minRoot = this.ui.minimizedHost?.shadowRoot;

            // --- Core UI Toggles ---
            root.getElementById('btn-toggle-minimize')?.addEventListener('click', () => this.setMinimizedState(true));
            root.getElementById('btn-toggle-pin')?.addEventListener('click', () => this.setPinState(!this.state.state.pinned));
            root.getElementById('btn-toggle-stub')?.addEventListener('click', () => {
                const newVal = !this.state.state.settings.show_minimized_stub;
                this.state.update({ settings: { ...this.state.state.settings, show_minimized_stub: newVal } });
                this.savePreference({ show_minimized_stub: newVal });
            });
            root.getElementById('btn-toggle-ui-mode')?.addEventListener('click', () => {
                const newMode = this.state.state.uiMode === 'full' ? 'compact' : 'full';
                this.state.update({ uiMode: newMode });
                this.savePreference({ mode: newMode });
            });

            // --- Playback & List Actions ---
            const getFolderId = () => root.getElementById('folder-select')?.value;

            root.getElementById('btn-play')?.addEventListener('click', () => {
                const fid = getFolderId();
                if (fid) this.sendCommandToBackground('play', fid);
            });
            root.getElementById('btn-play-new')?.addEventListener('click', async () => {
                const fid = getFolderId();
                if (!fid) return;
                const confirmed = !this.state.state.settings.confirm_play_new || 
                                  await this.showPageLevelConfirmation("Launching a new MPV instance while another is running may cause issues. Continue?");
                if (confirmed) {
                    this.sendCommandToBackground('play', fid, { play_new_instance: true });
                }
            });
            root.getElementById('btn-close-mpv')?.addEventListener('click', async () => {
                const fid = getFolderId();
                if (!fid) return;
                
                const status = await this.bridge.send('is_mpv_running');
                if (!status?.is_running) {
                    this.addLogEntry({ text: "[Content]: Close command ignored, MPV is not running.", type: 'info' });
                    return;
                }

                const confirmed = !this.state.state.settings.confirm_close_mpv || 
                                  await this.showPageLevelConfirmation("Are you sure you want to close MPV?");
                if (confirmed) this.sendCommandToBackground('close_mpv', fid);
            });
            root.getElementById('btn-add')?.addEventListener('click', async () => {
                const fid = getFolderId();
                if (fid && this.state.state.detectedUrl) {
                    const result = await this.bridge.send('add', fid, { data: this.pageScraper.scrapePageDetails(this.state.state.detectedUrl) });
                    if (result?.success) this.refreshPlaylist();
                }
            });
            root.getElementById('btn-clear')?.addEventListener('click', async () => {
                const fid = getFolderId();
                if (!fid) return;
                const confirmed = !this.state.state.settings.confirm_clear_playlist || 
                                  await this.showPageLevelConfirmation(`Are you sure you want to clear the playlist in "${fid}"?`);
                if (confirmed) this.sendCommandToBackground('clear', fid);
            });

            // Compact equivalents
            root.getElementById('btn-compact-play')?.addEventListener('click', () => {
                const fid = root.getElementById('compact-folder-select')?.value;
                if (fid) this.sendCommandToBackground('play', fid);
            });
            root.getElementById('btn-compact-add')?.addEventListener('click', async () => {
                const fid = root.getElementById('compact-folder-select')?.value;
                if (fid && this.state.state.detectedUrl) {
                    const result = await this.bridge.send('add', fid, { data: this.pageScraper.scrapePageDetails(this.state.state.detectedUrl) });
                    if (result?.success) this.refreshPlaylist();
                }
            });
            root.getElementById('btn-compact-clear')?.addEventListener('click', async () => {
                const fid = root.getElementById('compact-folder-select')?.value;
                if (!fid) return;
                const confirmed = !this.state.state.settings.confirm_clear_playlist || 
                                  await this.showPageLevelConfirmation(`Are you sure you want to clear the playlist in "${fid}"?`);
                if (confirmed) this.sendCommandToBackground('clear', fid);
            });
            root.getElementById('btn-compact-close-mpv')?.addEventListener('click', async () => {
                const fid = root.getElementById('compact-folder-select')?.value;
                if (!fid) return;
                const confirmed = !this.state.state.settings.confirm_close_mpv || 
                                  await this.showPageLevelConfirmation("Are you sure you want to close MPV?");
                if (confirmed) this.sendCommandToBackground('close_mpv', fid);
            });

            // --- Log Controls ---
            root.getElementById('btn-toggle-log')?.addEventListener('click', () => this.state.update({ logVisible: !this.state.state.logVisible }));
            root.getElementById('btn-clear-log')?.addEventListener('click', () => {
                const logContainer = root.getElementById('log-container');
                if (logContainer) logContainer.innerHTML = '';
            });
            root.getElementById('btn-filter-info')?.addEventListener('click', () => {
                const filters = { ...this.state.state.logFilters, info: !this.state.state.logFilters.info };
                this.state.update({ logFilters: filters });
            });
            root.getElementById('btn-filter-error')?.addEventListener('click', () => {
                const filters = { ...this.state.state.logFilters, error: !this.state.state.logFilters.error };
                this.state.update({ logFilters: filters });
            });

            // --- Minimized Stub Events ---
            minRoot?.getElementById('m3u8-minimized-stub')?.addEventListener('click', async (e) => {
                const stub = e.currentTarget;
                const isStreamPresent = stub?.classList.contains('stream-present');
                const isAlreadyInPlaylist = stub?.classList.contains('url-in-playlist');
                
                console.log("[Stub Click]", { isStreamPresent, isAlreadyInPlaylist, button: e.button });

                if (isStreamPresent && !isAlreadyInPlaylist && e.button === 0) {
                    const hostname = window.location.hostname;
                    const isYouTube = hostname.includes('youtube.com') && window.location.pathname.includes('/watch');
                    const urlToUse = this.state.state.detectedUrl || (isYouTube ? window.location.href : null);

                    console.log("[Stub Click] Attempting to add:", urlToUse);

                    if (!urlToUse) {
                        this.setMinimizedState(false);
                        return;
                    }

                    let targetFolderId = getFolderId();
                    
                    if (!targetFolderId) {
                        const response = await this.bridge.send('get_last_folder_id');
                        if (response?.success && response.folderId) {
                            targetFolderId = response.folderId;
                        }
                    }

                    console.log("[Stub Click] Target folder:", targetFolderId);
                    
                    if (targetFolderId) {
                        const result = await this.bridge.send('add', targetFolderId, { 
                            data: this.pageScraper.scrapePageDetails(urlToUse) 
                        });
                        this.addLogEntry({ text: `[Content]: Adding detected stream via minimized stub...`, type: 'info' });
                        if (result?.success) this.refreshPlaylist();
                    } else {
                        console.warn("[Stub Click] Could not determine target folder.");
                        this.setMinimizedState(false);
                    }
                } else {
                    console.log("[Stub Click] Logic falling through to setMinimizedState(false)");
                    this.setMinimizedState(false);
                }
            });
            minRoot?.getElementById('m3u8-minimized-play-btn')?.addEventListener('click', () => {
                const fid = getFolderId();
                if (fid) this.sendCommandToBackground('play', fid);
            });

            // --- Global Listeners ---
            document.addEventListener('fullscreenchange', this.handleFullscreenChange);
            window.addEventListener('keydown', this.handleGlobalKeydown, true);
            this.resizeListener = MPV.debounce(() => this._handleResize(), 250);
            window.addEventListener('resize', this.resizeListener);

            // --- Draggable Init ---
            const banner = root.getElementById('status-banner');
            if (banner) {
                new MPV.Draggable(this.ui.controllerHost, banner, {
                    dragButton: 0,
                    onDragStart: () => !this.state.state.pinned,
                    onDragMove: () => this.updateAdaptiveElements(),
                    onDragEnd: (e, pos) => {
                        this.preResizePosition = null;
                        this.savePreference({ position: pos });
                    }
                });
            }

            const minStub = minRoot?.getElementById('m3u8-minimized-wrapper');
            if (minStub) {
                const minHandle = minRoot.getElementById('m3u8-minimized-stub');
                if (minHandle) minHandle.title = 'Left-click: Open Controller\nRight-click: Drag to move';

                new MPV.Draggable(this.ui.minimizedHost, minStub, {
                    dragButton: 2,
                    onDragEnd: (e, pos) => {
                        this.ui.minimizedHost.classList.remove('top-left', 'top-right');
                        this.savePreference({ minimizedStubPosition: pos });
                    }
                });
            }
        }

        updateStatusBanner(text, isSuccess = false) {
            const statusBanner = this.ui.shadowRoot?.getElementById('status-banner');
            const streamStatus = this.ui.shadowRoot?.getElementById('stream-status');
            if (!statusBanner || !streamStatus) return;

            streamStatus.textContent = text;
            statusBanner.classList.toggle("detected", isSuccess);
        }

        updateAddButtonState() {
            if (!this.ui.shadowRoot) return;
            
            const addBtn = this.ui.shadowRoot.getElementById('btn-add');
            const compactAddBtn = this.ui.shadowRoot.getElementById('btn-compact-add');
            // Ensure we are looking inside the shadowRoot of the minimizedHost
            const minimizedStub = this.ui.minimizedHost?.shadowRoot?.getElementById('m3u8-minimized-stub');
            
            const hostname = window.location.hostname;
            const isYouTube = hostname.includes('youtube.com') && window.location.pathname.includes('/watch');
            const url = this.state.state.detectedUrl || (isYouTube ? window.location.href : null);

            // Reset button states
            [addBtn, compactAddBtn, minimizedStub].forEach(btn => {
                btn?.classList.remove('url-in-playlist', 'stream-present');
            });

            if (!url) {
                this.updateStatusBanner('No stream/playlist detected', false);
                if (minimizedStub) {
                    minimizedStub.title = 'Left-click: Open Controller\nRight-click: Drag to move';
                    minimizedStub.classList.remove('stream-present', 'url-in-playlist');
                }
                [addBtn, compactAddBtn].forEach(btn => {
                    if (btn) {
                        btn.disabled = true;
                        btn.title = "No stream detected";
                    }
                });
            } else {
                this.updateStatusBanner(isYouTube ? 'YouTube Video detected' : 'Stream/video detected', true);

                const playlist = this.playlistUI?.currentPlaylist || [];
                const isUrlInPlaylist = playlist.some(item => item.url === url);

                const targets = [addBtn, compactAddBtn, minimizedStub];

                if (isUrlInPlaylist) {
                    targets.forEach(btn => {
                        if (!btn) return;
                        btn.classList.add('url-in-playlist');
                        btn.title = btn === minimizedStub 
                            ? 'URL is already in playlist\nLeft-click: Open Controller\nRight-click: Drag to move'
                            : 'URL is already in this playlist';
                    });
                } else {
                    targets.forEach(btn => {
                        if (!btn) return;
                        btn.classList.add('stream-present');
                        btn.title = btn === minimizedStub
                            ? 'Stream Detected!\nLeft-click: Add to Playlist\nRight-click: Drag to move'
                            : 'Click to add URL to playlist';
                    });
                }
                
                [addBtn, compactAddBtn].forEach(btn => {
                    if (btn) btn.disabled = false;
                });
            }
        }

        updateAdaptiveElements() {
            if (!this.ui.shadowRoot) return;
            const state = this.state.state;
            const leftAniBtn = this.ui.shadowRoot.getElementById('btn-toggle-anilist-left');
            const rightAniBtn = this.ui.shadowRoot.getElementById('btn-toggle-anilist-right');
            
            const showAnilistButtons = state.settings.enable_anilist_integration;
            if (leftAniBtn) leftAniBtn.style.display = (showAnilistButtons && state.uiMode === 'compact') ? 'flex' : 'none';
            if (rightAniBtn) rightAniBtn.style.display = (showAnilistButtons && state.uiMode === 'full') ? 'flex' : 'none';
            
            if (this.anilistUI) this.anilistUI.validatePosition();
        }

        addLogEntry(log) {
            if (!this.ui.shadowRoot) return;
            const container = this.ui.shadowRoot.getElementById('log-container');
            if (!container) return;

            const placeholder = container.querySelector('#log-placeholder');
            if (placeholder) placeholder.remove();

            const entry = document.createElement('div');
            entry.className = `log-item log-item-${log.type || 'info'}`;
            
            const isError = log.type === 'error';
            if (!this.state.state.logFilters[isError ? 'error' : 'info']) {
                entry.classList.add('hidden-by-filter');
            }

            const timestamp = new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
            entry.innerHTML = `<span class="log-time">[${timestamp}]</span> <span class="log-text">${log.text}</span>`;
            
            container.appendChild(entry);
            container.scrollTop = container.scrollHeight;
        }

        _handleResize() {
            const host = this.ui.controllerHost;
            if (!host || host.style.display === 'none') {
                this.validateAndRepositionMinimizedStub();
                return;
            }

            const maxX = window.innerWidth - host.offsetWidth;
            const maxY = window.innerHeight - host.offsetHeight;
            const isOffScreen = host.offsetLeft > maxX || host.offsetTop > maxY;

            if (isOffScreen) {
                if (!this.preResizePosition) {
                    this.preResizePosition = { left: host.style.left, top: host.style.top };
                }
                this.validateAndRepositionController();
            } else if (this.preResizePosition) {
                const originalLeft = parseFloat(this.preResizePosition.left) || 0;
                const originalTop = parseFloat(this.preResizePosition.top) || 0;
                if (originalLeft <= maxX && originalTop <= maxY) this.preResizePosition = null;
            }
        }

        validateAndRepositionController() {
            const host = this.ui.controllerHost;
            if (!host || host.style.display === 'none') return;

            requestAnimationFrame(() => {
                const rect = host.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) return;

                const vw = window.innerWidth;
                const vh = window.innerHeight;
                let newLeft = rect.left;
                let newTop = rect.top;
                let changed = false;

                if (rect.right > vw) { newLeft = Math.max(0, vw - rect.width); changed = true; }
                if (rect.bottom > vh) { newTop = Math.max(0, vh - rect.height); changed = true; }
                if (rect.left < 0) { newLeft = 0; changed = true; }
                if (rect.top < 0) { newTop = 0; changed = true; }

                if (changed) {
                    const pos = { left: `${newLeft}px`, top: `${newTop}px`, right: 'auto', bottom: 'auto' };
                    Object.assign(host.style, pos);
                    this.savePreference({ position: pos });
                }
            });
        }

        validateAndRepositionMinimizedStub() {
            const stub = this.ui.minimizedHost;
            if (!stub || stub.style.display === 'none') return;

            requestAnimationFrame(() => {
                const rect = stub.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) return;

                const vw = window.innerWidth;
                const vh = window.innerHeight;
                let newLeft = rect.left;
                let newTop = rect.top;
                let changed = false;

                if (rect.right > vw) { newLeft = Math.max(0, vw - rect.width); changed = true; }
                if (rect.bottom > vh) { newTop = Math.max(0, vh - rect.height); changed = true; }
                if (rect.left < 0) { newLeft = 0; changed = true; }
                if (rect.top < 0) { newTop = 0; changed = true; }

                if (changed) {
                    const pos = { left: `${newLeft}px`, top: `${newTop}px`, right: 'auto', bottom: 'auto' };
                    Object.assign(stub.style, pos);
                    this.savePreference({ minimizedStubPosition: pos });
                }
            });
        }

        handleGlobalKeydown(e) {
            if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || e.target.isContentEditable) return;

            const combo = this.normalizeKeyCombo(e);
            const state = this.state.state;
            const normalize = (str) => (str || '').replace(/\s+/g, '').toLowerCase().replace('control', 'ctrl').replace('command', 'meta').replace('option', 'alt');

            if (state.kb_add_playlist && combo === normalize(state.kb_add_playlist)) {
                e.preventDefault(); e.stopPropagation();
                const folderId = this.ui.shadowRoot?.getElementById('folder-select')?.value;
                if (folderId && state.detectedUrl) this.sendCommandToBackground('add', folderId, { data: this.pageScraper.scrapePageDetails(state.detectedUrl) });
            } else if (state.kb_toggle_controller && combo === normalize(state.kb_toggle_controller)) {
                e.preventDefault(); e.stopPropagation(); this.setMinimizedState(!state.minimized);
            } else if (state.kb_play_playlist && combo === normalize(state.kb_play_playlist)) {
                e.preventDefault(); e.stopPropagation();
                const folderId = this.ui.shadowRoot?.getElementById('folder-select')?.value;
                if (folderId) this.sendCommandToBackground('play', folderId);
            } else if (state.kb_switch_playlist && combo === normalize(state.kb_switch_playlist)) {
                e.preventDefault(); e.stopPropagation();
                this.bridge.send('switch_playlist');
            } else if (state.kb_open_popup && combo === normalize(state.kb_open_popup)) {
                e.preventDefault(); e.stopPropagation();
                this.bridge.send('open_popup');
            }
        }

        normalizeKeyCombo(e) {
            const modifiers = [];
            if (e.ctrlKey) modifiers.push('ctrl');
            if (e.metaKey) modifiers.push('meta');
            if (e.altKey) modifiers.push('alt');
            if (e.shiftKey) modifiers.push('shift');

            let key = e.key.toLowerCase();
            
            if (key === ' ') key = 'space';
            if (key === 'escape') key = 'esc';
            if (['control', 'shift', 'alt', 'meta'].includes(key)) return null;
            
            return [...modifiers, key].join('+');
        }

        handleFullscreenChange() {
            const host = this.ui.controllerHost;
            const stub = this.ui.minimizedHost;
            if (document.fullscreenElement) {
                if (host && !this.preFullscreenPosition) {
                    this.preFullscreenPosition = { 
                        left: host.style.left, 
                        top: host.style.top, 
                        right: host.style.right, 
                        bottom: host.style.bottom 
                    };
                }
                if (host) host.style.display = 'none';
                if (stub) stub.style.display = 'none';
            } else {
                if (this.preFullscreenPosition && host) { 
                    Object.assign(host.style, this.preFullscreenPosition); 
                    this.preFullscreenPosition = null; 
                }
                this._syncUiToState(this.state.state);
            }
        }

        checkContext() { return !!chrome.runtime?.id; }
    };
})();