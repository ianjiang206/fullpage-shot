// State machine: idle → selecting → capturing → preview → (retry → selecting / close → idle)
import { MSG } from '../shared/protocol.js';
import { SelectionOverlay } from './select.js';
import { CaptureSession } from './capture.js';
import { ResultOverlay, ErrorOverlay } from './preview.js';

class CaptureFlow {
  #phase = 'idle';

  start() {
    if (this.#phase !== 'idle') return; // a flow is already running; ignore repeated clicks
    this.#enterSelecting();
  }

  #enterSelecting() {
    this.#phase = 'selecting';
    new SelectionOverlay({
      onConfirm: (selection) => this.#enterCapturing(selection),
      onCancel: () => this.#exitToIdle(),
    });
  }

  async #enterCapturing(selection) {
    this.#phase = 'capturing';
    await waitTwoFrames(); // the mask must actually leave composited frames so it never appears in frame 0
    const session = new CaptureSession(selection, {
      onProgress: (index, total) => chrome.runtime.sendMessage({ type: MSG.PROGRESS, text: `${index}/${total}` }),
      onStatus: (text) => chrome.runtime.sendMessage({ type: MSG.PROGRESS, text }),
    });
    try {
      this.#enterPreview(await session.run());
    } catch (error) {
      if (error && error.message === 'aborted') this.#exitToIdle(); // user cancelled with Esc
      else this.#enterError('截取失败：' + (error && error.message ? error.message : error));
    } finally {
      chrome.runtime.sendMessage({ type: MSG.DONE });
    }
  }

  #enterPreview(result) {
    this.#phase = 'preview';
    new ResultOverlay({
      ...result,
      // ResultOverlay.close() fires onClose (back to idle) before onRetry runs
      onRetry: () => this.#enterSelecting(),
      onClose: () => this.#exitToIdle(),
    });
  }

  #enterError(message) {
    this.#phase = 'preview';
    new ErrorOverlay(message, () => this.#exitToIdle());
  }

  #exitToIdle() {
    this.#phase = 'idle';
  }
}

function waitTwoFrames() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

const flow = new CaptureFlow();
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === MSG.PING) { sendResponse({ ok: true }); return false; }
  if (msg.type === MSG.START) { flow.start(); sendResponse({ ok: true }); return false; }
  return false;
});
