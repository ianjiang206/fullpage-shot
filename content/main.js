'use strict';
// Task 4 版本：截取结果直接自动下载（验证拼接正确性），Task 5 换成预览浮层。
(function () {
  if (window.__fpsMainLoaded) return;
  window.__fpsMainLoaded = true;

  let capturing = false;

  function twoFrames() {
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && capturing) window.FpsCapture.cancel();
  }, true);

  function start() {
    if (capturing) return;
    window.FpsSelect.start({ onConfirm, onCancel: () => {} });
  }

  async function onConfirm(sel) {
    capturing = true;
    await twoFrames(); // 等选区遮罩真正离开合成帧，避免出现在首帧里
    try {
      const result = await window.FpsCapture.capture(sel, (i, n) => {
        chrome.runtime.sendMessage({ type: 'fps:progress', text: `${i}/${n}` });
      });
      result.parts.forEach((p, i) => {
        setTimeout(() => {
          p.canvas.toBlob((blob) => {
            if (!blob) return;
            const a = document.createElement('a');
            a.download = `fps-debug-part${i + 1}.png`;
            a.href = URL.createObjectURL(blob);
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 10000);
          }, 'image/png');
        }, i * 400);
      });
    } catch (e) {
      if (e && e.message !== 'aborted') {
        alert('截取失败：' + (e && e.message ? e.message : e));
      }
    } finally {
      capturing = false;
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'fps:ping') { sendResponse({ ok: true }); return false; }
    if (msg.type === 'fps:start') { start(); sendResponse({ ok: true }); return false; }
    return false;
  });
})();
