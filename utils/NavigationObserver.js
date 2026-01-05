/**
 * @class NavigationObserver
 * Monitors DOM mutations and URL changes for Single-Page Application support.
 */
window.MPV = window.MPV || {};

window.MPV.NavigationObserver = class NavigationObserver {
    constructor({ onNavigation, onMutation, onValidate }) {
        this.onNavigation = onNavigation || (() => {});
        this.onMutation = onMutation || (() => {});
        this.onValidate = onValidate || (() => {});
        
        this.lastUrl = window.location.href;
        this.observer = null;
        this.pollInterval = null;
        this.isDestroyed = false;

        this.debouncedNav = window.MPV.debounce(this._checkUrl.bind(this), 250);
        this.debouncedMutation = window.MPV.debounce(this.onMutation, 500);
    }

    init() {
        if (this.isDestroyed) return;

        this.observer = new MutationObserver(() => {
            if (this.isDestroyed) return;
            this.debouncedMutation();
            this.debouncedNav();
        });

        this.observer.observe(document.documentElement, { 
            childList: true, 
            subtree: true 
        });

        this.pollInterval = setInterval(() => {
            if (this.isDestroyed) return;
            this.debouncedNav();
            this.onValidate();
        }, 1000);
    }

    _checkUrl() {
        if (this.isDestroyed) return;
        
        const currentUrl = window.location.href;
        if (currentUrl !== this.lastUrl) {
            const oldUrl = this.lastUrl;
            this.lastUrl = currentUrl;
            this.onNavigation(currentUrl, oldUrl);
        }
    }

    destroy() {
        this.isDestroyed = true;
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
    }
};
