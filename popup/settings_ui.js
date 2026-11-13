// popup/settings_ui.js
// Extracted view mode, favorites, category filtering, search, and keybind recording for OptionsManager.

export function setSettingsMode(ctx, mode) {
	ctx.currentMode = mode === "advanced" ? "advanced" : "simple";
	try {
		localStorage.setItem("mpv_settings_view_mode", ctx.currentMode);
	} catch (e) {
		console.debug("[Settings] Failed to save settings view mode:", e);
	}

	const container = document.getElementById("shared-settings-container");
	if (container) {
		if (ctx.currentMode === "simple") {
			container.classList.add("mode-simple");
			container.classList.remove("mode-advanced");
		} else {
			container.classList.add("mode-advanced");
			container.classList.remove("mode-simple");
		}
	}

	const btnSimple = document.getElementById("btn-mode-simple");
	const btnAdvanced = document.getElementById("btn-mode-advanced");
	if (btnSimple && btnAdvanced) {
		btnSimple.classList.toggle("active", ctx.currentMode === "simple");
		btnAdvanced.classList.toggle("active", ctx.currentMode === "advanced");
	}

	const searchInput = document.getElementById("settings-search-input");
	if (searchInput && searchInput.value.trim()) {
		handleSettingsSearch(ctx, searchInput.value);
	}
}

export function getSettingIdentifier(group) {
	if (!group) return null;
	if (group.dataset.settingId) return group.dataset.settingId;
	const favBtn = group.querySelector(".btn-fav-setting");
	if (favBtn?.dataset?.settingId) return favBtn.dataset.settingId;
	const input = group.querySelector(
		"input, select, textarea, button:not(.btn-fav-setting)",
	);
	if (input && input.id) return input.id;
	if (group.id) return group.id;
	if (group.dataset.settingName)
		return group.dataset.settingName.trim().replace(/\s+/g, "-");
	return null;
}

export function initializeFavoriteButtons(ctx) {
	const wrapper = document.getElementById("settings-sections-wrapper");
	if (!wrapper) return;

	const groups = wrapper.querySelectorAll(".control-group, .setting-item");
	groups.forEach((group) => {
		if (group.id === "custom-geometry-container") return;
		const id = getSettingIdentifier(group);
		if (!id) return;
		if (group.querySelector(".btn-fav-setting")) return;

		const starBtn = document.createElement("button");
		starBtn.type = "button";
		starBtn.className = "btn-fav-setting";
		starBtn.dataset.settingId = id;
		starBtn.title = ctx.favoriteSettings.has(id)
			? "Remove from Favorites"
			: "Pin to Favorites";
		starBtn.innerHTML =
			'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';

		const label = group.querySelector(".settings-label, label");
		if (label) {
			label.insertAdjacentElement("beforebegin", starBtn);
		} else {
			group.insertAdjacentElement("afterbegin", starBtn);
		}

		starBtn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			toggleFavorite(ctx, id);
		});
	});

	updateFavoriteUI(ctx);
}

export function toggleFavorite(ctx, id) {
	if (ctx.favoriteSettings.has(id)) {
		ctx.favoriteSettings.delete(id);
	} else {
		ctx.favoriteSettings.add(id);
	}

	try {
		localStorage.setItem(
			"mpv_favorite_settings",
			JSON.stringify([...ctx.favoriteSettings]),
		);
	} catch (e) {
		console.debug("[Settings] Failed to save favorite settings:", e);
	}

	updateFavoriteUI(ctx);

	if (ctx.currentCategory === "favorites") {
		applyCategoryFilter(ctx, "favorites");
	}
}

export function updateFavoriteUI(ctx) {
	const starBtns = document.querySelectorAll(".btn-fav-setting");
	starBtns.forEach((btn) => {
		const isFav = ctx.favoriteSettings.has(btn.dataset.settingId);
		btn.classList.toggle("is-favorite", isFav);
		btn.title = isFav ? "Remove from Favorites" : "Pin to Favorites";
		const group = btn.closest(".control-group, .setting-item");
		if (group) {
			group.classList.toggle("is-favorite-setting", isFav);
		}
	});

	const favTab = document.querySelector(
		'.cat-tab-btn[data-category="favorites"], .cat-tab-btn[data-cat="favorites"]',
	);
	if (favTab) {
		const label = favTab.querySelector(".fav-tab-label");
		const count = ctx.favoriteSettings.size;
		if (label) {
			label.textContent = count > 0 ? `Favorites (${count})` : "Favorites";
		} else {
			favTab.textContent = count > 0 ? `Favorites (${count})` : "Favorites";
		}
	}
}

export function applyCategoryFilter(ctx, cat = "all") {
	ctx.currentCategory = cat;
	try {
		localStorage.setItem("mpv_settings_category", ctx.currentCategory);
	} catch (e) {
		console.debug("[Settings] Failed to save settings category:", e);
	}

	const catTabs = document.querySelectorAll(".cat-tab-btn");
	catTabs.forEach((tab) => {
		const tabCat = tab.dataset.category || tab.dataset.cat;
		tab.classList.toggle("active", tabCat === ctx.currentCategory);
	});

	const searchInput = document.getElementById("settings-search-input");
	if (searchInput && searchInput.value) {
		searchInput.value = "";
		const clearBtn = document.getElementById("btn-clear-settings-search");
		if (clearBtn) clearBtn.style.display = "none";
		const statusEl = document.getElementById("settings-search-status");
		if (statusEl) {
			statusEl.textContent = "";
			statusEl.style.display = "none";
		}
	}

	const wrapper = document.getElementById("settings-sections-wrapper");
	if (!wrapper) return;
	const sections = wrapper.querySelectorAll(".settings-section");
	const emptyNotice = document.getElementById("favorites-empty-notice");

	if (ctx.currentCategory === "favorites") {
		const hasFavorites = ctx.favoriteSettings.size > 0;
		if (emptyNotice) {
			emptyNotice.style.display = hasFavorites ? "none" : "flex";
		}

		sections.forEach((section) => {
			section.style.borderColor = "var(--border-primary)";
			section.style.boxShadow = "none";

			section
				.querySelectorAll(".settings-compact-separator, .settings-group-header")
				.forEach((el) => {
					el.style.display = "none";
				});

			const items = section.querySelectorAll(".control-group, .setting-item");
			let sectionFavCount = 0;

			items.forEach((item) => {
				if (item.id === "custom-geometry-container") {
					const geometrySelect = document.getElementById("geometry-select");
					const geomGroup = geometrySelect?.closest(".control-group");
					const isGeomFav =
						geomGroup &&
						ctx.favoriteSettings.has(getSettingIdentifier(geomGroup));
					item.style.display =
						isGeomFav && geometrySelect?.value === "custom" ? "flex" : "none";
					item.classList.toggle("fav-visible-override", Boolean(isGeomFav));
					return;
				}

				item.style.backgroundColor = "transparent";
				const id = getSettingIdentifier(item);
				const isFav = ctx.favoriteSettings.has(id);

				if (isFav) {
					item.style.display = "";
					item.classList.add("fav-visible-override");
					sectionFavCount++;
				} else {
					item.style.display = "none";
					item.classList.remove("fav-visible-override");
				}
			});

			if (sectionFavCount > 0) {
				section.style.display = "block";
				section.open = true;
			} else {
				section.style.display = "none";
			}
		});
	} else {
		if (emptyNotice) emptyNotice.style.display = "none";

		sections.forEach((section) => {
			section.style.borderColor = "var(--border-primary)";
			section.style.boxShadow = "none";

			section
				.querySelectorAll(".settings-compact-separator, .settings-group-header")
				.forEach((el) => {
					el.style.display = "";
				});

			const items = section.querySelectorAll(".control-group, .setting-item");
			items.forEach((item) => {
				if (item.id === "custom-geometry-container") {
					const geometrySelect = document.getElementById("geometry-select");
					item.style.display =
						geometrySelect?.value === "custom" ? "flex" : "none";
					item.style.backgroundColor = "transparent";
					item.classList.remove("fav-visible-override");
					return;
				}
				item.style.display = "";
				item.style.backgroundColor = "transparent";
				item.classList.remove("fav-visible-override");
			});

			const secCat = section.dataset.category || section.dataset.cat;
			if (ctx.currentCategory === "all") {
				section.style.display = "block";
			} else if (secCat === ctx.currentCategory) {
				section.style.display = "block";
				section.open = true;
			} else {
				section.style.display = "none";
			}
		});
	}
}

export function handleSettingsSearch(ctx, query) {
	const wrapper = document.getElementById("settings-sections-wrapper");
	if (!wrapper) return;

	const sections = Array.from(wrapper.querySelectorAll(".settings-section"));
	const normalizedQuery = (query || "").toLowerCase().trim();
	const clearBtn = document.getElementById("btn-clear-settings-search");
	const statusEl = document.getElementById("settings-search-status");

	if (clearBtn) {
		clearBtn.style.display = normalizedQuery ? "inline-flex" : "none";
	}

	if (!normalizedQuery) {
		if (statusEl) {
			statusEl.textContent = "";
			statusEl.style.display = "none";
		}
		applyCategoryFilter(ctx, ctx.currentCategory);
		return;
	}

	if (statusEl) {
		statusEl.style.display = "flex";
	}

	const emptyNotice = document.getElementById("favorites-empty-notice");
	if (emptyNotice) emptyNotice.style.display = "none";

	let totalMatches = 0;
	const isSimpleMode = ctx.currentMode === "simple";
	const isFavoritesTab = ctx.currentCategory === "favorites";

	sections.forEach((section) => {
		const sectionName = (section.dataset.sectionName || "").toLowerCase();
		const sectionTitle = (
			section.querySelector("summary span")?.textContent || ""
		).toLowerCase();
		const sectionMatches =
			sectionName.includes(normalizedQuery) ||
			sectionTitle.includes(normalizedQuery);

		section
			.querySelectorAll(".settings-compact-separator, .settings-group-header")
			.forEach((el) => {
				el.style.display = "none";
			});

		const items = Array.from(
			section.querySelectorAll(".control-group, .setting-item"),
		);
		let sectionMatchCount = 0;

		items.forEach((item) => {
			if (item.id === "custom-geometry-container") {
				const geometrySelect = document.getElementById("geometry-select");
				const geomGroup = geometrySelect?.closest(".control-group");
				const geomVisible = geomGroup && geomGroup.style.display !== "none";
				item.style.display =
					geomVisible && geometrySelect?.value === "custom" ? "flex" : "none";
				return;
			}

			const isAdvancedItem =
				item.classList.contains("setting-advanced") ||
				item.closest(".group-advanced") !== null;

			if (isFavoritesTab) {
				const id = getSettingIdentifier(item);
				if (!ctx.favoriteSettings.has(id)) {
					item.style.display = "none";
					item.style.backgroundColor = "transparent";
					return;
				}
			} else if (isSimpleMode && isAdvancedItem) {
				item.style.display = "none";
				item.style.backgroundColor = "transparent";
				return;
			}

			const settingName = (item.dataset.settingName || "").toLowerCase();
			const textContent = (item.textContent || "").toLowerCase();
			const helpTitle = (
				item.querySelector(".help-icon")?.getAttribute("title") || ""
			).toLowerCase();

			const matches =
				sectionMatches ||
				settingName.includes(normalizedQuery) ||
				textContent.includes(normalizedQuery) ||
				helpTitle.includes(normalizedQuery);

			if (matches) {
				item.style.display = "";
				item.style.backgroundColor = "rgba(88, 101, 242, 0.12)";
				if (isFavoritesTab) item.classList.add("fav-visible-override");
				sectionMatchCount++;
				totalMatches++;
			} else {
				item.style.display = "none";
				item.style.backgroundColor = "transparent";
			}
		});

		if (sectionMatchCount > 0 || (sectionMatches && !isFavoritesTab)) {
			section.style.display = "block";
			section.open = true;
			section.style.borderColor = "var(--accent-primary)";
			section.style.boxShadow = "0 0 10px rgba(88, 101, 242, 0.2)";
		} else {
			section.style.display = "none";
			section.style.borderColor = "var(--border-primary)";
			section.style.boxShadow = "none";
		}
	});

	if (statusEl) {
		if (totalMatches > 0) {
			const suffix = isFavoritesTab
				? " in Favorites"
				: isSimpleMode
					? " (Simple mode — switch to Advanced for more)"
					: "";
			statusEl.textContent = `Found ${totalMatches} matching setting${totalMatches === 1 ? "" : "s"}${suffix}`;
		} else {
			statusEl.textContent = `No settings found matching "${query}"`;
		}
	}
}

export function startRecording(ctx, btn, input) {
	stopRecording(ctx);

	ctx.activeRecorder = { btn, input, originalValue: input.value };
	btn.classList.add("recording");
	btn.innerHTML =
		'<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4"/><path d="M12 18v4"/><path d="M4.93 4.93l2.83 2.83"/><path d="M16.24 16.24l2.83 2.83"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="M4.93 19.07l2.83-2.83"/><path d="M16.24 7.76l2.83-2.83"/></svg>';
	input.value = "Press combination...";
	input.classList.add("recording-active");

	ctx.keyHandler = (e) => {
		e.preventDefault();
		e.stopPropagation();

		const forbiddenKeys = [
			"Control",
			"Shift",
			"Alt",
			"Meta",
			"CapsLock",
			"Tab",
		];
		if (forbiddenKeys.includes(e.key)) return;

		const combo = [];
		if (e.ctrlKey) combo.push("Ctrl");
		if (e.shiftKey) combo.push("Shift");
		if (e.altKey) combo.push("Alt");
		if (e.metaKey) combo.push("Meta");

		let keyName = e.key;
		if (keyName === " ") keyName = "Space";
		if (keyName.length === 1) keyName = keyName.toUpperCase();

		combo.push(keyName);

		const comboStr = combo.join("+");
		input.value = comboStr;
		stopRecording(ctx);
		ctx.debouncedSaveAllPreferences();
	};

	window.addEventListener("keydown", ctx.keyHandler, true);

	ctx.escHandler = (e) => {
		if (e.key === "Escape") {
			input.value = ctx.activeRecorder.originalValue;
			stopRecording(ctx);
		}
	};
	window.addEventListener("keydown", ctx.escHandler);
}

export function stopRecording(ctx) {
	if (ctx.activeRecorder) {
		ctx.activeRecorder.btn.classList.remove("recording");
		ctx.activeRecorder.btn.innerHTML =
			'<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>';
		ctx.activeRecorder.input.classList.remove("recording-active");
		ctx.activeRecorder = null;
	}
	if (ctx.keyHandler) window.removeEventListener("keydown", ctx.keyHandler, true);
	if (ctx.escHandler) window.removeEventListener("keydown", ctx.escHandler);
}
