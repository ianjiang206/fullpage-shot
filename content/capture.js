'use strict';
// Capture flow: scroll-container detection → frame planning → per-frame
// scroll/settle/screenshot/draw → scene restoration.
// Frame drawing is clipped to the selection's crop column; fixed/sticky elements
// follow the WYSIWYG visibility rules (spec §5.3).
import * as geometry from './geometry.js';
import { MSG } from '../shared/protocol.js';
import { ScrollTarget } from './scroll-target.js';

  const FRAME_MIN_INTERVAL = 520; // captureVisibleTab is rate-limited to 2/sec; leave headroom
  const LAZY_WAIT = 300;          // per-frame allowance for lazy-loaded content
  const MAX_RETRIES = 3;

  let aborted = false;
  let lastCaptureAt = 0;

  function cancel() { aborted = true; }
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // Collect visible fixed/sticky elements plus their original inline visibility
  // (for restoration). Zero-area elements must not be skipped wholesale: the GitHub
  // blob toolbar is an h:0 sticky wrapper whose visible content is rendered by an
  // absolute child — leaving it unmanaged makes it appear in every frame once stuck.
  // Zero-area elements use the bounding box of visible descendants as their visual
  // rect; only those with no visible descendants are skipped.
  function collectFixedElements() {
    const records = [];
    for (const element of document.querySelectorAll('*')) {
      if (element === document.documentElement || element === document.body) continue;
      const style = getComputedStyle(element);
      if (style.position !== 'fixed' && style.position !== 'sticky') continue;
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const own = element.getBoundingClientRect();
      const rect = geometry.visualRect(
        { left: own.left, right: own.right, top: own.top, bottom: own.bottom },
        (own.width === 0 || own.height === 0) ? visibleChildRects(element) : null);
      if (!rect) continue;
      records.push({
        element,
        previousVisibility: element.style.visibility,
        isSticky: style.position === 'sticky',
        cssTop: parseFloat(style.top) || 0,
        height: own.height,
        visualRect: rect,
      });
    }
    return records;
  }

  // Visible descendant rects of a zero-area element (capped at 50 to bound deep DOMs)
  function visibleChildRects(el) {
    const rects = [];
    for (const descendant of el.querySelectorAll('*')) {
      const style = getComputedStyle(descendant);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = descendant.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      rects.push({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
      if (rects.length >= 50) break;
    }
    return rects;
  }

  async function requestFrame() {
    const wait = FRAME_MIN_INTERVAL - (Date.now() - lastCaptureAt);
    if (wait > 0) await sleep(wait);
    let lastErr = 'empty response';
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      lastCaptureAt = Date.now();
      const resp = await chrome.runtime.sendMessage({ type: MSG.CAPTURE });
      if (resp && resp.dataUrl) return resp.dataUrl;
      lastErr = (resp && resp.error) || lastErr;
      if (!/MAX_CAPTURE_VISIBLE_TAB|too many/i.test(lastErr)) throw new Error(lastErr);
      await sleep(600); // rate-limit error: back off, then retry
    }
    throw new Error('captureVisibleTab rate limit persists: ' + lastErr);
  }

  async function toBitmap(dataUrl) {
    const blob = await (await fetch(dataUrl)).blob();
    return createImageBitmap(blob);
  }

  // Warm-up: scroll the target container through once before real frame capture
  // (~150ms per screen) to trigger lazy images/iframes and one-shot scroll reveal
  // animations, then return — content is ready when frames are captured.
  async function warmUp(setTop, maxScroll, step) {
    for (let y = 0; y < maxScroll; y += step) {
      if (aborted) return;
      setTop(y);
      await sleep(150);
    }
    setTop(maxScroll);
    await sleep(300);
  }

  // sel: {x, y, width, height, fromTop?} in viewport CSS px (only x/width form
  // the crop column; the vertical range is the container's full content height)
  // onProgress(frameIndex, totalFrames), 1-based
  async function capture(sel, onProgress) {
    aborted = false;

    const target = ScrollTarget.resolve(sel);
    const initTop = target.top;
    const initWinX = window.scrollX;
    const initWinY = window.scrollY;
    // Disable smooth scrolling so scrollTo animations cannot disturb alignment; restored afterwards
    const restoreScrollBehavior = target.saveScrollBehavior();

    const fixed = collectFixedElements();
    const known = new Set(fixed.map((record) => record.element));
    // Record whether each element intersects the selection at selection time
    // (viewport coordinates; the page has not scrolled yet). Fixed/stuck elements
    // keep the same visual position at any scroll offset, so this check holds for
    // the whole capture. Uses the visual rect from collection: for zero-area
    // wrappers (h:0 sticky + absolute descendants) the visible region lives on the
    // descendants, and the element's own rect would misjudge "selection covers the
    // toolbar" as uncovered.
    const selectionBounds = { left: sel.x, right: sel.x + sel.width, top: sel.y, bottom: sel.y + sel.height };
    for (const record of fixed) {
      record.coveredBySelection = geometry.rectsOverlap(record.visualRect, selectionBounds);
    }

    let dpr = null;
    let parts = null;
    let canvases = null;
    let colRect = null;

    try {
      // Warm-up scroll (before any measurement; scrolling past triggers lazy loading
      // and reveal animations and may grow the content height)
      const maxScroll = Math.max(0, target.contentHeight - target.viewportHeight);
      if (maxScroll > 0) {
        chrome.runtime.sendMessage({ type: MSG.PROGRESS, text: '预热' });
        await warmUp((y) => target.setTop(y), maxScroll, target.viewportHeight);
        if (aborted) throw new Error('aborted');
        target.setTop(initTop);
        await target.settle();
      }

      // Inner scroll container: first make it fully visible in the viewport
      // (top-align via window scroll when needed), otherwise frame planning and
      // frame capture disagree. No-op for window scrolling.
      target.ensureFullyVisible();
      const viewportHeight = target.viewportHeight;
      const contentHeight = target.contentHeight;

      // Vertical range: from the selection's top edge (content coordinate) to the
      // content end; 「截取整页」 carries fromTop and starts at 0.
      // All frame-planning / part-assignment / slicing geometry happens in "capture
      // coordinates" (0 = startY); scrolling translates back to content coordinates
      // via setTop(frame + startY).
      const frameOriginY = target.captureOriginY();
      const startY = sel.fromTop ? 0 : geometry.selectionStartY(sel.y, frameOriginY);
      if (startY >= contentHeight) {
        throw new Error('选区起点已在内容末尾之后，请重新框选');
      }
      const capContent = contentHeight - startY;
      const frames = geometry.planFrames(capContent, viewportHeight);

      // Natural document position of sticky elements (content coordinates): measure
      // by temporarily switching to relative + top:auto (sticky and relative occupy
      // the same in-flow slot), then restore.
      // Fixed elements and elements outside the container have no natural position
      // in the content-coordinate sense, so naturalTop stays null (hidden throughout);
      // content-level stickies (taller than half the viewport, e.g. scroll-jacking
      // containers) are never hidden and need no measurement.
      for (const record of fixed) {
        record.naturalTop = null;
        if (!record.isSticky || !target.contains(record.element)) continue;
        if (geometry.stickyIsContent(record.height, viewportHeight)) continue;
        const previousPosition = record.element.style.position;
        const previousTop = record.element.style.top;
        record.element.style.position = 'relative';
        record.element.style.top = 'auto';
        const rect = record.element.getBoundingClientRect();
        record.naturalTop = rect.top - target.contentBoxTop() + target.top;
        record.element.style.position = previousPosition;
        record.element.style.top = previousTop;
      }

      for (let i = 0; i < frames.length; i++) {
        if (aborted) throw new Error('aborted');
        if (onProgress) onProgress(i + 1, frames.length);

        target.setTop(frames[i] + startY);
        await target.settle();
        // Popup sweep: fixed/sticky elements that appear mid-capture (e.g. a delayed
        // cookie banner) were not part of the scene at selection time — fold them
        // into the managed list with coveredBySelection=false and naturalTop=null so the
        // rules below hide them. (A full rescan per frame has a cost, but the frame
        // budget is ≥520ms, which easily covers it.)
        for (const record of collectFixedElements()) {
          if (!known.has(record.element)) {
            known.add(record.element);
            fixed.push({ ...record, coveredBySelection: false, naturalTop: null });
          }
        }
        // WYSIWYG visibility per element (pure decision in geometry.frameVisibility):
        // unstuck stickies at their natural place; covered fixed/stuck elements once
        // in frame 0; content-level stickies never hidden; everything else hidden.
        for (const record of fixed) {
          const visible = geometry.frameVisibility(record, frames[i] + startY, i === 0, viewportHeight);
          record.element.style.visibility = visible ? record.previousVisibility : 'hidden';
        }
        await sleep(LAZY_WAIT);
        const dataUrl = await requestFrame();
        const img = await toBitmap(dataUrl);

        if (dpr === null) {
          // Measure dpr from the first frame (img.width = innerWidth × real dpr,
          // including page zoom)
          dpr = img.width / window.innerWidth;
          parts = geometry.splitIntoParts(frames, viewportHeight, capContent, dpr);
          colRect = geometry.cropColumn(sel.x, sel.width, window.innerWidth, dpr);
          if (colRect.width <= 0) throw new Error('裁剪列宽度为 0，请重新框选');
          canvases = parts.map((p) => {
            const c = document.createElement('canvas');
            c.width = colRect.width;
            c.height = Math.round(p.height * dpr);
            return c;
          });
        }

        for (let p = 0; p < parts.length; p++) {
          const part = parts[p];
          if (i < part.frameStart || i >= part.frameEnd) continue;
          const slice = geometry.framePartIntersection(frames[i], viewportHeight, capContent, part.y, part.height);
          if (!slice) continue;
          canvases[p].getContext('2d').drawImage(
            img,
            colRect.x, Math.round((target.contentBoxTop() + slice.frameOffsetY) * dpr), colRect.width, Math.round(slice.height * dpr),
            0, Math.round(slice.partOffsetY * dpr), colRect.width, Math.round(slice.height * dpr),
          );
        }
      }

      return {
        parts: parts.map((p, idx) => ({ canvas: canvases[idx], startY: p.y, cssHeight: p.height })),
        width: colRect.width,
        totalHeight: Math.round(capContent * dpr),
        dpr,
      };
    } finally {
      target.setTop(initTop);
      window.scrollTo(initWinX, initWinY);
      for (const record of fixed) record.element.style.visibility = record.previousVisibility;
      restoreScrollBehavior();
      chrome.runtime.sendMessage({ type: MSG.DONE });
    }
  }

export { capture, cancel, collectFixedElements };
