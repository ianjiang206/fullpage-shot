// Fixed/sticky element management for the duration of a capture (main spec
// §5.3 WYSIWYG rules): collect the visible fixed/sticky set, measure sticky
// natural positions, apply per-frame visibility, sweep mid-capture popups
// into the hidden set, and restore everything afterwards.
import { visualRect, rectsOverlap, stickyIsContent, frameVisibility } from './geometry.js';

const MAX_DESCENDANT_RECTS = 50; // bounds the descendant scan on deep DOMs

/**
 * @typedef {Object} FixedElementRecord
 * @property {Element} element
 * @property {string} previousVisibility  inline visibility before management (for restoration)
 * @property {boolean} isSticky
 * @property {number} cssTop              parsed computed top (stick offset)
 * @property {number} height              own border-box height (stickyIsContent input)
 * @property {{left:number, right:number, top:number, bottom:number}} visualRect
 * @property {boolean} [coveredBySelection]  judged at collection time, viewport coordinates
 * @property {?number} [naturalTop]       sticky's natural document position, content coordinates
 */

// Scan the page for visible fixed/sticky elements. Zero-area elements are not
// skipped wholesale: the GitHub blob toolbar pattern is an h:0 sticky wrapper
// whose visible content is rendered by an absolute child — such elements use
// the bounding box of their visible descendants as their visual rect; only
// zero-area elements with no visible descendants are skipped.
export function scanFixedElements() {
  const records = [];
  for (const element of document.querySelectorAll('*')) {
    if (element === document.documentElement || element === document.body) continue;
    const style = getComputedStyle(element);
    if (style.position !== 'fixed' && style.position !== 'sticky') continue;
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const own = element.getBoundingClientRect();
    const rect = visualRect(
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

// Visible descendant rects of a zero-area element.
function visibleChildRects(element) {
  const rects = [];
  for (const descendant of element.querySelectorAll('*')) {
    const style = getComputedStyle(descendant);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const rect = descendant.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    rects.push({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
    if (rects.length >= MAX_DESCENDANT_RECTS) break;
  }
  return rects;
}

export class FixedElementManager {
  #target;
  #selectionBounds;
  #records = [];
  #known = new Set();

  constructor(target, selectionBounds) {
    this.#target = target;
    this.#selectionBounds = selectionBounds;
  }

  // Initial scan at selection time: also records whether each element's
  // visual rect intersects the selection (fixed/stuck elements keep their
  // visual position at any scroll offset, so the judgment holds all capture).
  collect() {
    for (const record of scanFixedElements()) {
      record.coveredBySelection = rectsOverlap(record.visualRect, this.#selectionBounds);
      record.naturalTop = null;
      this.#records.push(record);
      this.#known.add(record.element);
    }
  }

  // A sticky's natural document position (content coordinates), measured by
  // temporarily switching to position:relative (sticky and relative occupy the
  // same in-flow slot), then restoring. Fixed elements, elements outside the
  // container, and content-level stickies get no naturalTop (the first two
  // stay hidden throughout; the last is never hidden).
  measureNaturalTops() {
    for (const record of this.#records) {
      if (!record.isSticky) continue;
      if (!this.#target.contains(record.element)) continue;
      if (stickyIsContent(record.height, this.#target.viewportHeight)) continue;
      const element = record.element;
      const previousPosition = element.style.position;
      const previousTop = element.style.top;
      element.style.position = 'relative';
      element.style.top = 'auto';
      const rect = element.getBoundingClientRect();
      record.naturalTop = rect.top - this.#target.contentBoxTop() + this.#target.top;
      element.style.position = previousPosition;
      element.style.top = previousTop;
    }
  }

  // Popup sweep: fixed/sticky elements that appear mid-capture (e.g. a delayed
  // cookie banner) were not part of the scene at selection time — fold them
  // into the managed set as not-covered with no natural position so the rules
  // hide them throughout.
  sweep() {
    for (const record of scanFixedElements()) {
      if (this.#known.has(record.element)) continue;
      this.#known.add(record.element);
      this.#records.push({ ...record, coveredBySelection: false, naturalTop: null });
    }
  }

  applyFrame(frameY, isFirstFrame) {
    for (const record of this.#records) {
      const visible = frameVisibility(record, frameY, isFirstFrame, this.#target.viewportHeight);
      record.element.style.visibility = visible ? record.previousVisibility : 'hidden';
    }
  }

  restore() {
    for (const record of this.#records) {
      record.element.style.visibility = record.previousVisibility;
    }
  }
}
