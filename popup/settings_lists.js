// popup/settings_lists.js
// Extracted list/pill editors and buffering presets for OptionsManager.

export function renderRestrictedDomainsList(domains = []) {
	const container = document.getElementById("restricted-domains-list-container");
	if (!container) return;
	container.innerHTML = "";
	domains.forEach((domain) => {
		const pill = document.createElement("div");
		pill.className = "filter-pill";
		pill.textContent = domain;
		pill.dataset.domain = domain;
		pill.title = "Click to remove";
		container.appendChild(pill);
	});
}

export async function addRestrictedDomain(ctx) {
	const input = document.getElementById("restricted-domain-input");
	if (!input) return;
	let newDomain = input.value.trim().toLowerCase();
	if (!newDomain) return;

	try {
		if (newDomain.includes("://")) {
			newDomain = new URL(newDomain).hostname;
		} else {
			newDomain = newDomain.split("/")[0];
		}
	} catch (e) {
		console.debug("[Settings] Invalid domain format:", e);
	}

	if (!/^[a-z0-9]+([-.]{1}[a-z0-9]+)*\.[a-z]{2,13}$/.test(newDomain)) {
		ctx.showStatus('Invalid format. Use "domain.com"', true);
		return;
	}

	const response = await ctx.sendMessageAsync({
		action: "get_ui_preferences",
	});
	const currentDomains = response?.preferences?.restrictedDomains || [];

	if (!currentDomains.includes(newDomain)) {
		const newDomains = [...currentDomains, newDomain];
		renderRestrictedDomainsList(newDomains);
		await ctx.sendMessageAsync({
			action: "set_ui_preferences",
			preferences: { restrictedDomains: newDomains },
		});
		ctx.showStatus(`Domain "${newDomain}" restricted.`);
	} else {
		ctx.showStatus("Domain already in list.", true);
	}
	input.value = "";
}

export async function removeRestrictedDomain(ctx, domainToRemove) {
	const response = await ctx.sendMessageAsync({
		action: "get_ui_preferences",
	});
	const currentDomains = response?.preferences?.restrictedDomains || [];
	const newDomains = currentDomains.filter((d) => d !== domainToRemove);
	await ctx.sendMessageAsync({
		action: "set_ui_preferences",
		preferences: { restrictedDomains: newDomains },
	});
	renderRestrictedDomainsList(newDomains);
}

export function renderMpvFlagsList(flags = []) {
	const container = document.getElementById("mpv-flags-list-container");
	if (!container) return;
	container.innerHTML = "";
	flags.forEach((flagData) => {
		const pill = document.createElement("div");
		pill.className = "filter-pill";
		if (flagData.enabled === false) {
			pill.classList.add("disabled");
		}
		pill.textContent = flagData.flag;
		pill.dataset.flag = flagData.flag;
		pill.title = "Click to toggle. Double-click to remove.";
		container.appendChild(pill);
	});
}

export function renderAutomaticMpvFlagsList(flags = []) {
	const container = document.getElementById("automatic-mpv-flags-list-container");
	if (!container) return;
	container.innerHTML = "";
	flags.forEach((flagData) => {
		const pill = document.createElement("div");
		pill.className = "filter-pill";
		if (!flagData.enabled) {
			pill.classList.add("disabled");
		}
		pill.textContent = flagData.flag;
		pill.dataset.flag = flagData.flag;
		pill.title = flagData.description || "";
		container.appendChild(pill);
	});
}

export function addMpvFlag(ctx) {
	const input = document.getElementById("mpv-flag-input");
	if (!input) return;
	const newFlag = input.value.trim();
	if (!newFlag) return;

	const existing = Array.from(
		document.querySelectorAll("#mpv-flags-list-container .filter-pill"),
	).find((p) => p.dataset.flag === newFlag);
	if (existing) {
		input.value = "";
		return;
	}

	const container = document.getElementById("mpv-flags-list-container");
	const pill = document.createElement("div");
	pill.className = "filter-pill";
	pill.textContent = newFlag;
	pill.dataset.flag = newFlag;
	pill.title = "Click to toggle. Double-click to remove.";
	container.appendChild(pill);

	input.value = "";
	ctx.debouncedSaveAllPreferences();
}

export function toggleMpvFlag(ctx, element) {
	element.classList.toggle("disabled");
	ctx.debouncedSaveAllPreferences();
}

export function removeMpvFlag(ctx, element) {
	element.remove();
	ctx.debouncedSaveAllPreferences();
}

export function resetMpvFlags(ctx) {
	renderMpvFlagsList([]);
	ctx.debouncedSaveAllPreferences();
}

export function toggleAutomaticMpvFlag(ctx, element) {
	element.classList.toggle("disabled");
	ctx.debouncedSaveAllPreferences();
}

export async function resetAutomaticMpvFlags(ctx) {
	const response = await ctx.sendMessageAsync({
		action: "get_default_automatic_flags",
	});
	if (response && response.flags) {
		renderAutomaticMpvFlagsList(response.flags);
		ctx.debouncedSaveAllPreferences();
	}
}

export function renderScraperFilterList(words = []) {
	const container = document.getElementById("scraper-filter-list-container");
	if (!container) return;
	container.innerHTML = "";
	words.forEach((word) => {
		const pill = document.createElement("div");
		pill.className = "filter-pill";
		pill.textContent = word;
		pill.dataset.word = word;
		pill.title = "Click to remove";
		container.appendChild(pill);
	});
}

export function renderBuiltInFilterList() {
	const container = document.getElementById(
		"scraper-builtin-filter-list-container",
	);
	if (!container) return;
	const builtInWords = [
		"watch",
		"online",
		"free",
		"episode",
		"season",
		"full",
		"hd",
		"eng sub",
		"subbed",
		"dubbed",
		"animepahe",
	];
	container.innerHTML = "";
	builtInWords.forEach((word) => {
		const pill = document.createElement("div");
		pill.className = "filter-pill readonly";
		pill.textContent = word;
		pill.title = "This is a built-in filter and cannot be removed.";
		container.appendChild(pill);
	});
}

export async function addScraperFilterWord(ctx) {
	const input = document.getElementById("scraper-filter-input");
	if (!input) return;
	const newWord = input.value.trim().toLowerCase();
	if (!newWord) return;

	const response = await ctx.sendMessageAsync({
		action: "get_ui_preferences",
	});
	const currentWords = response?.preferences?.scraperFilterWords || [];

	if (!currentWords.includes(newWord)) {
		const newWords = [...currentWords, newWord];
		await ctx.sendMessageAsync({
			action: "set_ui_preferences",
			preferences: { scraperFilterWords: newWords },
		});
		renderScraperFilterList(newWords);
	}
	input.value = "";
}

export async function removeScraperFilterWord(ctx, wordToRemove) {
	const response = await ctx.sendMessageAsync({
		action: "get_ui_preferences",
	});
	const currentWords = response?.preferences?.scraperFilterWords || [];
	const newWords = currentWords.filter((word) => word !== wordToRemove);
	await ctx.sendMessageAsync({
		action: "set_ui_preferences",
		preferences: { scraperFilterWords: newWords },
	});
	renderScraperFilterList(newWords);
}

export function getBufferingPresets() {
	return {
		default: {
			enableCache: true,
			demuxerMaxBytes: "1G",
			demuxerMaxBackBytes: "500M",
			cacheSecs: 500,
			demuxerReadaheadSecs: 500,
			streamBufferSize: "10M",
			ytdlpConcurrentFragments: 4,
			enableReconnect: true,
			reconnectDelay: 4,
		},
		smooth: {
			enableCache: true,
			demuxerMaxBytes: "2G",
			demuxerMaxBackBytes: "1G",
			cacheSecs: 1200,
			demuxerReadaheadSecs: 1200,
			streamBufferSize: "32M",
			ytdlpConcurrentFragments: 8,
			enableReconnect: true,
			reconnectDelay: 2,
		},
		"low-ram": {
			enableCache: true,
			demuxerMaxBytes: "250M",
			demuxerMaxBackBytes: "50M",
			cacheSecs: 60,
			demuxerReadaheadSecs: 60,
			streamBufferSize: "2M",
			ytdlpConcurrentFragments: 2,
			enableReconnect: true,
			reconnectDelay: 4,
		},
	};
}

export function applyBufferingPreset(ctx, presetKey) {
	if (presetKey === "custom") return;
	const presets = getBufferingPresets();
	const preset = presets[presetKey];
	if (!preset) return;

	const cacheEl = document.getElementById("enable-cache-checkbox");
	const maxBytesEl = document.getElementById("demuxer-max-bytes-input");
	const maxBackBytesEl = document.getElementById("demuxer-max-back-bytes-input");
	const cacheSecsEl = document.getElementById("cache-secs-input");
	const readaheadSecsEl = document.getElementById("demuxer-readahead-secs-input");
	const bufferSizeEl = document.getElementById("stream-buffer-size-input");
	const fragmentsEl = document.getElementById("ytdlp-concurrent-fragments-input");
	const reconnectEl = document.getElementById("enable-reconnect-checkbox");
	const reconnectDelayEl = document.getElementById("reconnect-delay-input");

	if (cacheEl) cacheEl.checked = preset.enableCache;
	if (maxBytesEl) maxBytesEl.value = preset.demuxerMaxBytes;
	if (maxBackBytesEl) maxBackBytesEl.value = preset.demuxerMaxBackBytes;
	if (cacheSecsEl) cacheSecsEl.value = preset.cacheSecs;
	if (readaheadSecsEl) readaheadSecsEl.value = preset.demuxerReadaheadSecs;
	if (bufferSizeEl) bufferSizeEl.value = preset.streamBufferSize;
	if (fragmentsEl) fragmentsEl.value = preset.ytdlpConcurrentFragments;
	if (reconnectEl) reconnectEl.checked = preset.enableReconnect;
	if (reconnectDelayEl) reconnectDelayEl.value = preset.reconnectDelay;

	ctx.debouncedSaveAllPreferences();
}

export function detectBufferingPreset(prefs) {
	if (!prefs) return "custom";
	const presets = getBufferingPresets();
	for (const [key, preset] of Object.entries(presets)) {
		const matches =
			(prefs.enableCache ?? true) === preset.enableCache &&
			String(prefs.demuxerMaxBytes ?? "1G").toUpperCase() === preset.demuxerMaxBytes.toUpperCase() &&
			String(prefs.demuxerMaxBackBytes ?? "500M").toUpperCase() === preset.demuxerMaxBackBytes.toUpperCase() &&
			Number(prefs.cacheSecs ?? 500) === preset.cacheSecs &&
			Number(prefs.demuxerReadaheadSecs ?? 500) === preset.demuxerReadaheadSecs &&
			String(prefs.streamBufferSize ?? "10M").toUpperCase() === preset.streamBufferSize.toUpperCase() &&
			Number(prefs.ytdlpConcurrentFragments ?? 4) === preset.ytdlpConcurrentFragments &&
			(prefs.enableReconnect ?? true) === preset.enableReconnect &&
			Number(prefs.reconnectDelay ?? 4) === preset.reconnectDelay;

		if (matches) return key;
	}
	return "custom";
}

export function syncBufferingPresetState() {
	const currentValues = {
		enableCache: document.getElementById("enable-cache-checkbox")?.checked,
		demuxerMaxBytes: document.getElementById("demuxer-max-bytes-input")?.value,
		demuxerMaxBackBytes: document.getElementById("demuxer-max-back-bytes-input")?.value,
		cacheSecs: document.getElementById("cache-secs-input")?.value,
		demuxerReadaheadSecs: document.getElementById("demuxer-readahead-secs-input")?.value,
		streamBufferSize: document.getElementById("stream-buffer-size-input")?.value,
		ytdlpConcurrentFragments: document.getElementById("ytdlp-concurrent-fragments-input")?.value,
		enableReconnect: document.getElementById("enable-reconnect-checkbox")?.checked,
		reconnectDelay: document.getElementById("reconnect-delay-input")?.value,
	};
	const matched = detectBufferingPreset(currentValues);
	const select = document.getElementById("buffering-preset-select");
	if (select) {
		select.value = matched;
	}
}
