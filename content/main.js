// State machine: idle → selecting → capturing → preview → (retry back to selecting / close back to idle)
import { MSG } from '../shared/protocol.js';
import { SelectionOverlay } from './select.js';
import * as capture from './capture.js';
import { ResultOverlay, ErrorOverlay } from './preview.js';

let phase = 'idle'; // idle | selecting | capturing | preview
let ui = null;      // current overlay's {close()}

function twoFrames() {
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}

function start() {
  if (phase !== 'idle') return; // a flow is already running; ignore repeated clicks
  beginSelect();
}

function beginSelect() {
  phase = 'selecting';
  ui = new SelectionOverlay({
    onConfirm,
    onCancel: () => { phase = 'idle'; ui = null; },
  });
}

async function onConfirm(sel) {
  ui = null; // the selection overlay has already removed itself
  phase = 'capturing';
  await twoFrames(); // wait for the mask to actually leave composited frames so it never appears in frame 0
  const session = new capture.CaptureSession(sel, {
    onProgress: (i, n) => chrome.runtime.sendMessage({ type: MSG.PROGRESS, text: `${i}/${n}` }),
    onStatus: (text) => chrome.runtime.sendMessage({ type: MSG.PROGRESS, text }),
  });
  try {
    const result = await session.run();
    phase = 'preview';
    ui = new ResultOverlay({
      ...result,
      onRetry: () => { beginSelect(); },
      onClose: () => { phase = 'idle'; ui = null; },
    });
  } catch (e) {
    if (e && e.message === 'aborted') {
      phase = 'idle'; // user cancelled with Esc: silently back to idle
      return;
    }
    phase = 'preview';
    ui = new ErrorOverlay(
      '截取失败：' + (e && e.message ? e.message : e),
      () => { phase = 'idle'; ui = null; },
    );
  } finally {
    chrome.runtime.sendMessage({ type: MSG.DONE }); // the badge clears here now, not in capture.js
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === MSG.PING) { sendResponse({ ok: true }); return false; }
  if (msg.type === MSG.START) { start(); sendResponse({ ok: true }); return false; }
  return false;
});
