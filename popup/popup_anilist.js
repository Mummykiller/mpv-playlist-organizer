// popup/popup_anilist.js
// AniList release schedule fetching and navigation for popup.js.

import { domUtils } from "../utils/domUtils.module.js";
import { AniListRenderer } from "../utils/anilist_renderer.module.js";

export function createAniListManager(ctx) {
	const {
		anilistReleasesSection,
		anilistReleasesContent,
		refreshAnilistBtn,
		anilistNavControls,
		btnAnilistPrev,
		btnAnilistNext,
		btnAnilistToday,
	} = ctx;

	let currentAnilistOffset = 0;
	let activeFetchId = 0;

	async function fetchAniListReleases(forceRefresh = false, offset = 0) {
		const fetchId = ++activeFetchId;
		if (anilistNavControls) anilistNavControls.style.display = "flex";

		const existingList = anilistReleasesContent.querySelector(
			".anilist-releases-list, .anilist-empty-message, .anilist-error",
		);
		if (existingList) existingList.remove();

		let spinner = anilistReleasesContent.querySelector(".loading-spinner");
		if (!spinner) {
			spinner = document.createElement("div");
			spinner.className = "loading-spinner";
			anilistReleasesContent.appendChild(spinner);
		}
		spinner.style.display = "block";

		if (btnAnilistPrev) btnAnilistPrev.disabled = offset <= -6;
		if (btnAnilistNext) btnAnilistNext.disabled = offset >= 6;
		if (btnAnilistToday) {
			btnAnilistToday.style.opacity = offset === 0 ? "0.5" : "1";
			btnAnilistToday.style.cursor = offset === 0 ? "default" : "pointer";

			if (offset !== 0) {
				const targetDate = new Date();
				targetDate.setDate(targetDate.getDate() + offset);
				btnAnilistToday.textContent = targetDate.toLocaleDateString(
					undefined,
					{ month: "short", day: "numeric" },
				);
			} else {
				btnAnilistToday.textContent = "Today";
			}
		}

		try {
			const releases = await AniListRenderer.fetchReleases(
				forceRefresh,
				offset,
			);
			if (fetchId !== activeFetchId) return;
			spinner.style.display = "none";
			AniListRenderer.render(anilistReleasesContent, releases, offset);

			if (anilistReleasesSection.open) {
				setTimeout(() => {
					const ytView = document.getElementById("youtube-tools-view");
					if (ytView && ytView.style.display !== "none") return;
					const container = document.getElementById("scrollable-content");
					if (container) domUtils.smoothScrollTo(container, container.scrollHeight, 400);
				}, 50);
			}
		} catch (error) {
			if (fetchId !== activeFetchId) return;
			spinner.style.display = "none";
			const errorElement = document.createElement("div");
			errorElement.className = "anilist-error";
			errorElement.textContent = `Error: ${error.message}`;
			anilistReleasesContent.appendChild(errorElement);
		}
	}

	function bindAniListListeners() {
		if (btnAnilistPrev) {
			btnAnilistPrev.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				if (currentAnilistOffset > -6) {
					currentAnilistOffset--;
					fetchAniListReleases(false, currentAnilistOffset);
				}
			});
		}

		if (btnAnilistNext) {
			btnAnilistNext.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				if (currentAnilistOffset < 6) {
					currentAnilistOffset++;
					fetchAniListReleases(false, currentAnilistOffset);
				}
			});
		}

		if (btnAnilistToday) {
			btnAnilistToday.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				if (currentAnilistOffset !== 0) {
					currentAnilistOffset = 0;
					fetchAniListReleases(false, 0);
				}
			});
		}

		refreshAnilistBtn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			fetchAniListReleases(true, currentAnilistOffset);
		});

		anilistReleasesSection.addEventListener("toggle", (event) => {
			if (event.target.open) {
				let noteElement = anilistReleasesSection.querySelector(
					".anilist-release-delay-info",
				);
				if (!noteElement) {
					noteElement = document.createElement("p");
					noteElement.className = "anilist-release-delay-info";
					anilistReleasesContent.insertAdjacentElement(
						"beforebegin",
						noteElement,
					);
				}
				noteElement.textContent =
					"Note: There may be a 30 minute to 3 hour delay on release times.";

				fetchAniListReleases(false, currentAnilistOffset);

				setTimeout(() => {
					const ytView = document.getElementById("youtube-tools-view");
					if (ytView && ytView.style.display !== "none") return;
					const container = document.getElementById("scrollable-content");
					if (container) domUtils.smoothScrollTo(container, container.scrollHeight, 400);
				}, 50);
			}
		});
	}

	return {
		fetchAniListReleases,
		bindAniListListeners,
	};
}
