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

  // 收集可见的 fixed/sticky 元素及其原 inline visibility（用于恢复）。
  // 注意零面积元素不能一刀切跳过：GitHub blob 工具栏是 h:0 的 sticky 包装 +
  // absolute 子元素渲染可见内容，漏管会导致它吸附后每帧都出现在截图里。
  // 零面积时用可见后代的包围盒作为其视觉矩形（rect），无可见后代的才跳过。
  function collectFixedElements() {
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      if (el === document.documentElement || el === document.body) continue;
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      const rect = window.FpsStitch.visualRect(
        { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
        (r.width === 0 || r.height === 0) ? visibleChildRects(el) : null);
      if (!rect) continue;
      out.push({ el, prev: el.style.visibility, sticky: cs.position === 'sticky', cssTop: parseFloat(cs.top) || 0, height: r.height, rect });
    }
    return out;
  }

  // 零面积元素的可见后代矩形（上限 50 个，防深层 DOM 退化）
  function visibleChildRects(el) {
    const rects = [];
    for (const d of el.querySelectorAll('*')) {
      const dcs = getComputedStyle(d);
      if (dcs.display === 'none' || dcs.visibility === 'hidden') continue;
      const dr = d.getBoundingClientRect();
      if (dr.width === 0 || dr.height === 0) continue;
      rects.push({ left: dr.left, right: dr.right, top: dr.top, bottom: dr.bottom });
      if (rects.length >= 50) break;
    }
    return rects;
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

  // 预热：正式截帧前先把目标容器完整滚一遍（约每屏停 150ms），触发懒加载
  // 图片/iframe 与一次性滚动 reveal 动画，然后滚回原位——截帧时内容已就绪
  async function warmUp(setTop, maxScroll, step) {
    for (let y = 0; y < maxScroll; y += step) {
      if (aborted) return;
      setTop(y);
      await sleep(150);
    }
    setTop(maxScroll);
    await sleep(300);
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
    const fixedSet = new Set(fixed.map((f) => f.el));
    // 记录框选时刻各元素是否与选区相交（视口坐标，此刻页面尚未滚动）。
    // fixed/吸顶元素在任意滚动位置的视觉位置不变，故该判定对截取全程有效。
    // 用收集时的视觉矩形：零面积包装元素（h:0 sticky + absolute 后代）的可见区域
    // 在后代身上，用元素自身 rect 会把"框选覆盖了工具栏"误判为未覆盖。
    const selBounds = { left: sel.x, right: sel.x + sel.w, top: sel.y, bottom: sel.y + sel.h };
    for (const f of fixed) {
      f.inSelection = window.FpsStitch.rectsOverlap(f.rect, selBounds);
    }

    let dpr = null;
    let parts = null;
    let canvases = null;
    let colRect = null;

    try {
      // 预热滚动（在任何测量之前；滚动经过会触发懒加载与 reveal 动画，可能撑大内容高度）
      const warmMax = Math.max(0, target.scrollHeight - (isWindow ? window.innerHeight : target.clientHeight));
      if (warmMax > 0) {
        chrome.runtime.sendMessage({ type: 'fps:progress', text: '预热' });
        await warmUp(setTop, warmMax, isWindow ? window.innerHeight : target.clientHeight);
        if (aborted) throw new Error('aborted');
        setTop(initTop);
        await waitSettle(getTop);
      }

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

      // 纵向范围：从选区顶边（内容坐标）到内容末尾；「截取整页」带 fromTop 从 0 开始。
      // 帧规划/分 part/切片的几何全部在"截取坐标系"（0 = startY）中进行，
      // 滚动时再平移回内容坐标（setTop(frame + startY)）。
      const frameOriginY = isWindow ? -getTop() : containerTop - target.scrollTop;
      const startY = sel.fromTop ? 0 : window.FpsStitch.selectionStartY(sel.y, frameOriginY);
      if (startY >= contentHeight) {
        throw new Error('选区起点已在内容末尾之后，请重新框选');
      }
      const capContent = contentHeight - startY;
      const frames = window.FpsStitch.planFrames(capContent, viewportHeight);

      // sticky 元素的自然文档位置（内容坐标）：临时切 relative + top:auto 测量
      // （sticky 与 relative 的流内占位一致），测完恢复。
      // fixed 元素与容器外元素没有内容坐标意义上的自然位置，naturalTop 保持 null（全程隐藏）；
      // 内容级 sticky（高过半视口，如滚动叙事容器）永不隐藏，无需测量。
      for (const f of fixed) {
        f.naturalTop = null;
        if (!f.sticky || (!isWindow && !target.contains(f.el))) continue;
        if (window.FpsStitch.stickyIsContent(f.height, viewportHeight)) continue;
        const prevPos = f.el.style.position;
        const prevTop = f.el.style.top;
        f.el.style.position = 'relative';
        f.el.style.top = 'auto';
        const rect = f.el.getBoundingClientRect();
        f.naturalTop = isWindow
          ? rect.top + getTop()
          : rect.top - containerTop + target.scrollTop;
        f.el.style.position = prevPos;
        f.el.style.top = prevTop;
      }

      for (let i = 0; i < frames.length; i++) {
        if (aborted) throw new Error('aborted');
        if (onProgress) onProgress(i + 1, frames.length);

        setTop(frames[i] + startY);
        await waitSettle(getTop);
        // 弹窗清扫：截取中途新出现的 fixed/sticky（如延时 cookie 弹窗）不属于框选时
        // 的场景——并入管理列表，inSelection=false 且 naturalTop=null，下方规则将它们隐藏。
        // （每帧全量重扫有开销，但帧预算 ≥520ms，足够容纳）
        for (const f of collectFixedElements()) {
          if (!fixedSet.has(f.el)) {
            fixedSet.add(f.el);
            fixed.push({ ...f, inSelection: false, naturalTop: null });
          }
        }
        // 每帧截屏前设置遮挡元素可见性。语义（所见即所得）：
        // 1) sticky 未吸顶时是流内内容，在自然位置帧可见一次；
        // 2) fixed / 已吸顶的 sticky 仅在框选时刻与选区相交时，于首帧按原样出现一次；
        // 3) 内容级 sticky（高过半视口，如滚动叙事容器）永不隐藏；
        // 4) 其余情况隐藏，不重复、不遮挡
        for (const f of fixed) {
          if (f.sticky && window.FpsStitch.stickyIsContent(f.height, viewportHeight)) continue;
          const atNaturalPlace = f.sticky && f.naturalTop !== null &&
            window.FpsStitch.stickyVisible(frames[i] + startY, f.naturalTop, f.cssTop);
          const visible = atNaturalPlace || (i === 0 && f.inSelection);
          f.el.style.visibility = visible ? f.prev : 'hidden';
        }
        await sleep(LAZY_WAIT);
        const dataUrl = await requestFrame();
        const img = await toBitmap(dataUrl);

        if (dpr === null) {
          // 以首帧实测 dpr（img.width = innerWidth * 真实 dpr，含页面缩放）
          dpr = img.width / window.innerWidth;
          parts = window.FpsStitch.assignParts(frames, viewportHeight, capContent, dpr);
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
          const slice = window.FpsStitch.frameSlice(frames[i], viewportHeight, capContent, part.srcY, part.height);
          if (!slice) continue;
          canvases[p].getContext('2d').drawImage(
            img,
            colRect.sx, Math.round((containerTop + slice.sy) * dpr), colRect.sw, Math.round(slice.sh * dpr),
            0, Math.round(slice.dy * dpr), colRect.sw, Math.round(slice.sh * dpr),
          );
        }
      }

      return {
        parts: parts.map((p, idx) => ({ canvas: canvases[idx], srcY: p.srcY, heightCss: p.height })),
        width: colRect.sw,
        totalHeight: Math.round(capContent * dpr),
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
