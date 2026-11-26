/**
 * Logic tests for the SystemLogger (Throttling, Buffering, Context, Stack Traces).
 * Runs in Node.js.
 * Tests the generated 'utils/SystemLogger.js' to verify build parity.
 */
const assert = require("node:assert").strict;
const path = require("node:path");

// Mock 'navigator' for Node.js environment
global.navigator = { userAgent: "NodeJS-Test", platform: "Linux" };
global.window = { MPV_INTERNAL: {} };

// Mock 'console' to capture logs without cluttering terminal
const savedConsole = global.console;
const originalConsole = { ...savedConsole };
let capturedLogs = [];
global.console = {
    ...originalConsole,
    log: (...args) => capturedLogs.push({ level: "INFO", msg: args[0] }),
    error: (...args) => capturedLogs.push({ level: "ERROR", msg: args[0] }),
    warn: (...args) => capturedLogs.push({ level: "WARN", msg: args[0] }),
    debug: (...args) => capturedLogs.push({ level: "DEBUG", msg: args[0] }),
};

// Load the generated SystemLogger.js
require(path.join(__dirname, "../../utils/SystemLogger.js"));
const { logger, LogLevel } = global.window.MPV_INTERNAL;

async function runTests() {
    originalConsole.log("Running SystemLogger Tests...");

    // =========================================================================
    // --- TEST 1: Level Filtering ---
    // =========================================================================
    capturedLogs = [];
    logger.setLevel(LogLevel.WARN);
    logger.debug("Should not log");
    logger.info("Should not log");
    logger.warn("Should log warn");
    logger.error("Should log error");
    assert.strictEqual(capturedLogs.length, 2, "Level filtering failed: expected 2 logs (WARN & ERROR).");
    assert.strictEqual(capturedLogs[0].level, "WARN");
    assert.strictEqual(capturedLogs[1].level, "ERROR");
    originalConsole.log("  [OK] Level Filtering");

    // =========================================================================
    // --- TEST 2: Context Tracking ---
    // =========================================================================
    capturedLogs = [];
    logger.setLevel(LogLevel.INFO);
    await logger.runWithContext("REQ-999", async () => {
        logger.info("Inside context");
        await logger.runWithContext("REQ-INNER", () => {
            logger.info("Inside nested context");
        });
        logger.info("Back in outer context");
    });
    assert.ok(capturedLogs[0].msg.includes("[REQ-999]"), "Outer context ID missing.");
    assert.ok(capturedLogs[1].msg.includes("[REQ-INNER]"), "Nested context ID missing.");
    assert.ok(capturedLogs[2].msg.includes("[REQ-999]"), "Restored outer context ID missing.");
    originalConsole.log("  [OK] Context Tracking");

    // =========================================================================
    // --- TEST 3: Error Stack Trace Preservation ---
    // =========================================================================
    logger.nativeSender = null;
    logger.buffer = [];
    logger.setLevel(LogLevel.DEBUG);

    // 3a. Explicit stack in meta
    const customStack = "Error: Something broke\n    at Object.testFunc (file.js:42:10)";
    logger.error("Explicit Stack Error", { stack: customStack, requestId: "REQ-STACK-1" });
    assert.strictEqual(logger.buffer.length, 1);
    assert.strictEqual(logger.buffer[0].stack, customStack, "Explicit stack was not preserved.");
    assert.strictEqual(logger.buffer[0].context, "REQ-STACK-1");

    // 3b. Error instance passed in meta.data
    const subError = new Error("Underlying I/O failure");
    logger.error("Operation failed", { data: subError, requestId: "REQ-STACK-2" });
    assert.strictEqual(logger.buffer.length, 2);
    assert.strictEqual(logger.buffer[1].stack, subError.stack, "Error instance in meta.data stack was not preserved.");

    // 3c. Direct Error instance passed as message
    const directError = new Error("Direct Error Passed");
    logger.error(directError, { requestId: "REQ-STACK-3" });
    assert.strictEqual(logger.buffer.length, 3);
    assert.ok(logger.buffer[2].message.includes("Direct Error Passed"), "Direct Error message was not captured.");
    assert.strictEqual(logger.buffer[2].stack, directError.stack, "Direct Error instance stack was not preserved.");

    // 3d. Clean empty string when no stack is provided
    logger.error("No stack error message");
    assert.strictEqual(logger.buffer.length, 4);
    assert.strictEqual(logger.buffer[3].stack, "", "Stack should default to empty string when not provided.");

    // 3e. Persist stack for lower level when persist=true
    logger.warn("Warning with trace", { persist: true, stack: "Trace at line 1" });
    assert.strictEqual(logger.buffer.length, 5);
    assert.strictEqual(logger.buffer[4].level, "WARN");
    assert.strictEqual(logger.buffer[4].stack, "Trace at line 1");
    originalConsole.log("  [OK] Error Stack Trace Preservation");

    // =========================================================================
    // --- TEST 4: Rate Limiting Under Burst ---
    // =========================================================================
    logger.nativeSender = null;
    logger.buffer = [];
    logger.globalLogCount = 0;
    logger.globalWindowStart = Date.now();
    logger.logCounts = {};
    capturedLogs = [];

    // 4a. Per-message burst throttling:
    // Same message repeated 20 times rapidly. First 9 pass; on 10th (MAX_LOGS_PER_WINDOW), throttling activates.
    const repeatedMsg = "Repeated Network Timeout";
    for (let i = 0; i < 20; i++) {
        logger.error(repeatedMsg);
    }
    const key = repeatedMsg.substring(0, 100);
    const msgEntry = logger.logCounts[key];
    assert.ok(msgEntry !== undefined, "Message was not recorded in throttle table.");
    assert.strictEqual(msgEntry.count, 20, "Throttle table should track total occurrence count.");
    assert.strictEqual(logger.buffer.length, 9, "First 9 occurrences are buffered before 10th triggers throttle.");
    
    // Check that warning was logged on the 10th attempt
    const throttleWarn = capturedLogs.find(l => l.level === "WARN" && l.msg.includes("Throttling frequent log"));
    assert.ok(throttleWarn, "Expected warning about throttling frequent log.");

    // 4b. Per-message cooldown & resume:
    // Artificially advance timestamp past 1 second window
    msgEntry.lastTime -= 1500;
    logger.error(repeatedMsg);
    assert.strictEqual(msgEntry.count, 1, "Count should reset to 1 after cooldown window.");
    assert.strictEqual(logger.buffer.length, 10, "Message should be buffered again after cooldown.");
    const resumeWarn = capturedLogs.find(l => l.level === "WARN" && l.msg.includes("Resuming logs for"));
    assert.ok(resumeWarn, "Expected warning about resuming logs.");

    // 4c. Global floodgate under burst of diverse errors:
    // Even if messages are completely distinct, the global cap (MAX_LOGS_PER_WINDOW * 3 = 30)
    // must protect against bridge flooding.
    logger.buffer = [];
    logger.globalLogCount = 0;
    logger.globalWindowStart = Date.now();
    logger.logCounts = {};

    for (let i = 0; i < 45; i++) {
        logger.error(`Diverse burst error #${i}`);
    }
    // Hard global cap is 30 logs per window
    assert.strictEqual(logger.buffer.length, 30, `Expected exactly 30 logs buffered under diverse burst, got ${logger.buffer.length}`);
    assert.strictEqual(logger.globalLogCount, 45, "Global log count should track all 45 attempts.");

    // 4d. Global window cooldown:
    logger.globalWindowStart -= 1500;
    logger.error("Diverse error after global window cooldown");
    assert.strictEqual(logger.buffer.length, 31, "Logging should resume after global cooldown window.");
    originalConsole.log("  [OK] Rate Limiting Under Burst (Per-message & Global Floodgate)");

    // =========================================================================
    // --- TEST 5: Buffer Management & Flushing ---
    // =========================================================================
    logger.nativeSender = null;
    logger.buffer = [];
    logger.globalLogCount = 0;
    logger.globalWindowStart = 0;
    logger.logCounts = {};

    // 5a. FIFO Eviction on Buffer Overflow (MAX_BUFFER = 50)
    for (let i = 0; i < 55; i++) {
        logger.globalWindowStart = Date.now();
        logger.globalLogCount = 0;
        logger.logCounts = {};
        logger.error(`Buffer fill msg ${i}`);
    }
    assert.strictEqual(logger.buffer.length, 50, "Buffer should not exceed MAX_BUFFER (50).");
    assert.strictEqual(logger.buffer[0].message, "Buffer fill msg 5", "Oldest 5 entries should have been evicted (FIFO).");
    assert.strictEqual(logger.buffer[49].message, "Buffer fill msg 54", "Newest entry should be at the end of the buffer.");

    // 5b. Buffer Flushing via setNativeSender
    logger.buffer = [];
    logger.error("Buffered 1", { requestId: "REQ-A", stack: "Stack A" });
    logger.error("Buffered 2", { requestId: "REQ-B", stack: "Stack B" });
    logger.error("Buffered 3", { requestId: "REQ-C", stack: "Stack C" });
    assert.strictEqual(logger.buffer.length, 3);

    const sentPayloads = [];
    logger.setNativeSender(async (payload) => {
        sentPayloads.push(payload);
    });

    assert.strictEqual(sentPayloads.length, 3, "All buffered payloads should have been flushed.");
    assert.strictEqual(sentPayloads[0].message, "[REQ-A] Buffered 1");
    assert.strictEqual(sentPayloads[0].stack, "Stack A");
    assert.strictEqual(sentPayloads[1].message, "[REQ-B] Buffered 2");
    assert.strictEqual(sentPayloads[2].message, "[REQ-C] Buffered 3");
    assert.strictEqual(logger.buffer.length, 0, "Buffer should be empty after flushing.");

    // 5c. Live sending when nativeSender is active
    logger.error("Live direct message", { requestId: "REQ-D" });
    assert.strictEqual(sentPayloads.length, 4, "Active sender should immediately receive live message.");
    assert.strictEqual(logger.buffer.length, 0, "Buffer should remain empty when active sender is connected.");

    // 5d. Re-entrancy guard
    logger.isPersisting = true;
    logger.error("Should be blocked by re-entrancy guard");
    assert.strictEqual(sentPayloads.length, 4, "Re-entrancy guard should prevent duplicate send when persisting.");
    logger.isPersisting = false;

    // 5e. Diagnostics collector inspection
    const diag = logger.getDiagnostics();
    assert.ok(Array.isArray(diag.errors), "Diagnostics should contain errors array.");
    assert.ok(typeof diag.platform === "string" && diag.platform.length > 0, "Diagnostics platform should be non-empty string.");
    assert.ok(typeof diag.userAgent === "string" && diag.userAgent.length > 0, "Diagnostics userAgent should be non-empty string.");
    originalConsole.log("  [OK] Buffer Management, Flushing & Re-entrancy Guard");

    // =========================================================================
    // --- TEST 6: _flushBuffer with Synchronous / Non-Promise nativeSender ---
    // =========================================================================
    const { pathToFileURL } = require("node:url");
    const modUrl = pathToFileURL(path.join(__dirname, "../../utils/SystemLogger.module.js")).href;
    const { logger: modLogger } = await import(modUrl);
    modLogger.nativeSender = null;
    modLogger.buffer = [];
    modLogger.globalLogCount = 0;
    modLogger.globalWindowStart = 0;
    modLogger.logCounts = {};

    modLogger.error("Sync sender buffered 1");
    modLogger.error("Sync sender buffered 2");
    assert.strictEqual(modLogger.buffer.length, 2);

    const syncReceived = [];
    // Non-async sender returning undefined (no .catch method)
    modLogger.setNativeSender((payload) => {
        syncReceived.push(payload.message);
    });
    assert.strictEqual(syncReceived.length, 2, "_flushBuffer should handle non-Promise nativeSender");
    assert.strictEqual(modLogger.buffer.length, 0);

    // Synchronously throwing sender should not crash _flushBuffer
    modLogger.nativeSender = null;
    modLogger.error("Sync throw buffered");
    assert.strictEqual(modLogger.buffer.length, 1);
    assert.doesNotThrow(() => {
        modLogger.setNativeSender(() => {
            throw new Error("sync failure");
        });
    });
    assert.strictEqual(modLogger.buffer.length, 0);
    originalConsole.log("  [OK] _flushBuffer non-Promise & throwing nativeSender safety");

    originalConsole.log("\nALL SYSTEM LOGGER TESTS PASSED! 🛡️");
}

(async () => {
    try {
        await runTests();
    } catch (err) {
        originalConsole.error("\nTEST FAILED! ❌");
        originalConsole.error(err);
        process.exit(1);
    } finally {
        global.console = savedConsole;
    }
})();
