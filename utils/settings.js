/**
 * Manages the settings UI, including loading, saving, and event handling for all preferences.
 */
class OptionsManager {
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
            { key: 'launch_geometry', elementId: 'geometry-select', type: 'select' },
            { key: 'custom_geometry_width', elementId: 'custom-width', type: 'input' },
            { key: 'custom_geometry_height', elementId: 'custom-height', type: 'input' },
            { key: 'force_terminal', elementId: 'force-terminal-checkbox', type: 'checkbox' },
            { key: 'show_play_new_button', elementId: 'show-play-new-button-checkbox', type: 'checkbox' },
            { key: 'duplicate_url_behavior', elementId: 'duplicate-behavior-select', type: 'select' },
            { key: 'one_click_add', elementId: 'one-click-add-checkbox', type: 'checkbox' },
            { key: 'stream_scanner_timeout', elementId: 'scanner-timeout-input', type: 'input', transform: Number },
            { key: 'confirm_remove_folder', elementId: 'confirm-remove-folder-checkbox', type: 'checkbox' },
            { key: 'confirm_clear_playlist', elementId: 'confirm-clear-playlist-checkbox', type: 'checkbox' },
            { key: 'confirm_close_mpv', elementId: 'confirm-close-mpv-checkbox', type: 'checkbox' },
            { key: 'confirm_play_new', elementId: 'confirm-play-new-checkbox', type: 'checkbox' },
            { key: 'confirm_folder_switch', elementId: 'confirm-folder-switch-checkbox', type: 'checkbox' },
            { key: 'clear_on_completion', elementId: 'clear-on-completion-checkbox', type: 'checkbox' },
            { key: 'autofocus_new_folder', elementId: 'autofocus-new-folder-checkbox', type: 'checkbox' },
            { key: 'enable_dblclick_copy', elementId: 'enable-dblclick-copy-checkbox', type: 'checkbox' },
            { key: 'show_copy_title_button', elementId: 'show-copy-title-button-checkbox', type: 'checkbox' },
            { key: 'lockAnilistPanel', elementId: 'lock-anilist-panel-checkbox', type: 'checkbox' },
            { key: 'forcePanelAttached', elementId: 'force-panel-attached-checkbox', type: 'checkbox' },
            { key: 'anilistAttachOnOpen', elementId: 'anilist-attach-on-open-checkbox', type: 'checkbox' },
            { key: 'enable_anilist_integration', elementId: 'enable-anilist-integration-checkbox', type: 'checkbox' },
            { key: 'disable_anilist_cache', elementId: 'disable-anilist-cache-checkbox', type: 'checkbox' },
            { key: 'anilist_image_height', elementId: 'anilist-image-height-slider', type: 'slider', transform: Number },
            { key: 'show_minimized_stub', elementId: 'show-minimized-stub-checkbox', type: 'checkbox' },
            { key: 'ytdlp_update_behavior', elementId: 'ytdlp-update-behavior-select', type: 'select' },
            { key: 'mode', elementId: 'default-ui-mode-select', type: 'select' },
            { key: 'kb_add_playlist', elementId: 'kb-add-playlist-input', type: 'input' },
            { key: 'kb_toggle_controller', elementId: 'kb-toggle-ui-input', type: 'input' },
            { key: 'kb_open_popup', elementId: 'kb-open-popup-input', type: 'input' }
        ];

        this.debouncedSaveAllPreferences = this._debounce(this.saveAllPreferences.bind(this), 400);
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
        const isCustom = prefs.launch_geometry === 'custom';

        this.preferenceMappings.forEach(mapping => {
            const el = document.getElementById(mapping.elementId);
            if (el) {
                const value = prefs[mapping.key];
                if (mapping.type === 'checkbox') {
                    el.checked = !!value;
                } else { // select, input, textarea, slider
                    el.value = value !== undefined ? value : '';
                }
            }
        });

        // Handle special UI logic that depends on preferences
        document.getElementById('custom-geometry-container').style.display = isCustom ? 'flex' : 'none';
        const enableAnilist = prefs.enable_anilist_integration ?? true;
        document.getElementById('anilist-options-container').style.display = enableAnilist ? 'block' : 'none';
        document.getElementById('shared-anilist-section').style.display = enableAnilist ? 'block' : 'none';

        // Manual handling for MPV flags list
        const flagsStr = prefs.custom_mpv_flags || '';
        const flags = flagsStr.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
        this._renderMpvFlagsList(flags);

        // Manual handling for Automatic MPV flags list
        const automaticFlags = prefs.automatic_mpv_flags || [];
        this._renderAutomaticMpvFlagsList(automaticFlags);

        this._updateAnilistImageSize(prefs.anilist_image_height || 126);

        this._renderScraperFilterList(prefs.scraper_filter_words || []);
        this._renderBuiltInFilterList();
    }

    saveAllPreferences() {
        const preferences = {};

        this.preferenceMappings.forEach(mapping => {
            const el = document.getElementById(mapping.elementId);
            if (el) {
                let value;
                if (mapping.type === 'checkbox') {
                    value = el.checked;
                } else {
                    value = el.value;
                }
                preferences[mapping.key] = mapping.transform ? mapping.transform(value) : (typeof value === 'string' ? value.trim() : value);
            }
        });

        // Gather MPV flags from the DOM list
        const flagPills = document.querySelectorAll('#mpv-flags-list-container .filter-pill');
        if (flagPills.length > 0) {
            const flags = Array.from(flagPills).map(p => p.dataset.flag);
            preferences.custom_mpv_flags = flags.join(' ');
        } else {
            preferences.custom_mpv_flags = '';
        }

        // Gather Automatic MPV flags from the DOM list
        const automaticFlagPills = document.querySelectorAll('#automatic-mpv-flags-list-container .filter-pill');
        if (automaticFlagPills.length > 0) {
            preferences.automatic_mpv_flags = Array.from(automaticFlagPills).map(p => {
                return {
                    flag: p.dataset.flag,
                    description: p.title,
                    enabled: !p.classList.contains('disabled')
                }
            });
        }


        preferences.stream_scanner_timeout = Number(preferences.stream_scanner_timeout) || 60;

        this.sendMessageAsync({ action: 'set_ui_preferences', preferences: preferences }).then(response => {
            if (!response?.success) {
                this.showStatus('Failed to save settings.', true);
            }
        });
    }

    _updateAnilistImageSize(height) {
        const baseWidth = 50;
        const defaultHeight = 70;
        const effectiveHeight = Number(height || defaultHeight);
        const scalingFactor = effectiveHeight / defaultHeight;
        const effectiveWidth = Math.round(baseWidth * scalingFactor);

        document.documentElement.style.setProperty('--anilist-item-width', `${effectiveWidth}px`);
        document.documentElement.style.setProperty('--anilist-image-height', `${effectiveHeight}px`);
        document.getElementById('anilist-image-size-current').textContent = `${effectiveHeight}px`;
    }

    _renderMpvFlagsList(flags = []) {
        const container = document.getElementById('mpv-flags-list-container');
        if (!container) return;
        container.innerHTML = '';
        flags.forEach(flag => {
            const pill = document.createElement('div');
            pill.className = 'filter-pill';
            pill.textContent = flag;
            pill.dataset.flag = flag;
            pill.title = 'Click to remove';
            container.appendChild(pill);
        });
    }

    _renderAutomaticMpvFlagsList(flags = []) {
        const container = document.getElementById('automatic-mpv-flags-list-container');
        if (!container) return;
        container.innerHTML = '';
        flags.forEach(flagData => {
            const pill = document.createElement('div');
            pill.className = 'filter-pill';
            if (!flagData.enabled) {
                pill.classList.add('disabled');
            }
            pill.textContent = flagData.flag;
            pill.dataset.flag = flagData.flag;
            pill.title = flagData.description || ''; // Use empty string fallback
            container.appendChild(pill);
        });
    }

    _addMpvFlag() {
        const input = document.getElementById('mpv-flag-input');
        if (!input) return;
        const newFlag = input.value.trim();
        if (!newFlag) return;

        // Create pill and append to DOM immediately
        const container = document.getElementById('mpv-flags-list-container');
        const pill = document.createElement('div');
        pill.className = 'filter-pill';
        pill.textContent = newFlag;
        pill.dataset.flag = newFlag;
        pill.title = 'Click to remove';
        container.appendChild(pill);

        input.value = '';
        this.debouncedSaveAllPreferences();
    }

    _removeMpvFlag(element) {
        element.remove();
        this.debouncedSaveAllPreferences();
    }

    _resetMpvFlags() {
        this._renderMpvFlagsList([]); // Clear list
        this.debouncedSaveAllPreferences();
    }

    _renderScraperFilterList(words = []) {
        const container = document.getElementById('scraper-filter-list-container');
        if (!container) return;
        container.innerHTML = '';
        words.forEach(word => {
            const pill = document.createElement('div');
            pill.className = 'filter-pill';
            pill.textContent = word;
            pill.dataset.word = word;
            pill.title = 'Click to remove';
            container.appendChild(pill);
        });
    }

    _renderBuiltInFilterList() {
        const container = document.getElementById('scraper-builtin-filter-list-container');
        if (!container) return;
        const builtInWords = ['watch', 'online', 'free', 'full', 'hd', 'eng sub', 'subbed', 'dubbed', 'animepahe'];
        container.innerHTML = '';
        builtInWords.forEach(word => {
            const pill = document.createElement('div');
            pill.className = 'filter-pill readonly';
            pill.textContent = word;
            pill.title = 'This is a built-in filter and cannot be removed.';
            container.appendChild(pill);
        });
    }

    async _addScraperFilterWord() {
        const input = document.getElementById('scraper-filter-input');
        if (!input) return;
        const newWord = input.value.trim().toLowerCase();
        if (!newWord) return;

        const response = await this.sendMessageAsync({ action: 'get_ui_preferences' });
        const currentWords = response?.preferences?.scraper_filter_words || [];

        if (!currentWords.includes(newWord)) {
            const newWords = [...currentWords, newWord];
            await this.sendMessageAsync({ action: 'set_ui_preferences', preferences: { scraper_filter_words: newWords } });
            this._renderScraperFilterList(newWords);
        }
        input.value = '';
    }

    async _removeScraperFilterWord(wordToRemove) {
        const response = await this.sendMessageAsync({ action: 'get_ui_preferences' });
        const currentWords = response?.preferences?.scraper_filter_words || [];
        const newWords = currentWords.filter(word => word !== wordToRemove);
        await this.sendMessageAsync({ action: 'set_ui_preferences', preferences: { scraper_filter_words: newWords } });
        this._renderScraperFilterList(newWords);
    }

    initializeEventListeners() {
        // --- Generic Listeners ---
        this.preferenceMappings.forEach(mapping => {
            const control = document.getElementById(mapping.elementId);
            if (control) {
                const eventType = (mapping.type === 'textarea' || mapping.type === 'input' || mapping.type === 'slider') ? 'input' : 'change';
                control.addEventListener(eventType, this.debouncedSaveAllPreferences);
            }
        });

        // --- Special-cased Listeners ---
        const geometrySelect = document.getElementById('geometry-select');
        if (geometrySelect) {
            geometrySelect.addEventListener('change', () => {
                document.getElementById('custom-geometry-container').style.display = geometrySelect.value === 'custom' ? 'flex' : 'none';
                this.debouncedSaveAllPreferences();
            });
        }

        const anilistSlider = document.getElementById('anilist-image-height-slider');
        if (anilistSlider) {
            anilistSlider.addEventListener('input', () => this._updateAnilistImageSize(anilistSlider.value));
        }

        const anilistEnableCheck = document.getElementById('enable-anilist-integration-checkbox');
        if (anilistEnableCheck) {
            anilistEnableCheck.addEventListener('change', () => {
                const isEnabled = anilistEnableCheck.checked;
                document.getElementById('anilist-options-container').style.display = isEnabled ? 'block' : 'none';
                document.getElementById('shared-anilist-section').style.display = isEnabled ? 'block' : 'none';
                if (isEnabled && document.getElementById('shared-anilist-section').open) {
                    this.fetchAniListReleases(true);
                }
            });
        }

        const anilistCacheCheck = document.getElementById('disable-anilist-cache-checkbox');
        if (anilistCacheCheck) {
            anilistCacheCheck.addEventListener('change', () => {
                if (document.getElementById('shared-anilist-section').open) {
                    this.fetchAniListReleases(true);
                }
            });
        }

        const manualYtdlpBtn = document.getElementById('btn-manual-ytdlp-update');
        if (manualYtdlpBtn) {
            manualYtdlpBtn.addEventListener('click', () => {
                this.showStatus('Starting yt-dlp update...');
                this.sendMessageAsync({ action: 'manual_ytdlp_update' });
            });
        }

        const scraperInput = document.getElementById('scraper-filter-input');
        if (scraperInput) {
            scraperInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this._addScraperFilterWord();
                }
            });
        }

        const scraperList = document.getElementById('scraper-filter-list-container');
        if (scraperList) {
            scraperList.addEventListener('click', (e) => {
                if (e.target.classList.contains('filter-pill')) {
                    this._removeScraperFilterWord(e.target.dataset.word);
                }
            });
        }

        // --- MPV Flags Listeners ---
        const mpvFlagInput = document.getElementById('mpv-flag-input');
        if (mpvFlagInput) {
            mpvFlagInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this._addMpvFlag();
                }
            });
        }

        const mpvFlagsList = document.getElementById('mpv-flags-list-container');
        if (mpvFlagsList) {
            mpvFlagsList.addEventListener('click', (e) => {
                if (e.target.classList.contains('filter-pill')) {
                    this._removeMpvFlag(e.target);
                }
            });
        }

        const resetMpvFlagsBtn = document.getElementById('btn-reset-mpv-flags');
        if (resetMpvFlagsBtn) {
            resetMpvFlagsBtn.addEventListener('click', () => this._resetMpvFlags());
        }

        const automaticMpvFlagsList = document.getElementById('automatic-mpv-flags-list-container');
        if (automaticMpvFlagsList) {
            automaticMpvFlagsList.addEventListener('click', (e) => {
                if (e.target.classList.contains('filter-pill')) {
                    this._toggleAutomaticMpvFlag(e.target);
                }
            });
        }

        const resetAutomaticMpvFlagsBtn = document.getElementById('btn-reset-automatic-mpv-flags');
        if (resetAutomaticMpvFlagsBtn) {
            resetAutomaticMpvFlagsBtn.addEventListener('click', () => this._resetAutomaticMpvFlags());
        }
    }

    _toggleAutomaticMpvFlag(element) {
        element.classList.toggle('disabled');
        this.debouncedSaveAllPreferences();
    }

    async _resetAutomaticMpvFlags() {
        const response = await this.sendMessageAsync({ action: 'get_default_automatic_flags' });
        if (response && response.flags) {
            this._renderAutomaticMpvFlagsList(response.flags);
            this.debouncedSaveAllPreferences();
        }
    }
}