/**
 * @class Draggable
 */
window.MPV_INTERNAL = window.MPV_INTERNAL || {};

(() => {
	const MPV = window.MPV_INTERNAL;
	window.MPV_INTERNAL.Draggable = class Draggable {
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
			
			// Only prevent default if we're actually going to start dragging
			// This avoids blocking child click events on some browsers/OSs
			this.isDragging = true;
			document.body.classList.add("mpv-controller-dragging");
			const rect = this.element.getBoundingClientRect();
			this.offsetX = e.clientX - rect.left;
			this.offsetY = e.clientY - rect.top;
			this.element.style.transition = "none";
			document.addEventListener("mousemove", this.onMouseMove);
			document.addEventListener("mouseup", this.onMouseUp);
		}

		onMouseMove(e) {
			if (!this.isDragging) return;
			e.preventDefault();
			let newLeft = e.clientX - this.offsetX;
			let newTop = e.clientY - this.offsetY;
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
			this.isDragging = false;
			document.body.classList.remove("mpv-controller-dragging");
			this.element.style.transition = "";
			document.removeEventListener("mousemove", this.onMouseMove);
			document.removeEventListener("mouseup", this.onMouseUp);
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

		onContextMenu(e) {
			if (this.options.dragButton === 2) e.preventDefault();
		}
		attach() {
			this.handle.addEventListener("mousedown", this.onMouseDown);
			this.handle.addEventListener("contextmenu", this.onContextMenu);
		}
	};
})();
