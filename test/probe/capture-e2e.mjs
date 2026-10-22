// Drives a real CaptureSession end-to-end on the fixture page: per-frame
// screenshot requests are bridged to Page.captureScreenshot via a CDP binding.
// Checks the result shape, the progress sequence (warm-up first), and scene
// restoration — including the mid-warm-up Esc-cancel path.
import assert from 'node:assert/strict';
import { startServer, launchChrome, CdpPage, i18nStubSource } from './cdp.mjs';

const server = await startServer();
const chrome = await launchChrome();
try {
  const page = await CdpPage.open('http://127.0.0.1:8931/test/fixtures/long-page.html');
  await page.exposeFunction('__cdpScreenshot', () => page.screenshotDataUrl());

  const report = await page.evaluate(`(async () => {
    window.chrome = {
      i18n: ${i18nStubSource},
      runtime: {
        getURL: (p) => '/' + p,
        onMessage: { addListener: () => {} },
        sendMessage: (msg) => msg.type === 'fps:capture'
          ? window.__cdpScreenshot().then((dataUrl) => ({ dataUrl }))
          : Promise.resolve({}),
      },
    };
    const { CaptureSession } = await import('/content/capture.js');
    const progress = [];
    const session = new CaptureSession(
      { x: 240, y: 0, width: innerWidth - 240, height: innerHeight, fromTop: true },
      { onProgress: (i, n) => progress.push(i + '/' + n), onStatus: (text) => progress.push(text) },
    );
    const result = await session.run();
    return {
      width: result.width,
      totalHeight: result.totalHeight,
      dpr: result.dpr,
      parts: result.parts.length,
      partCanvasHeights: result.parts.map((p) => p.canvas.height),
      progress,
      scrollRestored: window.scrollY === 0,
    };
  })()`);

  assert.equal(report.dpr, 1, 'headless dpr is 1');
  assert.equal(report.width, 800 - 240, 'crop column excludes the 240px sidebar');
  assert.ok(report.totalHeight > 3000, 'content height is stitched in full');
  assert.equal(report.parts, 1, 'fixture content fits in a single part');
  assert.equal(report.partCanvasHeights[0], report.totalHeight);
  assert.equal(report.progress[0], '预热', 'warm-up status reported first');
  assert.equal(report.progress[1], '1/' + (report.progress.length - 1), 'frames counted 1..n');
  assert.equal(report.scrollRestored, true, 'scroll position restored');
  console.log('capture e2e probe OK (run)', { width: report.width, totalHeight: report.totalHeight, frames: report.progress.length - 1 });

  // Mid-warm-up cancel: run() rejects with 'aborted' and the scene restores.
  const cancelReport = await page.evaluate(`(async () => {
    const { CaptureSession } = await import('/content/capture.js');
    const session = new CaptureSession(
      { x: 240, y: 0, width: innerWidth - 240, height: innerHeight, fromTop: true }, {});
    const run = session.run();
    setTimeout(() => session.cancel(), 300); // during the warm-up pass
    const outcome = await run.then(() => 'resolved').catch((e) => 'thrown:' + e.message);
    return { outcome, scrollRestored: window.scrollY === 0 };
  })()`);
  assert.equal(cancelReport.outcome, 'thrown:aborted');
  assert.equal(cancelReport.scrollRestored, true);
  console.log('capture e2e probe OK (cancel)');
} finally {
  chrome.kill();
  server.close();
}
