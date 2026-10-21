'use strict';
// 协调状态机：idle → selecting → capturing → preview →（重选回 selecting / 关闭回 idle）
(function () {
  if (window.__fpsMainLoaded) return;
  window.__fpsMainLoaded = true;

  let phase = 'idle'; // idle | selecting | capturing | preview
  let ui = null;      // 当前浮层的 {close()}

  function twoFrames() {
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && phase === 'capturing') window.FpsCapture.cancel();
  }, true);

  function start() {
    if (phase !== 'idle') return; // 已有流程在进行，忽略重复点击
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
    ui = null; // 选区浮层已自行移除
    phase = 'capturing';
    await twoFrames(); // 等遮罩真正离开合成帧，避免出现在首帧里
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
        phase = 'idle'; // 用户 Esc 取消：静默回到 idle
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
