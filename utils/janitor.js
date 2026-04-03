/**
 * @class Janitor
 * Handles site-specific automations and "cleanups" for the frontend.
 * For example: Auto-clicking "Click to Load" buttons on streaming sites.
 */
window.MPV_INTERNAL = window.MPV_INTERNAL || {};

(() => {
	const MPV = window.MPV_INTERNAL;

	MPV.Janitor = class Janitor {
		constructor() {
			this.hostname = window.location.hostname;
			this._initAutomations();
		}

		_initAutomations() {
			// 1. Kwik / AnimePahe Auto-Clicker
			if (this.hostname.includes("kwik.cx") || this.hostname.includes("animepahe")) {
				this._runPaheAutoClicker();
			}
		}

		/**
		 * Specifically handles the "Click to Load" button on Kwik/AnimePahe.
		 */
		_runPaheAutoClicker() {
			const targetSelector = "div.click-to-load";
			let attempts = 0;
			const maxAttempts = 50; // ~5 seconds of polling

			const interval = setInterval(() => {
				attempts++;
				const element = document.querySelector(targetSelector);
				
				if (element) {
					console.log(`[Janitor] Found '${targetSelector}' on ${this.hostname}. Clicking...`);
					try {
						element.click();
						// We don't clear immediately because sometimes one click isn't enough 
						// or the page takes a moment to react.
						if (attempts > 5) clearInterval(interval); 
					} catch (e) {
						console.warn("[Janitor] Click failed:", e);
					}
				}

				if (attempts >= maxAttempts) {
					clearInterval(interval);
				}
			}, 100);
		}
	};
})();
