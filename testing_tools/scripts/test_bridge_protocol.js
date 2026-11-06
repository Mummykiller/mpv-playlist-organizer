const assert = require("node:assert").strict;
const { validateContract, ACTION_SCHEMAS } = require("./bridge_contract");

/**
 * JS-to-Python Case Normalizer Mock
 * (Matches logic in translator.py + commUtils.js)
 */
function toSnakeCase(obj) {
	if (Array.isArray(obj)) return obj.map(toSnakeCase);
	if (obj !== null && typeof obj === "object") {
		return Object.keys(obj).reduce((acc, key) => {
			const WHITELIST = new Set(["request_id", "url", "m3u8"]);
			let snakeKey = WHITELIST.has(key)
				? key
				: key === "requestId" ? "request_id" : key.replace(/[A-Z]/g, (l) => `_${l.toLowerCase()}`);
			
			// Match Python's acronym/id handling
			snakeKey = snakeKey.replace(/^_+/, "");
			acc[snakeKey] = toSnakeCase(obj[key]);
			return acc;
		}, {});
	}
	return obj;
}

function runTests() {
	console.log("Running Bridge Protocol Integration Tests...");

	// --- TEST 1: Valid Playback Request ---
	const playbackMsg = {
		action: "play",
		requestId: "req_1",
		folderId: "Default",
		urlItem: { url: "https://test.com", title: "Test" },
		startPaused: true,
		ytdlQuality: "best" // Settings field
	};

	const snakedPlayback = toSnakeCase(playbackMsg);
	const result1 = validateContract(snakedPlayback);
	assert.ok(result1.valid, `Playback Request should be valid. Error: ${result1.error}`);
	console.log("  [OK] Playback Request Mapping");

	// --- TEST 2: Catch Misspelled Key (The silent killer) ---
	const typoMsg = {
		action: "play",
		folderID: "Default", // Typo: ID vs Id
	};
	const snakedTypo = toSnakeCase(typoMsg);
	const result2 = validateContract(snakedTypo);
	assert.strictEqual(result2.valid, false, "Should catch misspelled 'folderID'");
	assert.ok(result2.error.includes("folder_i_d"), "Should report the snaked version of the typo");
	console.log("  [OK] Caught Typo Key (folderID)");

	// --- TEST 3: Whitelist Preservation ---
	const whitelistMsg = {
		action: "play",
		request_id: "already_snaked", // Should not be modified
		url: "https://example.com"
	};
	const snakedWhitelist = toSnakeCase(whitelistMsg);
	assert.strictEqual(snakedWhitelist.request_id, "already_snaked");
	assert.strictEqual(snakedWhitelist.url, "https://example.com");
	console.log("  [OK] Whitelist Preservation");

	// --- TEST 4: Service Request (AniList & Dependencies) ---
	const anilistMsg = {
		action: "get_anilist_releases",
		days: 7,
		force: true,
		deleteCache: false
	};
	const snakedAnilist = toSnakeCase(anilistMsg);
	const result4a = validateContract(snakedAnilist);
	assert.ok(result4a.valid, `AniList Request should be valid. Error: ${result4a.error}`);

	const depMsg = {
		action: "check_dependencies",
		force: true,
		forceRefresh: true
	};
	const snakedDep = toSnakeCase(depMsg);
	const result4b = validateContract(snakedDep);
	assert.ok(result4b.valid, `Check Dependencies Request should be valid. Error: ${result4b.error}`);
	console.log("  [OK] Service Request Mapping");

	// --- TEST 5: Illegal Key for Specific Action ---
	const illegalMsg = {
		action: "log_event",
		level: "INFO",
		message: "Hello",
		folderId: "Default" // folderId is NOT valid for log_event
	};
	const snakedIllegal = toSnakeCase(illegalMsg);
	const result5 = validateContract(snakedIllegal);
	assert.strictEqual(result5.valid, false, "Should catch irrelevant key for action");
	assert.ok(result5.error.includes("folder_id"), "Error should mention folder_id");
	console.log("  [OK] Caught Illegal Key for Action");

	// --- TEST 6: log_browser_error Schema Contract Checks ---
	// 6a: Valid full payload
	const validBrowserError = {
		action: "log_browser_error",
		requestId: "req_err_101",
		message: "Uncaught TypeError: Cannot read properties of undefined",
		context: "content.js:142",
		stack: "TypeError: Cannot read properties...\n    at content.js:142:15"
	};
	const snakedBrowserError = toSnakeCase(validBrowserError);
	const result6a = validateContract(snakedBrowserError);
	assert.ok(result6a.valid, `Valid log_browser_error should pass schema validation. Error: ${result6a.error}`);

	// 6b: Valid minimal payload (only action)
	const minimalBrowserError = { action: "log_browser_error" };
	const result6b = validateContract(toSnakeCase(minimalBrowserError));
	assert.ok(result6b.valid, `Minimal log_browser_error should pass schema validation. Error: ${result6b.error}`);

	// 6c: Reject 'level' on log_browser_error (level is only on log_event, not LogBrowserErrorRequest)
	const browserErrorWithLevel = {
		action: "log_browser_error",
		level: "ERROR",
		message: "Failed"
	};
	const result6c = validateContract(toSnakeCase(browserErrorWithLevel));
	assert.strictEqual(result6c.valid, false, "log_browser_error must reject 'level'");
	assert.ok(result6c.error.includes("level"), "Error message should mention 'level'");

	// 6d: Reject 'folder_id' / 'folderId' on log_browser_error
	const browserErrorWithFolder = {
		action: "log_browser_error",
		folderId: "Default",
		message: "Failed"
	};
	const result6d = validateContract(toSnakeCase(browserErrorWithFolder));
	assert.strictEqual(result6d.valid, false, "log_browser_error must reject 'folder_id'");
	assert.ok(result6d.error.includes("folder_id"));

	// 6e: Reject misspelled keys on log_browser_error (e.g., stackTrace instead of stack)
	const browserErrorWithTypo = {
		action: "log_browser_error",
		message: "Something broke",
		stackTrace: "Error at line 1" // Should be 'stack'
	};
	const result6e = validateContract(toSnakeCase(browserErrorWithTypo));
	assert.strictEqual(result6e.valid, false, "log_browser_error must reject misspelled 'stackTrace'");
	assert.ok(result6e.error.includes("stack_trace"));

	// 6f: Reject arbitrary unknown keys
	const browserErrorWithGarbage = {
		action: "log_browser_error",
		randomField: 12345
	};
	const result6f = validateContract(toSnakeCase(browserErrorWithGarbage));
	assert.strictEqual(result6f.valid, false, "log_browser_error must reject arbitrary unknown keys");
	console.log("  [OK] log_browser_error Contract & Payload Rejections");

	// --- TEST 7: Structural Payload Rejections (Missing Action, Unknown Action) ---
	// 7a: Missing action
	const missingAction = { requestId: "req_no_act", message: "foo" };
	const result7a = validateContract(toSnakeCase(missingAction));
	assert.strictEqual(result7a.valid, false);
	assert.strictEqual(result7a.error, "Missing 'action' key.");

	// 7b: Unknown action with unknown keys
	const unknownActionWithKeys = {
		action: "some_imaginary_action",
		unexpected_data: "forbidden"
	};
	const result7b = validateContract(toSnakeCase(unknownActionWithKeys));
	assert.strictEqual(result7b.valid, false);
	assert.ok(result7b.error.includes("unexpected_data"));

	// 7c: Unknown action with only BaseRequest keys (fallback allowed)
	const unknownActionBaseOnly = {
		action: "some_ping",
		requestId: "req_ping_1"
	};
	const result7c = validateContract(toSnakeCase(unknownActionBaseOnly));
	assert.ok(result7c.valid, "BaseRequest fallback should allow base keys for unknown actions");
	console.log("  [OK] Structural Contract Integrity (Missing/Unknown Actions)");

	// --- TEST 8: Other Extended Action Contracts ---
	// 8a: cancel_task
	const validCancel = { action: "cancel_task", taskId: "task_abc123" };
	assert.ok(validateContract(toSnakeCase(validCancel)).valid, "cancel_task should accept taskId");
	const invalidCancel = { action: "cancel_task", playlist: [] };
	assert.strictEqual(validateContract(toSnakeCase(invalidCancel)).valid, false, "cancel_task should reject playlist");

	// 8b: get_smart_reorder
	const validSmartReorder = { action: "get_smart_reorder", folderId: "Default", data: [] };
	assert.ok(validateContract(toSnakeCase(validSmartReorder)).valid, "get_smart_reorder should be valid");
	const invalidSmartReorder = { action: "get_smart_reorder", days: 7 };
	assert.strictEqual(validateContract(toSnakeCase(invalidSmartReorder)).valid, false, "get_smart_reorder rejects days");

	// 8c: set_ui_preferences
	const validSetUi = { action: "set_ui_preferences", preferences: { ytdl_quality: "best" } };
	assert.ok(validateContract(toSnakeCase(validSetUi)).valid, "set_ui_preferences should accept preferences");
	const invalidSetUi = { action: "set_ui_preferences", invalidOption: true };
	assert.strictEqual(validateContract(toSnakeCase(invalidSetUi)).valid, false, "set_ui_preferences rejects invalidOption");

	console.log("  [OK] Extended Action Schemas (cancel_task, get_smart_reorder, set_ui_preferences)");

	console.log("\nALL BRIDGE PROTOCOL TESTS PASSED! 🤝");
}

try {
	runTests();
} catch (err) {
	console.error("\nTEST FAILED! ❌");
	console.error(err);
	process.exit(1);
}
