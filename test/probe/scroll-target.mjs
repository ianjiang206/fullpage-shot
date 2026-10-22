// On the fixture page: resolving inside the inner scroll container yields a
// ContainerScrollTarget for that element; resolving in the plain content
// column yields a WindowScrollTarget. Also checks saveScrollBehavior restore.
import assert from 'node:assert/strict';
import { startServer, launchChrome, CdpPage } from './cdp.mjs';

const server = await startServer();
const chrome = await launchChrome();
try {
  const page = await CdpPage.open('http://127.0.0.1:8931/test/fixtures/long-page.html');
  const report = await page.evaluate(`(async () => {
    window.chrome = { runtime: { getURL: (p) => '/' + p, onMessage: { addListener: () => {} }, sendMessage: async () => ({}) } };
    const { ScrollTarget } = await import('/content/scroll-target.js');
    const inner = document.getElementById('inner');
    window.scrollTo(0, inner.offsetTop - 120); // the container sits below the fold
    const rect = inner.getBoundingClientRect();
    const inside = ScrollTarget.resolve({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: 10, height: 10 });
    const outside = ScrollTarget.resolve({ x: innerWidth * 0.6, y: Math.max(10, rect.top - 60), width: 10, height: 10 });
    const restore = inside.saveScrollBehavior();
    const smoothOff = inside.element.style.scrollBehavior === 'auto';
    restore();
    const smoothBack = inside.element.style.scrollBehavior === '';
    return {
      insideType: inside.constructor.name,
      insideIsInner: inside.element === inner,
      insideViewportHeight: inside.viewportHeight === inner.clientHeight,
      outsideType: outside.constructor.name,
      outsideViewportHeight: outside.viewportHeight === innerHeight,
      outsideIsWindowScrolling: outside.element === (document.scrollingElement || document.documentElement),
      smoothOff, smoothBack,
    };
  })()`);
  assert.equal(report.insideType, 'ContainerScrollTarget');
  assert.equal(report.insideIsInner, true);
  assert.equal(report.insideViewportHeight, true);
  assert.equal(report.outsideType, 'WindowScrollTarget');
  assert.equal(report.outsideViewportHeight, true);
  assert.equal(report.outsideIsWindowScrolling, true);
  assert.equal(report.smoothOff, true);
  assert.equal(report.smoothBack, true);
  console.log('scroll-target probe OK');
} finally {
  chrome.kill();
  server.close();
}
