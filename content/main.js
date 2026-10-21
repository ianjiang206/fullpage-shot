'use strict';
// State machine: idle → selecting → capturing → preview → (retry back to selecting / close back to idle)
(function () {
  if (window.__fpsMainLoaded) return;
  window.__fpsMainLoaded = true;

  let phase = 'idle'; // idle | selecting | capturing | preview
  let ui = null;      // current overlay's {close()}

  function twoFrames() {
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && phase === 'capturing') window.FpsCapture.cancel();
  }, true);

  function start() {
    if (phase !== 'idle') return; // a flow is already running; ignore repeated clicks
    beginSelect();
  }

  function beginSelect() {
    phase = 'selecting';
    ui = window.FpsSelect.start({
      onConfirm,
      onCancel: () => { phase = 'idle'; ui = null; },
    });
  }

  async function onConfirm(sel) {
    ui = null; // the selection overlay has already removed itself
    phase = 'capturing';
    await twoFrames(); // wait for the mask to actually leave composited frames so it never appears in frame 0
    try {
      const result = await window.FpsCapture.capture(sel, (i, n) => {
        chrome.runtime.sendMessage({ type: 'fps:progress', text: `${i}/${n}` });
      });
      phase = 'preview';
      ui = window.FpsPreview.show({
        ...result,
        onRetry: () => { beginSelect(); },
        onClose: () => { phase = 'idle'; ui = null; },
      });
    } catch (e) {
      if (e && e.message === 'aborted') {
        phase = 'idle'; // user cancelled with Esc: silently back to idle
        return;
      }
      phase = 'preview';
      ui = window.FpsPreview.showError(
        '截取失败：' + (e && e.message ? e.message : e),
        () => { phase = 'idle'; ui = null; },
      );
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'fps:ping') { sendResponse({ ok: true }); return false; }
    if (msg.type === 'fps:start') { start(); sendResponse({ ok: true }); return false; }
    return false;
  });
})();
