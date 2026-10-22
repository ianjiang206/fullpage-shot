// Pure-function module: frame planning, frame/part intersection, part
// splitting, crop-column mapping, fit scale, scroll-container selection, and
// the fixed/sticky geometry rules. No DOM/Chrome dependencies — node imports
// it directly for unit tests.
export const MAX_CANVAS_EDGE = 16384; // conservative Chrome canvas max dimension (device px)

// Frame scroll positions: step = viewportHeight, last frame bottom-aligned;
// content within one screen → [0].
export function planFrames(contentHeight, viewportHeight) {
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
// contentHeight) with a part band ([partY, partY+partHeight)).
// Returns {frameOffsetY: source offset within frame, height: source height,
// partOffsetY: destination offset within part} in CSS px, or null when there
// is no overlap.
export function framePartIntersection(frameTop, viewportHeight, contentHeight, partY, partHeight) {
  const frameBottom = Math.min(frameTop + viewportHeight, contentHeight);
  const visibleTop = Math.max(frameTop, partY);
  const visibleBottom = Math.min(frameBottom, partY + partHeight);
  if (visibleBottom <= visibleTop) return null;
  return { frameOffsetY: visibleTop - frameTop, height: visibleBottom - visibleTop, partOffsetY: visibleTop - partY };
}

// Distribute the frame sequence into part bands along frame boundaries.
// Bands are contiguous, non-overlapping, and cover [0, contentHeight).
// Returns [{y, height, frameStart, frameEnd}] with frame index range [frameStart, frameEnd).
export function splitIntoParts(frames, viewportHeight, contentHeight, dpr, maxEdge = MAX_CANVAS_EDGE) {
  if (viewportHeight * dpr > maxEdge) {
    throw new Error(`single frame height ${Math.round(viewportHeight * dpr)}px exceeds part limit ${maxEdge}px; cannot stitch`);
  }
  const parts = [];
  let start = 0;
  for (let i = 0; i < frames.length; i++) {
    const isLast = i === frames.length - 1;
    const coverEnd = isLast ? contentHeight : frames[i] + viewportHeight;
    if ((coverEnd - frames[start]) * dpr > maxEdge && i > start) {
      parts.push({ y: frames[start], height: frames[i] - frames[start], frameStart: start, frameEnd: i });
      start = i;
    }
  }
  parts.push({ y: frames[start], height: contentHeight - frames[start], frameStart: start, frameEnd: frames.length });
  return parts;
}

// Selection (viewport CSS px) → horizontal source range of the frame image
// (device px), clamped to the viewport.
export function cropColumn(selX, selWidth, viewportWidth, dpr) {
  const x = Math.max(0, Math.round(selX * dpr));
  const right = Math.min(Math.round((selX + selWidth) * dpr), Math.round(viewportWidth * dpr));
  return { x, width: Math.max(0, right - x) };
}

// Scale factor for a single image (clipboard use): 1 when within maxEdge.
export function fitScale(width, height, maxEdge = MAX_CANVAS_EDGE) {
  return Math.min(1, maxEdge / Math.max(width, height));
}

// candidates are ordered deepest-first [{element, scrollHeight, clientHeight}];
// returns the first scrollable element.
export function firstScrollable(candidates) {
  for (const candidate of candidates) {
    if (candidate.scrollHeight > candidate.clientHeight + 8) return candidate.element;
  }
  return null;
}

// How to handle an inner scroll container's content-box visibility in the viewport:
//   'ok'          already fully visible ([top, top+height] ⊆ [0, innerHeight])
//   'align'       can become fully visible by top-aligning via window scroll (height ≤ viewport)
//   'unsupported' taller than the viewport, cannot be fully aligned
export function containerVisibility(contentTop, contentHeight, innerHeight) {
  if (contentTop >= 0 && contentTop + contentHeight <= innerHeight) return 'ok';
  return contentHeight <= innerHeight ? 'align' : 'unsupported';
}

// Content coordinate of the selection's top edge = selY (viewport y) − frameOriginY
// (the viewport y of content coordinate 0). For window scrolling frameOriginY =
// -scrollTop; for an inner container it is content-box viewport top − container
// scrollTop. A selection top above the content start counts as 0; the caller
// reports an error when it is past the content end.
export function selectionStartY(selY, frameOriginY) {
  return Math.max(0, selY - frameOriginY);
}

// Whether a sticky element is still at its natural position in a given frame:
// true while the frame's scroll position has not passed naturalTop − cssTop —
// i.e. it is captured exactly once at its natural document position and hidden
// once stuck, avoiding duplicates and occlusion.
export function stickyAtNaturalPosition(scrollTopContent, naturalTop, cssTop) {
  return scrollTopContent <= naturalTop - cssTop;
}

// Whether two rects intersect (same coordinate system, {left, right, top, bottom}).
// Edge-touching does not count as overlap.
export function rectsOverlap(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

// Whether a sticky element is "content body" (scroll-jacking container): a sticky
// taller than half the viewport is content and is never hidden (it appears
// multiple times down the long image as scroll progresses — the inherent
// expression of scroll animation in a linear image); small stickies are UI chrome
// (navbars etc.) and follow stickyAtNaturalPosition / selection-overlap rules.
export function stickyIsContent(elHeight, viewportHeight) {
  return elHeight > viewportHeight / 2;
}

// An element's visual rect: its own rect when it has area; for zero-area elements
// (e.g. an h:0 sticky wrapper — the GitHub blob toolbar pattern, where visible
// content lives in absolute-positioned descendants) the bounding box of visible
// descendant rects; null when zero-area with no visible descendants (the caller
// should not collect/manage it).
// Rects are {left, right, top, bottom}; childRects is an array of the same, or null.
export function visualRect(own, childRects) {
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

// Per-frame visibility of one fixed/sticky record (main spec §5.3 WYSIWYG rules):
// 1) a content-level sticky (taller than half the viewport) is never hidden;
// 2) an unstuck sticky is in-flow content, visible in the frames where it sits
//    at its natural position (regardless of selection coverage);
// 3) anything else (fixed, or a stuck sticky) appears as-is once in frame 0,
//    only if it intersected the selection at selection time.
// record: {isSticky, height, naturalTop, cssTop, coveredBySelection} (pure fields).
export function frameVisibility(record, frameY, isFirstFrame, viewportHeight) {
  if (record.isSticky && stickyIsContent(record.height, viewportHeight)) return true;
  if (record.isSticky && record.naturalTop != null &&
      stickyAtNaturalPosition(frameY, record.naturalTop, record.cssTop)) return true;
  return isFirstFrame && record.coveredBySelection === true;
}
