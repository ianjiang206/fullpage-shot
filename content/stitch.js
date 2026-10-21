'use strict';
// Pure-function module: frame planning, frame/part intersection, part assignment,
// crop-column mapping, fit scale, scroll-container selection.
// No DOM/Chrome dependencies — node can require it directly for unit tests;
// in the browser it mounts as window.FpsStitch.
(function (root, factory) {
  const api = factory();
  root.FpsStitch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  const MAX_PART_SIZE = 16384; // conservative Chrome canvas max dimension (device px)

  // Frame scroll positions: step = viewportHeight, last frame bottom-aligned;
  // content within one screen → [0].
  function planFrames(contentHeight, viewportHeight) {
    if (!(contentHeight > 0) || !(viewportHeight > 0)) {
      throw new Error('planFrames: contentHeight/viewportHeight must be positive');
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

  // Intersection of a frame ([frameTop, frameTop+viewportHeight), clamped to
  // contentHeight) with a part band ([bandSrcY, bandSrcY+bandHeight)).
  // Returns {sy: source offset within frame, sh: source height, dy: destination
  // offset within part} in CSS px, or null when there is no overlap.
  function frameSlice(frameTop, viewportHeight, contentHeight, bandSrcY, bandHeight) {
    const frameBottom = Math.min(frameTop + viewportHeight, contentHeight);
    const visTop = Math.max(frameTop, bandSrcY);
    const visBottom = Math.min(frameBottom, bandSrcY + bandHeight);
    if (visBottom <= visTop) return null;
    return { sy: visTop - frameTop, sh: visBottom - visTop, dy: visTop - bandSrcY };
  }

  // Distribute the frame sequence into part bands along frame boundaries.
  // Bands are contiguous, non-overlapping, and cover [0, contentHeight).
  // Returns [{srcY, height, frameStart, frameEnd}] with frame index range [frameStart, frameEnd).
  function assignParts(frames, viewportHeight, contentHeight, dpr, maxPartSize) {
    const max = maxPartSize || MAX_PART_SIZE;
    if (viewportHeight * dpr > max) {
      throw new Error(`single frame height ${Math.round(viewportHeight * dpr)}px exceeds part limit ${max}px; cannot stitch`);
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

  // Selection (viewport CSS px) → horizontal source range of the frame image
  // (device px), clamped to the viewport.
  function cropRect(selX, selW, viewportWidth, dpr) {
    const sx = Math.max(0, Math.round(selX * dpr));
    const right = Math.min(Math.round((selX + selW) * dpr), Math.round(viewportWidth * dpr));
    return { sx, sw: Math.max(0, right - sx) };
  }

  // Scale factor for a single image (clipboard use): 1 when within maxSize.
  function fitScale(width, height, maxSize) {
    const max = maxSize || MAX_PART_SIZE;
    return Math.min(1, max / Math.max(width, height));
  }

  // candidates are ordered deepest-first [{el, scrollHeight, clientHeight}];
  // returns the first scrollable el.
  function pickScrollTarget(candidates) {
    for (const c of candidates) {
      if (c.scrollHeight > c.clientHeight + 8) return c.el;
    }
    return null;
  }

  // How to handle an inner scroll container's content-box visibility in the viewport:
  //   'ok'          already fully visible ([top, top+height] ⊆ [0, innerHeight])
  //   'align'       can become fully visible by top-aligning via window scroll (height ≤ viewport)
  //   'unsupported' taller than the viewport, cannot be fully aligned
  function containerVisibility(contentTop, contentHeight, innerHeight) {
    if (contentTop >= 0 && contentTop + contentHeight <= innerHeight) return 'ok';
    return contentHeight <= innerHeight ? 'align' : 'unsupported';
  }

  // Content coordinate of the selection's top edge = selY (viewport y) − frameOriginY
  // (the viewport y of content coordinate 0). For window scrolling frameOriginY =
  // -scrollTop; for an inner container it is content-box viewport top − container
  // scrollTop. A selection top above the content start counts as 0; the caller
  // reports an error when it is past the content end.
  function selectionStartY(selY, frameOriginY) {
    return Math.max(0, selY - frameOriginY);
  }

  // Whether a sticky element should be visible in a given frame: only while not
  // stuck (frame scroll position has not passed naturalTop − cssTop) — i.e. it is
  // captured exactly once at its natural document position and hidden once stuck,
  // avoiding duplicates and occlusion.
  function stickyVisible(scrollTopContent, naturalTop, cssTop) {
    return scrollTopContent <= naturalTop - cssTop;
  }

  // Whether two rects intersect (same coordinate system, {left, right, top, bottom}).
  // Edge-touching does not count as overlap.
  function rectsOverlap(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  // Whether a sticky element is "content body" (scroll-jacking container): a sticky
  // taller than half the viewport is content and is never hidden (it appears
  // multiple times down the long image as scroll progresses — the inherent
  // expression of scroll animation in a linear image); small stickies are UI chrome
  // (navbars etc.) and follow stickyVisible / selection-overlap rules.
  function stickyIsContent(elHeight, viewportHeight) {
    return elHeight > viewportHeight / 2;
  }

  // An element's visual rect: its own rect when it has area; for zero-area elements
  // (e.g. an h:0 sticky wrapper — the GitHub blob toolbar pattern, where visible
  // content lives in absolute-positioned descendants) the bounding box of visible
  // descendant rects; null when zero-area with no visible descendants (the caller
  // should not collect/manage it).
  // Rects are {left, right, top, bottom}; childRects is an array of the same, or null.
  function visualRect(own, childRects) {
    if (own.right > own.left && own.bottom > own.top) return own;
    if (!childRects || childRects.length === 0) return null;
    let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
    for (const c of childRects) {
      if (c.left < left) left = c.left;
      if (c.right > right) right = c.right;
      if (c.top < top) top = c.top;
      if (c.bottom > bottom) bottom = c.bottom;
    }
    return right > left && bottom > top ? { left, right, top, bottom } : null;
  }

  return { planFrames, frameSlice, assignParts, cropRect, fitScale, pickScrollTarget, containerVisibility, selectionStartY, stickyVisible, rectsOverlap, stickyIsContent, visualRect, MAX_PART_SIZE };
});
