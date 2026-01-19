/**
 * @class Resizable
 */
window.MPV_INTERNAL = window.MPV_INTERNAL || {};

(() => {
	window.MPV_INTERNAL.Resizable = class Resizable {
		constructor(element, handle, options = {}) {
			this.element = element;
			this.handle = handle;
			this.options = {
				minWidth: 100,
				minHeight: 100,
				onResizeStart: () => {},
				onResizeMove: () => {},
				onResizeEnd: () => {},
				...options,
			};
			this.isResizing = false;
			this.startX = 0;
			this.startY = 0;
			this.startWidth = 0;
			this.startHeight = 0;
			this.onMouseDown = this.onMouseDown.bind(this);
			this.onMouseMove = this.onMouseMove.bind(this);
			this.onMouseUp = this.onMouseUp.bind(this);
			this.attach();
		}

		onMouseDown(e) {
			if (e.button !== 0) return;
			e.preventDefault();
			this.isResizing = true;
			document.body.classList.add("mpv-anilist-resizing");
			this.startX = e.clientX;
			this.startY = e.clientY;
			this.startWidth = parseInt(
				document.defaultView.getComputedStyle(this.element).width,
				10,
			);
			this.startHeight = parseInt(
				document.defaultView.getComputedStyle(this.element).height,
				10,
			);
			document.addEventListener("mousemove", this.onMouseMove);
			document.addEventListener("mouseup", this.onMouseUp);
			this.options.onResizeStart(e);
		}

		onMouseMove(e) {
			if (!this.isResizing) return;
			const newWidth = Math.max(
				this.options.minWidth,
				this.startWidth + (e.clientX - this.startX),
			);
			const newHeight = Math.max(
				this.options.minHeight,
				this.startHeight + (e.clientY - this.startY),
			);
			this.element.style.width = `${newWidth}px`;
			this.element.style.height = `${newHeight}px`;
			this.options.onResizeMove(e, { width: newWidth, height: newHeight });
		}

		onMouseUp(e) {
			if (!this.isResizing) return;
			this.isResizing = false;
			document.body.classList.remove("mpv-anilist-resizing");
			document.removeEventListener("mousemove", this.onMouseMove);
			document.removeEventListener("mouseup", this.onMouseUp);
			this.options.onResizeEnd({
				width: this.element.style.width,
				height: this.element.style.height,
			});
		}

		attach() {
			this.handle.addEventListener("mousedown", this.onMouseDown);
		}
	};
})();
