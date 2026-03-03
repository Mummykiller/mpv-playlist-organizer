// AUTO-GENERATED from SystemLogger.module.js. DO NOT EDIT MANUALLY.
window.MPV_INTERNAL = window.MPV_INTERNAL || {};
(() => {
	const MPV = window.MPV_INTERNAL;
	/**
	 * Unified System Logger for MPV Playlist Organizer.
	 * Handles console logging, diagnostics collection, and remote persistence to Python.
	 * Replaces: utils/diagnosticCollector.js and ad-hoc console.log calls.
	 */

	const LogLevel = MPV.LogLevel = {
		DEBUG: 0,
		INFO: 1,
		WARN: 2,
		ERROR: 3,
		FATAL: 4,
	};

	const LEVEL_NAMES = {
		0: "DEBUG",
		1: "INFO",
		2: "WARN",
		3: "ERROR",
		4: "FATAL",
	};

	class SystemLogger {
		constructor() {
			this.level = LogLevel.INFO;
			this.nativeSender = null;
			this.buffer = [];
			this.MAX_BUFFER = 50;
			this.errors = []; // Diagnostic collector storage
			this.MAX_ERRORS = 50;

			// Rate Limiting
			this.logCounts = {}; // Key: "message_hash", Value: { count, lastTime }
			this.RATE_LIMIT_WINDOW = 1000; // 1 second
			this.MAX_LOGS_PER_WINDOW = 10;
			this.globalLogCount = 0;
			this.globalWindowStart = 0;

			// Context Management
			this.activeContext = null;

			// Re-entrancy Guard for log_event
			this.isPersisting = false;
		}

		/**
		 * Sets the minimum log level.
		 * @param {number|string} level - Level constant or name.
		 */
		setLevel(level) {
			if (typeof level === "string") {
				const normalized = level.toUpperCase();
				for (const [val, name] of Object.entries(LEVEL_NAMES)) {
					if (name === normalized) {
						this.level = parseInt(val, 10);
						return;
					}
				}
			} else {
				this.level = level;
			}
		}

		/**
		 * Injects the function to send logs to the Native Host.
		 * Breaks circular dependency with nativeConnection.
		 * @param {Function} senderFn - async (payload) => void
		 */
		setNativeSender(senderFn) {
			this.nativeSender = senderFn;
			this._flushBuffer();
		}

		/**
		 * Runs a function with a specific request ID context.
		 * @param {string} requestId 
		 * @param {Function} fn 
		 */
		async runWithContext(requestId, fn) {
			const prev = this.activeContext;
			this.activeContext = requestId;
			try {
				return await fn();
			} finally {
				this.activeContext = prev;
			}
		}

		debug(msg, meta = {}) { this._log(LogLevel.DEBUG, msg, meta); }
		info(msg, meta = {}) { this._log(LogLevel.INFO, msg, meta); }
		warn(msg, meta = {}) { this._log(LogLevel.WARN, msg, meta); }
		error(msg, meta = {}) { this._log(LogLevel.ERROR, msg, meta); }
		fatal(msg, meta = {}) { this._log(LogLevel.FATAL, msg, meta); }

		_log(level, message, meta = {}) {
			if (level < this.level) return;

			const timestamp = new Date().toISOString();
			const levelName = LEVEL_NAMES[level];
			const contextId = meta.requestId || this.activeContext;
			const prefix = contextId ? `[${contextId}] ` : "";
			const formattedMsg = `${prefix}${message}`;

			// 1. Console Output
			const consoleArgs = [`[${levelName}] ${formattedMsg}`];
			if (meta.data) consoleArgs.push(meta.data);

			switch (level) {
				case LogLevel.DEBUG: console.debug(...consoleArgs); break;
				case LogLevel.INFO: console.log(...consoleArgs); break;
				case LogLevel.WARN: console.warn(...consoleArgs); break;
				case LogLevel.ERROR: 
				case LogLevel.FATAL: console.error(...consoleArgs); break;
			}

			// 2. Diagnostics Collection (Errors only)
			if (level >= LogLevel.WARN) {
				this._addDiagnostic(levelName, message, contextId);
			}

			// 3. Persistence (Remote Logging)
			if (meta.persist || level >= LogLevel.ERROR) {
				this._persist(levelName, formattedMsg, contextId);
			}
		}

		_addDiagnostic(level, message, context) {
			this.errors.push({
				timestamp: new Date().toISOString(),
				level,
				context: context || "GLOBAL",
				error: message
			});
			if (this.errors.length > this.MAX_ERRORS) {
				this.errors.shift();
			}
		}

		_persist(levelName, message, contextId) {
			// 1. Re-entrancy / Infinite Loop Guard
			if (this.isPersisting) return;

			// 2. Rate Limiting
			if (this._shouldThrottle(message)) return;

			const payload = {
				action: "log_event",
				level: levelName,
				message: message,
				context: contextId || "JS_CORE"
			};

			if (this.nativeSender) {
				this.isPersisting = true;
				// Fire and forget
				this.nativeSender(payload).finally(() => {
					this.isPersisting = false;
				});
			} else {
				this.buffer.push(payload);
				if (this.buffer.length > this.MAX_BUFFER) {
					this.buffer.shift();
				}
			}
		}

		_shouldThrottle(message) {
			const now = Date.now();

			// A. Global Throttle: Prevent bridge flood from diverse error bursts
			if (now - this.globalWindowStart > this.RATE_LIMIT_WINDOW) {
				this.globalWindowStart = now;
				this.globalLogCount = 0;
			}
			this.globalLogCount++;
			if (this.globalLogCount > this.MAX_LOGS_PER_WINDOW * 3) {
				return true; // Hard global cap
			}

			// B. Per-Message Throttle (Naive hashing)
			const key = message.substring(0, 100);

			if (!this.logCounts[key]) {
				this.logCounts[key] = { count: 1, lastTime: now };
				return false;
			}

			const entry = this.logCounts[key];
			if (now - entry.lastTime > this.RATE_LIMIT_WINDOW) {
				// Reset window
				if (entry.count > this.MAX_LOGS_PER_WINDOW) {
					console.warn(`[SystemLogger] Resuming logs for: "${key.substring(0, 50)}..."`);
				}
				entry.count = 1;
				entry.lastTime = now;
				return false;
			}

			entry.count++;
			if (entry.count === this.MAX_LOGS_PER_WINDOW) {
				console.warn(`[SystemLogger] Throttling frequent log: "${key.substring(0, 50)}..."`);
				return true;
			}

			return entry.count > this.MAX_LOGS_PER_WINDOW;
		}

		_flushBuffer() {
			if (!this.nativeSender || this.buffer.length === 0) return;

			const batch = [...this.buffer];
			this.buffer = [];

			// Send individually to keep simple
			batch.forEach(payload => {
				this.nativeSender(payload).catch(e => console.error("Failed to flush log:", e));
			});
		}

		getDiagnostics() {
			return {
				errors: this.errors,
				bufferSize: this.buffer.length,
				userAgent: navigator.userAgent,
				platform: navigator.platform
			};
		}
	}

	const logger = MPV.logger = new SystemLogger();

})();