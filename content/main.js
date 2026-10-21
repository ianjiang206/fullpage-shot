'use strict';
// 占位版本（Task 1）：仅验证注入链路，Task 3/4/5 逐步替换为完整状态机。
(function () {
  if (window.__fpsMainLoaded) return;
  window.__fpsMainLoaded = true;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'fps:ping') {
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'fps:start') {
      const el = document.createElement('div');
      el.textContent = 'FullPage Shot 已注入';
      el.style.cssText =
        'position:fixed;top:12px;right:12px;z-index:2147483647;background:#1a73e8;' +
        'color:#fff;padding:8px 12px;border-radius:6px;font:13px sans-serif;';
      document.documentElement.appendChild(el);
      setTimeout(() => el.remove(), 1500);
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });
})();
