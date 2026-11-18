/**
 * @class ControllerTimers
 * Manages heartbeat, visual watchdog, and transient UI timers for MpvController
 * with deterministic cleanup on destroy().
 */
window.MPV_INTERNAL = window.MPV_INTERNAL || {};

(() => {
	const MPV = window.MPV_INTERNAL;

	MPV.ControllerTimers = class ControllerTimers {
		constructor(controller) {
			this.controller = controller;
			this.heartbeatInterval = null;
			this.visualWatchdogInterval = null;
			this._timeouts = new Set();
			this._rafIds = new Set();
		}

		startHeartbeat(intervalMs = 30000) {
			if (this.heartbeatInterval) {
				clearInterval(this.heartbeatInterval);
				this.heartbeatInterval = null;
			}
			this.heartbeatInterval = setInterval(
				this.controller._safeWrap(async () => {
					try {
						await this.controller.bridge.send("heartbeat");
					} catch (e) {
						console.warn("[Content] Heartbeat failed, tearing down:", e);
						this.controller.teardown();
					}
				}),
				intervalMs,
			);
			this.controller.heartbeatInterval = this.heartbeatInterval;
		}

		startVisualWatchdog(intervalMs = 3000) {
			if (this.visualWatchdogInterval) {
				clearInterval(this.visualWatchdogInterval);
				this.visualWatchdogInterval = null;
			}
			this.visualWatchdogInterval = setInterval(() => {
				if (this.controller.isTearingDown) return;
				if (document.visibilityState === "visible") {
					this.checkVisibility();
				}
			}, intervalMs);
			this.controller.visualWatchdogInterval = this.visualWatchdogInterval;
		}

		initFullscreenSettleCheck(maxFrames = 10) {
			if (typeof requestAnimationFrame !== "function") return;
			let frames = 0;
			let rafId = null;
			const settle = () => {
				if (rafId !== null) this._rafIds.delete(rafId);
				if (this.controller.isTearingDown) return;
				this.checkVisibility();
				frames++;
				if (frames < maxFrames) {
					rafId = requestAnimationFrame(settle);
					this._rafIds.add(rafId);
				}
			};
			rafId = requestAnimationFrame(settle);
			this._rafIds.add(rafId);
		}

		checkVisibility() {
			const c = this.controller;
			if (c.isTearingDown || !c.ui?.controllerHost) return;

			const isNativeFullscreen = !!document.fullscreenElement;

			// Detect true browser/F11 fullscreen without falsely matching maximized windows
			const isFakeFullscreen =
				window.screen.width > 0 &&
				window.screen.height > 0 &&
				window.innerWidth === window.screen.width &&
				window.innerHeight === window.screen.height &&
				!isNativeFullscreen;

			const shouldHide = isNativeFullscreen || isFakeFullscreen;

			if (shouldHide !== c.suppressedByWatchdog) {
				c.suppressedByWatchdog = shouldHide;

				if (shouldHide) {
					const host = c.ui.controllerHost;
					if (host && host.style.display !== "none") {
						c.preFullscreenPosition = {
							left: host.style.left,
							top: host.style.top,
							right: host.style.right,
							bottom: host.style.bottom,
						};
					}
				} else if (c.preFullscreenPosition) {
					const host = c.ui.controllerHost;
					if (host) Object.assign(host.style, c.preFullscreenPosition);
					c.preFullscreenPosition = null;
				}

				c._syncUiToState(c.state.state);
			}
		}

		scheduleTimeout(fn, delayMs, { allowDuringTeardown = false } = {}) {
			const id = setTimeout(() => {
				this._timeouts.delete(id);
				if (allowDuringTeardown || !this.controller.isTearingDown) {
					fn();
				}
			}, delayMs);
			this._timeouts.add(id);
			return id;
		}

		destroy() {
			if (this.heartbeatInterval) {
				clearInterval(this.heartbeatInterval);
				this.heartbeatInterval = null;
			}
			if (this.controller) {
				this.controller.heartbeatInterval = null;
			}

			if (this.visualWatchdogInterval) {
				clearInterval(this.visualWatchdogInterval);
				this.visualWatchdogInterval = null;
			}
			if (this.controller) {
				this.controller.visualWatchdogInterval = null;
			}

			for (const id of this._timeouts) {
				clearTimeout(id);
			}
			this._timeouts.clear();

			if (typeof cancelAnimationFrame === "function") {
				for (const rafId of this._rafIds) {
					cancelAnimationFrame(rafId);
				}
			}
			this._rafIds.clear();
		}
	};
})();
