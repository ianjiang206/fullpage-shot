'use strict';
// 选区遮罩：拖拽框选；Enter/「开始截取」确认；Esc 取消；单击空白重画；「截取整页」直接全宽。
// 样式经 shadow DOM + web_accessible_resources 注入的 overlay.css 隔离。
window.FpsSelect = (() => {
  const DRAG_THRESHOLD = 4; // px，小于此视为单击（重画）
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
    hint.textContent = '拖拽框选要截取的区域 · Enter 确认 · Esc 取消';
    const fullBtn = mkBtn('截取整页', 'fps-btn');
    const cancelBtn = mkBtn('取消', 'fps-btn');
    toolbar.append(hint, fullBtn, cancelBtn);

    const rectEl = document.createElement('div');
    rectEl.className = 'fps-rect';
    rectEl.style.display = 'none';
    const label = document.createElement('div');
    label.className = 'fps-label';
    const confirmBtn = mkBtn('开始截取', 'fps-btn fps-primary fps-confirm');
    rectEl.append(label, confirmBtn);

    overlay.appendChild(rectEl);
    shadow.append(overlay, toolbar);
    document.documentElement.appendChild(host);

    let origin = null; // 拖拽起点 {x, y}
    let rect = null;   // 选区 {x, y, w, h}，视口 CSS px
    let done = false;

    function rectFrom(a, b) {
      const x1 = clamp(Math.min(a.x, b.x), 0, window.innerWidth);
      const y1 = clamp(Math.min(a.y, b.y), 0, window.innerHeight);
      const x2 = clamp(Math.max(a.x, b.x), 0, window.innerWidth);
      const y2 = clamp(Math.max(a.y, b.y), 0, window.innerHeight);
      return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    }

    function render() {
      if (!rect) { rectEl.style.display = 'none'; return; }
      rectEl.style.display = 'block';
      rectEl.style.left = rect.x + 'px';
      rectEl.style.top = rect.y + 'px';
      rectEl.style.width = rect.w + 'px';
      rectEl.style.height = rect.h + 'px';
      // 纵向永远覆盖整页高度（spec §5.1），label 如实告知
      label.textContent = `宽 ${Math.round(rect.w)} px × 整页高度`;
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
    // 选区内按下不触发重画（点「开始截取」）
    rectEl.addEventListener('mousedown', (e) => e.stopPropagation());

    function onMove(e) {
      if (!origin) return;
      const next = rectFrom(origin, { x: e.clientX, y: e.clientY });
      // 宽或高过小视为误触，回到未选状态
      rect = (next.w >= DRAG_THRESHOLD && next.h >= DRAG_THRESHOLD) ? next : null;
      render();
    }
    function onUp() { origin = null; }
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);

    confirmBtn.addEventListener('click', () => { if (rect) finish('confirm'); });
    fullBtn.addEventListener('click', () => {
      rect = { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
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
        e.preventDefault(); // 选区阶段锁定页面滚动
      }
    }
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
    overlay.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

    return { close: () => finish('cancel') };
  }

  return { start };
})();
