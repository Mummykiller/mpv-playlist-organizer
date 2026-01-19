/**
 * Collects and stores diagnostic information and errors for the JavaScript side.
 * Mimics the Python DiagnosticCollector for unified troubleshooting.
 */
export class DiagnosticCollector {
	constructor() {
		this.errors = [];
		this.MAX_ERRORS = 50;
	}

	/**
	 * Records an error with context and timestamp.
	 * @param {string} context - Where the error occurred (e.g., 'Storage Migration').
	 * @param {Error|string} error - The error object or message.
	 */
	addError(context, error) {
		const timestamp = new Date().toISOString();
		const errorMsg =
			error instanceof Error ? error.stack || error.message : String(error);

		console.error(`[Diagnostic] [${context}]`, error);

		this.errors.push({
			timestamp,
			context,
			error: errorMsg,
		});

		if (this.errors.length > this.MAX_ERRORS) {
			this.errors.shift();
		}
	}

	/**
	 * Returns all collected errors.
	 * @returns {Array}
	 */
	getErrors() {
		return [...this.errors];
	}

	/**
	 * Clears the error log.
	 */
	clear() {
		this.errors = [];
	}
}

export const diagnosticCollector = new DiagnosticCollector();
