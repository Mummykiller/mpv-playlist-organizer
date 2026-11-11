/**
 * @class Draggable
 */
window.MPV_INTERNAL = window.MPV_INTERNAL || {};

(() => {
	const MPV = window.MPV_INTERNAL;
	MPV.Draggable = class Draggable {
		constructor(element, handle, options = {}) {
			this.element = element;
			this.handle = handle;
			this.options = {
				dragButton: 0,
				onDragStart: () => {},
				onDragMove: () => {},
				onDragEnd: () => {},
				clamp: true,
				...options,
			};
			this.isDragging = false;
			this.hasMoved = false;
			this.startX = 0;
			this.startY = 0;
			this.offsetX = 0;
			this.offsetY = 0;
			this.onMouseDown = this.onMouseDown.bind(this);
			this.onMouseMove = this.onMouseMove.bind(this);
			this.onMouseUp = this.onMouseUp.bind(this);
			this.onContextMenu = this.onContextMenu.bind(this);
			this.attach();
		}

		onMouseDown(e) {
			if (
				e.button !== this.options.dragButton ||
				this.options.onDragStart(e) === false
			)
				return;
			
			this.isDragging = true;
			this.hasMoved = false;
			this.startX = e.clientX || 0;
			this.startY = e.clientY || 0;
			const rect = this.element.getBoundingClientRect();
			this.offsetX = (e.clientX || 0) - rect.left;
			this.offsetY = (e.clientY || 0) - rect.top;
			document.addEventListener("mousemove", this.onMouseMove);
			document.addEventListener("mouseup", this.onMouseUp);
		}

		onMouseMove(e) {
			if (!this.isDragging) return;
			const clientX = e.clientX || 0;
			const clientY = e.clientY || 0;
			const dx = clientX - this.startX;
			const dy = clientY - this.startY;

			if (!this.hasMoved && Math.hypot(dx, dy) > 3) {
				this.hasMoved = true;
				document.body.classList.add("mpv-controller-dragging");
				this.element.style.transition = "none";
			}
			if (!this.hasMoved) return;

			e.preventDefault();
			let newLeft = clientX - this.offsetX;
			let newTop = clientY - this.offsetY;
			if (this.options.clamp) {
				const maxX =
					document.documentElement.clientWidth - this.element.offsetWidth;
				const maxY = window.innerHeight - this.element.offsetHeight;
				newLeft = Math.min(maxX, Math.max(0, newLeft));
				newTop = Math.min(maxY, Math.max(0, newTop));
			}
			this.element.style.left = `${newLeft}px`;
			this.element.style.top = `${newTop}px`;
			this.element.style.right = "auto";
			this.element.style.bottom = "auto";
			this.options.onDragMove(e, { newLeft, newTop });
		}

		onMouseUp(e) {
			if (!this.isDragging) return;
			const didMove = this.hasMoved;
			this.isDragging = false;
			this.hasMoved = false;
			document.body.classList.remove("mpv-controller-dragging");
			this.element.style.transition = "";
			document.removeEventListener("mousemove", this.onMouseMove);
			document.removeEventListener("mouseup", this.onMouseUp);

			if (didMove) {
				// Suppress click / contextmenu / auxclick that may fire after dragging
				const suppress = (ev) => {
					ev.stopPropagation();
					ev.preventDefault();
				};
				window.addEventListener("click", suppress, true);
				window.addEventListener("contextmenu", suppress, true);
				window.addEventListener("auxclick", suppress, true);
				setTimeout(() => {
					window.removeEventListener("click", suppress, true);
					window.removeEventListener("contextmenu", suppress, true);
					window.removeEventListener("auxclick", suppress, true);
				}, 50);

				const rect = this.element.getBoundingClientRect();
				const vw = document.documentElement.clientWidth;
				const vh = window.innerHeight;
				const center = vw / 2;
				const elCenter = rect.left + rect.width / 2;
				let pos;
				if (elCenter < center)
					pos = {
						left: `${(rect.left / vw) * 100}%`,
						top: `${(rect.top / vh) * 100}%`,
						right: "auto",
						bottom: "auto",
					};
				else
					pos = {
						left: "auto",
						top: `${(rect.top / vh) * 100}%`,
						right: `${((vw - rect.right) / vw) * 100}%`,
						bottom: "auto",
					};
				this.options.onDragEnd(e, pos);
			}
		}

		onContextMenu(e) {
			if (this.options.dragButton === 2) e.preventDefault();
		}
		attach() {
			this.handle.addEventListener("mousedown", this.onMouseDown);
			this.handle.addEventListener("contextmenu", this.onContextMenu);
		}

		destroy() {
			if (this.handle) {
				this.handle.removeEventListener("mousedown", this.onMouseDown);
				this.handle.removeEventListener("contextmenu", this.onContextMenu);
			}
			if (this.isDragging) {
				this.isDragging = false;
				this.hasMoved = false;
				document.body.classList.remove("mpv-controller-dragging");
				this.element.style.transition = "";
			}
			document.removeEventListener("mousemove", this.onMouseMove);
			document.removeEventListener("mouseup", this.onMouseUp);
		}
	};
})();
