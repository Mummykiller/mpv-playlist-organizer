/**
 * @class Resizable
 * A utility class to make an HTML element resizable via a handle.
 */
class Resizable {
    /**
     * @param {HTMLElement} element - The element to be resized.
     * @param {HTMLElement} handle - The handle element that triggers the resize.
     * @param {object} [options={}] - Configuration options.
     * @param {number} [options.minWidth=200] - The minimum width the element can be resized to.
     * @param {number} [options.minHeight=150] - The minimum height the element can be resized to.
     * @param {Function} [options.onResizeEnd] - A callback function to execute when resizing is finished.
     */
    constructor(element, handle, options = {}) {
        if (!element || !handle) {
            console.error("Resizable: Both an element and a handle must be provided.");
            return;
        }

        this.element = element;
        this.handle = handle;
        this.minWidth = options.minWidth || 200;
        this.minHeight = options.minHeight || 150;
        this.onResizeEnd = options.onResizeEnd || (() => {});

        this.isResizing = false;
        this.startX = 0;
        this.startY = 0;
        this.startWidth = 0;
        this.startHeight = 0;

        this._onMouseDown = this._onMouseDown.bind(this);
        this._onMouseMove = this._onMouseMove.bind(this);
        this._onMouseUp = this._onMouseUp.bind(this);

        this.handle.addEventListener('mousedown', this._onMouseDown);
    }

    _onMouseDown(e) {
        e.preventDefault();
        this.isResizing = true;
        document.body.classList.add('mpv-resizing-active');

        this.startX = e.clientX;
        this.startY = e.clientY;
        this.startWidth = this.element.offsetWidth;
        this.startHeight = this.element.offsetHeight;

        this.element.style.transition = 'none';

        document.addEventListener('mousemove', this._onMouseMove);
        document.addEventListener('mouseup', this._onMouseUp);
    }

    _onMouseMove(e) {
        if (!this.isResizing) return;

        const rect = this.element.getBoundingClientRect();
        const maxAllowedWidth = window.innerWidth - rect.left;
        const maxAllowedHeight = window.innerHeight - rect.top;

        const newWidth = Math.min(maxAllowedWidth, Math.max(this.minWidth, this.startWidth + (e.clientX - this.startX)));
        const newHeight = Math.min(maxAllowedHeight, Math.max(this.minHeight, this.startHeight + (e.clientY - this.startY)));

        this.element.style.width = `${newWidth}px`;
        this.element.style.height = `${newHeight}px`;
    }

    _onMouseUp() {
        if (!this.isResizing) return;
        this.isResizing = false;
        document.body.classList.remove('mpv-resizing-active');
        this.element.style.transition = '';

        document.removeEventListener('mousemove', this._onMouseMove);
        document.removeEventListener('mouseup', this._onMouseUp);

        this.onResizeEnd({ width: this.element.style.width, height: this.element.style.height });
    }
}