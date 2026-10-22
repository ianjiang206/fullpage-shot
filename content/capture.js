// Capture flow: a CaptureSession drives one capture end-to-end — scroll
// preparation, warm-up, frame planning, the per-frame loop, and scene
// restoration (main spec §5). Geometry comes from geometry.js; DOM concerns
// from scroll-target.js / fixed-elements.js.
import * as geometry from './geometry.js';
import { MSG } from '../shared/protocol.js';
import { ScrollTarget } from './scroll-target.js';
import { FixedElementManager } from './fixed-elements.js';

const FRAME_MIN_INTERVAL = 520; // captureVisibleTab is rate-limited to 2/sec; leave headroom
const LAZY_WAIT = 300;          // per-frame allowance for lazy-loaded content
const MAX_RETRIES = 3;
const WARMUP_STEP_MS = 150;     // warm-up dwell per screen
const WARMUP_FINAL_MS = 300;    // warm-up dwell at the content end

/** @typedef {{x:number, y:number, width:number, height:number, fromTop?:boolean}} Selection */
/** @typedef {{canvas: HTMLCanvasElement, startY: number, cssHeight: number}} CapturePart */
/** @typedef {{parts: CapturePart[], width: number, totalHeight: number, dpr: number}} CaptureResult */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CaptureSession {
  #selection;
  #onProgress;
  #onStatus;
  #aborted = false;
  #lastCaptureAt = 0;
  #escListener = null;

  // scene state (prepareScene → restoreScene)
  #target = null;
  #fixed = null;
  #initialTop = 0;
  #initialWindowX = 0;
  #initialWindowY = 0;
  #restoreScrollBehavior = null;

  // plan state (set by #plan)
  #viewportHeight = 0;
  #startY = 0;
  #captureHeight = 0;
  #frames = [];

  /**
   * @param {Selection} selection
   * @param {{onProgress?: (index:number, total:number) => void, onStatus?: (text:string) => void}} callbacks
   */
  constructor(selection, { onProgress, onStatus } = {}) {
    this.#selection = selection;
    this.#onProgress = onProgress;
    this.#onStatus = onStatus;
  }

  cancel() {
    this.#aborted = true;
  }

  /** @returns {Promise<CaptureResult>} */
  async run() {
    this.#escListener = (event) => { if (event.key === 'Escape') this.cancel(); };
    document.addEventListener('keydown', this.#escListener, true);
    try {
      this.#prepareScene();
      await this.#warmUp();
      this.#throwIfAborted();
      this.#target.ensureFullyVisible();
      this.#plan();
      return await this.#captureFrames();
    } finally {
      this.#restoreScene();
    }
  }

  #throwIfAborted() {
    if (this.#aborted) throw new Error('aborted');
  }

  #prepareScene() {
    const selection = this.#selection;
    this.#target = ScrollTarget.resolve(selection);
    this.#initialTop = this.#target.top;
    this.#initialWindowX = window.scrollX;
    this.#initialWindowY = window.scrollY;
    // Disable smooth scrolling so scrollTo animations cannot disturb alignment; restored afterwards
    this.#restoreScrollBehavior = this.#target.saveScrollBehavior();
    // Selection coverage is judged at selection time (viewport coordinates; the
    // page has not scrolled yet) — fixed/stuck elements keep the same visual
    // position at any scroll offset, so the check holds for the whole capture.
    this.#fixed = new FixedElementManager(this.#target, {
      left: selection.x,
      right: selection.x + selection.width,
      top: selection.y,
      bottom: selection.y + selection.height,
    });
    this.#fixed.collect();
  }

  // Warm-up: scroll through once before real frame capture to trigger lazy
  // images/iframes and one-shot scroll reveal animations, then return —
  // content is ready when frames are captured.
  async #warmUp() {
    const maxScroll = Math.max(0, this.#target.contentHeight - this.#target.viewportHeight);
    if (maxScroll <= 0) return;
    if (this.#onStatus) this.#onStatus('预热');
    for (let y = 0; y < maxScroll; y += this.#target.viewportHeight) {
      if (this.#aborted) return;
      this.#target.setTop(y);
      await sleep(WARMUP_STEP_MS);
    }
    this.#target.setTop(maxScroll);
    await sleep(WARMUP_FINAL_MS);
    this.#target.setTop(this.#initialTop);
    await this.#target.settle();
  }

  #plan() {
    // All frame-planning / part-splitting / slicing geometry happens in capture
    // coordinates (0 = the selection's top edge in content coordinates, startY);
    // scrolling translates back via setTop(frame + startY). 「截取整页」 carries
    // fromTop and starts at 0.
    this.#viewportHeight = this.#target.viewportHeight;
    const contentHeight = this.#target.contentHeight;
    this.#startY = this.#selection.fromTop ? 0
      : geometry.selectionStartY(this.#selection.y, this.#target.captureOriginY());
    if (this.#startY >= contentHeight) {
      throw new Error('选区起点已在内容末尾之后，请重新框选');
    }
    this.#captureHeight = contentHeight - this.#startY;
    this.#frames = geometry.planFrames(this.#captureHeight, this.#viewportHeight);
    this.#fixed.measureNaturalTops();
  }

  async #captureFrames() {
    let dpr = null, parts = null, canvases = null, column = null;
    for (let i = 0; i < this.#frames.length; i++) {
      this.#throwIfAborted();
      if (this.#onProgress) this.#onProgress(i + 1, this.#frames.length);

      const frameTop = this.#frames[i] + this.#startY; // content coordinates
      this.#target.setTop(frameTop);
      await this.#target.settle();
      // Popup sweep: fixed/sticky elements that appear mid-capture join the
      // managed set as not-covered (hidden throughout). A full rescan per frame
      // has a cost, but the ≥520ms frame budget easily covers it.
      this.#fixed.sweep();
      // WYSIWYG visibility per element (pure decision in geometry.frameVisibility)
      this.#fixed.applyFrame(frameTop, i === 0);
      await sleep(LAZY_WAIT);
      const bitmap = await this.#requestBitmap();

      if (dpr === null) ({ dpr, parts, canvases, column } = this.#initStitching(bitmap));
      this.#drawFrame(bitmap, i, parts, canvases, column, dpr);
    }
    return {
      parts: parts.map((part, index) => ({ canvas: canvases[index], startY: part.y, cssHeight: part.height })),
      width: column.width,
      totalHeight: Math.round(this.#captureHeight * dpr),
      dpr,
    };
  }

  // First-frame-only setup: dpr measured from the image (img.width = innerWidth
  // × real dpr, including page zoom — never window.devicePixelRatio), the part
  // split along frame boundaries, the crop column, and the canvases.
  #initStitching(firstBitmap) {
    const dpr = firstBitmap.width / window.innerWidth;
    const parts = geometry.splitIntoParts(this.#frames, this.#viewportHeight, this.#captureHeight, dpr);
    const column = geometry.cropColumn(this.#selection.x, this.#selection.width, window.innerWidth, dpr);
    if (column.width <= 0) throw new Error('裁剪列宽度为 0，请重新框选');
    const canvases = parts.map((part) => {
      const canvas = document.createElement('canvas');
      canvas.width = column.width;
      canvas.height = Math.round(part.height * dpr);
      return canvas;
    });
    return { dpr, parts, canvases, column };
  }

  #drawFrame(bitmap, frameIndex, parts, canvases, column, dpr) {
    for (let p = 0; p < parts.length; p++) {
      const part = parts[p];
      if (frameIndex < part.frameStart || frameIndex >= part.frameEnd) continue;
      const slice = geometry.framePartIntersection(
        this.#frames[frameIndex], this.#viewportHeight, this.#captureHeight, part.y, part.height);
      if (!slice) continue;
      canvases[p].getContext('2d').drawImage(
        bitmap,
        column.x, Math.round((this.#target.contentBoxTop() + slice.frameOffsetY) * dpr),
        column.width, Math.round(slice.height * dpr),
        0, Math.round(slice.partOffsetY * dpr),
        column.width, Math.round(slice.height * dpr),
      );
    }
  }

  // Paced (≥FRAME_MIN_INTERVAL between shots) screenshot request with
  // rate-limit backoff retries, returned as a decoded bitmap.
  async #requestBitmap() {
    const wait = FRAME_MIN_INTERVAL - (Date.now() - this.#lastCaptureAt);
    if (wait > 0) await sleep(wait);
    let lastError = 'empty response';
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      this.#lastCaptureAt = Date.now();
      const resp = await chrome.runtime.sendMessage({ type: MSG.CAPTURE });
      if (resp && resp.dataUrl) {
        const blob = await (await fetch(resp.dataUrl)).blob();
        return createImageBitmap(blob);
      }
      lastError = (resp && resp.error) || lastError;
      if (!/MAX_CAPTURE_VISIBLE_TAB|too many/i.test(lastError)) throw new Error(lastError);
      await sleep(600); // rate-limit error: back off, then retry
    }
    throw new Error('captureVisibleTab rate limit persists: ' + lastError);
  }

  // Runs on success, failure, and Esc-cancel alike (main spec §5.5).
  #restoreScene() {
    document.removeEventListener('keydown', this.#escListener, true);
    if (this.#target) this.#target.setTop(this.#initialTop);
    window.scrollTo(this.#initialWindowX, this.#initialWindowY);
    if (this.#fixed) this.#fixed.restore();
    if (this.#restoreScrollBehavior) this.#restoreScrollBehavior();
  }
}
