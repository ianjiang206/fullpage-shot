import test from 'node:test';
import assert from 'node:assert/strict';
// stitch.js is still UMD until Task 2; under node ESM the guarded `module`
// reference is skipped and the API lands on globalThis.
import '../content/stitch.js';
const S = globalThis.FpsStitch;

// --- planFrames ---
test('planFrames: short page yields a single frame, no scrolling', () => {
  assert.deepEqual(S.planFrames(800, 1000), [0]);
  assert.deepEqual(S.planFrames(1000, 1000), [0]);
});

test('planFrames: exact division produces no duplicate frames', () => {
  assert.deepEqual(S.planFrames(3000, 1000), [0, 1000, 2000]);
});

test('planFrames: non-divisible heights bottom-align the last frame', () => {
  assert.deepEqual(S.planFrames(3200, 1000), [0, 1000, 2000, 2200]);
  assert.deepEqual(S.planFrames(1001, 1000), [0, 1]);
});

test('planFrames: invalid input throws', () => {
  assert.throws(() => S.planFrames(0, 1000));
  assert.throws(() => S.planFrames(1000, 0));
});

// --- frameSlice ---
test('frameSlice: full frame inside a part', () => {
  assert.deepEqual(S.frameSlice(1000, 1000, 3200, 0, 2000), { sy: 0, sh: 1000, dy: 1000 });
});

test('frameSlice: no overlap with part returns null', () => {
  assert.equal(S.frameSlice(2200, 1000, 3200, 0, 2000), null);
});

test('frameSlice: frame top above part is top-clipped', () => {
  assert.deepEqual(S.frameSlice(0, 1000, 5000, 500, 1000), { sy: 500, sh: 500, dy: 0 });
});

test('frameSlice: frame bottom past part bottom is bottom-clipped', () => {
  assert.deepEqual(S.frameSlice(1000, 1000, 5000, 0, 1500), { sy: 0, sh: 500, dy: 1000 });
});

// --- assignParts ---
test('assignParts: single part when height fits', () => {
  const parts = S.assignParts([0, 1000, 2000], 1000, 3000, 1, 16384);
  assert.deepEqual(parts, [{ srcY: 0, height: 3000, frameStart: 0, frameEnd: 3 }]);
});

test('assignParts: splits along frame boundaries', () => {
  const parts = S.assignParts([0, 1000, 2000, 3000], 1000, 4000, 1, 2500);
  assert.deepEqual(parts, [
    { srcY: 0, height: 2000, frameStart: 0, frameEnd: 2 },
    { srcY: 2000, height: 2000, frameStart: 2, frameEnd: 4 },
  ]);
});

test('assignParts: with an overlapping last frame, parts stay contiguous with no duplicated or missing content', () => {
  const frames = S.planFrames(3200, 1000); // [0, 1000, 2000, 2200]
  const parts = S.assignParts(frames, 1000, 3200, 1, 2100);
  assert.deepEqual(parts, [
    { srcY: 0, height: 2000, frameStart: 0, frameEnd: 2 },
    { srcY: 2000, height: 1200, frameStart: 2, frameEnd: 4 },
  ]);
  // invariant: parts join end-to-end and cover exactly [0, contentHeight)
  let y = 0;
  for (const p of parts) {
    assert.equal(p.srcY, y);
    y += p.height;
  }
  assert.equal(y, 3200);
});

test('assignParts: a single frame taller than the limit throws instead of looping forever', () => {
  assert.throws(() => S.assignParts([0], 20000, 40000, 1, 16384), /exceeds part limit/);
});

// --- cropRect ---
test('cropRect: dpr conversion and rounding', () => {
  assert.deepEqual(S.cropRect(100, 300, 1280, 2), { sx: 200, sw: 600 });
});

test('cropRect: fractional dpr still yields integer pixels', () => {
  const r = S.cropRect(10.5, 100.3, 1280, 1.5);
  assert.equal(r.sx, Math.round(10.5 * 1.5));
  assert.ok(Number.isInteger(r.sx));
  assert.ok(Number.isInteger(r.sw));
});

test('cropRect: out-of-range values clamp to the viewport', () => {
  assert.deepEqual(S.cropRect(1200, 500, 1280, 1), { sx: 1200, sw: 80 });
  assert.deepEqual(S.cropRect(-50, 200, 1280, 1), { sx: 0, sw: 150 });
});

// --- fitScale ---
test('fitScale: no scaling within the limit; over the limit scales by the longest edge', () => {
  assert.equal(S.fitScale(1000, 5000, 16384), 1);
  assert.equal(S.fitScale(1000, 32768, 16384), 0.5);
});

// --- pickScrollTarget ---
test('pickScrollTarget: returns the deepest scrollable container', () => {
  const inner = { name: 'inner' };
  const got = S.pickScrollTarget([
    { el: { name: 'leaf' }, scrollHeight: 100, clientHeight: 100 },
    { el: inner, scrollHeight: 2000, clientHeight: 400 },
    { el: { name: 'outer' }, scrollHeight: 9000, clientHeight: 800 },
  ]);
  assert.equal(got, inner);
});

test('pickScrollTarget: within the tolerance is not scrollable; null when nothing scrolls', () => {
  assert.equal(S.pickScrollTarget([{ el: {}, scrollHeight: 405, clientHeight: 400 }]), null);
  assert.equal(S.pickScrollTarget([]), null);
});

// --- containerVisibility ---
test('containerVisibility: fully visible → ok', () => {
  assert.equal(S.containerVisibility(100, 360, 900), 'ok');
  assert.equal(S.containerVisibility(0, 900, 900), 'ok'); // exactly fills the viewport (fullscreen panel)
});

test('containerVisibility: clipped but fits → align', () => {
  assert.equal(S.containerVisibility(-50, 360, 900), 'align'); // top above the viewport
  assert.equal(S.containerVisibility(800, 360, 900), 'align'); // bottom below the viewport
});

test('containerVisibility: taller than the viewport → unsupported', () => {
  assert.equal(S.containerVisibility(100, 1200, 900), 'unsupported');
  assert.equal(S.containerVisibility(-100, 1200, 900), 'unsupported');
});

// --- selectionStartY ---
test('selectionStartY: viewport coordinates map to content coordinates', () => {
  // window: scrolled 2000, selection top at viewport y=300 → content y 2300 (frameOriginY = -2000)
  assert.equal(S.selectionStartY(300, -2000), 2300);
  // container: content-box top at viewport y=100, container scrollTop=500, selection top at y=150 → 550
  assert.equal(S.selectionStartY(150, 100 - 500), 550);
});

test('selectionStartY: selection top above the content start counts as 0', () => {
  assert.equal(S.selectionStartY(50, 100), 0);
});

// --- stickyVisible ---
test('stickyVisible: visible before sticking, hidden once stuck', () => {
  assert.equal(S.stickyVisible(0, 260, 0), true);   // top frame, element at natural position
  assert.equal(S.stickyVisible(260, 260, 0), true); // exactly at the boundary still counts as natural
  assert.equal(S.stickyVisible(261, 260, 0), false); // stuck
});

test('stickyVisible: accounts for the cssTop offset', () => {
  // a sticky with top: 10px sticks when scrollTop > naturalTop - 10
  assert.equal(S.stickyVisible(250, 260, 10), true);
  assert.equal(S.stickyVisible(251, 260, 10), false);
});

// --- rectsOverlap ---
test('rectsOverlap: intersection rules', () => {
  const sel = { left: 10, right: 50, top: 20, bottom: 80 };
  assert.equal(S.rectsOverlap({ left: 0, right: 100, top: 0, bottom: 40 }, sel), true);   // selection covers a top bar
  assert.equal(S.rectsOverlap({ left: 0, right: 100, top: 0, bottom: 20 }, sel), false);  // edges merely touching do not count
  assert.equal(S.rectsOverlap({ left: 0, right: 100, top: 0, bottom: 10 }, sel), false);  // above the selection
  assert.equal(S.rectsOverlap({ left: 60, right: 100, top: 30, bottom: 60 }, sel), false); // no horizontal overlap
});

// --- stickyIsContent ---
test('stickyIsContent: a sticky taller than half the viewport is content and is never hidden', () => {
  assert.equal(S.stickyIsContent(900, 900), true);   // 100vh scroll-jacking container
  assert.equal(S.stickyIsContent(451, 900), true);   // just past half
  assert.equal(S.stickyIsContent(450, 900), false);  // exactly half still counts as chrome
  assert.equal(S.stickyIsContent(40, 900), false);   // navbar
});

// --- visualRect ---
// GitHub blob toolbar pattern: an h:0 sticky wrapper whose visible content is
// rendered by an absolute-positioned child. Such elements have zero area of their
// own, so collection and selection-overlap checks must use the "visual rect" —
// otherwise they escape management (repeating every frame once stuck) or get
// misjudged for inSelection (covered by the selection but treated as not covered).
test('visualRect: an element with area uses its own rect', () => {
  const own = { left: 0, right: 100, top: 0, bottom: 50 };
  assert.deepEqual(S.visualRect(own, []), own);
});
test('visualRect: zero area falls back to the bounding box of visible descendants', () => {
  const own = { left: 100, right: 1172, top: 0, bottom: 0 }; // h:0 sticky wrapper
  const child = { left: 100, right: 1172, top: 0, bottom: 90 }; // absolute child
  assert.deepEqual(S.visualRect(own, [child]), child);
});
test('visualRect: multiple descendants are unioned', () => {
  const own = { left: 0, right: 0, top: 0, bottom: 0 };
  const kids = [
    { left: 10, right: 60, top: 0, bottom: 30 },
    { left: 50, right: 120, top: 20, bottom: 80 },
  ];
  assert.deepEqual(S.visualRect(own, kids), { left: 10, right: 120, top: 0, bottom: 80 });
});
test('visualRect: zero area with no visible descendants → null (not collected)', () => {
  assert.equal(S.visualRect({ left: 5, right: 5, top: 5, bottom: 5 }, []), null);
  assert.equal(S.visualRect({ left: 5, right: 5, top: 5, bottom: 5 }, null), null);
});
