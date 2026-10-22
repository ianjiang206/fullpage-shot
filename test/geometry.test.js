import test from 'node:test';
import assert from 'node:assert/strict';
import * as geometry from '../content/geometry.js';

// --- planFrames ---
test('planFrames: short page yields a single frame, no scrolling', () => {
  assert.deepEqual(geometry.planFrames(800, 1000), [0]);
  assert.deepEqual(geometry.planFrames(1000, 1000), [0]);
});

test('planFrames: exact division produces no duplicate frames', () => {
  assert.deepEqual(geometry.planFrames(3000, 1000), [0, 1000, 2000]);
});

test('planFrames: non-divisible heights bottom-align the last frame', () => {
  assert.deepEqual(geometry.planFrames(3200, 1000), [0, 1000, 2000, 2200]);
  assert.deepEqual(geometry.planFrames(1001, 1000), [0, 1]);
});

test('planFrames: invalid input throws', () => {
  assert.throws(() => geometry.planFrames(0, 1000));
  assert.throws(() => geometry.planFrames(1000, 0));
});

// --- framePartIntersection ---
test('framePartIntersection: full frame inside a part', () => {
  assert.deepEqual(geometry.framePartIntersection(1000, 1000, 3200, 0, 2000),
    { frameOffsetY: 0, height: 1000, partOffsetY: 1000 });
});

test('framePartIntersection: no overlap with part returns null', () => {
  assert.equal(geometry.framePartIntersection(2200, 1000, 3200, 0, 2000), null);
});

test('framePartIntersection: frame top above part is top-clipped', () => {
  assert.deepEqual(geometry.framePartIntersection(0, 1000, 5000, 500, 1000),
    { frameOffsetY: 500, height: 500, partOffsetY: 0 });
});

test('framePartIntersection: frame bottom past part bottom is bottom-clipped', () => {
  assert.deepEqual(geometry.framePartIntersection(1000, 1000, 5000, 0, 1500),
    { frameOffsetY: 0, height: 500, partOffsetY: 1000 });
});

// --- splitIntoParts ---
test('splitIntoParts: single part when height fits', () => {
  const parts = geometry.splitIntoParts([0, 1000, 2000], 1000, 3000, 1);
  assert.deepEqual(parts, [{ y: 0, height: 3000, frameStart: 0, frameEnd: 3 }]);
});

test('splitIntoParts: splits along frame boundaries', () => {
  const parts = geometry.splitIntoParts([0, 1000, 2000, 3000], 1000, 4000, 1, 2500);
  assert.deepEqual(parts, [
    { y: 0, height: 2000, frameStart: 0, frameEnd: 2 },
    { y: 2000, height: 2000, frameStart: 2, frameEnd: 4 },
  ]);
});

test('splitIntoParts: with an overlapping last frame, parts stay contiguous with no duplicated or missing content', () => {
  const frames = geometry.planFrames(3200, 1000); // [0, 1000, 2000, 2200]
  const parts = geometry.splitIntoParts(frames, 1000, 3200, 1, 2100);
  assert.deepEqual(parts, [
    { y: 0, height: 2000, frameStart: 0, frameEnd: 2 },
    { y: 2000, height: 1200, frameStart: 2, frameEnd: 4 },
  ]);
  // invariant: parts join end-to-end and cover exactly [0, contentHeight)
  let y = 0;
  for (const p of parts) {
    assert.equal(p.y, y);
    y += p.height;
  }
  assert.equal(y, 3200);
});

test('splitIntoParts: a single frame taller than the limit throws instead of looping forever', () => {
  assert.throws(() => geometry.splitIntoParts([0], 20000, 40000, 1, 16384), /exceeds part limit/);
});

// --- cropColumn ---
test('cropColumn: dpr conversion and rounding', () => {
  assert.deepEqual(geometry.cropColumn(100, 300, 1280, 2), { x: 200, width: 600 });
});

test('cropColumn: fractional dpr still yields integer pixels', () => {
  const r = geometry.cropColumn(10.5, 100.3, 1280, 1.5);
  assert.equal(r.x, Math.round(10.5 * 1.5));
  assert.ok(Number.isInteger(r.x));
  assert.ok(Number.isInteger(r.width));
});

test('cropColumn: out-of-range values clamp to the viewport', () => {
  assert.deepEqual(geometry.cropColumn(1200, 500, 1280, 1), { x: 1200, width: 80 });
  assert.deepEqual(geometry.cropColumn(-50, 200, 1280, 1), { x: 0, width: 150 });
});

// --- fitScale ---
test('fitScale: no scaling within the limit; over the limit scales by the longest edge', () => {
  assert.equal(geometry.fitScale(1000, 5000, 16384), 1);
  assert.equal(geometry.fitScale(1000, 32768, 16384), 0.5);
});

test('fitScale: maxEdge defaults to MAX_CANVAS_EDGE', () => {
  assert.equal(geometry.fitScale(1000, 5000), 1);
  assert.equal(geometry.fitScale(1000, 32768), 0.5);
});

// --- firstScrollable ---
test('firstScrollable: returns the deepest scrollable container', () => {
  const inner = { name: 'inner' };
  const got = geometry.firstScrollable([
    { element: { name: 'leaf' }, scrollHeight: 100, clientHeight: 100 },
    { element: inner, scrollHeight: 2000, clientHeight: 400 },
    { element: { name: 'outer' }, scrollHeight: 9000, clientHeight: 800 },
  ]);
  assert.equal(got, inner);
});

test('firstScrollable: within the tolerance is not scrollable; null when nothing scrolls', () => {
  assert.equal(geometry.firstScrollable([{ element: {}, scrollHeight: 405, clientHeight: 400 }]), null);
  assert.equal(geometry.firstScrollable([]), null);
});

// --- containerVisibility ---
test('containerVisibility: fully visible → ok', () => {
  assert.equal(geometry.containerVisibility(100, 360, 900), 'ok');
  assert.equal(geometry.containerVisibility(0, 900, 900), 'ok'); // exactly fills the viewport (fullscreen panel)
});

test('containerVisibility: clipped but fits → align', () => {
  assert.equal(geometry.containerVisibility(-50, 360, 900), 'align'); // top above the viewport
  assert.equal(geometry.containerVisibility(800, 360, 900), 'align'); // bottom below the viewport
});

test('containerVisibility: taller than the viewport → unsupported', () => {
  assert.equal(geometry.containerVisibility(100, 1200, 900), 'unsupported');
  assert.equal(geometry.containerVisibility(-100, 1200, 900), 'unsupported');
});

// --- selectionStartY ---
test('selectionStartY: viewport coordinates map to content coordinates', () => {
  // window: scrolled 2000, selection top at viewport y=300 → content y 2300 (frameOriginY = -2000)
  assert.equal(geometry.selectionStartY(300, -2000), 2300);
  // container: content-box top at viewport y=100, container scrollTop=500, selection top at y=150 → 550
  assert.equal(geometry.selectionStartY(150, 100 - 500), 550);
});

test('selectionStartY: selection top above the content start counts as 0', () => {
  assert.equal(geometry.selectionStartY(50, 100), 0);
});

// --- stickyAtNaturalPosition ---
test('stickyAtNaturalPosition: natural before sticking, not once stuck', () => {
  assert.equal(geometry.stickyAtNaturalPosition(0, 260, 0), true);   // top frame, element at natural position
  assert.equal(geometry.stickyAtNaturalPosition(260, 260, 0), true); // exactly at the boundary still counts as natural
  assert.equal(geometry.stickyAtNaturalPosition(261, 260, 0), false); // stuck
});

test('stickyAtNaturalPosition: accounts for the cssTop offset', () => {
  // a sticky with top: 10px sticks when scrollTop > naturalTop - 10
  assert.equal(geometry.stickyAtNaturalPosition(250, 260, 10), true);
  assert.equal(geometry.stickyAtNaturalPosition(251, 260, 10), false);
});

// --- rectsOverlap ---
test('rectsOverlap: intersection rules', () => {
  const sel = { left: 10, right: 50, top: 20, bottom: 80 };
  assert.equal(geometry.rectsOverlap({ left: 0, right: 100, top: 0, bottom: 40 }, sel), true);   // selection covers a top bar
  assert.equal(geometry.rectsOverlap({ left: 0, right: 100, top: 0, bottom: 20 }, sel), false);  // edges merely touching do not count
  assert.equal(geometry.rectsOverlap({ left: 0, right: 100, top: 0, bottom: 10 }, sel), false);  // above the selection
  assert.equal(geometry.rectsOverlap({ left: 60, right: 100, top: 30, bottom: 60 }, sel), false); // no horizontal overlap
});

// --- stickyIsContent ---
test('stickyIsContent: a sticky taller than half the viewport is content and is never hidden', () => {
  assert.equal(geometry.stickyIsContent(900, 900), true);   // 100vh scroll-jacking container
  assert.equal(geometry.stickyIsContent(451, 900), true);   // just past half
  assert.equal(geometry.stickyIsContent(450, 900), false);  // exactly half still counts as chrome
  assert.equal(geometry.stickyIsContent(40, 900), false);   // navbar
});

// --- visualRect ---
// GitHub blob toolbar pattern: an h:0 sticky wrapper whose visible content is
// rendered by an absolute-positioned child. Such elements have zero area of
// their own, so collection and selection-overlap checks must use the "visual
// rect" — otherwise they escape management (repeating every frame once stuck)
// or get misjudged for selection coverage.
test('visualRect: an element with area uses its own rect', () => {
  const own = { left: 0, right: 100, top: 0, bottom: 50 };
  assert.deepEqual(geometry.visualRect(own, []), own);
});
test('visualRect: zero area falls back to the bounding box of visible descendants', () => {
  const own = { left: 100, right: 1172, top: 0, bottom: 0 }; // h:0 sticky wrapper
  const child = { left: 100, right: 1172, top: 0, bottom: 90 }; // absolute child
  assert.deepEqual(geometry.visualRect(own, [child]), child);
});
test('visualRect: multiple descendants are unioned', () => {
  const own = { left: 0, right: 0, top: 0, bottom: 0 };
  const kids = [
    { left: 10, right: 60, top: 0, bottom: 30 },
    { left: 50, right: 120, top: 20, bottom: 80 },
  ];
  assert.deepEqual(geometry.visualRect(own, kids), { left: 10, right: 120, top: 0, bottom: 80 });
});
test('visualRect: zero area with no visible descendants → null (not collected)', () => {
  assert.equal(geometry.visualRect({ left: 5, right: 5, top: 5, bottom: 5 }, []), null);
  assert.equal(geometry.visualRect({ left: 5, right: 5, top: 5, bottom: 5 }, null), null);
});
