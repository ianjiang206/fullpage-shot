'use strict';
// Selection overlay: drag a rectangle to select; Enter / the action button confirms;
// Esc cancels; pressing anywhere on the mask redraws; with no selection the action
// button is 「截取整页」 (full width, from the top).
// Styles are isolated via shadow DOM + overlay.css injected through web_accessible_resources.
  const DRAG_THRESHOLD = 4; // px; smaller than this counts as a click (redraw)
  const SCROLL_KEYS = [' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End'];

  function mkBtn(text, cls) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = text;
    return b;
  }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function start({ onConfirm, onCancel }) {
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL('overlay.css');
    shadow.appendChild(link);

    const overlay = document.createElement('div');
    overlay.className = 'fps-overlay';

    const toolbar = document.createElement('div');
    toolbar.className = 'fps-toolbar';
    const hint = document.createElement('span');
    hint.textContent = '拖拽框选要截取的区域';
    const actionBtn = mkBtn('', 'fps-btn fps-primary');
    const cancelBtn = mkBtn('', 'fps-btn');
    cancelBtn.innerHTML = '取消 <kbd>Esc</kbd>';
    toolbar.append(hint, actionBtn, cancelBtn);

    const rectEl = document.createElement('div');
    rectEl.className = 'fps-rect';
    rectEl.style.display = 'none';
    const label = document.createElement('div');
    label.className = 'fps-label';
    rectEl.appendChild(label);

    overlay.appendChild(rectEl);
    shadow.append(overlay, toolbar);
    document.documentElement.appendChild(host);

    let origin = null; // drag start point {x, y}
    let rect = null;   // selection {x, y, w, h} in viewport CSS px
    let done = false;

    function rectFrom(a, b) {
      const x1 = clamp(Math.min(a.x, b.x), 0, window.innerWidth);
      const y1 = clamp(Math.min(a.y, b.y), 0, window.innerHeight);
      const x2 = clamp(Math.max(a.x, b.x), 0, window.innerWidth);
      const y2 = clamp(Math.max(a.y, b.y), 0, window.innerHeight);
      return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    }

    function render() {
      // Contextual toolbar: with a selection the action button is 「截取」,
      // without one it is 「截取整页」
      actionBtn.innerHTML = rect ? '截取 <kbd>Enter</kbd>' : '截取整页';
      hint.textContent = rect ? '拖拽任意处可重新框选' : '拖拽框选要截取的区域';
      if (!rect) { rectEl.style.display = 'none'; return; }
      rectEl.style.display = 'block';
      rectEl.style.left = rect.x + 'px';
      rectEl.style.top = rect.y + 'px';
      rectEl.style.width = rect.w + 'px';
      rectEl.style.height = rect.h + 'px';
      // Vertically we capture from the selection's top edge to the content end
      // (spec §5.1); the label says so honestly
      label.textContent = `宽 ${Math.round(rect.w)} px · 从此处截到页尾`;
    }

    function finish(kind) {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      host.remove();
      if (kind === 'confirm') onConfirm(rect);
      else onCancel();
    }

    overlay.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      origin = { x: e.clientX, y: e.clientY };
      rect = null;
      render();
    });

    function onMove(e) {
      if (!origin) return;
      const next = rectFrom(origin, { x: e.clientX, y: e.clientY });
      // too small in either dimension counts as a mis-touch; back to no selection
      rect = (next.w >= DRAG_THRESHOLD && next.h >= DRAG_THRESHOLD) ? next : null;
      render();
    }
    function onUp() { origin = null; }
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);

    actionBtn.addEventListener('click', () => {
      // no selection = capture full page (full width, from the top)
      if (!rect) rect = { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight, fromTop: true };
      finish('confirm');
    });
    cancelBtn.addEventListener('click', () => finish('cancel'));

    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        finish('cancel');
      } else if (e.key === 'Enter') {
        if (rect) { e.preventDefault(); finish('confirm'); }
      } else if (SCROLL_KEYS.includes(e.key)) {
        e.preventDefault(); // lock page scrolling while selecting
      }
    }
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
    overlay.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

    render(); // initialize the toolbar button label (no selection → 「截取整页」)
    return { close: () => finish('cancel') };
  }

export { start };
