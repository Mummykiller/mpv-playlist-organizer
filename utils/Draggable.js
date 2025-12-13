/**
 * Makes a given element draggable.
 */
class Draggable {
    /**
     * @param {HTMLElement} element - The element to be moved.
     * @param {HTMLElement} handle - The element that triggers the drag.
     * @param {object} [options={}] - Configuration options.
     * @param {number} [options.dragButton=0] - The mouse button to initiate drag (0=left, 1=middle, 2=right).
     * @param {Function} [options.onDragStart] - Callback when dragging starts. Return false to prevent drag.
     * @param {Function} [options.onDragMove] - Callback during movement. Receives (event, { newLeft, newTop }).
     * @param {Function} [options.onDragEnd] - Callback when dragging ends.
     * @param {boolean} [options.clamp=true] - If true, clamps the element within the viewport.
     */
    constructor(element, handle, options = {}) {
        if (!element || !handle) {
            console.error("Draggable: 'element' and 'handle' must be valid HTML elements.");
            return;
        }

        this.element = element;
        this.handle = handle;
        this.options = {
            dragButton: 0,
            onDragStart: () => {},
            onDragMove: () => {},
            onDragEnd: () => {},
            clamp: true,
            ...options
        };

        this.isDragging = false;
        this.offsetX = 0;
        this.offsetY = 0;

        // Bind context for event listeners
        this.onMouseDown = this.onMouseDown.bind(this);
        this.onMouseMove = this.onMouseMove.bind(this);
        this.onMouseUp = this.onMouseUp.bind(this);
        this.onContextMenu = this.onContextMenu.bind(this);

        this.attach();
    }

    onMouseDown(e) {
        if (e.button !== this.options.dragButton) return;

        // Allow the onDragStart callback to prevent the drag
        if (this.options.onDragStart(e) === false) {
            return;
        }

        e.preventDefault();
        this.isDragging = true;
        document.body.classList.add('mpv-controller-dragging'); // Generic dragging cursor

        const rect = this.element.getBoundingClientRect();
        this.offsetX = e.clientX - rect.left;
        this.offsetY = e.clientY - rect.top;

        this.element.style.transition = 'none';

        document.addEventListener('mousemove', this.onMouseMove);
        document.addEventListener('mouseup', this.onMouseUp);
    }

    onMouseMove(e) {
        if (!this.isDragging) return;

        let newLeft = e.clientX - this.offsetX;
        let newTop = e.clientY - this.offsetY;

        if (this.options.clamp) {
            const hostWidth = this.element.offsetWidth;
            const hostHeight = this.element.offsetHeight;
            const maxX = window.innerWidth - hostWidth;
            const maxY = window.innerHeight - hostHeight;

            newLeft = Math.min(maxX, Math.max(0, newLeft));
            newTop = Math.min(maxY, Math.max(0, newTop));
        }

        this.element.style.left = `${newLeft}px`;
        this.element.style.top = `${newTop}px`;
        this.element.style.right = 'auto';
        this.element.style.bottom = 'auto';

        this.options.onDragMove(e, { newLeft, newTop });
    }

    onMouseUp(e) {
        if (!this.isDragging) return;
        this.isDragging = false;
        document.body.classList.remove('mpv-controller-dragging');
        this.element.style.transition = '';
        document.removeEventListener('mousemove', this.onMouseMove);
        document.removeEventListener('mouseup', this.onMouseUp);
        this.options.onDragEnd(e);
    }

    onContextMenu(e) {
        if (this.options.dragButton === 2) e.preventDefault();
    }

    attach() {
        this.handle.addEventListener('mousedown', this.onMouseDown);
        this.handle.addEventListener('contextmenu', this.onContextMenu);
    }

    detach() {
        this.handle.removeEventListener('mousedown', this.onMouseDown);
        this.handle.removeEventListener('contextmenu', this.onContextMenu);
        document.removeEventListener('mousemove', this.onMouseMove);
        document.removeEventListener('mouseup', this.onMouseUp);
    }
}