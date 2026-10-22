'use strict';
// Capture flow: scroll-container detection → frame planning → per-frame
// scroll/settle/screenshot/draw → scene restoration.
// Frame drawing is clipped to the selection's crop column; fixed/sticky elements
// follow the WYSIWYG visibility rules (spec §5.3).
import * as stitch from './stitch.js';
import { MSG } from '../shared/protocol.js';

  const FRAME_MIN_INTERVAL = 520; // captureVisibleTab is rate-limited to 2/sec; leave headroom
  const LAZY_WAIT = 300;          // per-frame allowance for lazy-loaded content
  const SETTLE_TIMEOUT = 2000;
  const MAX_RETRIES = 3;

  let aborted = false;
  let lastCaptureAt = 0;

  function cancel() { aborted = true; }
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // Walk up from the selection center to the nearest scrollable ancestor; null = window scrolling
  function findScrollContainer(x, y) {
    const chain = [];
    let el = document.elementFromPoint(x, y);
    while (el && el !== document.documentElement && el !== document.body) {
      chain.push({ el, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight });
      el = el.parentElement;
    }
    return stitch.pickScrollTarget(chain);
  }

  // Collect visible fixed/sticky elements plus their original inline visibility
  // (for restoration). Zero-area elements must not be skipped wholesale: the GitHub
  // blob toolbar is an h:0 sticky wrapper whose visible content is rendered by an
  // absolute child — leaving it unmanaged makes it appear in every frame once stuck.
  // Zero-area elements use the bounding box of visible descendants as their visual
  // rect; only those with no visible descendants are skipped.
  function collectFixedElements() {
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      if (el === document.documentElement || el === document.body) continue;
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      const rect = stitch.visualRect(
        { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
        (r.width === 0 || r.height === 0) ? visibleChildRects(el) : null);
      if (!rect) continue;
      out.push({ el, prev: el.style.visibility, sticky: cs.position === 'sticky', cssTop: parseFloat(cs.top) || 0, height: r.height, rect });
    }
    return out;
  }

  // Visible descendant rects of a zero-area element (capped at 50 to bound deep DOMs)
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

  // Poll scrollTop until it stays unchanged for 100ms (with a timeout fallback)
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

  // sel: {x, y, w, h} in viewport CSS px (only x/w form the crop column; the vertical
  // range is the container's full content height)
  // onProgress(frameIndex, totalFrames), 1-based
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

    // Disable smooth scrolling so scrollTo animations cannot disturb alignment; restored afterwards
    const scrollBehaviorSaved = [];
    for (const el of new Set([document.documentElement, target])) {
      scrollBehaviorSaved.push([el, el.style.scrollBehavior]);
      el.style.scrollBehavior = 'auto';
    }

    const fixed = collectFixedElements();
    const fixedSet = new Set(fixed.map((f) => f.el));
    // Record whether each element intersects the selection at selection time
    // (viewport coordinates; the page has not scrolled yet). Fixed/stuck elements
    // keep the same visual position at any scroll offset, so this check holds for
    // the whole capture. Uses the visual rect from collection: for zero-area
    // wrappers (h:0 sticky + absolute descendants) the visible region lives on the
    // descendants, and the element's own rect would misjudge "selection covers the
    // toolbar" as uncovered.
    const selBounds = { left: sel.x, right: sel.x + sel.w, top: sel.y, bottom: sel.y + sel.h };
    for (const f of fixed) {
      f.inSelection = stitch.rectsOverlap(f.rect, selBounds);
    }

    let dpr = null;
    let parts = null;
    let canvases = null;
    let colRect = null;

    try {
      // Warm-up scroll (before any measurement; scrolling past triggers lazy loading
      // and reveal animations and may grow the content height)
      const warmMax = Math.max(0, target.scrollHeight - (isWindow ? window.innerHeight : target.clientHeight));
      if (warmMax > 0) {
        chrome.runtime.sendMessage({ type: MSG.PROGRESS, text: '预热' });
        await warmUp(setTop, warmMax, isWindow ? window.innerHeight : target.clientHeight);
        if (aborted) throw new Error('aborted');
        setTop(initTop);
        await waitSettle(getTop);
      }

      // Inner scroll container: first make it fully visible in the viewport
      // (top-align via window scroll when needed), otherwise frame planning and
      // frame capture disagree. Container content box = border box + clientTop
      // (border width).
      let containerTop = 0;
      if (!isWindow) {
        const contentTop = () => target.getBoundingClientRect().top + target.clientTop;
        let visibility = stitch.containerVisibility(contentTop(), target.clientHeight, window.innerHeight);
        if (visibility === 'align') {
          window.scrollBy(0, contentTop());
          visibility = stitch.containerVisibility(contentTop(), target.clientHeight, window.innerHeight);
        }
        if (visibility !== 'ok') {
          throw new Error('内部滚动容器高于视口，暂不支持完整截取；请改用「截取整页」');
        }
        containerTop = Math.max(0, contentTop());
      }
      const viewportHeight = isWindow ? window.innerHeight : target.clientHeight;
      const contentHeight = target.scrollHeight;

      // Vertical range: from the selection's top edge (content coordinate) to the
      // content end; 「截取整页」 carries fromTop and starts at 0.
      // All frame-planning / part-assignment / slicing geometry happens in "capture
      // coordinates" (0 = startY); scrolling translates back to content coordinates
      // via setTop(frame + startY).
      const frameOriginY = isWindow ? -getTop() : containerTop - target.scrollTop;
      const startY = sel.fromTop ? 0 : stitch.selectionStartY(sel.y, frameOriginY);
      if (startY >= contentHeight) {
        throw new Error('选区起点已在内容末尾之后，请重新框选');
      }
      const capContent = contentHeight - startY;
      const frames = stitch.planFrames(capContent, viewportHeight);

      // Natural document position of sticky elements (content coordinates): measure
      // by temporarily switching to relative + top:auto (sticky and relative occupy
      // the same in-flow slot), then restore.
      // Fixed elements and elements outside the container have no natural position
      // in the content-coordinate sense, so naturalTop stays null (hidden throughout);
      // content-level stickies (taller than half the viewport, e.g. scroll-jacking
      // containers) are never hidden and need no measurement.
      for (const f of fixed) {
        f.naturalTop = null;
        if (!f.sticky || (!isWindow && !target.contains(f.el))) continue;
        if (stitch.stickyIsContent(f.height, viewportHeight)) continue;
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
        // Popup sweep: fixed/sticky elements that appear mid-capture (e.g. a delayed
        // cookie banner) were not part of the scene at selection time — fold them
        // into the managed list with inSelection=false and naturalTop=null so the
        // rules below hide them. (A full rescan per frame has a cost, but the frame
        // budget is ≥520ms, which easily covers it.)
        for (const f of collectFixedElements()) {
          if (!fixedSet.has(f.el)) {
            fixedSet.add(f.el);
            fixed.push({ ...f, inSelection: false, naturalTop: null });
          }
        }
        // Set occluding-element visibility before each screenshot. Semantics (WYSIWYG):
        // 1) an unstuck sticky is in-flow content, visible once in its natural-position frame;
        // 2) fixed / stuck sticky elements appear as-is once in frame 0 only if they
        //    intersected the selection at selection time;
        // 3) content-level stickies (taller than half the viewport) are never hidden;
        // 4) everything else is hidden — no duplicates, no occlusion
        for (const f of fixed) {
          if (f.sticky && stitch.stickyIsContent(f.height, viewportHeight)) continue;
          const atNaturalPlace = f.sticky && f.naturalTop !== null &&
            stitch.stickyVisible(frames[i] + startY, f.naturalTop, f.cssTop);
          const visible = atNaturalPlace || (i === 0 && f.inSelection);
          f.el.style.visibility = visible ? f.prev : 'hidden';
        }
        await sleep(LAZY_WAIT);
        const dataUrl = await requestFrame();
        const img = await toBitmap(dataUrl);

        if (dpr === null) {
          // Measure dpr from the first frame (img.width = innerWidth × real dpr,
          // including page zoom)
          dpr = img.width / window.innerWidth;
          parts = stitch.assignParts(frames, viewportHeight, capContent, dpr);
          colRect = stitch.cropRect(sel.x, sel.w, window.innerWidth, dpr);
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
          const slice = stitch.frameSlice(frames[i], viewportHeight, capContent, part.srcY, part.height);
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
      chrome.runtime.sendMessage({ type: MSG.DONE });
    }
  }

export { capture, cancel, findScrollContainer, collectFixedElements };
