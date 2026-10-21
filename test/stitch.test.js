'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../content/stitch.js');

// --- planFrames ---
test('planFrames: 短页面单帧不滚动', () => {
  assert.deepEqual(S.planFrames(800, 1000), [0]);
  assert.deepEqual(S.planFrames(1000, 1000), [0]);
});

test('planFrames: 整除不产生重复帧', () => {
  assert.deepEqual(S.planFrames(3000, 1000), [0, 1000, 2000]);
});

test('planFrames: 非整除底对齐', () => {
  assert.deepEqual(S.planFrames(3200, 1000), [0, 1000, 2000, 2200]);
  assert.deepEqual(S.planFrames(1001, 1000), [0, 1]);
});

test('planFrames: 非法输入抛错', () => {
  assert.throws(() => S.planFrames(0, 1000));
  assert.throws(() => S.planFrames(1000, 0));
});

// --- frameSlice ---
test('frameSlice: 完整帧落在 part 内', () => {
  assert.deepEqual(S.frameSlice(1000, 1000, 3200, 0, 2000), { sy: 0, sh: 1000, dy: 1000 });
});

test('frameSlice: 与 part 不重叠返回 null', () => {
  assert.equal(S.frameSlice(2200, 1000, 3200, 0, 2000), null);
});

test('frameSlice: 帧顶在 part 上方时顶裁剪', () => {
  assert.deepEqual(S.frameSlice(0, 1000, 5000, 500, 1000), { sy: 500, sh: 500, dy: 0 });
});

test('frameSlice: 帧底超 part 底时底裁剪', () => {
  assert.deepEqual(S.frameSlice(1000, 1000, 5000, 0, 1500), { sy: 0, sh: 500, dy: 1000 });
});

// --- assignParts ---
test('assignParts: 高度足够时单 part', () => {
  const parts = S.assignParts([0, 1000, 2000], 1000, 3000, 1, 16384);
  assert.deepEqual(parts, [{ srcY: 0, height: 3000, frameStart: 0, frameEnd: 3 }]);
});

test('assignParts: 沿帧边界拆分', () => {
  const parts = S.assignParts([0, 1000, 2000, 3000], 1000, 4000, 1, 2500);
  assert.deepEqual(parts, [
    { srcY: 0, height: 2000, frameStart: 0, frameEnd: 2 },
    { srcY: 2000, height: 2000, frameStart: 2, frameEnd: 4 },
  ]);
});

test('assignParts: 末帧重叠时 part 连续、无内容重复或缺失', () => {
  const frames = S.planFrames(3200, 1000); // [0, 1000, 2000, 2200]
  const parts = S.assignParts(frames, 1000, 3200, 1, 2100);
  assert.deepEqual(parts, [
    { srcY: 0, height: 2000, frameStart: 0, frameEnd: 2 },
    { srcY: 2000, height: 1200, frameStart: 2, frameEnd: 4 },
  ]);
  // 不变式：part 首尾相接且恰好覆盖 [0, contentHeight)
  let y = 0;
  for (const p of parts) {
    assert.equal(p.srcY, y);
    y += p.height;
  }
  assert.equal(y, 3200);
});

test('assignParts: 单帧高度超上限抛错而非死循环', () => {
  assert.throws(() => S.assignParts([0], 20000, 40000, 1, 16384), /超过 part 上限/);
});

// --- cropRect ---
test('cropRect: dpr 换算与取整', () => {
  assert.deepEqual(S.cropRect(100, 300, 1280, 2), { sx: 200, sw: 600 });
});

test('cropRect: 非整数 dpr 产出整数像素', () => {
  const r = S.cropRect(10.5, 100.3, 1280, 1.5);
  assert.equal(r.sx, Math.round(10.5 * 1.5));
  assert.ok(Number.isInteger(r.sx));
  assert.ok(Number.isInteger(r.sw));
});

test('cropRect: 越界 clamp 到视口', () => {
  assert.deepEqual(S.cropRect(1200, 500, 1280, 1), { sx: 1200, sw: 80 });
  assert.deepEqual(S.cropRect(-50, 200, 1280, 1), { sx: 0, sw: 150 });
});

// --- fitScale ---
test('fitScale: 限内不缩放，超限按最长边', () => {
  assert.equal(S.fitScale(1000, 5000, 16384), 1);
  assert.equal(S.fitScale(1000, 32768, 16384), 0.5);
});

// --- pickScrollTarget ---
test('pickScrollTarget: 返回最深的可滚动容器', () => {
  const inner = { name: 'inner' };
  const got = S.pickScrollTarget([
    { el: { name: 'leaf' }, scrollHeight: 100, clientHeight: 100 },
    { el: inner, scrollHeight: 2000, clientHeight: 400 },
    { el: { name: 'outer' }, scrollHeight: 9000, clientHeight: 800 },
  ]);
  assert.equal(got, inner);
});

test('pickScrollTarget: 余量内不算可滚动；全不可滚动返回 null', () => {
  assert.equal(S.pickScrollTarget([{ el: {}, scrollHeight: 405, clientHeight: 400 }]), null);
  assert.equal(S.pickScrollTarget([]), null);
});

// --- containerVisibility ---
test('containerVisibility: 完整可见 → ok', () => {
  assert.equal(S.containerVisibility(100, 360, 900), 'ok');
  assert.equal(S.containerVisibility(0, 900, 900), 'ok'); // 恰好占满视口（全屏面板）
});

test('containerVisibility: 被裁但高度可容纳 → align', () => {
  assert.equal(S.containerVisibility(-50, 360, 900), 'align'); // 顶部在视口上方
  assert.equal(S.containerVisibility(800, 360, 900), 'align'); // 底部在视口下方
});

test('containerVisibility: 高于视口 → unsupported', () => {
  assert.equal(S.containerVisibility(100, 1200, 900), 'unsupported');
  assert.equal(S.containerVisibility(-100, 1200, 900), 'unsupported');
});

// --- selectionStartY ---
test('selectionStartY: 视口坐标换算为内容坐标', () => {
  // window：已滚动 2000，选区顶在视口 y=300 → 内容坐标 2300（frameOriginY = -2000）
  assert.equal(S.selectionStartY(300, -2000), 2300);
  // 容器：内容盒顶在视口 y=100，容器 scrollTop=500，选区顶在视口 y=150 → 内容坐标 550
  assert.equal(S.selectionStartY(150, 100 - 500), 550);
});

test('selectionStartY: 选区顶在内容起点之上时按 0 计', () => {
  assert.equal(S.selectionStartY(50, 100), 0);
});

// --- stickyVisible ---
test('stickyVisible: 未吸顶时可见，吸顶后隐藏', () => {
  assert.equal(S.stickyVisible(0, 260, 0), true);   // 页首帧，元素在自然位置
  assert.equal(S.stickyVisible(260, 260, 0), true); // 恰好到达边界仍算自然位置
  assert.equal(S.stickyVisible(261, 260, 0), false); // 已吸顶
});

test('stickyVisible: 计入 cssTop 偏移', () => {
  // top: 10px 的 sticky 在 scrollTop > naturalTop - 10 时吸顶
  assert.equal(S.stickyVisible(250, 260, 10), true);
  assert.equal(S.stickyVisible(251, 260, 10), false);
});

// --- rectsOverlap ---
test('rectsOverlap: 相交判定', () => {
  const sel = { left: 10, right: 50, top: 20, bottom: 80 };
  assert.equal(S.rectsOverlap({ left: 0, right: 100, top: 0, bottom: 40 }, sel), true);   // 选区覆盖顶部条
  assert.equal(S.rectsOverlap({ left: 0, right: 100, top: 0, bottom: 20 }, sel), false);  // 选区顶边恰好相接，不算相交
  assert.equal(S.rectsOverlap({ left: 0, right: 100, top: 0, bottom: 10 }, sel), false);  // 选区在其下方
  assert.equal(S.rectsOverlap({ left: 60, right: 100, top: 30, bottom: 60 }, sel), false); // 横向不相交
});

// --- stickyIsContent ---
test('stickyIsContent: 超过半视口高的 sticky 是内容，永不隐藏', () => {
  assert.equal(S.stickyIsContent(900, 900), true);   // 100vh 滚动叙事容器
  assert.equal(S.stickyIsContent(451, 900), true);   // 恰好越过一半
  assert.equal(S.stickyIsContent(450, 900), false);  // 恰好一半仍算 chrome
  assert.equal(S.stickyIsContent(40, 900), false);   // 导航栏
});

// --- visualRect ---
// GitHub blob 工具栏模式：h:0 的 sticky 包装 + absolute 子元素渲染可见内容。
// 这类元素自身零面积，收集与选区相交判定都必须用"视觉矩形"，否则漏管（每帧吸附重复）
// 或误判 inSelection（框选覆盖却被当未覆盖）。
test('visualRect: 自身有面积时用自身矩形', () => {
  const own = { left: 0, right: 100, top: 0, bottom: 50 };
  assert.deepEqual(S.visualRect(own, []), own);
});
test('visualRect: 零面积时取可见后代的包围盒', () => {
  const own = { left: 100, right: 1172, top: 0, bottom: 0 }; // h:0 sticky 包装
  const child = { left: 100, right: 1172, top: 0, bottom: 90 }; // absolute 子元素
  assert.deepEqual(S.visualRect(own, [child]), child);
});
test('visualRect: 多个后代取并集', () => {
  const own = { left: 0, right: 0, top: 0, bottom: 0 };
  const kids = [
    { left: 10, right: 60, top: 0, bottom: 30 },
    { left: 50, right: 120, top: 20, bottom: 80 },
  ];
  assert.deepEqual(S.visualRect(own, kids), { left: 10, right: 120, top: 0, bottom: 80 });
});
test('visualRect: 零面积且无可见后代 → null（不收集）', () => {
  assert.equal(S.visualRect({ left: 5, right: 5, top: 5, bottom: 5 }, []), null);
  assert.equal(S.visualRect({ left: 5, right: 5, top: 5, bottom: 5 }, null), null);
});
