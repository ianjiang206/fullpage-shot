// Loads the fixture page in headless Chrome, stubs chrome.*, imports the whole
// content module graph, and exercises collection + planning on the live page.
// Verifies: ESM graph links, exports exist, no window.Fps* globals remain, and
// the zero-area sticky shell is collected via its descendant bounding box.
import assert from 'node:assert/strict';
import { startServer, launchChrome, CdpPage } from './cdp.mjs';

const server = await startServer();
const chrome = await launchChrome();
try {
  const page = await CdpPage.open('http://127.0.0.1:8931/test/fixtures/long-page.html');
  const report = await page.evaluate(`(async () => {
    window.chrome = {
      runtime: {
        getURL: (p) => '/' + p,
        sendMessage: async () => ({}),
        onMessage: { addListener: () => {} },
      },
    };
    const geometry = await import('/content/geometry.js');
    const capture = await import('/content/capture.js');
    const { scanFixedElements } = await import('/content/fixed-elements.js');
    const { SelectionOverlay } = await import('/content/select.js');
    const { ResultOverlay, ErrorOverlay } = await import('/content/preview.js');
    await import('/content/main.js'); // registers its listener against the stub
    const fixed = scanFixedElements();
    const shell = fixed.find((record) => record.element.className === 'sticky-shell');
    return {
      frames: geometry.planFrames(3200, 1000),
      fixedCount: fixed.length,
      shellHasArea: !!shell && shell.visualRect.bottom > shell.visualRect.top,
      exports: [typeof SelectionOverlay, typeof capture.capture, typeof ResultOverlay, typeof ErrorOverlay],
      globals: ['FpsStitch', 'FpsSelect', 'FpsCapture', 'FpsPreview'].filter((n) => window[n] !== undefined),
    };
  })()`);
  assert.deepEqual(report.frames, [0, 1000, 2000, 2200]);
  assert.ok(report.fixedCount >= 3, 'sidebar + sticky-header + sticky-shell collected');
  assert.equal(report.shellHasArea, true, 'h:0 sticky shell gets a descendant-bbox visual rect');
  assert.deepEqual(report.exports, ['function', 'function', 'function', 'function']);
  assert.deepEqual(report.globals, [], 'no window.Fps* globals remain');
  console.log('module-graph probe OK', report);
} finally {
  chrome.kill();
  server.close();
}
