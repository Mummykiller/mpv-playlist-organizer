const assert = require("node:assert").strict;
const path = require("node:path");

/**
 * Mock Environment for loading the namespaced global files.
 */
global.window = { MPV_INTERNAL: {} };
global.chrome = { runtime: { id: "test" } };

// Load the generated commUtils.js
const commUtilsPath = path.join(__dirname, "../../utils/commUtils.js");
require(commUtilsPath);

const {
	normalizeKeys,
	isYouTubeUrl,
	getYoutubeId,
	normalizeYouTubeUrl,
	sanitizeString,
	isExtensionReloadError,
	debounce,
	DOMAIN_SPECIFIC_KEYS
} = global.window.MPV_INTERNAL;

async function runTests() {
	console.log("Running JS Normalization & Utility Tests (commUtils)...");

	// 1. snake_case to camelCase (Success Case)
	const pyMsg = {
		status: "success",
		payload: {
			action: "playback_status_changed",
			folder_id: "Default",
			is_paused: true,
			session_ids: ["1", "2"],
			// Verify Whitelist preservation
			request_id: "req_123",
			url: "https://example.com"
		}
	};

	const normalized = normalizeKeys(pyMsg);
	
	assert.strictEqual(normalized.status, "success");
	assert.strictEqual(normalized.payload.action, "playback_status_changed"); // Values remain snake_case
	assert.strictEqual(normalized.payload.folderId, "Default");
	assert.strictEqual(normalized.payload.isPaused, true);
	assert.deepStrictEqual(normalized.payload.sessionIds, ["1", "2"]);
	
	// Whitelist Check: request_id and url should remain as-is
	assert.strictEqual(normalized.payload.request_id, "req_123");
	assert.strictEqual(normalized.payload.url, "https://example.com");
	console.log("  [OK] snake_case -> camelCase");

	// 2. Nested objects, arrays, and primitive edge cases
	const nested = {
		top_level: {
			nested_key: [
				{ item_one: 1, m3u8: "stream.m3u8" },
				{ item_two: 2, mp4: "video.mp4" }
			],
			null_field: null,
			bool_flag: false,
			numeric_val: 42,
			kebab_case_test: "converted",
			"kebab-case-key": "also_converted"
		}
	};
	const normalizedNested = normalizeKeys(nested);
	assert.strictEqual(normalizedNested.topLevel.nestedKey[0].itemOne, 1);
	assert.strictEqual(normalizedNested.topLevel.nestedKey[0].m3u8, "stream.m3u8"); // Whitelisted
	assert.strictEqual(normalizedNested.topLevel.nestedKey[1].itemTwo, 2);
	assert.strictEqual(normalizedNested.topLevel.nestedKey[1].mp4, "video.mp4"); // Whitelisted
	assert.strictEqual(normalizedNested.topLevel.nullField, null);
	assert.strictEqual(normalizedNested.topLevel.boolFlag, false);
	assert.strictEqual(normalizedNested.topLevel.numericVal, 42);
	assert.strictEqual(normalizedNested.topLevel.kebabCaseKey, "also_converted");
	console.log("  [OK] Nested normalization with whitelists & primitives");

	// 3. Null, undefined, and non-object inputs
	assert.strictEqual(normalizeKeys(null), null);
	assert.strictEqual(normalizeKeys(undefined), undefined);
	assert.strictEqual(normalizeKeys("string_test"), "string_test");
	assert.strictEqual(normalizeKeys(123), 123);
	console.log("  [OK] Non-object input passthrough");

	// 4. YouTube URL Detection
	assert.strictEqual(isYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), true);
	assert.strictEqual(isYouTubeUrl("https://youtu.be/dQw4w9WgXcQ"), true);
	assert.strictEqual(isYouTubeUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ"), true);
	assert.strictEqual(isYouTubeUrl("https://vimeo.com/123456"), false);
	assert.strictEqual(isYouTubeUrl(""), false);
	assert.strictEqual(isYouTubeUrl(null), false);
	assert.strictEqual(isYouTubeUrl(undefined), false);
	console.log("  [OK] isYouTubeUrl detection");

	// 5. YouTube ID Extraction
	assert.strictEqual(getYoutubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
	assert.strictEqual(getYoutubeId("https://youtu.be/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
	assert.strictEqual(getYoutubeId("https://www.youtube.com/embed/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
	assert.strictEqual(getYoutubeId("https://www.youtube.com/shorts/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
	assert.strictEqual(getYoutubeId("https://www.youtube.com/playlist?list=PL12345ABCDE"), "PL12345ABCDE");
	assert.strictEqual(getYoutubeId("https://example.com/video.mp4"), null);
	assert.strictEqual(getYoutubeId(""), null);
	assert.strictEqual(getYoutubeId(null), null);
	console.log("  [OK] getYoutubeId extraction");

	// 6. YouTube URL Normalization (Timestamp and tracking removal)
	const rawYt = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&index=5&ab_channel=Artist&attr_tag=xyz";
	const cleanYt = normalizeYouTubeUrl(rawYt);
	assert.ok(!cleanYt.includes("t=42s"), "Timestamp 't' should be stripped");
	assert.ok(!cleanYt.includes("index=5"), "Parameter 'index' should be stripped");
	assert.ok(!cleanYt.includes("ab_channel"), "Parameter 'ab_channel' should be stripped");
	assert.ok(!cleanYt.includes("attr_tag"), "Parameter 'attr_tag' should be stripped");
	assert.ok(cleanYt.includes("v=dQw4w9WgXcQ"), "Video ID 'v' must be preserved");

	const rawShort = "https://youtu.be/dQw4w9WgXcQ?t=100&start=100";
	const cleanShort = normalizeYouTubeUrl(rawShort);
	assert.ok(!cleanShort.includes("t=100"));
	assert.ok(!cleanShort.includes("start=100"));

	// Non-YouTube URL remains untouched
	const nonYt = "https://example.com/stream?t=42";
	assert.strictEqual(normalizeYouTubeUrl(nonYt), nonYt);
	console.log("  [OK] normalizeYouTubeUrl tracking removal");

	// 7. String Sanitization
	// Title mode (isFilename = false): removes quotes and newlines, preserves colons/slashes
	const dirtyTitle = '  "My Favorite Video: Episode 1" `special` \n\t  ';
	const cleanTitle = sanitizeString(dirtyTitle, false);
	assert.strictEqual(cleanTitle, "My Favorite Video: Episode 1 special");

	// Filename mode (isFilename = true): strict filesystem filtering
	const dirtyFilename = '  My/Illegal:File*Name?"With<Special>Chars|And$Var;&`\n.mp4  ';
	const cleanFilename = sanitizeString(dirtyFilename, true);
	assert.strictEqual(cleanFilename, "MyIllegalFileNameWithSpecialCharsAndVar.mp4");
	console.log("  [OK] sanitizeString (title & filename modes)");

	// 8. Extension Reload Error Detection
	assert.strictEqual(isExtensionReloadError("Extension context invalidated."), true);
	assert.strictEqual(isExtensionReloadError("Error: Could not establish connection. Receiving end does not exist."), true);
	assert.strictEqual(isExtensionReloadError("The message channel closed before a response was received."), true);
	assert.strictEqual(isExtensionReloadError(new Error("Extension context invalidated.")), true);
	assert.strictEqual(isExtensionReloadError("SyntaxError: Unexpected token"), false);
	assert.strictEqual(isExtensionReloadError(null), false);
	console.log("  [OK] isExtensionReloadError detection");

	// 9. Domain-Specific Keys Contract
	assert.ok(Array.isArray(DOMAIN_SPECIFIC_KEYS), "DOMAIN_SPECIFIC_KEYS should be an array");
	assert.ok(DOMAIN_SPECIFIC_KEYS.includes("minimized"));
	assert.ok(DOMAIN_SPECIFIC_KEYS.includes("mode"));
	assert.ok(DOMAIN_SPECIFIC_KEYS.includes("position"));
	assert.ok(DOMAIN_SPECIFIC_KEYS.includes("pinned"));
	console.log("  [OK] DOMAIN_SPECIFIC_KEYS contract");

	// 10. Debounce utility
	let counter = 0;
	let lastArg = "";
	const debouncedFn = debounce((val) => {
		counter++;
		lastArg = val;
	}, 20);

	debouncedFn("call1");
	debouncedFn("call2");
	debouncedFn("call3");
	assert.strictEqual(counter, 0, "Debounced function should not execute immediately");

	await new Promise((r) => setTimeout(r, 40));
	assert.strictEqual(counter, 1, "Debounced function should execute exactly once");
	assert.strictEqual(lastArg, "call3", "Debounced function should receive the latest arguments");
	console.log("  [OK] debounce execution timing");

	console.log("\nALL JS BRIDGE PROTOCOL & UTILITY TESTS PASSED! ✨");
}

runTests().catch((err) => {
	console.error("\nTEST FAILED! ❌");
	console.error(err);
	process.exit(1);
});
