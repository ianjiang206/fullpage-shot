// A ScrollTarget abstracts the scrollable surface being captured — the window
// or an inner scroll container — so capture code never branches on isWindow.
import { firstScrollable, containerVisibility } from './geometry.js';

const SETTLE_TIMEOUT = 2000;
const SETTLE_POLL = 50;

export class ScrollTarget {
  // Resolve the scroll target under the selection's center point: walk up
  // from elementFromPoint to the nearest scrollable ancestor; null → window.
  static resolve(selection) {
    const chain = [];
    let element = document.elementFromPoint(
      selection.x + selection.width / 2, selection.y + selection.height / 2);
    while (element && element !== document.documentElement && element !== document.body) {
      chain.push({ element, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight });
      element = element.parentElement;
    }
    const container = firstScrollable(chain);
    return container ? new ContainerScrollTarget(container) : new WindowScrollTarget();
  }

  // The viewport y of the target's content-box top edge (window: 0; for a
  // container this is only used after ensureFullyVisible, so it is ≥ 0).
  contentBoxTop() {
    return 0;
  }

  // The viewport y of content coordinate 0 (selectionStartY's frameOriginY).
  captureOriginY() {
    return this.contentBoxTop() - this.top;
  }

  // Whether el belongs to this target's scrollable content (window: everything).
  contains(element) {
    return true;
  }

  // No-op for the window; containers override with align-or-error.
  ensureFullyVisible() {}

  // Elements whose inline scroll-behavior participates in smooth scrolling.
  scrollElements() {
    return [document.documentElement];
  }

  // Disable smooth scrolling so scrollTo animations cannot disturb alignment;
  // returns a closure restoring the original inline values.
  saveScrollBehavior() {
    const elements = this.scrollElements();
    const saved = elements.map((element) => [element, element.style.scrollBehavior]);
    for (const element of elements) element.style.scrollBehavior = 'auto';
    return () => {
      for (const [element, previous] of saved) element.style.scrollBehavior = previous;
    };
  }

  // Poll scrollTop until it stays unchanged for 100ms (with a timeout fallback).
  settle() {
    return new Promise((resolve) => {
      let last = this.top;
      let stableReads = 0;
      const startedAt = Date.now();
      const timer = setInterval(() => {
        const now = this.top;
        if (now === last) {
          if (++stableReads >= 2) { clearInterval(timer); resolve(); }
        } else {
          last = now;
          stableReads = 0;
        }
        if (Date.now() - startedAt > SETTLE_TIMEOUT) { clearInterval(timer); resolve(); }
      }, SETTLE_POLL);
    });
  }
}

export class WindowScrollTarget extends ScrollTarget {
  constructor() {
    super();
    this.element = document.scrollingElement || document.documentElement;
  }

  get top() { return this.element.scrollTop; }
  setTop(value) { this.element.scrollTop = value; }
  get viewportHeight() { return window.innerHeight; }
  get contentHeight() { return this.element.scrollHeight; }
}

export class ContainerScrollTarget extends ScrollTarget {
  constructor(element) {
    super();
    this.element = element;
  }

  get top() { return this.element.scrollTop; }
  setTop(value) { this.element.scrollTop = value; }
  get viewportHeight() { return this.element.clientHeight; }
  get contentHeight() { return this.element.scrollHeight; }

  // Container content box = border box + clientTop (border width).
  contentBoxTop() {
    return this.element.getBoundingClientRect().top + this.element.clientTop;
  }

  contains(element) {
    return this.element.contains(element);
  }

  scrollElements() {
    return [document.documentElement, this.element];
  }

  // Frame planning and frame capture only agree when the container's content
  // box is fully visible in the viewport: top-align it via window scroll, or
  // report a clear error when it is taller than the viewport (no silent
  // misalignment — suggest 「截取整页」 instead).
  ensureFullyVisible() {
    const contentTop = () => this.element.getBoundingClientRect().top + this.element.clientTop;
    let visibility = containerVisibility(contentTop(), this.element.clientHeight, window.innerHeight);
    if (visibility === 'align') {
      window.scrollBy(0, contentTop());
      visibility = containerVisibility(contentTop(), this.element.clientHeight, window.innerHeight);
    }
    if (visibility !== 'ok') {
      throw new Error('内部滚动容器高于视口，暂不支持完整截取；请改用「截取整页」');
    }
  }
}
