'use strict';
// 截取流程：滚动容器探测 → 帧规划 → 逐帧 scroll/settle/截屏/绘制 → 现场恢复。
// 帧绘制只在选区裁剪列内进行；fixed/sticky 元素首帧保留、其后隐藏。
window.FpsCapture = (() => {
  const FRAME_MIN_INTERVAL = 520; // captureVisibleTab 限速 2 次/秒，留余量
  const LAZY_WAIT = 300;          // 每帧给懒加载的时间
  const SETTLE_TIMEOUT = 2000;
  const MAX_RETRIES = 3;

  let aborted = false;
  let lastCaptureAt = 0;

  function cancel() { aborted = true; }
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // 从选区中心向上找最近的可滚动祖先；找不到返回 null（= window 滚动）
  function findScrollContainer(x, y) {
    const chain = [];
    let el = document.elementFromPoint(x, y);
    while (el && el !== document.documentElement && el !== document.body) {
      chain.push({ el, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight });
      el = el.parentElement;
    }
    return window.FpsStitch.pickScrollTarget(chain);
  }

  // 收集可见的 fixed/sticky 元素及其原 inline visibility（用于恢复）
  function collectFixedElements() {
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      if (el === document.documentElement || el === document.body) continue;
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      out.push({ el, prev: el.style.visibility });
    }
    return out;
  }

  // 轮询 scrollTop 直到连续 100ms 不再变化（或超时兜底）
  function waitSettle(getTop) {
    return new Promise((resolve) => {
      let last = getTop();
      let stable = 0;
      const started = Date.now();
      const timer = setInterval(() => {
        const now = getTop();
        if (now === last) {
          if (++stable >= 2) { clearInterval(timer); resolve(); }
        } else {
          last = now;
          stable = 0;
        }
        if (Date.now() - started > SETTLE_TIMEOUT) { clearInterval(timer); resolve(); }
      }, 50);
    });
  }

  async function requestFrame() {
    const wait = FRAME_MIN_INTERVAL - (Date.now() - lastCaptureAt);
    if (wait > 0) await sleep(wait);
    let lastErr = 'empty response';
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      lastCaptureAt = Date.now();
      const resp = await chrome.runtime.sendMessage({ type: 'fps:capture' });
      if (resp && resp.dataUrl) return resp.dataUrl;
      lastErr = (resp && resp.error) || lastErr;
      if (!/MAX_CAPTURE_VISIBLE_TAB|too many/i.test(lastErr)) throw new Error(lastErr);
      await sleep(600); // 限速错误：退避后重试
    }
    throw new Error('captureVisibleTab 持续超限：' + lastErr);
  }

  async function toBitmap(dataUrl) {
    const blob = await (await fetch(dataUrl)).blob();
    return createImageBitmap(blob);
  }

  // sel: {x, y, w, h} 视口 CSS px（仅用 x/w 作裁剪列；纵向 = 容器全部内容高度）
  // onProgress(frameIndex, totalFrames)，从 1 开始
  async function capture(sel, onProgress) {
    aborted = false;

    const container = findScrollContainer(sel.x + sel.w / 2, sel.y + sel.h / 2);
    const isWindow = !container;
    const scrollingEl = document.scrollingElement || document.documentElement;
    const target = container || scrollingEl;
    const getTop = () => target.scrollTop;
    const setTop = (v) => { target.scrollTop = v; };
    const initTop = getTop();
    const initWinX = window.scrollX;
    const initWinY = window.scrollY;

    // 关闭平滑滚动，避免 scrollTo 动画干扰对齐；结束后恢复
    const scrollBehaviorSaved = [];
    for (const el of new Set([document.documentElement, target])) {
      scrollBehaviorSaved.push([el, el.style.scrollBehavior]);
      el.style.scrollBehavior = 'auto';
    }

    const fixed = collectFixedElements();

    let dpr = null;
    let parts = null;
    let canvases = null;
    let colRect = null;

    try {
      // 内部滚动容器：先让它在视口中完整可见（必要时滚动 window 顶对齐），
      // 否则帧规划与截帧对不上。容器内容盒 = border box + clientTop（边框宽）。
      let containerTop = 0;
      if (!isWindow) {
        const contentTop = () => target.getBoundingClientRect().top + target.clientTop;
        let visibility = window.FpsStitch.containerVisibility(contentTop(), target.clientHeight, window.innerHeight);
        if (visibility === 'align') {
          window.scrollBy(0, contentTop());
          visibility = window.FpsStitch.containerVisibility(contentTop(), target.clientHeight, window.innerHeight);
        }
        if (visibility !== 'ok') {
          throw new Error('内部滚动容器高于视口，暂不支持完整截取；请改用「截取整页」');
        }
        containerTop = Math.max(0, contentTop());
      }
      const viewportHeight = isWindow ? window.innerHeight : target.clientHeight;
      const contentHeight = target.scrollHeight;
      const frames = window.FpsStitch.planFrames(contentHeight, viewportHeight);

      for (let i = 0; i < frames.length; i++) {
        if (aborted) throw new Error('aborted');
        if (onProgress) onProgress(i + 1, frames.length);

        setTop(frames[i]);
        await waitSettle(getTop);
        await sleep(LAZY_WAIT);
        const dataUrl = await requestFrame();
        const img = await toBitmap(dataUrl);

        if (dpr === null) {
          // 以首帧实测 dpr（img.width = innerWidth * 真实 dpr，含页面缩放）
          dpr = img.width / window.innerWidth;
          parts = window.FpsStitch.assignParts(frames, viewportHeight, contentHeight, dpr);
          colRect = window.FpsStitch.cropRect(sel.x, sel.w, window.innerWidth, dpr);
          if (colRect.sw <= 0) throw new Error('裁剪列宽度为 0，请重新框选');
          canvases = parts.map((p) => {
            const c = document.createElement('canvas');
            c.width = colRect.sw;
            c.height = Math.round(p.height * dpr);
            return c;
          });
        }

        for (let p = 0; p < parts.length; p++) {
          const part = parts[p];
          if (i < part.frameStart || i >= part.frameEnd) continue;
          const slice = window.FpsStitch.frameSlice(frames[i], viewportHeight, contentHeight, part.srcY, part.height);
          if (!slice) continue;
          canvases[p].getContext('2d').drawImage(
            img,
            colRect.sx, Math.round((containerTop + slice.sy) * dpr), colRect.sw, Math.round(slice.sh * dpr),
            0, Math.round(slice.dy * dpr), colRect.sw, Math.round(slice.sh * dpr),
          );
        }

        // 首帧绘制完成后再隐藏 fixed/sticky（让它们只在顶部出现一次）
        if (i === 0) for (const f of fixed) f.el.style.visibility = 'hidden';
      }

      return {
        parts: parts.map((p, idx) => ({ canvas: canvases[idx], srcY: p.srcY, heightCss: p.height })),
        width: colRect.sw,
        totalHeight: Math.round(contentHeight * dpr),
        dpr,
      };
    } finally {
      setTop(initTop);
      window.scrollTo(initWinX, initWinY);
      for (const f of fixed) f.el.style.visibility = f.prev;
      for (const [el, prev] of scrollBehaviorSaved) el.style.scrollBehavior = prev;
      chrome.runtime.sendMessage({ type: 'fps:done' });
    }
  }

  return { capture, cancel, findScrollContainer, collectFixedElements };
})();
