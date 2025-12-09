/**
 * @class AniListUI
 * Manages the state, rendering, and event handling for the AniList side panel.
 */
class AniListUI {
    /**
     * @param {MpvController} controller - The main controller instance.
     * @param {UIManager} uiManager - The UI manager instance.
     */
    constructor(controller, uiManager) {
        this.controller = controller;
        this.uiManager = uiManager;

        // --- Element References from UIManager ---
        this.panelHost = this.uiManager.anilistPanelHost;
        this.shadowRoot = this.uiManager.anilistShadowRoot;
        this.controllerShadowRoot = this.uiManager.shadowRoot;

        // --- State ---
        this.isManuallyPositioned = false;
        this.isLocked = false;
        this.autoReattach = true;
        this.forceReattach = false;
        this.isEnabled = true; // Master toggle from settings
        this.showOnPage = true; // Sub-setting for on-page UI
    }

    /**
     * Updates the UI based on the current state (e.g., lock status).
     */
    updateDynamicStyles() {
        if (!this.shadowRoot) return;

        const dragHandle = this.shadowRoot.querySelector('.anilist-panel-header');
        if (dragHandle) {
            // If the panel is locked, use a default cursor. Otherwise, use 'grab'.
            dragHandle.style.cursor = this.isLocked ? 'default' : 'grab';
        }
    }

    /**
     * Binds all event listeners related to the AniList panel.
     */
    bindEvents() {
        if (!this.shadowRoot || !this.controllerShadowRoot) return;

        // --- Panel's Internal Controls ---
        this.shadowRoot.getElementById('btn-close-anilist-panel')?.addEventListener('click', () => this.toggleVisibility(false));
        this.shadowRoot.getElementById('btn-refresh-anilist')?.addEventListener('click', () => this.fetchReleases(true));

        // --- Controller's Toggle Buttons ---
        const toggleHandler = () => this.toggleVisibility();
        this.controllerShadowRoot.getElementById('btn-toggle-anilist-left')?.addEventListener('click', toggleHandler);
        this.controllerShadowRoot.getElementById('btn-toggle-anilist-right')?.addEventListener('click', toggleHandler);

        // --- Draggable & Resizable ---
        const dragHandle = this.shadowRoot.querySelector('.anilist-panel-header');
        const resizeHandle = this.shadowRoot.getElementById('anilist-resize-handle');

        if (this.panelHost && dragHandle) {
            new Draggable(this.panelHost, dragHandle, {
                onDragStart: () => !this.isLocked,
                onDragEnd: () => {
                    this.isManuallyPositioned = true;
                    const newPosition = {
                        left: this.panelHost.style.left,
                        top: this.panelHost.style.top,
                        right: this.panelHost.style.right,
                        bottom: this.panelHost.style.bottom
                    };
                    this.controller.savePreference({ anilistPanelPosition: newPosition });
                }
            });
        }

        if (this.panelHost && resizeHandle) {
            new Resizable(this.panelHost, resizeHandle, {
                minWidth: 250,
                minHeight: 200,
                onResizeEnd: (newSize) => {
                    this.controller.savePreference({ anilistPanelSize: newSize });
                }
            });
        }
    }

    /**
     * Toggles the visibility of the AniList side panel.
     * @param {boolean} [forceState] - Optional. `true` to show, `false` to hide. Toggles if omitted.
     * @param {boolean} [savePref=true] - Whether to save the visibility state.
     */
    toggleVisibility(forceState, savePref = true) {
        if (!this.panelHost) return;

        let shouldBeVisible;
        if (typeof forceState === 'boolean') {
            shouldBeVisible = forceState;
        } else {
            shouldBeVisible = this.panelHost.style.display === 'none';
        }

        // Master override: if the feature is disabled in settings, it can never be visible.
        if (shouldBeVisible && (!this.isEnabled || !this.showOnPage)) {
            shouldBeVisible = false;
        }

        if (shouldBeVisible) {
            this.panelHost.style.display = 'block';

            // This block should execute if forceReattach is true, regardless of savePref.
            if (this.forceReattach) {
                this.isManuallyPositioned = false;
                this.controller.savePreference({
                    anilistPanelPosition: null,
                    forceReattachAnilistPanel: false
                });
                this.forceReattach = false;
            }

            if (this.autoReattach || !this.isManuallyPositioned) {
                this.snapToController();
            }

            this.fetchReleases();
            if (savePref) {
                this.controller.savePreference({ anilistPanelVisible: true });
            }
        } else {
            this.panelHost.style.display = 'none';
            if (savePref) {
                this.controller.savePreference({ anilistPanelVisible: false });
            }
        }
    }

    /**
     * Snaps the AniList panel to the side of the main controller.
     */
    snapToController() {
        if (this.isManuallyPositioned && !this.forceReattach) return;
        if (!this.panelHost || !this.uiManager.controllerHost || this.panelHost.style.display === 'none') return;

        const controllerRect = this.uiManager.controllerHost.getBoundingClientRect();
        const panelWidth = this.panelHost.offsetWidth;
        const gap = 10;

        const controllerCenter = controllerRect.left + (controllerRect.width / 2);
        const screenCenter = window.innerWidth / 2;

        const newLeft = (controllerCenter < screenCenter)
            ? controllerRect.right + gap  // Snap to right
            : controllerRect.left - panelWidth - gap; // Snap to left

        this.panelHost.style.top = `${controllerRect.top}px`;
        this.panelHost.style.left = `${newLeft}px`;
        this.panelHost.style.right = 'auto';
        this.panelHost.style.bottom = 'auto';
    }

    /**
     * Fetches and renders the AniList release data.
     * @param {boolean} [forceRefresh=false] - Whether to force a refresh of the data.
     */
    async fetchReleases(forceRefresh = false) {
        if (!this.shadowRoot) return;
        const anilistContent = this.shadowRoot.getElementById('anilist-releases-list');
        if (!anilistContent) return;

        anilistContent.innerHTML = '<div class="loading-spinner"></div>';
        try {
            const releases = await AniListRenderer.fetchReleases(forceRefresh);
            AniListRenderer.render(anilistContent, releases);
        } catch (error) {
            const errorElement = document.createElement('li');
            errorElement.className = 'anilist-error';
            errorElement.textContent = `Error: ${error.message}`;
            anilistContent.innerHTML = '';
            anilistContent.appendChild(errorElement);
        }
    }

    /**
     * Ensures the panel is within the visible viewport boundaries.
     */
    validatePosition() {
        if (!this.panelHost || this.panelHost.style.display === 'none') return;

        setTimeout(() => {
            const { offsetWidth, offsetHeight, offsetLeft, offsetTop } = this.panelHost;
            if (offsetWidth === 0 || offsetHeight === 0) return;

            const newLeft = Math.min(window.innerWidth - offsetWidth, Math.max(0, offsetLeft));
            const newTop = Math.min(window.innerHeight - offsetHeight, Math.max(0, offsetTop));

            if (newLeft !== offsetLeft || newTop !== offsetTop) {
                this.panelHost.style.left = `${newLeft}px`;
                this.panelHost.style.top = `${newTop}px`;
            }
        }, 20);
    }
}