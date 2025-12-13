

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
        this.forceAttached = false; // New state for the setting
        this.attachOnOpen = true; // New state for the "soft attach" setting
        this.isEnabled = true; // Master toggle from settings
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
        this.shadowRoot.getElementById('btn-pin-anilist-panel')?.addEventListener('click', (e) => {
            this.isLocked = !this.isLocked;
            e.currentTarget.classList.toggle('pinned', this.isLocked);
            this.updateDynamicStyles();
        });

        // --- Controller's Toggle Buttons ---
        const toggleHandler = () => this.toggleVisibility();
        this.controllerShadowRoot.getElementById('btn-toggle-anilist-left')?.addEventListener('click', toggleHandler);
        this.controllerShadowRoot.getElementById('btn-toggle-anilist-right')?.addEventListener('click', toggleHandler);

        // --- Draggable & Resizable ---
        const dragHandle = this.shadowRoot.querySelector('.anilist-panel-header');
        const resizeHandle = this.shadowRoot.getElementById('anilist-resize-handle');

        if (this.panelHost && dragHandle) {
            new Draggable(this.panelHost, dragHandle, {
                onDragStart: () => {
                    // Prevent dragging if locked OR if forced attached.
                    return !this.isLocked && !this.forceAttached;
                },
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
        // New: Also hide if forceAttached is on and the main controller is minimized.
        const isControllerMinimized = this.uiManager.controllerHost.style.display === 'none';
        if (shouldBeVisible && (!this.isEnabled || (this.forceAttached && isControllerMinimized))) {
            shouldBeVisible = false;
        }

        // Update the toggle button's active state
        const leftBtn = this.controllerShadowRoot.getElementById('btn-toggle-anilist-left');
        const rightBtn = this.controllerShadowRoot.getElementById('btn-toggle-anilist-right');

        if (shouldBeVisible) {
            this.panelHost.style.display = 'block';

            // If 'attachOnOpen' is enabled and this is a user-initiated toggle (not a page load restore),
            // we treat this opening as a "fresh" one by resetting the manual position flag.
            // This ensures the soft attach works every time the user clicks the button.
            if (this.attachOnOpen && typeof forceState !== 'boolean') {
                this.isManuallyPositioned = false;
            }

            // Snap if forced, or if it's not manually positioned.
            if (this.forceAttached || !this.isManuallyPositioned) {
                this.snapToController();
            }

            this.fetchReleases();
            if (savePref) {
                this.controller.savePreference({ anilistPanelVisible: true });
            }
            if (leftBtn) leftBtn.classList.add('active-toggle');
            if (rightBtn) rightBtn.classList.add('active-toggle');
        } else {
            this.panelHost.style.display = 'none';
            if (savePref) {
                this.controller.savePreference({ anilistPanelVisible: false });
            }
            if (leftBtn) leftBtn.classList.remove('active-toggle');
            if (rightBtn) rightBtn.classList.remove('active-toggle');
        }

        // After toggling, always re-evaluate which side the button should be on.
        // This ensures the button appears correctly when the panel is first opened.
        this.controller.updateAdaptiveElements();
    }

    /**
     * Snaps the AniList panel to the side of the main controller.
     */
    snapToController() {
        // If forceAttached is false, respect manual positioning. Otherwise, snap regardless.
        if (this.isManuallyPositioned && !this.forceAttached) return;
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