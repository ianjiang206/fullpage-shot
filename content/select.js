// Selection overlay: drag a rectangle to select; Enter / the action button
// confirms; Esc cancels; pressing anywhere on the mask redraws. With no
// selection the action button is 「截取整页」 (full width, from the top).
import { Overlay, h } from './overlay.js';

const DRAG_THRESHOLD = 4; // px; smaller than this counts as a click (redraw)
const SCROLL_KEYS = [' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End'];

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

/** @typedef {{x:number, y:number, width:number, height:number, fromTop?:boolean}} Selection */

export class SelectionOverlay extends Overlay {
  #onConfirm;
  #origin = null; // drag start point {x, y}
  #rect = null;   // Selection in viewport CSS px
  #mouseMove;
  #mouseUp;

  constructor({ onConfirm, onCancel }) {
    super({ onClose: onCancel });
    this.#onConfirm = onConfirm;

    this.hint = h('span', { text: '拖拽框选要截取的区域' });
    this.actionButton = h('button', { type: 'button', class: 'fps-btn fps-primary' });
    const cancelButton = h('button', {
      type: 'button', class: 'fps-btn', html: '取消 <kbd>Esc</kbd>',
      onClick: () => this.close(),
    });
    this.label = h('div', { class: 'fps-label' });
    this.rectEl = h('div', { class: 'fps-rect', style: 'display:none' }, this.label);
    this.mask = h('div', { class: 'fps-overlay' }, this.rectEl);
    this.mount(this.mask, h('div', { class: 'fps-toolbar' }, this.hint, this.actionButton, cancelButton));

    this.actionButton.addEventListener('click', () => this.confirm());
    this.mask.addEventListener('mousedown', (event) => this.#startDrag(event));
    this.#mouseMove = (event) => this.#updateDrag(event);
    this.#mouseUp = () => { this.#origin = null; };
    window.addEventListener('mousemove', this.#mouseMove, true);
    window.addEventListener('mouseup', this.#mouseUp, true);
    // Lock page scrolling while selecting (released on teardown).
    this.mask.addEventListener('wheel', (event) => event.preventDefault(), { passive: false });
    this.mask.addEventListener('touchmove', (event) => event.preventDefault(), { passive: false });
    this.#render();
  }

  teardown() {
    super.teardown();
    window.removeEventListener('mousemove', this.#mouseMove, true);
    window.removeEventListener('mouseup', this.#mouseUp, true);
  }

  handleKeyDown(event) {
    if (event.key === 'Enter' && this.#rect) {
      event.preventDefault();
      this.confirm();
      return;
    }
    if (SCROLL_KEYS.includes(event.key)) {
      event.preventDefault(); // lock page scrolling while selecting
      return;
    }
    super.handleKeyDown(event); // Escape → cancel
  }

  // Confirm: with a selection capture it; with none capture the full page
  // (full width, from the top).
  confirm() {
    if (this.closed) return;
    const rect = this.#rect ?? {
      x: 0, y: 0, width: window.innerWidth, height: window.innerHeight, fromTop: true,
    };
    this.teardown(); // teardown only — confirm must not fire onClose (= onCancel)
    this.#onConfirm(rect);
  }

  #startDrag(event) {
    if (event.button !== 0) return;
    this.#origin = { x: event.clientX, y: event.clientY };
    this.#rect = null;
    this.#render();
  }

  #updateDrag(event) {
    if (!this.#origin) return;
    const next = rectFromPoints(this.#origin, { x: event.clientX, y: event.clientY });
    // too small in either dimension counts as a mis-touch; back to no selection
    this.#rect = (next.width >= DRAG_THRESHOLD && next.height >= DRAG_THRESHOLD) ? next : null;
    this.#render();
  }

  #render() {
    // Contextual toolbar: with a selection the action button is 「截取」,
    // without one it is 「截取整页」
    this.actionButton.innerHTML = this.#rect ? '截取 <kbd>Enter</kbd>' : '截取整页';
    this.hint.textContent = this.#rect ? '拖拽任意处可重新框选' : '拖拽框选要截取的区域';
    if (!this.#rect) {
      this.rectEl.style.display = 'none';
      return;
    }
    this.rectEl.style.display = 'block';
    this.rectEl.style.left = this.#rect.x + 'px';
    this.rectEl.style.top = this.#rect.y + 'px';
    this.rectEl.style.width = this.#rect.width + 'px';
    this.rectEl.style.height = this.#rect.height + 'px';
    // Vertically we capture from the selection's top edge to the content end
    // (spec §5.1); the label says so honestly
    this.label.textContent = `宽 ${Math.round(this.#rect.width)} px · 从此处截到页尾`;
  }
}

function rectFromPoints(a, b) {
  const x1 = clamp(Math.min(a.x, b.x), 0, window.innerWidth);
  const y1 = clamp(Math.min(a.y, b.y), 0, window.innerHeight);
  const x2 = clamp(Math.max(a.x, b.x), 0, window.innerWidth);
  const y2 = clamp(Math.max(a.y, b.y), 0, window.innerHeight);
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}
