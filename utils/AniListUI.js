/**
 * @class AniListUI
 */
window.MPV = window.MPV || {};

window.MPV.AniListUI = class AniListUI {
    constructor(controller, uiManager) {
        this.controller = controller;
        this.uiManager = uiManager;
        this.panelHost = this.uiManager.anilistPanelHost;
        this.shadowRoot = this.uiManager.anilistShadowRoot;
        this.controllerShadowRoot = this.uiManager.shadowRoot;
        this.isManuallyPositioned = false;
        this.isLocked = false;
        this.forceAttached = false;
        this.attachOnOpen = true;
        this.isEnabled = true;
    }

    updateDynamicStyles() {
        if (!this.shadowRoot) return;
        const dragHandle = this.shadowRoot.querySelector('.anilist-panel-header');
        if (dragHandle) dragHandle.style.cursor = this.isLocked ? 'default' : 'grab';
    }

    bindEvents() {
        if (!this.shadowRoot || !this.controllerShadowRoot) return;
        this.shadowRoot.getElementById('btn-close-anilist-panel')?.addEventListener('click', () => this.toggleVisibility(false));
        this.shadowRoot.getElementById('btn-refresh-anilist')?.addEventListener('click', () => this.fetchReleases(true));
        this.shadowRoot.getElementById('btn-pin-anilist-panel')?.addEventListener('click', (e) => {
            this.isLocked = !this.isLocked;
            e.currentTarget.classList.toggle('pinned', this.isLocked);
            this.updateDynamicStyles();
            this.controller.savePreference({ lockAnilistPanel: this.isLocked });
        });
        const toggleHandler = () => this.toggleVisibility();
        this.controllerShadowRoot.getElementById('btn-toggle-anilist-left')?.addEventListener('click', toggleHandler);
        this.controllerShadowRoot.getElementById('btn-toggle-anilist-right')?.addEventListener('click', toggleHandler);
        const dragHandle = this.shadowRoot.querySelector('.anilist-panel-header');
        const resizeHandle = this.shadowRoot.getElementById('anilist-resize-handle');
        if (this.panelHost && dragHandle) {
            new window.MPV.Draggable(this.panelHost, dragHandle, {
                onDragStart: () => !this.isLocked && !this.forceAttached,
                onDragEnd: (e, pos) => {
                    this.isManuallyPositioned = true;
                    Object.assign(this.panelHost.style, pos);
                    this.controller.savePreference({ anilistPanelPosition: pos });
                }
            });
        }
        if (this.panelHost && resizeHandle) {
            new window.MPV.Resizable(this.panelHost, resizeHandle, {
                minWidth: 250, minHeight: 200,
                onResizeEnd: (size) => this.controller.savePreference({ anilistPanelSize: size })
            });
        }
    }

    toggleVisibility(forceState, savePref = true) {
        if (!this.panelHost) return;
        let shouldBeVisible = typeof forceState === 'boolean' ? forceState : this.panelHost.style.display === 'none';
        const isControllerMinimized = this.uiManager.controllerHost.style.display === 'none';
        if (shouldBeVisible && (!this.isEnabled || (this.forceAttached && isControllerMinimized))) shouldBeVisible = false;
        const leftBtn = this.controllerShadowRoot.getElementById('btn-toggle-anilist-left');
        const rightBtn = this.controllerShadowRoot.getElementById('btn-toggle-anilist-right');
        if (shouldBeVisible) {
            this.panelHost.style.display = 'block';
            if (this.attachOnOpen && typeof forceState !== 'boolean') this.isManuallyPositioned = false;
            if (this.forceAttached || !this.isManuallyPositioned) this.snapToController();
            this.fetchReleases();
            if (savePref) this.controller.savePreference({ anilistPanelVisible: true });
            leftBtn?.classList.add('active-toggle');
            rightBtn?.classList.add('active-toggle');
        } else {
            this.panelHost.style.display = 'none';
            if (savePref) this.controller.savePreference({ anilistPanelVisible: false });
            leftBtn?.classList.remove('active-toggle');
            rightBtn?.classList.remove('active-toggle');
        }
        this.controller.updateAdaptiveElements();
    }

    snapToController() {
        if (this.isManuallyPositioned && !this.forceAttached) return;
        if (!this.panelHost || !this.uiManager.controllerHost || this.panelHost.style.display === 'none') return;
        const controllerRect = this.uiManager.controllerHost.getBoundingClientRect();
        const panelWidth = this.panelHost.offsetWidth;
        const gap = 10;
        const controllerCenter = controllerRect.left + (controllerRect.width / 2);
        const screenCenter = window.innerWidth / 2;
        const newLeft = (controllerCenter < screenCenter) ? controllerRect.right + gap : controllerRect.left - panelWidth - gap;
        this.panelHost.style.top = `${controllerRect.top}px`;
        this.panelHost.style.left = `${newLeft}px`;
        this.panelHost.style.right = 'auto';
        this.panelHost.style.bottom = 'auto';
    }

    async fetchReleases(forceRefresh = false) {
        if (!this.shadowRoot || !this.controller.checkContext()) return;
        const container = this.shadowRoot.getElementById('anilist-releases-list');
        if (!container) return;
        container.innerHTML = '<div class="loading-spinner"></div>';
        try {
            const releases = await window.MPV.AniListRenderer.fetchReleases(forceRefresh);
            if (this.controller.checkContext()) window.MPV.AniListRenderer.render(container, releases);
        } catch (error) {
            container.innerHTML = `<li class="anilist-error">Error: ${error.message}</li>`;
        }
    }

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
};
