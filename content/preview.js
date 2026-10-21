'use strict';
// 结果预览浮层：缩略图 + 下载 PNG（多 part 依次下载）+ 复制到剪贴板（超长自动缩放）+ 重选/关闭。
window.FpsPreview = (() => {

  function mkBtn(text, cls) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = text;
    return b;
  }

  function basePanel() {
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL('overlay.css');
    const card = document.createElement('div');
    card.className = 'fps-card';
    const panel = document.createElement('div');
    panel.className = 'fps-panel';
    card.appendChild(panel);
    shadow.append(link, card);
    document.documentElement.appendChild(host);
    return { host, card, panel };
  }

  // 把 parts 拼成单张 blob；超过 MAX_PART_SIZE 时等比缩小（剪贴板只支持单图）
  function buildSingleBlob(parts, width, totalHeight, dpr) {
    const scale = window.FpsStitch.fitScale(width, totalHeight);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(width * scale));
    c.height = Math.max(1, Math.round(totalHeight * scale));
    const ctx = c.getContext('2d');
    for (const p of parts) {
      const dy = Math.round(p.srcY * dpr * scale);
      const dh = Math.round(p.canvas.height * scale);
      ctx.drawImage(p.canvas, 0, 0, p.canvas.width, p.canvas.height, 0, dy, c.width, dh);
    }
    return new Promise((resolve, reject) =>
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob 失败'))), 'image/png'));
  }

  function downloadAll(parts) {
    const t = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}`;
    const hostName = (location.hostname || 'page').replace(/[^\w.-]+/g, '_');
    parts.forEach((p, i) => {
      setTimeout(() => {
        p.canvas.toBlob((blob) => {
          if (!blob) return;
          const a = document.createElement('a');
          const suffix = parts.length > 1 ? `-part${i + 1}` : '';
          a.download = `fullpage-shot-${hostName}-${stamp}${suffix}.png`;
          a.href = URL.createObjectURL(blob);
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        }, 'image/png');
      }, i * 400); // 多文件错开，避免浏览器拦截连续下载
    });
  }

  function show({ parts, width, totalHeight, dpr, onRetry, onClose }) {
    const { host, card, panel } = basePanel();
    let closed = false;

    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      host.remove();
      if (onClose) onClose();
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    }
    document.addEventListener('keydown', onKey, true);
    card.addEventListener('click', (e) => { if (e.target === card) close(); });

    const title = document.createElement('div');
    title.className = 'fps-title';
    title.textContent = '截取完成';

    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'fps-thumb-wrap';
    const thumb = document.createElement('canvas');
    const first = parts[0].canvas;
    const tScale = Math.min(1, 320 / first.height, 480 / first.width);
    thumb.width = Math.max(1, Math.round(first.width * tScale));
    thumb.height = Math.max(1, Math.round(first.height * tScale));
    thumb.getContext('2d').drawImage(first, 0, 0, thumb.width, thumb.height);
    thumbWrap.appendChild(thumb);

    const meta = document.createElement('div');
    meta.className = 'fps-meta';
    meta.textContent = `${width} × ${totalHeight} px` +
      (parts.length > 1 ? ` · 共 ${parts.length} 张（超长自动拆分）` : '');

    const note = document.createElement('div');
    note.className = 'fps-note';

    const actions = document.createElement('div');
    actions.className = 'fps-actions';
    const dlBtn = mkBtn(parts.length > 1 ? `下载 ${parts.length} 张 PNG` : '下载 PNG', 'fps-btn fps-primary');
    const copyBtn = mkBtn('复制到剪贴板', 'fps-btn');
    const retryBtn = mkBtn('重新选择', 'fps-btn');
    const closeBtn = mkBtn('关闭', 'fps-btn');
    actions.append(dlBtn, copyBtn, retryBtn, closeBtn);

    panel.append(title, thumbWrap, meta, note, actions);

    dlBtn.addEventListener('click', () => downloadAll(parts));

    copyBtn.addEventListener('click', async () => {
      copyBtn.disabled = true;
      try {
        const scaled = window.FpsStitch.fitScale(width, totalHeight) < 1;
        const blob = await buildSingleBlob(parts, width, totalHeight, dpr);
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        note.textContent = scaled ? '已复制（超长，已等比缩放至上限内）' : '已复制到剪贴板';
      } catch (e) {
        note.textContent = '复制失败（' + (e && e.message ? e.message : e) + '），请使用下载';
      } finally {
        copyBtn.disabled = false;
      }
    });

    retryBtn.addEventListener('click', () => {
      close(); // 触发 onClose（状态归 idle）
      if (onRetry) onRetry();
    });
    closeBtn.addEventListener('click', () => close());

    return { close };
  }

  function showError(message, onClose) {
    const { host, panel } = basePanel();
    const title = document.createElement('div');
    title.className = 'fps-title';
    title.textContent = '出错了';
    const msg = document.createElement('div');
    msg.className = 'fps-meta';
    msg.textContent = message;
    const actions = document.createElement('div');
    actions.className = 'fps-actions';
    const closeBtn = mkBtn('关闭', 'fps-btn');
    actions.appendChild(closeBtn);
    panel.append(title, msg, actions);
    closeBtn.addEventListener('click', () => { host.remove(); if (onClose) onClose(); });
    return { close: () => host.remove() };
  }

  return { show, showError };
})();
