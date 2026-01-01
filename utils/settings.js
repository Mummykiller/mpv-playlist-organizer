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
            { key: 'kb_play_playlist', elementId: 'kb-play-playlist-input', type: 'input' },
            { key: 'kb_toggle_controller', elementId: 'kb-toggle-ui-input', type: 'input' },
            { key: 'kb_open_popup', elementId: 'kb-open-popup-input', type: 'input' },
            { key: 'enable_smart_resume', elementId: 'enable-smart-resume-checkbox', type: 'checkbox' },
            { key: 'enable_active_item_highlight', elementId: 'enable-active-highlight-checkbox', type: 'checkbox' },
            { key: 'disable_network_overrides', elementId: 'disable-network-overrides-checkbox', type: 'checkbox' },
            { key: 'enable_cache', elementId: 'enable-cache-checkbox', type: 'checkbox' },
            { key: 'http_persistence', elementId: 'http-persistence-select', type: 'select' },
            { key: 'demuxer_max_bytes', elementId: 'demuxer_max_bytes-input', type: 'input' },
            { key: 'demuxer_max_back_bytes', elementId: 'demuxer-max-back-bytes-input', type: 'input' },
            { key: 'cache_secs', elementId: 'cache-secs-input', type: 'input', transform: Number },
            { key: 'demuxer_readahead_secs', elementId: 'demuxer-readahead-secs-input', type: 'input', transform: Number },
            { key: 'stream_buffer_size', elementId: 'stream-buffer-size-input', type: 'input' }
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

        // --- Networking Master Toggle Logic ---
        const networkMasterToggle = document.getElementById('disable-network-overrides-checkbox');
        if (networkMasterToggle) {
            this._updateNetworkingSectionState(networkMasterToggle.checked);
        }

        // Manual handling for MPV flags list
        // Custom flags are now stored as objects {flag: string, enabled: boolean} OR legacy string
        const customFlagsRaw = prefs.custom_mpv_flags || [];
        const customFlags = Array.isArray(customFlagsRaw) ? customFlagsRaw : 
                           (typeof customFlagsRaw === 'string' ? customFlagsRaw.match(/(?:[^\s"]+|"[^"]*")+/g) || [] : []);
        
        // Normalize custom flags to objects
        const normalizedCustomFlags = customFlags.map(f => typeof f === 'string' ? { flag: f, enabled: true } : f);
        this._renderMpvFlagsList(normalizedCustomFlags);

        // Manual handling for Automatic MPV flags list
        const automaticFlags = prefs.automatic_mpv_flags || [];
        this._renderAutomaticMpvFlagsList(automaticFlags);

        this._updateAnilistImageSize(prefs.anilist_image_height || 126);

        this._renderScraperFilterList(prefs.scraper_filter_words || []);
        this._renderBuiltInFilterList();
    }

    _updateNetworkingSectionState(isDisabled) {
        const networkingSection = document.getElementById('disable-network-overrides-checkbox')?.closest('.settings-section');
        if (networkingSection) {
            const content = networkingSection.querySelector('.settings-section-content');
            // Gray out everything EXCEPT the master toggle itself
            const otherControls = Array.from(content.children).filter(child => !child.contains(document.getElementById('disable-network-overrides-checkbox')));
            
            otherControls.forEach(control => {
                if (isDisabled) {
                    control.classList.add('disabled-overlay');
                } else {
                    control.classList.remove('disabled-overlay');
                }
                
                // Also literally disable the inputs/selects
                control.querySelectorAll('input, select').forEach(input => {
                    input.disabled = isDisabled;
                });
            });
        }
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
            preferences.custom_mpv_flags = Array.from(flagPills).map(p => ({
                flag: p.dataset.flag,
                enabled: !p.classList.contains('disabled')
            }));
        } else {
            preferences.custom_mpv_flags = [];
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
        flags.forEach(flagData => {
            const pill = document.createElement('div');
            pill.className = 'filter-pill';
            if (flagData.enabled === false) {
                pill.classList.add('disabled');
            }
            pill.textContent = flagData.flag;
            pill.dataset.flag = flagData.flag;
            pill.title = 'Click to toggle. Double-click to remove.';
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

        // Check if already exists
        const existing = Array.from(document.querySelectorAll('#mpv-flags-list-container .filter-pill')).find(p => p.dataset.flag === newFlag);
        if (existing) {
            input.value = '';
            return;
        }

        // Create pill and append to DOM immediately
        const container = document.getElementById('mpv-flags-list-container');
        const pill = document.createElement('div');
        pill.className = 'filter-pill';
        pill.textContent = newFlag;
        pill.dataset.flag = newFlag;
        pill.title = 'Click to toggle. Double-click to remove.';
        container.appendChild(pill);

        input.value = '';
        this.debouncedSaveAllPreferences();
    }

    _toggleMpvFlag(element) {
        element.classList.toggle('disabled');
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
                
                // Extra logic for networking master toggle
                if (mapping.elementId === 'disable-network-overrides-checkbox') {
                    control.addEventListener('change', () => this._updateNetworkingSectionState(control.checked));
                }
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
            // Use a click delay to distinguish single vs double click
            let clickTimer = null;
            
            mpvFlagsList.addEventListener('click', (e) => {
                if (e.target.classList.contains('filter-pill')) {
                    if (clickTimer) {
                        clearTimeout(clickTimer);
                        clickTimer = null;
                        // Double click: Remove
                        this._removeMpvFlag(e.target);
                    } else {
                        clickTimer = setTimeout(() => {
                            clickTimer = null;
                            // Single click: Toggle
                            this._toggleMpvFlag(e.target);
                        }, 250);
                    }
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

        // --- Search Listener ---
        const searchInput = document.getElementById('settings-search-input');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => this._handleSettingsSearch(e.target.value));
        }

        // --- Keybind Record Listeners ---
        const recordBtns = document.querySelectorAll('.btn-record-keybind');
        recordBtns.forEach(btn => {
            const input = btn.parentElement.querySelector('input');
            if (input) {
                btn.addEventListener('click', () => this._startRecording(btn, input));
            }
        });

        // --- Section Reload Listeners ---
        const reloadBtns = document.querySelectorAll('.section-reload-btn');
        reloadBtns.forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this._handleSectionReload(btn);
            });
        });
    }

    async _handleSectionReload(btn) {
        if (btn.classList.contains('reloading')) return;

        // Visual feedback: Start continuous spin
        btn.classList.add('reloading');
        
        this.showStatus('Syncing settings across all tabs...');
        
        try {
            // Give it at least 600ms of spin for visual satisfaction
            const syncPromise = this.sendMessageAsync({ action: 'force_reload_settings' });
            const delayPromise = new Promise(resolve => setTimeout(resolve, 600));
            
            await Promise.all([syncPromise, delayPromise]);

            // Optional: Re-fetch preferences to ensure UI is fresh
            const response = await this.sendMessageAsync({ action: 'get_ui_preferences' });
            if (response?.success) {
                this.updateAllPreferencesUI(response.preferences);
            }
            
            // Brief "success" state
            setTimeout(() => {
                btn.classList.remove('reloading');
                this.showStatus('Settings synchronized!');
            }, 200);

        } catch (e) {
            btn.classList.remove('reloading');
            this.showStatus('Failed to sync settings.', true);
        }
    }

    _toggleAutomaticMpvFlag(element) {
        element.classList.toggle('disabled');
        this.debouncedSaveAllPreferences();
    }

    // --- Search & Reorder Logic ---
    _handleSettingsSearch(query) {
        const wrapper = document.getElementById('settings-sections-wrapper');
        const sections = Array.from(wrapper.querySelectorAll('.settings-section'));
        const normalizedQuery = query.toLowerCase().trim();

        if (!normalizedQuery) {
            // Restore default order (as defined in HTML)
            sections.sort((a, b) => 0); // Keep current order or implement a fixed sequence if needed
            sections.forEach(s => {
                s.style.display = 'block';
                s.style.boxShadow = 'none';
                s.style.borderColor = 'var(--border-primary)';
            });
            return;
        }

        const scoredSections = sections.map(section => {
            const sectionName = section.dataset.sectionName || '';
            const settings = Array.from(section.querySelectorAll('.control-group, .setting-item'));
            
            let bestScore = 0;
            if (sectionName.includes(normalizedQuery)) bestScore = 10;

            settings.forEach(setting => {
                const settingName = setting.dataset.settingName || '';
                if (settingName.includes(normalizedQuery)) {
                    bestScore = Math.max(bestScore, 5);
                    setting.style.backgroundColor = 'rgba(88, 101, 242, 0.1)'; // Subtle highlight
                } else {
                    setting.style.backgroundColor = 'transparent';
                }
            });

            return { element: section, score: bestScore };
        });

        // Reorder: Highest score first
        scoredSections.sort((a, b) => b.score - a.score);

        scoredSections.forEach(item => {
            wrapper.appendChild(item.element);
            if (item.score > 0) {
                item.element.open = true; // Auto-expand matching sections
                item.element.style.borderColor = 'var(--accent-primary)';
                item.element.style.boxShadow = '0 0 10px rgba(88, 101, 242, 0.2)';
            } else {
                item.element.style.borderColor = 'var(--border-primary)';
                item.element.style.boxShadow = 'none';
            }
        });
    }

    // --- Keybind Recorder Logic ---
    _startRecording(btn, input) {
        // Clear previous state
        this._stopRecording();

        this.activeRecorder = { btn, input, originalValue: input.value };
        btn.classList.add('recording');
        btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4"/><path d="M12 18v4"/><path d="M4.93 4.93l2.83 2.83"/><path d="M16.24 16.24l2.83 2.83"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="M4.93 19.07l2.83-2.83"/><path d="M16.24 7.76l2.83-2.83"/></svg>'; // Spinner icon
        input.value = 'Press combination...';
        input.classList.add('recording-active');

        this.keyHandler = (e) => {
            e.preventDefault();
            e.stopPropagation();

            const forbiddenKeys = ['Control', 'Shift', 'Alt', 'Meta', 'CapsLock', 'Tab'];
            if (forbiddenKeys.includes(e.key)) return;

            const combo = [];
            if (e.ctrlKey) combo.push('Ctrl');
            if (e.shiftKey) combo.push('Shift');
            if (e.altKey) combo.push('Alt');
            if (e.metaKey) combo.push('Meta');
            
            // Normalize key name
            let keyName = e.key;
            if (keyName === ' ') keyName = 'Space';
            if (keyName.length === 1) keyName = keyName.toUpperCase();
            
            combo.push(keyName);
            
            const comboStr = combo.join('+');
            input.value = comboStr;
            this._stopRecording();
            this.debouncedSaveAllPreferences();
        };

        window.addEventListener('keydown', this.keyHandler, true);
        
        // Click outside or ESC to cancel
        this.escHandler = (e) => {
            if (e.key === 'Escape') {
                input.value = this.activeRecorder.originalValue;
                this._stopRecording();
            }
        };
        window.addEventListener('keydown', this.escHandler);
    }

    _stopRecording() {
        if (this.activeRecorder) {
            this.activeRecorder.btn.classList.remove('recording');
            this.activeRecorder.btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>';
            this.activeRecorder.input.classList.remove('recording-active');
            this.activeRecorder = null;
        }
        if (this.keyHandler) window.removeEventListener('keydown', this.keyHandler, true);
        if (this.escHandler) window.removeEventListener('keydown', this.escHandler);
    }

    async _resetAutomaticMpvFlags() {
        const response = await this.sendMessageAsync({ action: 'get_default_automatic_flags' });
        if (response && response.flags) {
            this._renderAutomaticMpvFlagsList(response.flags);
            this.debouncedSaveAllPreferences();
        }
    }
}