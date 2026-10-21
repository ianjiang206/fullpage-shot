'use strict';
// 纯函数模块：帧规划、帧/part 交集、分 part、裁剪列换算、缩放比、滚动容器选择。
// 无 DOM/Chrome 依赖，node 可直接 require 单测；浏览器里挂载为 window.FpsStitch。
(function (root, factory) {
  const api = factory();
  root.FpsStitch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  const MAX_PART_SIZE = 16384; // Chrome canvas 单边保守上限（device px）

  // 帧滚动位置：步长 = viewportHeight，末帧底对齐；内容不超一屏 → [0]。
  function planFrames(contentHeight, viewportHeight) {
    if (!(contentHeight > 0) || !(viewportHeight > 0)) {
      throw new Error('planFrames: contentHeight/viewportHeight 必须为正数');
    }
    const maxScroll = contentHeight - viewportHeight;
    if (maxScroll <= 0) return [0];
    const ys = [0];
    let y = 0;
    while (y < maxScroll) {
      y = Math.min(y + viewportHeight, maxScroll);
      ys.push(y);
    }
    return ys;
  }

  // 帧（[frameTop, frameTop+viewportHeight)，不越 contentHeight）与 part 带
  // （[bandSrcY, bandSrcY+bandHeight)）的交集。
  // 返回 {sy: 帧内源起点, sh: 源高度, dy: part 内目标起点}（CSS px），不重叠返回 null。
  function frameSlice(frameTop, viewportHeight, contentHeight, bandSrcY, bandHeight) {
    const frameBottom = Math.min(frameTop + viewportHeight, contentHeight);
    const visTop = Math.max(frameTop, bandSrcY);
    const visBottom = Math.min(frameBottom, bandSrcY + bandHeight);
    if (visBottom <= visTop) return null;
    return { sy: visTop - frameTop, sh: visBottom - visTop, dy: visTop - bandSrcY };
  }

  // 沿帧边界把帧序列分进若干 part 带。带与带连续、无重叠，覆盖 [0, contentHeight)。
  // 返回 [{srcY, height, frameStart, frameEnd}]，帧下标范围 [frameStart, frameEnd)。
  function assignParts(frames, viewportHeight, contentHeight, dpr, maxPartSize) {
    const max = maxPartSize || MAX_PART_SIZE;
    if (viewportHeight * dpr > max) {
      throw new Error(`单帧高度 ${Math.round(viewportHeight * dpr)}px 超过 part 上限 ${max}px，无法拼接`);
    }
    const parts = [];
    let start = 0;
    for (let i = 0; i < frames.length; i++) {
      const isLast = i === frames.length - 1;
      const coverEnd = isLast ? contentHeight : frames[i] + viewportHeight;
      if ((coverEnd - frames[start]) * dpr > max && i > start) {
        parts.push({ srcY: frames[start], height: frames[i] - frames[start], frameStart: start, frameEnd: i });
        start = i;
      }
    }
    parts.push({ srcY: frames[start], height: contentHeight - frames[start], frameStart: start, frameEnd: frames.length });
    return parts;
  }

  // 选区（视口 CSS px）→ 帧图源矩形横向范围（device px），clamp 到视口。
  function cropRect(selX, selW, viewportWidth, dpr) {
    const sx = Math.max(0, Math.round(selX * dpr));
    const right = Math.min(Math.round((selX + selW) * dpr), Math.round(viewportWidth * dpr));
    return { sx, sw: Math.max(0, right - sx) };
  }

  // 单图（剪贴板用）缩放比：不超过 maxSize 时为 1。
  function fitScale(width, height, maxSize) {
    const max = maxSize || MAX_PART_SIZE;
    return Math.min(1, max / Math.max(width, height));
  }

  // candidates 从深到浅 [{el, scrollHeight, clientHeight}]，返回第一个可滚动的 el。
  function pickScrollTarget(candidates) {
    for (const c of candidates) {
      if (c.scrollHeight > c.clientHeight + 8) return c.el;
    }
    return null;
  }

  // 内部滚动容器内容盒在视口中的可见性处置：
  //   'ok'          已完整可见（[top, top+height] ⊆ [0, innerHeight]）
  //   'align'       可通过 window 顶对齐滚动变为完整可见（高度 ≤ 视口）
  //   'unsupported' 高于视口，无法完整对齐
  function containerVisibility(contentTop, contentHeight, innerHeight) {
    if (contentTop >= 0 && contentTop + contentHeight <= innerHeight) return 'ok';
    return contentHeight <= innerHeight ? 'align' : 'unsupported';
  }

  // 选区顶边的内容坐标 = selY（视口 y）− frameOriginY（内容坐标 0 在视口中的 y）。
  // window 滚动时 frameOriginY = -scrollTop；内部容器时 = 内容盒视口 top − 容器 scrollTop。
  // 选区顶边在内容起点之上时按 0 计；超出内容末尾的情况由调用方报错。
  function selectionStartY(selY, frameOriginY) {
    return Math.max(0, selY - frameOriginY);
  }

  // sticky 元素在某帧是否应可见：仅在未吸顶（帧滚动位置未越过 自然位置 − cssTop）时可见，
  // 即只在自然文档位置被截取一次，吸顶后隐藏，避免重复与遮挡。
  function stickyVisible(scrollTopContent, naturalTop, cssTop) {
    return scrollTopContent <= naturalTop - cssTop;
  }

  // 两个矩形是否相交（同一坐标系，{left, right, top, bottom}）。边缘相接不算相交。
  function rectsOverlap(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  return { planFrames, frameSlice, assignParts, cropRect, fitScale, pickScrollTarget, containerVisibility, selectionStartY, stickyVisible, rectsOverlap, MAX_PART_SIZE };
});
