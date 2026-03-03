/**
 * Compatibility Shim for legacy diagnosticCollector usage.
 * Redirects all calls to the new SystemLogger.
 */
import { logger } from "./SystemLogger.module.js";

export class DiagnosticCollector {
	constructor() {}
	addError(context, error) {
		logger.error(`[${context}] ${error}`, { persist: true });
	}
	getErrors() {
		return logger.getDiagnostics().errors;
	}
	clear() {
		logger.errors = [];
	}
}

export const diagnosticCollector = new DiagnosticCollector();
