// State machine: idle → selecting → capturing → preview → (retry back to selecting / close back to idle)
import { MSG } from '../shared/protocol.js';
import * as select from './select.js';
import * as capture from './capture.js';
import * as preview from './preview.js';

let phase = 'idle'; // idle | selecting | capturing | preview
let ui = null;      // current overlay's {close()}

function twoFrames() {
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && phase === 'capturing') capture.cancel();
}, true);

function start() {
  if (phase !== 'idle') return; // a flow is already running; ignore repeated clicks
  beginSelect();
}

function beginSelect() {
  phase = 'selecting';
  ui = select.start({
    onConfirm,
    onCancel: () => { phase = 'idle'; ui = null; },
  });
}

async function onConfirm(sel) {
  ui = null; // the selection overlay has already removed itself
  phase = 'capturing';
  await twoFrames(); // wait for the mask to actually leave composited frames so it never appears in frame 0
  try {
    const result = await capture.capture(sel, (i, n) => {
      chrome.runtime.sendMessage({ type: MSG.PROGRESS, text: `${i}/${n}` });
    });
    phase = 'preview';
    ui = preview.show({
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
    ui = preview.showError(
      '截取失败：' + (e && e.message ? e.message : e),
      () => { phase = 'idle'; ui = null; },
    );
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === MSG.PING) { sendResponse({ ok: true }); return false; }
  if (msg.type === MSG.START) { start(); sendResponse({ ok: true }); return false; }
  return false;
});
