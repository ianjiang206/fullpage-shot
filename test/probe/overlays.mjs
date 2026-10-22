// Mounts the overlays on the fixture page and drives them with synthetic
// events: drag-select + Enter confirm, full-page button confirm, Esc cancel,
// result-overlay rendering + Esc close, error overlay.
import assert from 'node:assert/strict';
import { startServer, launchChrome, CdpPage, i18nStubSource } from './cdp.mjs';

const server = await startServer();
const chrome = await launchChrome();
try {
  const page = await CdpPage.open('http://127.0.0.1:8931/test/fixtures/long-page.html');
  const report = await page.evaluate(`(async () => {
    window.chrome = { i18n: ${i18nStubSource}, runtime: { getURL: (p) => '/' + p, onMessage: { addListener: () => {} } } };
    const { SelectionOverlay } = await import('/content/select.js');
    const { ResultOverlay, ErrorOverlay } = await import('/content/preview.js');

    // 1. drag-select + Enter confirm
    const confirmed = new Promise((resolve) => {
      window.__sel = new SelectionOverlay({ onConfirm: resolve, onCancel: () => resolve(null) });
    });
    const sel = window.__sel;
    const mask = sel.host.shadowRoot.querySelector('.fps-overlay');
    mask.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 100, clientY: 100, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 500, clientY: 300, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    const labelDuringDrag = sel.actionButton.textContent;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const dragRect = await confirmed;

    // 2. full-page confirm with no selection
    const fullPage = new Promise((resolve) => {
      window.__sel2 = new SelectionOverlay({ onConfirm: resolve, onCancel: () => resolve(null) });
    });
    window.__sel2.actionButton.click();
    const fullRect = await fullPage;

    // 3. Esc cancels, preventDefaults, and removes the host
    const cancelled = new Promise((resolve) => {
      window.__sel3 = new SelectionOverlay({ onConfirm: () => resolve('confirmed'), onCancel: () => resolve('cancelled') });
    });
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    const escDelivered = document.dispatchEvent(esc); // false when preventDefault was called
    const cancelResult = await cancelled;
    const sel3Removed = !window.__sel3.host.isConnected;

    // 4. result overlay renders and Esc closes it
    const canvas = document.createElement('canvas');
    canvas.width = 200; canvas.height = 600;
    canvas.getContext('2d').fillStyle = '#27ae60';
    canvas.getContext('2d').fillRect(0, 0, 200, 600);
    let previewClosed = false;
    const result = new ResultOverlay({
      parts: [{ canvas, startY: 0, cssHeight: 600 }],
      width: 200, totalHeight: 600, dpr: 1,
      onRetry: () => {}, onClose: () => { previewClosed = true; },
    });
    const title = result.host.shadowRoot.querySelector('.fps-title').textContent;
    const meta = result.host.shadowRoot.querySelector('.fps-meta').textContent;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    const previewRemoved = !result.host.isConnected;

    // 5. error overlay shows the message and its close button removes it
    let errorClosed = false;
    const error = new ErrorOverlay(chrome.i18n.getMessage('captureFailed', 'boom'), () => { errorClosed = true; });
    const errorText = error.host.shadowRoot.querySelector('.fps-meta').textContent;
    error.host.shadowRoot.querySelector('.fps-btn').click();

    return {
      dragRect, labelDuringDrag, fullRect,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      cancelResult, escDefaultPrevented: !escDelivered, sel3Removed,
      title, meta, previewClosed, previewRemoved,
      errorText, errorClosed,
    };
  })()`);

  assert.deepEqual(report.dragRect, { x: 100, y: 100, width: 400, height: 200 });
  assert.ok(report.labelDuringDrag.startsWith('截取'), 'action button switches to 截取 during drag');
  assert.deepEqual(report.fullRect, {
    x: 0, y: 0, width: report.viewport.width, height: report.viewport.height, fromTop: true,
  });
  assert.equal(report.cancelResult, 'cancelled');
  assert.equal(report.escDefaultPrevented, true, 'Esc is preventDefaulted (and stopPropagated) by the overlay');
  assert.equal(report.sel3Removed, true);
  assert.equal(report.title, '截取完成');
  assert.equal(report.meta, '200 × 600 px');
  assert.equal(report.previewClosed, true);
  assert.equal(report.previewRemoved, true);
  assert.equal(report.errorText, '截取失败：boom');
  assert.equal(report.errorClosed, true);
  console.log('overlays probe OK');
} finally {
  chrome.kill();
  server.close();
}
