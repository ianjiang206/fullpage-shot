'use strict';
// Task 3 版本：选区确认后先显示选区参数，Task 4 接入真正的截取。
(function () {
  if (window.__fpsMainLoaded) return;
  window.__fpsMainLoaded = true;

  function toast(text, ms) {
    const el = document.createElement('div');
    el.textContent = text;
    el.style.cssText =
      'position:fixed;top:12px;right:12px;z-index:2147483647;background:#1a73e8;' +
      'color:#fff;padding:8px 12px;border-radius:6px;font:13px sans-serif;';
    document.documentElement.appendChild(el);
    setTimeout(() => el.remove(), ms || 3000);
  }

  function start() {
    window.FpsSelect.start({
      onConfirm: (sel) => {
        toast(`选区: x=${Math.round(sel.x)}, 宽=${Math.round(sel.w)}（Task 4 接入截取）`);
      },
      onCancel: () => {},
    });
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'fps:ping') { sendResponse({ ok: true }); return false; }
    if (msg.type === 'fps:start') { start(); sendResponse({ ok: true }); return false; }
    return false;
  });
})();
